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
import { hybridSearchSync } from '../core/hybrid-retrieval.js';
import type { ScoredArtifact } from '../core/hybrid-retrieval.js';
import { getSessionEvents } from '../core/session-events.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { initializeSchema, runMigrations } from '../core/migrations.js';
import { searchJournalFTS } from '../core/journal.js';

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
  'Search Claudex memory across all artifacts. Returns ranked results with provenance and relevance scores.',
  {
    query: z.string().describe('Search query text'),
    project: z.string().optional().describe('Project scope (defaults to CWD project)'),
    limit: z.number().optional().describe('Max results (default 10, max 50)'),
    offset: z.number().optional().describe('Result offset for pagination (default 0)'),
  },
  async ({ query, project, limit: rawLimit, offset: rawOffset }) => {
    const proj = project ?? defaultProject;
    const limit = rawLimit != null && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 10;
    const offset = rawOffset != null && Number.isInteger(rawOffset) && rawOffset >= 0
      ? rawOffset
      : 0;

    if (!query) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }] };
    }

    // 6.1: Hybrid search with graceful degradation to FTS5
    let artifactResults: Array<{
      id: number;
      type: string;
      summary: string;
      provenance: string;
      importance: number;
      project: string;
      source: 'artifacts';
      score: number;
    }>;

    try {
      // Fetch extra results to support pagination (offset + limit)
      const hybridResults = hybridSearchSync(getDb(), query, proj, {
        limit: offset + limit,
      });

      artifactResults = hybridResults.map(a => ({
        id: a.id,
        type: a.artifact_type,
        summary: a.summary,
        provenance: a.artifact_ref ?? `artifact #${a.id}`,
        importance: a.importance,
        project: a.project,
        source: 'artifacts' as const,
        score: a.hybrid_score,
      }));
    } catch {
      // Graceful degradation: fall back to FTS5-only search
      const ftsResults = searchArtifactsGlobal(getDb(), proj, query, offset + limit);
      artifactResults = ftsResults.map(a => ({
        id: a.id,
        type: a.artifact_type,
        summary: a.summary,
        provenance: a.artifact_ref ?? `artifact #${a.id}`,
        importance: a.importance,
        project: a.project,
        source: 'artifacts' as const,
        score: 0,
      }));
    }

    // Also search session journal (Evolved Flow recall metadata)
    const journalHits = searchJournalFTS(getDb(), query, proj, Math.min(offset + limit, 5));
    const journalResults = journalHits.map(j => ({
      id: j.id,
      type: 'journal_flow' as const,
      summary: j.content.slice(0, 200),
      provenance: `session:${j.session_id}`,
      importance: 4,
      project: j.project,
      source: 'journal' as const,
      recall_text: j.recall_text ?? undefined,
      score: 0.5, // Journal matches get a baseline score (recall-optimized)
    }));

    // Merge: journal results first (recall-optimized), then artifacts
    const allResults = [...journalResults, ...artifactResults];
    const total = allResults.length;

    // 6.2: Apply pagination
    const paginatedResults = allResults.slice(offset, offset + limit);
    const has_more = offset + limit < total;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: paginatedResults,
          total,
          has_more,
        }, null, 2),
      }],
    };
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
    agent_id: z.string().optional().describe('Agent identifier for multi-agent attribution'),
  },
  async ({ content, type, project, agent_id }) => {
    const proj = project ?? defaultProject;

    if (!content) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'content is required' }) }] };
    }

    const fingerprint = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

    // 6.4: Agent-ID attribution — prepend agent_id to session_id for tracking
    const sessionId = agent_id ? `${agent_id}:mcp:${proj}` : `mcp:${proj}`;

    if (type === 'decision') {
      const result = cachedPrepare(getDb(),
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(sessionId, proj, content, fingerprint);
      return { content: [{ type: 'text', text: JSON.stringify({ stored: result.changes > 0, type, project: proj, agent_id: agent_id ?? null }) }] };
    } else {
      const result = cachedPrepare(getDb(),
        `INSERT OR IGNORE INTO learnings (content, project, fingerprint)
         VALUES (?, ?, ?)`
      ).run(content, proj, fingerprint);
      return { content: [{ type: 'text', text: JSON.stringify({ stored: result.changes > 0, type, project: proj, agent_id: agent_id ?? null }) }] };
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
    if (session_id) {
      const events = getSessionEvents(getDb(), session_id);
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
    }

    // When no session_id given, find latest active session.
    // Try project-scoped first, then fall back to latest across all projects.
    const proj = project ?? defaultProject;
    let session = cachedPrepare(getDb(),
      `SELECT session_id FROM sessions WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(proj) as { session_id: string } | undefined;

    if (!session) {
      // Fallback: latest active session across ALL projects
      session = cachedPrepare(getDb(),
        `SELECT session_id FROM sessions WHERE status = 'active' ORDER BY created_at_epoch DESC LIMIT 1`
      ).get() as { session_id: string } | undefined;
    }

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
