/**
 * Claudex Recall MCP Server — exposes Claudex DB as MCP tools.
 *
 * Uses official @modelcontextprotocol/sdk for stdio transport.
 * 7 tools: claudex_search, claudex_recall, claudex_store, claudex_events,
 * claudex_message, claudex_session, claudex_curated_context.
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
import { hybridSearchSync, hybridSearchAsync } from '../core/hybrid-retrieval.js';
import { getSessionEvents } from '../core/session-events.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { initializeSchema, runMigrations } from '../core/migrations.js';
import { searchJournalFTS } from '../core/journal.js';
import { tokenizeQuery } from '../shared/search-utils.js';
import { searchConversations } from '../embeddings/qdrant-client.js';
import { extractLessonRef, ensurePointerId, recordPointerRecall } from '../angel/pointer-recall.js';

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

/**
 * Phase 5.5 — log a lesson recall if `ref` resolves to a lesson file under a
 * project's memory directory. Fire-and-forget: any failure swallows so that
 * the caller's recall response is never broken by the log path.
 *
 * Exported as a test seam: `recall-server-pointer-log.test.ts` invokes this
 * directly against an in-memory DB to verify the integration without booting
 * the MCP server.
 */
export function logLessonRecallIfApplicable(
  db: Database.Database,
  ref: string | null | undefined,
  sessionId: string,
): void {
  try {
    const lessonRef = extractLessonRef(ref);
    if (lessonRef) {
      const pid = ensurePointerId(db, lessonRef.project, lessonRef.filename, 'lesson');
      recordPointerRecall(db, pid, sessionId, null);
    }
  } catch {
    // Pointer log failures must not propagate.
  }
}

// ---------------------------------------------------------------------------
// MCP Instructions — stable identity/navigation content injected into CC's
// system prompt as a DANGEROUS_uncachedSystemPromptSection (position #14).
// Recomputed every turn but content is static, so org-scope cache hits normally.
//
// K1: Cache trade-off — any non-deferred MCP tool connected to CC downgrades
// the system prompt cache from `global` scope (shared across all users) to `org`
// scope (shared within org only). This is a CC architectural constraint, not a
// Claudex bug. With claude-teams and other MCP servers already connected, the
// downgrade is already in effect — removing Claudex MCP would NOT restore global
// scope. The benefit of direct memory access far outweighs the cache difference.
// ---------------------------------------------------------------------------

