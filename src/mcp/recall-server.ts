/**
 * Claudex Recall MCP Server — exposes Claudex DB as MCP tools.
 *
 * JSON-RPC over stdio (Content-Length framed, raw Buffer for byte accuracy).
 * 4 tools: claudex_search, claudex_recall, claudex_store, claudex_events.
 *
 * Usage: node dist/mcp/recall-server.cjs
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { getProjectId } from '../shared/scope-detector.js';
import { searchArtifactsGlobal } from '../core/artifacts.js';
import type { ArtifactRow } from '../core/artifacts.js';
import { getSessionEvents } from '../core/session-events.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { initializeSchema, runMigrations } from '../core/migrations.js';

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // initializeSchema handles both fresh DBs and existing ones
    initializeSchema(db);
    runMigrations(db);
  }
  return db;
}

const defaultProject = getProjectId(process.cwd());

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'claudex_search',
    description: 'Search Claudex memory across all artifacts. Returns ranked results with provenance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search query text' },
        project: { type: 'string' as const, description: 'Project scope (defaults to CWD project)' },
        limit: { type: 'number' as const, description: 'Max results (default 10, max 50)' },
      },
      required: ['query'] as const,
    },
  },
  {
    name: 'claudex_recall',
    description: 'Retrieve a specific artifact by ID or file reference path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' as const, description: 'Artifact ID' },
        artifact_ref: { type: 'string' as const, description: 'Artifact reference (file path)' },
      },
    },
  },
  {
    name: 'claudex_store',
    description: 'Store a decision or learning in Claudex memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' as const, description: 'Content to store' },
        type: { type: 'string' as const, enum: ['decision', 'learning'], description: 'Memory type' },
        project: { type: 'string' as const, description: 'Project scope (defaults to CWD project)' },
      },
      required: ['content', 'type'] as const,
    },
  },
  {
    name: 'claudex_events',
    description: 'Query structured session events for a project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string' as const, description: 'Project scope (defaults to CWD project)' },
        session_id: { type: 'string' as const, description: 'Specific session ID (defaults to latest)' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleSearch(args: Record<string, unknown>): unknown {
  const query = String(args.query ?? '');
  const project = String(args.project ?? defaultProject);
  const rawLimit = Number(args.limit ?? 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;

  if (!query) return { error: 'query is required' };

  const artifacts = searchArtifactsGlobal(getDb(), project, query, limit);
  return artifacts.map(a => ({
    id: a.id,
    type: a.artifact_type,
    summary: a.summary,
    provenance: a.artifact_ref ?? `artifact #${a.id}`,
    importance: a.importance,
    project: a.project,
  }));
}

function handleRecall(args: Record<string, unknown>): unknown {
  const rawId = args.id !== undefined ? Number(args.id) : null;
  const id = rawId !== null && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const ref = args.artifact_ref ? String(args.artifact_ref) : null;

  if (!id && !ref) return { error: 'id or artifact_ref required' };

  let row: ArtifactRow | undefined;
  if (id) {
    row = cachedPrepare(getDb(), 'SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  } else if (ref) {
    row = cachedPrepare(getDb(), 'SELECT * FROM artifacts WHERE artifact_ref = ? LIMIT 1').get(ref) as ArtifactRow | undefined;
  }

  if (!row) return { error: 'not found' };
  return {
    id: row.id,
    type: row.artifact_type,
    summary: row.summary,
    content: row.content,
    provenance: row.artifact_ref ?? `artifact #${row.id}`,
    project: row.project,
    importance: row.importance,
  };
}

function handleStore(args: Record<string, unknown>): unknown {
  const content = String(args.content ?? '');
  const type = String(args.type ?? '');
  const project = String(args.project ?? defaultProject);

  if (!content) return { error: 'content is required' };
  if (type !== 'decision' && type !== 'learning') return { error: 'type must be "decision" or "learning"' };

  const fingerprint = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

  if (type === 'decision') {
    const result = cachedPrepare(getDb(),
      `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
       VALUES (?, ?, ?, 'explicit', ?)`
    ).run(`mcp:${project}`, project, content, fingerprint);
    return { stored: result.changes > 0, type, project };
  } else {
    // Match actual learnings schema (no source_type/source_ref columns)
    const result = cachedPrepare(getDb(),
      `INSERT OR IGNORE INTO learnings (content, project, fingerprint)
       VALUES (?, ?, ?)`
    ).run(content, project, fingerprint);
    return { stored: result.changes > 0, type, project };
  }
}

function handleEvents(args: Record<string, unknown>): unknown {
  const project = String(args.project ?? defaultProject);
  const sessionId = args.session_id ? String(args.session_id) : null;

  if (sessionId) {
    return getSessionEvents(getDb(), sessionId);
  }

  const session = cachedPrepare(getDb(),
    `SELECT session_id FROM sessions WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1`
  ).get(project) as { session_id: string } | undefined;

  if (!session) return [];
  return getSessionEvents(getDb(), session.session_id);
}

// ---------------------------------------------------------------------------
// JSON-RPC MCP protocol (raw Buffer transport for byte-accurate framing)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function sendResponse(id: number | string, result: unknown): void {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  const buf = Buffer.from(response, 'utf-8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

function sendError(id: number | string | null, code: number, message: string): void {
  if (id === null) return; // Can't respond without an id
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  const buf = Buffer.from(response, 'utf-8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

function dispatch(req: JsonRpcRequest): unknown {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claudex-recall', version: '1.0.0' },
      };
    case 'notifications/initialized':
      return undefined;
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const toolName = String(req.params?.name ?? '');
      const toolArgs = (req.params?.arguments as Record<string, unknown>) ?? {};
      let result: unknown;
      switch (toolName) {
        case 'claudex_search': result = handleSearch(toolArgs); break;
        case 'claudex_recall': result = handleRecall(toolArgs); break;
        case 'claudex_store': result = handleStore(toolArgs); break;
        case 'claudex_events': result = handleEvents(toolArgs); break;
        default: return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    default:
      return undefined;
  }
}

// Raw Buffer stdin — no setEncoding (byte-accurate Content-Length framing)
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;

    const header = buffer.subarray(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf-8');
    buffer = buffer.subarray(bodyStart + contentLength);

    let reqId: number | string | null = null;
    try {
      const req = JSON.parse(body) as JsonRpcRequest;
      reqId = req.id ?? null;

      const result = dispatch(req);
      if (result !== undefined && reqId !== null) {
        sendResponse(reqId, result);
      }
    } catch (e) {
      // Dispatch error — respond with the request's id if available
      if (reqId !== null) {
        sendError(reqId, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Parse error with no id — we can't respond meaningfully
    }
  }
});

process.stdin.on('end', () => {
  if (db) { try { db.close(); } catch { /* */ } }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (db) { try { db.close(); } catch { /* */ } }
  process.exit(0);
});
