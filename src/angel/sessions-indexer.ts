/**
 * Angel Sessions Indexer — Phase 13 Plan 02.
 *
 * Scans Sessions/ directories in each registered project, detects new/modified
 * markdown files since the last heartbeat tick, parses them into ChunkV6 objects
 * using the same wrapper-redaction + sentence-boundary chunker the Phase 8 JSONL
 * ingestion uses, and lands them in transcript_chunk_v6 via upsertChunk.
 *
 * ANTI-SCOPE: This indexer handles cross-session retrieval only.
 * Same-session retrieval of just-written turns is intentionally out of scope
 * and relies on CC's in-conversation transcript.
 *
 * Recovery = normal path: a DB wipe followed by a heartbeat tick re-indexes
 * everything in Sessions/ through the same loop. No separate recovery code path.
 *
 * Watch mechanism: Angel heartbeat tick stat()-scans Sessions/. Chokidar
 * rejected (Windows-fragility + dep-graph surface). Polling rejected
 * (redundant with heartbeat). Latency target: ≤2 minutes (heartbeat cycle).
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cachedPrepare } from '../core/stmt-cache.js';
import { upsertChunk } from '../ingestion/upsert-chunk.js';
import { chunkTranscript, type ChunkV6, type JsonlTurn } from '../ingestion/transcript-chunker-v6.js';

const CLAUDEX_PROJECTS_JSON = path.join(os.homedir(), '.claudex', 'projects.json');

/** In-memory mtime cache across ticks (keyed by absolute file path). Optimization layer; cursor table is the source of truth. */
const mtimeCache = new Map<string, number>();

export interface SessionsIndexResult {
  files_scanned: number;
  files_indexed: number;
  chunks_upserted: number;
  errors: number;
}

/**
 * Look up the list of registered project directories from ~/.claudex/projects.json.
 * Returns array of { projectId, projectDir }. Non-throwing — returns [] on any error.
 */