const CLAUDEX_INSTRUCTIONS = `Claudex is active on this machine — a persistent memory system giving you context continuity across sessions.

## When to Use Claudex Tools
- claudex_search: FIRST CHOICE for any question about past work, decisions, learnings, experience patterns, or project knowledge. Also use when the user asks "do you remember..." — experience patterns (past corrections and lessons) are searchable here.
- claudex_events: Session history — what happened, what was built, timeline of recent work.
- claudex_recall: Retrieve a specific artifact by ID or file path when you have an exact reference.
- claudex_store: Persist a decision or learning for future sessions after key decisions or user directives.
- claudex_message: Send messages to other active sessions (cross-session coordination).
- claudex_session: Session management — name sessions, list active sessions, create/clear signals.
- claudex_curated_context: Manage Project Curated Context — mental models, workspace maps, shipped components, constraints, preferences. Use at /endsession to curate what the next session sees.

## Navigation Rule
Query Claudex before exploring the filesystem for context. Only read code files when you need to MODIFY them.
All projects live in ~/Desktop/Projects/. The project registry is at ~/.claudex/projects.json.

## Safety
Never call CC's CLIProxyAPI from a hook (deadlock). \`claudex_search\` ranks with RRF fusion over FTS5 + sqlite-vec channels — it does not invoke a reranker. The cross-encoder reranker (BAAI/bge-reranker-v2-m3 on port 7439) is used by the hybrid-retrieval path feeding session-start and user-prompt-submit hooks; \`hybrid-retrieval.ts\` falls back to the arctic-embed2 bi-encoder when that service is unavailable.`;

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'claudex-recall', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: CLAUDEX_INSTRUCTIONS },
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'claudex_search',
  {
    description: 'Search Claudex memory — decisions, learnings, observations, experience patterns, project knowledge. Use for conceptual questions ("What decisions were made about auth?", "What is Nexus?"), recalling past corrections or lessons ("Do you remember when..."), and finding behavioral patterns. Returns ranked results with provenance.',
    inputSchema: {
      query: z.string().describe('Search query text'),
      project: z.string().optional().describe('Project scope (defaults to CWD project)'),
      limit: z.number().optional().describe('Max results (default 10, max 50)'),
      offset: z.number().optional().describe('Result offset for pagination (default 0)'),
    },
    _meta: {
      'anthropic/searchHint': 'memory recall knowledge decisions learnings observations experience patterns corrections lessons principles past sessions remember',
      'anthropic/alwaysLoad': true,
    },
  },
  async ({ query, project, limit: rawLimit, offset: rawOffset }) => {
    const proj = project ?? defaultProject;
    const limit = rawLimit != null && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 10;
    const offset = rawOffset != null && Number.isInteger(rawOffset) && rawOffset >= 0
      ? Math.min(rawOffset, 500)
      : 0;

    if (!query) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }] };
    }

    // RRF constant — controls how much top ranks dominate
    const RRF_K = 60;

    // Unified result type for cross-source RRF ranking
    type SearchResult = {
      id: number; type: string; summary: string; provenance: string;
      importance: number; project: string; source: string; score: number;
      recall_text?: string;
    };

    // Channel 1: Artifacts via hybrid search (FTS5 + Qdrant KNN + recency)
    let artifactResults: SearchResult[] = [];
    try {
      const hybridResults = await hybridSearchAsync(getDb(), query, proj, {
        limit: offset + limit,
      });
      artifactResults = hybridResults.map((a, i) => ({
        id: a.id,
        type: a.artifact_type,
        summary: a.summary,
        provenance: a.artifact_ref ?? `artifact #${a.id}`,
        importance: a.importance,
        project: a.project,
        source: 'artifacts',
        score: 1.0 / (RRF_K + i + 1), // RRF rank score (1-indexed)
      }));
    } catch {
      const ftsResults = searchArtifactsGlobal(getDb(), proj, query, offset + limit);
      artifactResults = ftsResults.map((a, i) => ({
        id: a.id,
        type: a.artifact_type,
        summary: a.summary,
        provenance: a.artifact_ref ?? `artifact #${a.id}`,
        importance: a.importance,
        project: a.project,
        source: 'artifacts',
        score: 1.0 / (RRF_K + i + 1),
      }));
    }

    // Channel 2: Journal (BM25-ranked, deduplicated per session, recall_text as summary)
    let journalResults: SearchResult[] = [];
    try {
      const journalHits = searchJournalFTS(getDb(), query, proj, offset + limit);
      // Deduplicate: keep best match per session
      const seenSessions = new Set<string>();
      const dedupedHits = journalHits.filter(j => {
        if (seenSessions.has(j.session_id)) return false;
        seenSessions.add(j.session_id);
        return true;
      }).slice(0, Math.max(5, offset + limit));
      journalResults = dedupedHits.map((j, i) => ({
        id: j.id,
        type: 'journal_flow',
        // Use recall_text (meaningful aliases) over raw content ("Build succeeded")
        summary: j.recall_text || j.content.slice(0, 200),
        provenance: `session:${j.session_id}`,
        importance: 4,
        project: j.project,
        source: 'journal',
        recall_text: j.recall_text ?? undefined,
        score: 1.0 / (RRF_K + i + 1), // RRF rank score (1-indexed)
      }));
    } catch { /* non-fatal */ }

    // Channel 3: Conversation turns (BM25-ranked via FTS5)
    let conversationResults: SearchResult[] = [];
    try {
      const keywords = tokenizeQuery(query, 5);
      if (keywords.length > 0) {
        const ftsQuery = keywords.join(' OR ');
        const convHits = cachedPrepare(getDb(),
          `SELECT ct.id, ct.session_id, ct.turn_number, ct.user_text, ct.assistant_text,
                  ct.project, ct.timestamp_epoch, bm25(conversation_turns_fts) as rank
           FROM conversation_turns ct
           JOIN conversation_turns_fts fts ON fts.rowid = ct.id
           WHERE conversation_turns_fts MATCH ?
             AND ct.project = ?
           ORDER BY rank
           LIMIT ?`
        ).all(ftsQuery, proj, offset + limit) as Array<{
          id: number; session_id: string; turn_number: number;
          user_text: string | null; assistant_text: string | null;
          project: string; timestamp_epoch: number; rank: number;
        }>;

        conversationResults = convHits.map((c, i) => ({
          id: c.id,
          type: 'conversation_turn',
          summary: [
            c.user_text ? `User: ${c.user_text.slice(0, 100)}` : '',
            c.assistant_text ? `Assistant: ${c.assistant_text.slice(0, 100)}` : '',
          ].filter(Boolean).join(' | '),
          provenance: `session:${c.session_id}:turn${c.turn_number}`,
          importance: 3,
          project: c.project,
          source: 'conversation',
          score: 1.0 / (RRF_K + i + 1),
        }));
      }
    } catch { /* FTS on conversation_turns may fail — non-fatal */ }

    // Supplementary: Qdrant vector search for conversations (semantic matches FTS5 misses)
    try {
      const { embedQuery } = await import('../embeddings/embed-pipeline.js');
      const embedding = await embedQuery(query);
      if (embedding) {
        const vectorConvs = await searchConversations(embedding, proj, 3);
        const existingIds = new Set(conversationResults.map(c => c.id));
        // Rank-normalize vector results after FTS5 results (consistent RRF scale)
        const vectorRankStart = conversationResults.length + 1;
        let vectorIdx = 0;
        for (const vc of vectorConvs) {
          if (existingIds.has(vc.id as number)) continue;
          existingIds.add(vc.id as number);
          const payload = vc.payload ?? {};
          conversationResults.push({
            id: vc.id as number,
            type: 'conversation_turn',
            summary: String(payload.summary ?? payload.user_text ?? '').slice(0, 200),
            provenance: `session:${payload.session_id ?? 'unknown'}:turn${payload.turn_number ?? '?'}`,
            importance: 3,
            project: String(payload.project ?? proj),
            source: 'conversation',
            score: 1.0 / (RRF_K + vectorRankStart + vectorIdx), // Rank-normalized after FTS5
          });
          vectorIdx++;
        }
      }
    } catch { /* Qdrant/embeddings unavailable — non-fatal */ }

    // Channel 4: Learnings (BM25-ranked via FTS5 — V17 routes through artifact_fts,
    // pre-V17 through learnings_fts; tries artifact_fts first, falls back to legacy).
    let learningResults: SearchResult[] = [];
    try {
      const keywords = tokenizeQuery(query, 5);
      if (keywords.length > 0) {
        const ftsQuery = keywords.join(' OR ');
        const db = getDb();
        // Try V17 path first
        let hits: Array<{ id: number | string; content: string; project: string; promotion_count: number }> = [];
        try {
          const rows = cachedPrepare(db,
            `SELECT a.id AS id, a.body AS content, a.project_id AS project,
                    CAST(json_extract(a.data, '$.promotion_count') AS INTEGER) AS promotion_count
             FROM artifact_fts f
             JOIN artifact a ON a.rowid = f.rowid
             WHERE artifact_fts MATCH ?
               AND a.kind = 'learning'
               AND (a.project_id = ? OR a.project_id = '__global__')
             ORDER BY bm25(artifact_fts)
             LIMIT ?`
          ).all(ftsQuery, proj, offset + limit) as Array<{
            id: string; content: string; project: string; promotion_count: number;
          }>;
          hits = rows;
        } catch { /* artifact_fts unavailable */ }

        // Fallback to legacy learnings_fts if V17 path produced nothing
        if (hits.length === 0) {
          try {
            const rows = cachedPrepare(db,
              `SELECT l.id, l.content, l.project, l.promotion_count
               FROM learnings l
               JOIN learnings_fts fts ON fts.rowid = l.id
               WHERE learnings_fts MATCH ?
                 AND (l.project = ? OR l.project = '__global__')
               ORDER BY bm25(learnings_fts)
               LIMIT ?`
            ).all(ftsQuery, proj, offset + limit) as Array<{
              id: number; content: string; project: string; promotion_count: number;
            }>;
            hits = rows;
          } catch { /* learnings_fts retired post-V17 — non-fatal */ }
        }

        learningResults = hits.map((l, i) => ({
          id: typeof l.id === 'number' ? l.id : i,
          type: 'learning',
          summary: l.content.slice(0, 300),
          provenance: `learning:${l.id}`,
          importance: 5,
          project: l.project,
          source: 'learning',
          score: 1.0 / (RRF_K + i + 1),
        }));
      }
    } catch { /* non-fatal */ }

    // Channel 5: Decisions (FTS5 with BM25 — replaces broken LIKE AND)
    let decisionResults: SearchResult[] = [];
    try {
      const keywords = tokenizeQuery(query, 5);
      if (keywords.length > 0) {
        const ftsQuery = keywords.join(' OR ');
        const hits = cachedPrepare(getDb(),
          `SELECT d.id, d.content, d.project, d.session_id,
                  bm25(decisions_fts) as rank
           FROM decisions d
           JOIN decisions_fts fts ON fts.rowid = d.id
           WHERE decisions_fts MATCH ?
             AND (d.project = ? OR d.project = '__global__')
           ORDER BY rank
           LIMIT ?`
        ).all(ftsQuery, proj, offset + limit) as Array<{
          id: number; content: string; project: string; session_id: string; rank: number;
        }>;
        decisionResults = hits.map((d, i) => ({
          id: d.id,
          type: 'decision',
          summary: d.content.slice(0, 300),
          provenance: `decision:${d.id}:${d.session_id}`,
          importance: 4,
          project: d.project,
          source: 'decision',
          score: 1.0 / (RRF_K + i + 1),
        }));
      }
    } catch {
      // Fallback: LIKE OR search if decisions_fts doesn't exist
      try {
        const keywords = tokenizeQuery(query, 3);
        if (keywords.length > 0) {
          const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
          const likeParams = keywords.map(k => `%${k}%`);
          const hits = cachedPrepare(getDb(),
            `SELECT id, content, project, session_id
             FROM decisions
             WHERE (project = ? OR project = '__global__')
               AND (${conditions})
             ORDER BY timestamp_epoch DESC
             LIMIT ?`
          ).all(proj, ...likeParams, offset + limit) as Array<{
            id: number; content: string; project: string; session_id: string;
          }>;
          decisionResults = hits.map((d, i) => ({
            id: d.id,
            type: 'decision',
            summary: d.content.slice(0, 300),
            provenance: `decision:${d.id}:${d.session_id}`,
            importance: 4,
            project: d.project,
            source: 'decision',
            score: 1.0 / (RRF_K + i + 1),
          }));
        }
      } catch { /* non-fatal */ }
    }

    // Channel 6: Experience patterns (FTS5 — V17 routes through artifact_fts,
    // pre-V17 through experience_patterns_fts).
    let patternResults: SearchResult[] = [];
    try {
      const keywords = tokenizeQuery(query, 5);
      if (keywords.length > 0) {
        const ftsQuery = keywords.join(' OR ');
        const db = getDb();
        let hits: Array<{
          id: string; lesson: string; severity: string; source_project: string;
        }> = [];
        try {
          const rows = cachedPrepare(db,
            `SELECT a.id, a.body AS lesson,
                    CAST(json_extract(a.data, '$.severity') AS TEXT) AS severity,
                    a.project_id AS source_project
             FROM artifact_fts f
             JOIN artifact a ON a.rowid = f.rowid
             WHERE artifact_fts MATCH ?
               AND a.kind = 'experience_pattern'
               AND CAST(json_extract(a.data, '$.score') AS INTEGER) >= 2
               AND (a.project_id = ? OR a.project_id = '__global__')
             ORDER BY bm25(artifact_fts)
             LIMIT ?`
          ).all(ftsQuery, proj, offset + limit) as Array<{
            id: string; lesson: string; severity: string; source_project: string;
          }>;
          hits = rows;
        } catch { /* artifact_fts unavailable */ }

        if (hits.length === 0) {
          try {
            const rows = cachedPrepare(db,
              `SELECT ep.id, ep.lesson, ep.severity, ep.source_project
               FROM experience_patterns ep
               JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
               WHERE experience_patterns_fts MATCH ?
                 AND ep.score >= 2
                 AND (ep.source_project = ? OR ep.source_project = '__global__')
               ORDER BY bm25(experience_patterns_fts)
               LIMIT ?`
            ).all(ftsQuery, proj, offset + limit) as Array<{
              id: string; lesson: string; severity: string; source_project: string;
            }>;
            hits = rows;
          } catch { /* experience_patterns_fts retired post-V17 */ }
        }

        const sevImportance: Record<string, number> = { critical: 5, important: 4, minor: 3 };
        patternResults = hits.map((p, i) => ({
          id: i,
          type: 'experience_pattern',
          summary: p.lesson.slice(0, 300),
          provenance: `pattern:${p.id}:${p.source_project}`,
          importance: sevImportance[p.severity] ?? 3,
          project: p.source_project,
          source: 'experience',
          score: 1.0 / (RRF_K + i + 1),
        }));
      }
    } catch { /* non-fatal */ }

    // Source weight multipliers — narrow spread so relevance rank dominates,
    // weights act as tiebreaker only (old 0.8–1.3 range let weak decisions outrank strong artifacts)
    const SOURCE_WEIGHTS: Record<string, number> = {
      experience: 1.06,  // Validated behavioral corrections — highest signal
      decision: 1.05,    // Explicit decisions — slight boost
      learning: 1.03,    // Behavioral corrections
      artifacts: 1.0,    // General content (baseline)
      journal: 0.97,     // Breadcrumbs
      conversation: 0.95, // Raw dialogue
    };

    // Merge all channels and sort by weighted RRF score
    const allResults = [
      ...artifactResults, ...journalResults, ...conversationResults,
      ...learningResults, ...decisionResults, ...patternResults,
    ].map(r => ({
      ...r,
      score: r.score * (SOURCE_WEIGHTS[r.source] ?? 1.0),
    })).sort((a, b) => b.score - a.score);

    const total = allResults.length;
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

