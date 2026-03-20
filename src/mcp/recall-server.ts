/**
 * Claudex Recall MCP Server — exposes Claudex DB as MCP tools.
 *
 * Uses official @modelcontextprotocol/sdk for stdio transport.
 * 4 tools: claudex_search, claudex_recall, claudex_store, claudex_events.
 *
 * Usage: node dist/mcp/recall-server.cjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
    initializeSchema(db);
    runMigrations(db);
  }
  return db;
}

const defaultProject = getProjectId(process.cwd());

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'claudex-recall', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  'claudex_search',
  'Search Claudex memory across all artifacts. Returns ranked results with provenance.',
  {
    query: z.string().describe('Search query text'),
    project: z.string().optional().describe('Project scope (defaults to CWD project)'),
    limit: z.number().optional().describe('Max results (default 10, max 50)'),
  },
  async ({ query, project, limit: rawLimit }) => {
    const proj = project ?? defaultProject;
    const limit = rawLimit != null && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 10;

    if (!query) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }] };
    }

    const artifacts = searchArtifactsGlobal(getDb(), proj, query, limit);
    const results = artifacts.map(a => ({
      id: a.id,
      type: a.artifact_type,
      summary: a.summary,
      provenance: a.artifact_ref ?? `artifact #${a.id}`,
      importance: a.importance,
      project: a.project,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'claudex_recall',
  'Retrieve a specific artifact by ID or file reference path.',
  {
    id: z.number().optional().describe('Artifact ID'),
    artifact_ref: z.string().optional().describe('Artifact reference (file path)'),
  },
  async ({ id, artifact_ref }) => {
    const validId = id != null && Number.isInteger(id) && id > 0 ? id : null;
    const ref = artifact_ref ?? null;

    if (!validId && !ref) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'id or artifact_ref required' }) }] };
    }

    let row: ArtifactRow | undefined;
    if (validId) {
      row = cachedPrepare(getDb(), 'SELECT * FROM artifacts WHERE id = ?').get(validId) as ArtifactRow | undefined;
    } else if (ref) {
      row = cachedPrepare(getDb(), 'SELECT * FROM artifacts WHERE artifact_ref = ? LIMIT 1').get(ref) as ArtifactRow | undefined;
    }

    if (!row) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: row.id,
          type: row.artifact_type,
          summary: row.summary,
          content: row.content,
          provenance: row.artifact_ref ?? `artifact #${row.id}`,
          project: row.project,
          importance: row.importance,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'claudex_store',
  'Store a decision or learning in Claudex memory.',
  {
    content: z.string().describe('Content to store'),
    type: z.enum(['decision', 'learning']).describe('Memory type'),
    project: z.string().optional().describe('Project scope (defaults to CWD project)'),
  },
  async ({ content, type, project }) => {
    const proj = project ?? defaultProject;

    if (!content) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'content is required' }) }] };
    }

    const fingerprint = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

    if (type === 'decision') {
      const result = cachedPrepare(getDb(),
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(`mcp:${proj}`, proj, content, fingerprint);
      return { content: [{ type: 'text', text: JSON.stringify({ stored: result.changes > 0, type, project: proj }) }] };
    } else {
      const result = cachedPrepare(getDb(),
        `INSERT OR IGNORE INTO learnings (content, project, fingerprint)
         VALUES (?, ?, ?)`
      ).run(content, proj, fingerprint);
      return { content: [{ type: 'text', text: JSON.stringify({ stored: result.changes > 0, type, project: proj }) }] };
    }
  },
);

server.tool(
  'claudex_events',
  'Query structured session events for a project.',
  {
    project: z.string().optional().describe('Project scope (defaults to CWD project)'),
    session_id: z.string().optional().describe('Specific session ID (defaults to latest)'),
  },
  async ({ project, session_id }) => {
    const proj = project ?? defaultProject;

    if (session_id) {
      const events = getSessionEvents(getDb(), session_id);
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
    }

    const session = cachedPrepare(getDb(),
      `SELECT session_id FROM sessions WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(proj) as { session_id: string } | undefined;

    if (!session) {
      return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    }

    const events = getSessionEvents(getDb(), session.session_id);
    return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  process.stderr.write(`claudex-recall: failed to start: ${err}\n`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  if (db) { try { db.close(); } catch { /* */ } }
  process.exit(0);
});
