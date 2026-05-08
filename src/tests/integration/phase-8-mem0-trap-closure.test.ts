/**
 * Phase 8 plan 08-05 — Mem0-trap closure at the v6 transcript-chunk
 * write surface.
 *
 * Round-trips a synthetic turn body containing every wrapper tag in
 * KNOWN_WRAPPER_TAGS through chunkTranscript + upsertChunk, then SELECTs
 * the persisted body and asserts no wrapper substring survived.
 *
 * Pairs with V28's BEFORE-INSERT trigger on experience_patterns (Phase 4)
 * and V31's view-mode learnings.provenance enum (Phase 7) — three
 * structural closures across three write surfaces.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { chunkTranscript } from '../../ingestion/transcript-chunker-v6.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import { KNOWN_WRAPPER_TAGS } from '../../extraction/wrapper-parser.js';

describe('Mem0-trap closure — wrapper redaction at the v6 transcript-chunk write surface', () => {
  it('strips every KNOWN_WRAPPER_TAGS variant from the persisted chunk body', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const wrapperBlocks = KNOWN_WRAPPER_TAGS.map(
      tag => `<${tag}>Sensitive ${tag} content that must not persist.</${tag}>`,
    );
    const turnBody = [
      'Pre-wrapper organic content.',
      ...wrapperBlocks,
      'Post-wrapper organic content.',
    ].join('\n\n');

    const turn = {
      session_id: 'sess-mem0',
      project_id: 'test-project',
      turn_index: 0,
      role: 'user' as const,
      body: turnBody,
      created_at_epoch_ms: 1700000000000,
      provenance: 'organic' as const,
    };

    const chunks = chunkTranscript([turn]);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].wrapper_redacted).toBe(true);

    for (const chunk of chunks) {
      upsertChunk(db, chunk);
    }

    const persistedRows = db.prepare(
      `SELECT body FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).all('sess-mem0') as Array<{ body: string }>;

    expect(persistedRows.length).toBeGreaterThanOrEqual(1);
    for (const row of persistedRows) {
      for (const tag of KNOWN_WRAPPER_TAGS) {
        expect(row.body).not.toContain(`<${tag}>`);
        expect(row.body).not.toContain(`</${tag}>`);
        expect(row.body).not.toContain(`Sensitive ${tag} content`);
      }
      expect(row.body).toContain('organic content');
    }

    db.close();
  });

  it('flags wrapper_redacted=false when no wrapper blocks present', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const turn = {
      session_id: 'sess-clean',
      project_id: 'test-project',
      turn_index: 0,
      role: 'assistant' as const,
      body: 'A clean assistant turn with no wrapper blocks.',
      created_at_epoch_ms: 1700000000000,
      provenance: 'organic' as const,
    };
    const chunks = chunkTranscript([turn]);
    expect(chunks[0].wrapper_redacted).toBe(false);
    upsertChunk(db, chunks[0]);

    const row = db.prepare(
      `SELECT wrapper_redacted FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get('sess-clean') as { wrapper_redacted: number };
    expect(row.wrapper_redacted).toBe(0);
    db.close();
  });

  it('persists wrapper_redacted=true through the round-trip when ANY wrapper present', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const turn = {
      session_id: 'sess-flag',
      project_id: 'test-project',
      turn_index: 0,
      role: 'user' as const,
      body: 'Outer. <system-reminder>injected payload</system-reminder> More.',
      created_at_epoch_ms: 1700000000000,
      provenance: 'organic' as const,
    };
    const chunks = chunkTranscript([turn]);
    upsertChunk(db, chunks[0]);

    const row = db.prepare(
      `SELECT wrapper_redacted, body FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get('sess-flag') as { wrapper_redacted: number; body: string };
    expect(row.wrapper_redacted).toBe(1);
    expect(row.body).not.toContain('<system-reminder>');
    expect(row.body).not.toContain('injected payload');
    db.close();
  });
});