server.registerTool(
  'claudex_recall',
  {
    description: 'Retrieve a specific artifact by ID or file path. Use when you have an exact reference ("Get artifact #3074", "Show me the handoff").',
    inputSchema: {
      id: z.number().optional().describe('Artifact ID'),
      artifact_ref: z.string().optional().describe('Artifact reference (file path)'),
    },
    _meta: {
      'anthropic/searchHint': 'artifact file specific ID reference lookup get retrieve',
    },
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

    // Phase 5.5 — log a pointer recall when the resolved artifact_ref points
    // to a lesson file under a project's memory directory.
    logLessonRecallIfApplicable(getDb(), row.artifact_ref ?? ref, `mcp:${defaultProject}`);

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

server.registerTool(
  'claudex_store',
  {
    description: 'Persist a decision or learning for future sessions. Use after key decisions or user directives that should survive across sessions.',
    inputSchema: {
      content: z.string().describe('Content to store'),
      type: z.enum(['decision', 'learning']).describe('Memory type'),
      project: z.string().optional().describe('Project scope (defaults to CWD project)'),
      agent_id: z.string().optional().describe('Agent identifier for multi-agent attribution'),
      topic_key: z.string().optional().describe('Topic key for upsert (e.g., "architecture/auth-model"). Evolving decisions with the same topic key update in place instead of creating duplicates.'),
    },
    _meta: {
      'anthropic/searchHint': 'save persist remember decision learning directive store',
    },
  },
  async ({ content, type, project, agent_id, topic_key }) => {
    const proj = project ?? defaultProject;

    if (!content) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'content is required' }) }] };
    }

    const fingerprint = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

    // 6.4: Agent-ID attribution — prepend agent_id to session_id for tracking
    const sessionId = agent_id ? `${agent_id}:mcp:${proj}` : `mcp:${proj}`;

    // Topic key upsert: evolving decisions stay in one record
    if (type === 'decision' && topic_key) {
      const { upsertDecisionByTopic } = await import('../core/decisions.js');
      const id = upsertDecisionByTopic(getDb(), {
        session_id: sessionId,
        project: proj,
        content,
        source: 'explicit',
        topic_key,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ stored: id > 0, type, project: proj, topic_key, upserted: true }) }] };
    }

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