export function getRegisteredProjectDirs(): Array<{ projectId: string; projectDir: string }> {
  try {
    if (!fs.existsSync(CLAUDEX_PROJECTS_JSON)) return [];
    const raw = JSON.parse(fs.readFileSync(CLAUDEX_PROJECTS_JSON, 'utf-8'));
    const projects = raw.projects ?? {};
    const out: Array<{ projectId: string; projectDir: string }> = [];
    for (const [projectId, info] of Object.entries(projects)) {
      const p = (info as { path?: string })?.path;
      if (typeof p === 'string' && p.length > 0) {
        out.push({ projectId, projectDir: p });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Idempotent lazy-create of the sessions_index_cursor table.
 * Optimization cursor only — never required for correctness (upsertChunk
 * is idempotent on its UNIQUE constraint).
 */
function ensureCursorTable(db: Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_index_cursor (
        file_path TEXT PRIMARY KEY,
        last_indexed_mtime_ms INTEGER NOT NULL DEFAULT 0
      )
    `);
  } catch { /* non-fatal — cursor is an optimization */ }
}

/**
 * Scan Sessions/ directories for all registered projects and index new/changed files.
 * Called from the Angel heartbeat tick.
 *
 * When `projectDirs` is omitted, the registered-project list from
 * ~/.claudex/projects.json is used.
 */
export async function scanAndIndexSessions(
  db: Database,
  projectDirs?: Array<{ projectId: string; projectDir: string }>,
): Promise<SessionsIndexResult> {
  const result: SessionsIndexResult = { files_scanned: 0, files_indexed: 0, chunks_upserted: 0, errors: 0 };
  ensureCursorTable(db);

  const targets = projectDirs ?? getRegisteredProjectDirs();

  for (const { projectId, projectDir } of targets) {
    const sessionsDir = path.join(projectDir, 'Sessions');
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'));
    } catch {
      continue; // Sessions/ doesn't exist for this project yet — skip
    }

    for (const filename of files) {
      const filePath = path.join(sessionsDir, filename);
      result.files_scanned++;

      try {
        const stat = fs.statSync(filePath);
        const mtimeMs = stat.mtimeMs;
        const cached = mtimeCache.get(filePath);
        const lastIndexed = cached ?? getLastIndexedMtime(db, filePath);

        if (mtimeMs <= lastIndexed) {
          continue; // unchanged since last tick — skip without reading
        }

        const sessionId = extractSessionId(filename);
        if (!sessionId) continue;

        const markdown = fs.readFileSync(filePath, 'utf8');
        const chunks = buildChunksFromSessionMarkdown(markdown, sessionId, projectId);

        for (const chunk of chunks) {
          upsertChunk(db, chunk);
          result.chunks_upserted++;
        }

        mtimeCache.set(filePath, mtimeMs);
        setLastIndexedMtime(db, filePath, mtimeMs);
        result.files_indexed++;
      } catch {
        result.errors++;
      }
    }
  }

  return result;
}

/**
 * Parse a Sessions/ markdown file into ChunkV6 objects.
 *
 * Turn boundaries are detected by `## User`, `## Assistant`, `## ToolResult:*` headers.
 * Pure function (no DB, no I/O) — fully testable with fixture strings.
 *
 * Wrappers (system-reminder, experience-data, etc.) are redacted at extraction-time
 * inside chunkTranscript (which calls parseWrappers exactly once per turn),
 * consistent with the Phase 8 ingestion pipeline's wrapper redaction posture.
 */
export function buildChunksFromSessionMarkdown(
  markdown: string,
  sessionId: string,
  projectId: string,
): ChunkV6[] {
  const lines = markdown.split('\n');
  const TURN_HEADER = /^## (User|Assistant|ToolResult(?:: .+)?)\s*$/;

  const turns: JsonlTurn[] = [];
  let turnIndex = -1;
  let currentRole: 'user' | 'assistant' | 'tool' = 'user';
  let currentProvenance: 'organic' | 'tool_result' = 'organic';
  let currentLines: string[] = [];
  let currentTimestamp = 0;

  const flushTurn = () => {
    if (turnIndex < 0) return;
    const rawBody = currentLines.join('\n').trim();
    if (!rawBody) return;
    turns.push({
      session_id: sessionId,
      project_id: projectId,
      turn_index: turnIndex,
      role: currentRole,
      body: rawBody,
      created_at_epoch_ms: currentTimestamp || Date.now(),
      provenance: currentProvenance,
    });
  };

  for (const line of lines) {
    const headerMatch = line.match(TURN_HEADER);
    if (headerMatch) {
      flushTurn();
      turnIndex++;
      const headerKind = headerMatch[1];
      if (headerKind === 'User') {
        currentRole = 'user';
        currentProvenance = 'organic';
      } else if (headerKind === 'Assistant') {
        currentRole = 'assistant';
        currentProvenance = 'organic';
      } else {
        // ToolResult or ToolResult: <name>
        currentRole = 'tool';
        currentProvenance = 'tool_result';
      }
      currentLines = [];
      currentTimestamp = 0;
      continue;
    }

    // Timestamp line: _2026-05-14T00:55:14+02:00_
    if (turnIndex >= 0 && currentTimestamp === 0 && /^_\d{4}-\d{2}-\d{2}T/.test(line)) {
      const tsStr = line.replace(/^_/, '').replace(/_$/, '');
      const parsed = new Date(tsStr).getTime();
      if (!Number.isNaN(parsed)) currentTimestamp = parsed;
      continue;
    }

    if (turnIndex >= 0) {
      currentLines.push(line);
    }
  }
  flushTurn();

  return chunkTranscript(turns);
}

function extractSessionId(filename: string): string | null {
  const match = filename.match(/^\d{4}-\d{2}-\d{2}_(.+)\.md$/);
  return match?.[1] ?? null;
}

function getLastIndexedMtime(db: Database, filePath: string): number {
  try {
    const row = cachedPrepare(db,
      `SELECT last_indexed_mtime_ms FROM sessions_index_cursor WHERE file_path = ?`
    ).get(filePath) as { last_indexed_mtime_ms: number } | undefined;
    return row?.last_indexed_mtime_ms ?? 0;
  } catch {
    return 0;
  }
}

function setLastIndexedMtime(db: Database, filePath: string, mtimeMs: number): void {
  try {
    cachedPrepare(db, `
      INSERT INTO sessions_index_cursor (file_path, last_indexed_mtime_ms)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET last_indexed_mtime_ms = excluded.last_indexed_mtime_ms
    `).run(filePath, mtimeMs);
  } catch { /* non-throwing — cursor is an optimization */ }
}

/** Test helper: clear the in-memory mtime cache so tests can re-run scans cleanly. */
export function _resetMtimeCacheForTest(): void {
  mtimeCache.clear();
}
