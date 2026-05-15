/**
 * Phase 8 plan 08-03 end-to-end integration test.
 *
 * Asserts the full pipe: clean_endsession close-marker → enqueueSessionIngestion
 * row in session_events → Angel heartbeat consumes the queue → chunks land in
 * transcript_chunk_v6 → vec0 inserts attempted (vec0 may silently no-op in test
 * env without sqlite-vec; metadata path always lands).
 *
 * Hook safety guard: `session-end.ts` does not import any LLM/embedding/HTTP
 * surface — verified via grep against the source file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initializeSchema } from '../../core/migrations.js';
import {
  enqueueSessionIngestion,
  ingestSession,
} from '../../ingestion/ingest-session.js';
import { emitCleanEndsessionClose } from '../../adapters/cc-hooks/session-end-close-marker.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { DEFAULT_ANGEL_CONFIG } from '../../angel/types.js';
import { createSession } from '../../core/sessions.js';

class MockEmbeddingProvider extends EmbeddingProvider {
  constructor() { super(); }
  async isAvailable(): Promise<boolean> { return true; }
  async embed(_text: string): Promise<number[] | null> {
    return Array.from({ length: 1024 }, (_, i) => (i % 5) * 0.001);
  }
}

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-int-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeFakeJsonl(turnCount: number, project: string, sessionId: string): string {
  const projectsRoot = path.join(tmpHome, '.claude', 'projects', project);
  fs.mkdirSync(projectsRoot, { recursive: true });
  const file = path.join(projectsRoot, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({
      type: role,
      message: { content: `${role} turn ${i}.` },
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('Phase 8 ingestion hook — end-to-end', () => {
  it('emitCleanEndsessionClose + enqueueSessionIngestion + ingestSession lands chunks', async () => {
    const project = 'p1';
    const sessionId = 's-1';
    const jsonlPath = writeFakeJsonl(5, project, sessionId);

    // 1. Seed session row so emitCleanEndsessionClose's UPDATE has a target.
    createSession(db, { session_id: sessionId, project, cwd: '/tmp', source: 'test' });

    // 2. Emit the clean_endsession close marker (mirrors the hook's call site).
    emitCleanEndsessionClose(db, sessionId, project);

    // 3. Enqueue ingestion (mirrors the hook's call site).
    enqueueSessionIngestion(db, sessionId, project, jsonlPath);

    // 4. Verify queue row landed.
    const pendingBefore = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM session_events
        WHERE session_id = ? AND event_type = 'transcript_ingestion_pending'`
    ).get(sessionId) as { cnt: number }).cnt;
    expect(pendingBefore).toBe(1);

    // 5. Drain manually (Angel heartbeat tick test path uses real heartbeatTick;
    //    here we drive ingestSession directly to keep the test focused on
    //    the substrate layer rather than the heartbeat orchestrator).
    const r = await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    expect(r.chunksWritten).toBe(5);

    // 6. Confirm chunks in transcript_chunk_v6.
    const chunkRows = db.prepare(
      `SELECT turn_index, role, body FROM transcript_chunk_v6
        WHERE session_id = ? ORDER BY turn_index`
    ).all(sessionId) as Array<{ turn_index: number; role: string; body: string }>;
    expect(chunkRows.length).toBe(5);
    expect(chunkRows[0].role).toBe('user');
    expect(chunkRows[1].role).toBe('assistant');
  });

  it('idempotent re-drain: running ingestSession twice never duplicates rows', async () => {
    const project = 'p2';
    const sessionId = 's-2';
    const jsonlPath = writeFakeJsonl(3, project, sessionId);
    createSession(db, { session_id: sessionId, project, cwd: '/tmp', source: 'test' });
    emitCleanEndsessionClose(db, sessionId, project);

    await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    const before = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get(sessionId) as { cnt: number }).cnt;
    expect(before).toBe(3);

    await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    const after = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get(sessionId) as { cnt: number }).cnt;
    expect(after).toBe(3);
  });

  it('hook safety: session-end.ts has no LLM/embedding/HTTP imports', () => {
    const sessionEndSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'adapters', 'cc-hooks', 'session-end.ts'),
      'utf8',
    );
    // The hook only enqueues — never touches embedding/LLM surfaces.
    expect(sessionEndSrc).not.toMatch(/EmbeddingProvider/);
    expect(sessionEndSrc).not.toMatch(/callLocalLLM/);
    expect(sessionEndSrc).not.toMatch(/fetchJsonWithTimeout/);
  });

  it('heartbeat drain — drives the queue end-to-end via heartbeatTick', async () => {
    // Mock the curator + chunker imports so heartbeat doesn't try to do
    // memory_curation work in an env without Ollama.
    const mockCallLocalLLM = vi.fn(async () => JSON.stringify({ segments: [] }));
    vi.doMock('../../angel/llama-client.js', async () => {
      const actual = await vi.importActual<typeof import('../../angel/llama-client.js')>(
        '../../angel/llama-client.js',
      );
      return { ...actual, callLocalLLM: mockCallLocalLLM };
    });

    const { heartbeatTick } = await import('../../angel/heartbeat.js');

    const project = 'p3';
    const sessionId = 's-3';
    const jsonlPath = writeFakeJsonl(4, project, sessionId);
    createSession(db, { session_id: sessionId, project, cwd: '/tmp', source: 'test' });
    db.prepare(`UPDATE sessions SET status='completed', ended_at_epoch_ms=? WHERE session_id=?`)
      .run(Math.floor(Date.now() / 1000), sessionId);
    emitCleanEndsessionClose(db, sessionId, project);
    enqueueSessionIngestion(db, sessionId, project, jsonlPath);

    await heartbeatTick({
      db,
      config: { ...DEFAULT_ANGEL_CONFIG, heartbeatIntervalMs: 1, idleThresholdSeconds: 999999 },
    });

    // After the tick, the queue row should be marked processed and chunks
    // should be in transcript_chunk_v6 (whether or not embeddings landed —
    // Ollama is unreachable in test env, so embeddingsWritten may be 0 but
    // chunksWritten reflects the metadata-only path).
    const queueRow = db.prepare(
      `SELECT json_extract(detail, '$.processed') AS processed,
              json_extract(detail, '$.chunks_written') AS chunks_written
         FROM session_events
        WHERE session_id = ? AND event_type = 'transcript_ingestion_pending'`
    ).get(sessionId) as { processed: string | null; chunks_written: number | null };
    expect(queueRow.processed).toBeTruthy();
    expect(queueRow.chunks_written ?? 0).toBeGreaterThanOrEqual(4);

    const chunkCount = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get(sessionId) as { cnt: number }).cnt;
    expect(chunkCount).toBeGreaterThanOrEqual(4);

    // Re-tick — queue is empty, no double-ingestion.
    await heartbeatTick({
      db,
      config: { ...DEFAULT_ANGEL_CONFIG, heartbeatIntervalMs: 1, idleThresholdSeconds: 999999 },
    });
    const chunkCountAfter = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get(sessionId) as { cnt: number }).cnt;
    expect(chunkCountAfter).toBe(chunkCount);
  }, 30000);
});