server.registerTool(
  'claudex_events',
  {
    description: 'Query session history — what happened last session, what was built, what tools were used. Use for ANY question about recent work or session state.',
    inputSchema: {
      project: z.string().optional().describe('Project scope (defaults to CWD project)'),
      session_id: z.string().optional().describe('Specific session ID (defaults to latest)'),
    },
    _meta: {
      'anthropic/searchHint': 'session history recent work what happened last session events timeline activity',
      'anthropic/alwaysLoad': true,
    },
  },
  async ({ project, session_id }) => {
    if (session_id) {
      const events = getSessionEvents(getDb(), session_id);
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
    }

    // When no session_id given, find latest session for project (any status).
    // Fall back to latest active session across all projects.
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

server.registerTool(
  'claudex_message',
  {
    description: 'Send a message to another active session by name, topic, or project. Use when: asking another session a question, notifying about changes, or transferring work. The target receives it on their next turn.',
    inputSchema: {
      target: z.string().describe('Session name, topic fragment, project name, or session ID'),
      content: z.string().describe('Message content'),
      type: z.enum(['request', 'notify', 'transfer']).default('request').describe('Message type: request (expects response), notify (FYI), transfer (handoff)'),
      session_id: z.string().optional().describe('Current session ID (for sender attribution)'),
    },
    _meta: {
      'anthropic/searchHint': 'cross-session message send notify transfer communicate other session teammate',
    },
  },
  async ({ target, content, type, session_id }) => {
    const { resolveSession, listActiveSessions } = await import('../core/session-discovery.js');

    // M6: Enforce message size limit (8K chars ≈ 2K tokens)
    const MAX_MESSAGE_LENGTH = 8000;
    const trimmedContent = content.slice(0, MAX_MESSAGE_LENGTH);

    const senderSessionId = session_id ?? `mcp:${defaultProject}`;
    const resolved = resolveSession(getDb(), target, senderSessionId);

    if (!resolved) {
      const active = listActiveSessions(getDb(), senderSessionId);
      const sessionList = active.map(s =>
        `- ${s.name ?? s.session_id.slice(0, 8)} (${s.project ?? 'unknown'}: ${s.topic ?? 'no topic'})`
      ).join('\n');
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `No active session matching "${target}"`,
        active_sessions: active.length > 0 ? sessionList : 'No other active sessions found',
      }) }] };
    }

    // H1: For transfer type, use SBAR packaging instead of raw content
    if (type === 'transfer') {
      const { packageSessionContext, sendTransfer } = await import('../core/session-transfer.js');
      const pkg = packageSessionContext(getDb(), senderSessionId);
      if (pkg) {
        sendTransfer(getDb(), senderSessionId, resolved.session_id, pkg);
        return { content: [{ type: 'text', text: JSON.stringify({
          sent: true,
          transfer: true,
          target_session: resolved.session_id,
          target_name: resolved.name,
          token_cost: pkg.tokenCost,
        }) }] };
      }
      // Fallback: if SBAR packaging fails, send raw content as transfer
    }

    const messageType = type === 'transfer' ? 'transfer' : type === 'notify' ? 'notify' : 'request';
    const priority = type === 'transfer' ? 'urgent' : 'normal';

    cachedPrepare(getDb(),
      `INSERT INTO session_messages (target_session, sender, sender_type, message_type, content, priority)
       VALUES (?, ?, 'session', ?, ?, ?)`
    ).run(resolved.session_id, senderSessionId, messageType, trimmedContent, priority);

    return { content: [{ type: 'text', text: JSON.stringify({
      sent: true,
      target_session: resolved.session_id,
      target_name: resolved.name,
      target_topic: resolved.topic,
      match_type: resolved.match_type,
      message_type: messageType,
    }) }] };
  },
);

