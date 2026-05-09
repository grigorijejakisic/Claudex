/**
 * Phase 11 — production-shape WIR test (POLISH-05 + POLISH-06).
 *
 * Runs the EXPORTED production functions (upsertChunk + ingestSession +
 * routeFromArtifact) against the committed sanitized production-shape fixture
 * at `.planning/fixtures/production-shape-v32.db`. NEVER mocks production
 * modules. Network seams (Ollama embed) are unmocked since the fixture's vec0
 * tables are empty — routing returns `bi_encoder_only=true` with rank_score=0
 * spans, which the assertions accommodate.
 *
 * Three load-bearing assertions:
 *   (1) upsertChunk runs against production-shape DB and is idempotent
 *       (re-upserting the same key with a different body rewrites the body —
 *       POLISH-03 Finding #1 closure)
 *   (2) ingestSession returns errors=-1 + transcript_ingest_missing_file
 *       telemetry when the JSONL path doesn't exist (POLISH-03 Finding #4
 *       closure)
 *   (3) routeFromArtifact returns a non-throwing well-shaped result
 *       (Plan 10-01 contract preserved against production-shape DB)
 *
 * The fixture is built by `scripts/build-production-shape-snapshot.cjs` —
 * default mode is FRESH-V32 (small, git-committable, ~800 KB); pass
 * `--from-live-db` to copy + sanitize a real local DB (large, NOT committed).
 *
 * Failing this test BLOCKS SHIP at Phase 11 close-out per CONTEXT § Methodology
 * gates promoted from Phase 11 (#1: production-shape integration tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import { ingestSession } from '../../ingestion/ingest-session.js';
import { routeFromArtifact } from '../../retrieval/transcript-routing.js';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.planning',
  'fixtures',
  'production-shape-v32.db',
);

describe('Phase 11 — production-shape WIR test', () => {
  let workingPath: string;
  let db: Database.Database;

  beforeAll(() => {
    if (!fs.existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Production-shape fixture not found at ${FIXTURE_PATH}. ` +
        `Run \`bun run snapshot:build\` to create it.`,
      );
    }
    // Copy the fixture to a writable tmp path — tests must NOT mutate the
    // committed fixture.
    workingPath = path.join(
      os.tmpdir(),
      `wir-p11-${Date.now()}-${Math.random()}.db`,
    );
    fs.copyFileSync(FIXTURE_PATH, workingPath);
    db = new Database(workingPath);
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.unlinkSync(workingPath); } catch {}
  });

  it('(1) upsertChunk runs against production-shape DB and is idempotent on re-upsert with different body (POLISH-03 Finding #1)', () => {
    const sessionId = 'wir-p11-upsert';
    const chunk = {
      session_id: sessionId,
      project_id: 'wir-p11-project',
      turn_index: 0,
      sub_index: 0,
      role: 'user' as const,
      provenance: 'organic' as const,
      body: 'first body',
      created_at_epoch_ms: Date.now(),
      wrapper_redacted: false,
    };
    upsertChunk(db, chunk);
    upsertChunk(db, { ...chunk, body: 'second body' });
    const row = db.prepare(
      `SELECT body FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { body: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.body).toBe('second body'); // ON CONFLICT DO UPDATE worked
  });

  it('(2) ingestSession returns errors=-1 + telemetry for missing JSONL against production-shape DB (POLISH-03 Finding #4)', async () => {
    const sessionId = 'wir-p11-missing';
    const r = await ingestSession(
      db,
      sessionId,
      'wir-p11-project',
      '/this/path/definitely/does/not/exist.jsonl',
    );
    expect(r.errors).toBe(-1);
    expect(r.chunksWritten).toBe(0);
    expect(r.embeddingsWritten).toBe(0);

    const tel = db.prepare(
      `SELECT COUNT(*) AS n FROM session_events
       WHERE session_id = ? AND event_type = 'transcript_ingest_missing_file'`,
    ).get(sessionId) as { n: number };
    expect(tel.n).toBeGreaterThanOrEqual(1);
  });

  it('(3) routeFromArtifact returns a non-throwing well-shaped result against production-shape DB', async () => {
    // Use the seed session committed in the FRESH-mode fixture.
    const sessionId = 'wir-fixture-session';
    const sessionRow = db.prepare(
      `SELECT MIN(created_at_epoch_ms) AS ts FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { ts: number | null };

    let threw = false;
    let result: Awaited<ReturnType<typeof routeFromArtifact>> | null = null;
    try {
      result = await routeFromArtifact(db, {
        session_id: sessionId,
        created_at_epoch_ms: sessionRow.ts ?? Date.now(),
        query_text: 'production-shape probe',
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.spans).toBeInstanceOf(Array);
    expect(typeof result!.bi_encoder_only).toBe('boolean');
    expect(typeof result!.candidate_count).toBe('number');
    // Either Ollama is absent (bi_encoder_only=true, all rank_scores=0) or
    // present (real cosines). Either way the shape contract holds.
  });
});