server.registerTool(
  'claudex_session',
  {
    description: 'Manage sessions and signals. Actions: "list" (show active sessions), "name" (name this session), "signal" (create wip/failure/danger/claim/discovery signal), "clear_signal" (remove a signal), "pickup" (grab context from another session).',
    inputSchema: {
      action: z.enum(['name', 'list', 'signal', 'clear_signal', 'pickup']).describe('Action to perform'),
      session_id: z.string().optional().describe('Current session ID'),
      name: z.string().optional().describe('Session name (for action=name)'),
      signal_type: z.enum(['wip', 'failure', 'danger', 'claim', 'discovery']).optional().describe('Signal type (for action=signal)'),
      target: z.string().optional().describe('Signal target — file path, task, or topic (for action=signal)'),
      detail: z.string().optional().describe('Signal detail (for action=signal)'),
      signal_id: z.number().optional().describe('Signal ID to clear (for action=clear_signal)'),
      source: z.string().optional().describe('Source session name/ID to pick up from (for action=pickup)'),
    },
    _meta: {
      'anthropic/searchHint': 'session management name list signal active sessions coordination stigmergic',
    },
  },
  async ({ action, session_id, name, signal_type, target, detail, signal_id, source }) => {
    // Resolve session_id: use provided value, or find the most recently ACTIVE session for this project.
    // The MCP server doesn't receive CC's session_id, so we look it up from the DB.
    // Uses latest activity (session_events) not creation time to handle multi-session correctly.
    // Fallback to mcp:<project> only if no active session exists (shouldn't happen in normal use).
    let sessionId = session_id ?? '';
    if (!sessionId) {
      try {
        const active = cachedPrepare(getDb(),
          `SELECT s.session_id FROM sessions s
           LEFT JOIN (
             SELECT session_id, MAX(timestamp_epoch) as last_activity
             FROM session_events GROUP BY session_id
           ) e ON e.session_id = s.session_id
           WHERE s.project = ? AND s.status = 'active'
           ORDER BY COALESCE(e.last_activity, s.created_at_epoch) DESC LIMIT 1`
        ).get(defaultProject) as { session_id: string } | undefined;
        sessionId = active?.session_id ?? `mcp:${defaultProject}`;
      } catch {
        sessionId = `mcp:${defaultProject}`;
      }
    }

    if (action === 'name') {
      if (!name) return { content: [{ type: 'text', text: JSON.stringify({ error: 'name is required' }) }] };
      const { nameSession } = await import('../core/session-discovery.js');
      nameSession(getDb(), sessionId, name);
      return { content: [{ type: 'text', text: JSON.stringify({ named: true, session_id: sessionId, name }) }] };
    }

    if (action === 'list') {
      const { listActiveSessions } = await import('../core/session-discovery.js');
      const sessions = listActiveSessions(getDb(), sessionId);
      return { content: [{ type: 'text', text: JSON.stringify({ sessions, count: sessions.length }) }] };
    }

    if (action === 'signal') {
      if (!signal_type || !target) return { content: [{ type: 'text', text: JSON.stringify({ error: 'signal_type and target are required' }) }] };
      const { createSignal } = await import('../core/session-signals.js');
      // Resolve project from session if available, fallback to default
      const sessionRow = cachedPrepare(getDb(), 'SELECT project FROM sessions WHERE session_id = ?').get(sessionId) as { project: string } | undefined;
      const signalProject = sessionRow?.project || defaultProject;
      const id = createSignal(getDb(), sessionId, signalProject, signal_type, target, detail);
      return { content: [{ type: 'text', text: JSON.stringify({ created: id > 0, signal_id: id, signal_type, target }) }] };
    }

    if (action === 'clear_signal') {
      if (!signal_id) return { content: [{ type: 'text', text: JSON.stringify({ error: 'signal_id is required' }) }] };
      const { clearSignal } = await import('../core/session-signals.js');
      clearSignal(getDb(), signal_id);
      return { content: [{ type: 'text', text: JSON.stringify({ cleared: true, signal_id }) }] };
    }

    if (action === 'pickup') {
      if (!source) return { content: [{ type: 'text', text: JSON.stringify({ error: 'source session name/ID is required' }) }] };
      const { resolveSession } = await import('../core/session-discovery.js');
      const resolved = resolveSession(getDb(), source, sessionId);
      if (!resolved) return { content: [{ type: 'text', text: JSON.stringify({ error: `No session matching "${source}"` }) }] };

      const { packageSessionContext, formatTransferPackage } = await import('../core/session-transfer.js');
      const pkg = packageSessionContext(getDb(), resolved.session_id);
      if (!pkg) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not package session context' }) }] };

      return { content: [{ type: 'text', text: formatTransferPackage(pkg) }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown action: ${action}` }) }] };
  },
);

// ---------------------------------------------------------------------------
// claudex_curated_context — privileged always-on slot for agent-curated
// theory, workspace map, shipped manifest, constraints, preferences.
// Written at /endsession; read at /starthere via assembly injection P2.1.
// See context/specs/CURATED_CONTEXT.md for the full design.
// ---------------------------------------------------------------------------

server.registerTool(
  'claudex_curated_context',
  {
    description: "Manage Project Curated Context — the privileged always-on injection slot for mental models, workspace maps, shipped components, constraints, preferences, and reframes. Actions: 'list' (show active entries for project + global), 'write' (add new entry), 'confirm' (promote Angel-proposed → active), 'archive' (retire entry), 'promote' (mark permanent, tier 3), 'supersede' (write new entry replacing old). Use at /endsession to curate what the next session should know. Types: mental_model, workspace_map, shipped, reframe, constraint, preference. workspace_map and shipped are project-only (not valid at __global__ scope).",
    inputSchema: {
      action: z.enum(['list', 'write', 'confirm', 'archive', 'promote', 'supersede'])
        .describe('Action to perform'),
      project: z.string().optional()
        .describe("Project scope (defaults to CWD project). Use '__global__' for cross-project entries."),
      type: z.enum(['mental_model', 'workspace_map', 'shipped', 'reframe', 'constraint', 'preference'])
        .optional()
        .describe('Entry type (for write/supersede)'),
      content: z.string().optional()
        .describe('Entry content, active voice, ≤500 chars (for write/supersede)'),
      tags: z.array(z.string()).optional()
        .describe('Free-form tags (for write/supersede)'),
      supersedes_id: z.number().optional()
        .describe('ID of the entry being replaced (for supersede)'),
      id: z.number().optional()
        .describe('Entry ID (for confirm/archive/promote)'),
      session_id: z.string().optional()
        .describe('Source session ID (auto-filled for write when available)'),
      include_proposed: z.boolean().optional()
        .describe('Include Angel-proposed entries in list results (default true)'),
      types: z.array(z.enum(['mental_model', 'workspace_map', 'shipped', 'reframe', 'constraint', 'preference']))
        .optional()
        .describe('Filter list by types (default: all)'),
    },
    _meta: {
      'anthropic/searchHint': 'curated context mental model workspace shipped constraint preference reframe agent endsession',
    },
  },
  async ({ action, project, type, content, tags, supersedes_id, id, session_id, include_proposed, types }) => {
    const proj = project ?? defaultProject;

    try {
      if (action === 'list') {
        const { listEntries } = await import('../core/curated-context.js');
        const statuses = include_proposed === false
          ? (['active'] as const)
          : (['active', 'proposed'] as const);
        const entries = listEntries(getDb(), proj, {
          includeGlobal: true,
          statuses,
          types,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ entries, count: entries.length, project: proj }),
          }],
        };
      }

      if (action === 'write') {
        if (!type || !content) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'type and content are required for write' }),
            }],
          };
        }
        const { writeEntry } = await import('../core/curated-context.js');
        const newId = writeEntry(getDb(), {
          project: proj,
          type,
          content,
          curator: 'agent',
          tags,
          source_session_id: session_id,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ written: true, id: newId, project: proj, type }),
          }],
        };
      }

      if (action === 'confirm') {
        if (!id) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'id is required for confirm' }),
            }],
          };
        }
        const { confirmEntry } = await import('../core/curated-context.js');
        const ok = confirmEntry(getDb(), id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ confirmed: ok, id }) }],
        };
      }

      if (action === 'archive') {
        if (!id) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'id is required for archive' }),
            }],
          };
        }
        const { archiveEntry } = await import('../core/curated-context.js');
        const ok = archiveEntry(getDb(), id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ archived: ok, id }) }],
        };
      }

      if (action === 'promote') {
        if (!id) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'id is required for promote' }),
            }],
          };
        }
        const { promoteEntry } = await import('../core/curated-context.js');
        const ok = promoteEntry(getDb(), id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ promoted: ok, id }) }],
        };
      }

      if (action === 'supersede') {
        if (!supersedes_id || !type || !content) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'supersedes_id, type, and content are required for supersede' }),
            }],
          };
        }
        const { supersedeEntry } = await import('../core/curated-context.js');
        const newId = supersedeEntry(getDb(), supersedes_id, {
          project: proj,
          type,
          content,
          curator: 'agent',
          tags,
          source_session_id: session_id,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ superseded: true, old_id: supersedes_id, new_id: newId }),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Unknown action: ${action}` }),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        }],
      };
    }
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
