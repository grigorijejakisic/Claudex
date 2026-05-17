/**
 * Phase 14-07g — Provenance walker tests.
 *
 * 14 cases:
 *  1.  walkProvenance: empty graph → chain length 1 (just start)
 *  2.  walkProvenance: single incoming soft link → chain length 2
 *  3.  walkProvenance: 4-hop chain → chain length 5
 *  4.  walkProvenance: max_hops=2 → chain length 3
 *  5.  walkProvenance: max_hops > MAX_PROVENANCE_HOPS → clamped to 4
 *  6.  walkProvenance: cycle detected, no infinite loop, telemetry emitted
 *  7.  walkProvenance: 'contradicts' link not traversed
 *  8.  walkProvenance: 'extracted_from' soft link traversed
 *  9.  walkProvenance: 'triggered_by' confirmed hard link traversed
 * 10.  walkProvenance: 'triggered_by' pending hard link NOT traversed
 * 11.  walkProvenance: chain sorted by hop_distance ASC, created_at_epoch_ms DESC
 * 12.  walkProvenance: dead reference (artifact deleted) skipped silently
 * 13.  walkProvenance: missing start artifact → total_reached=0
 * 14.  walkProvenance: multiple incoming links at same hop → all included
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/test-db.js';
import {
  walkProvenance,
  MAX_PROVENANCE_HOPS,
  type ProvenanceChainEntry,
} from '../../intelligence/provenance-walker.js';
import {
  writeSoftLink,
  proposeHardLink,
  confirmHardLink,
} from '../../core/link-writer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DB = Database.Database;

/** Insert a minimal artifact row. Returns the id. */
function insertArtifact(
  db: DB,
  id: string,
  opts: {
    kind?: string;
    title?: string;
    body?: string;
    project?: string;
    created_at_epoch_ms?: number;
  } = {},
): string {
  const {
    kind = 'observation',
    title = null,
    body = `body of ${id}`,
    project = 'test-project',
    created_at_epoch_ms = Date.now(),
  } = opts;
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, title, body, created_at_epoch_ms, created_at_epoch_ms, project);
  return id;
}

/** Write a confirmed hard link (src → dst, type). Returns the link id. */
function writeConfirmedHardLink(
  db: DB,
  src: string,
  dst: string,
  type: 'triggered_by' | 'evidence_for' | 'contradicts',
  session = 'sess-confirm',
): number {
  const proposer = 'sess-propose';
  const id = proposeHardLink(db, {
    src_artifact_id: src,
    dst_artifact_id: dst,
    type,
    proposed_confidence: 0.9,
    proposed_by_session: proposer,
    proposer_rationale: 'test',
  })!;
  confirmHardLink(db, id, session);
  return id;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: DB;

beforeEach(() => {
  db = createTestDb();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('walkProvenance', () => {
  it('1. empty graph → chain length 1 (just start)', () => {
    insertArtifact(db, 'a1');
    const result = walkProvenance({ db, start_artifact_id: 'a1', session_id: 'sess-1' });
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0].artifact_id).toBe('a1');
    expect(result.chain[0].hop_distance).toBe(0);
    expect(result.chain[0].via_link_type).toBeNull();
    expect(result.total_reached).toBe(1);
    expect(result.cycle_detected).toBe(false);
  });

  it('2. single incoming soft link → chain length 2', () => {
    insertArtifact(db, 'decision-1', { kind: 'decision' });
    insertArtifact(db, 'obs-1', { kind: 'observation' });
    // obs-1 → decision-1 via 'extracted_from' (obs-1 is upstream of decision-1)
    writeSoftLink(db, {
      src_artifact_id: 'obs-1',
      dst_artifact_id: 'decision-1',
      type: 'extracted_from',
      created_by_session: 'sess-1',
    });

    const result = walkProvenance({ db, start_artifact_id: 'decision-1', session_id: 'sess-1' });
    expect(result.chain).toHaveLength(2);
    expect(result.chain[0].artifact_id).toBe('decision-1');
    expect(result.chain[1].artifact_id).toBe('obs-1');
    expect(result.chain[1].hop_distance).toBe(1);
    expect(result.chain[1].via_link_type).toBe('extracted_from');
    expect(result.cycle_detected).toBe(false);
  });

  it('3. 4-hop chain → chain length 5', () => {
    // d0 ← d1 ← d2 ← d3 ← d4 (each extracted_from the next)
    for (let i = 0; i <= 4; i++) {
      insertArtifact(db, `node-${i}`, { kind: 'observation' });
    }
    // links: node-1 → node-0 (node-1 is upstream of node-0)
    // node-2 → node-1, etc.
    for (let i = 1; i <= 4; i++) {
      writeSoftLink(db, {
        src_artifact_id: `node-${i}`,
        dst_artifact_id: `node-${i - 1}`,
        type: 'extracted_from',
        created_by_session: 'sess-1',
      });
    }

    const result = walkProvenance({ db, start_artifact_id: 'node-0', session_id: 'sess-1' });
    expect(result.chain).toHaveLength(5); // node-0 through node-4
    expect(result.chain.map(e => e.hop_distance)).toEqual([0, 1, 2, 3, 4]);
    expect(result.cycle_detected).toBe(false);
  });

  it('4. max_hops=2 → chain length 3', () => {
    for (let i = 0; i <= 4; i++) {
      insertArtifact(db, `deep-${i}`, { kind: 'observation' });
    }
    for (let i = 1; i <= 4; i++) {
      writeSoftLink(db, {
        src_artifact_id: `deep-${i}`,
        dst_artifact_id: `deep-${i - 1}`,
        type: 'extracted_from',
        created_by_session: 'sess-1',
      });
    }

    const result = walkProvenance({
      db,
      start_artifact_id: 'deep-0',
      session_id: 'sess-1',
      max_hops: 2,
    });
    // Should have: deep-0 (hop 0), deep-1 (hop 1), deep-2 (hop 2)
    expect(result.chain).toHaveLength(3);
    expect(result.chain.map(e => e.hop_distance)).toEqual([0, 1, 2]);
  });

  it('5. max_hops > MAX_PROVENANCE_HOPS → clamped to 4', () => {
    // Build a 6-hop chain; with clamp at 4, only 5 entries should appear.
    for (let i = 0; i <= 6; i++) {
      insertArtifact(db, `chain-${i}`, { kind: 'observation' });
    }
    for (let i = 1; i <= 6; i++) {
      writeSoftLink(db, {
        src_artifact_id: `chain-${i}`,
        dst_artifact_id: `chain-${i - 1}`,
        type: 'references',
        created_by_session: 'sess-1',
      });
    }

    const result = walkProvenance({
      db,
      start_artifact_id: 'chain-0',
      session_id: 'sess-1',
      max_hops: 999, // Way above MAX
    });
    // MAX_PROVENANCE_HOPS = 4, so we should see hops 0..4 = 5 entries
    expect(result.chain).toHaveLength(5);
    const maxHop = Math.max(...result.chain.map(e => e.hop_distance));
    expect(maxHop).toBe(MAX_PROVENANCE_HOPS);
  });

  it('6. cycle detected, no infinite loop, cycle_detected=true', () => {
    // A → B → A (cycle via extracted_from): walker must not loop
    insertArtifact(db, 'cycle-a');
    insertArtifact(db, 'cycle-b');

    // cycle-b is upstream of cycle-a
    writeSoftLink(db, {
      src_artifact_id: 'cycle-b',
      dst_artifact_id: 'cycle-a',
      type: 'extracted_from',
      created_by_session: 'sess-1',
    });
    // cycle-a is upstream of cycle-b (creates a cycle)
    writeSoftLink(db, {
      src_artifact_id: 'cycle-a',
      dst_artifact_id: 'cycle-b',
      type: 'extracted_from',
      created_by_session: 'sess-1',
    });

    // Should terminate without hanging
    const result = walkProvenance({ db, start_artifact_id: 'cycle-a', session_id: 'sess-cycle' });
    expect(result.cycle_detected).toBe(true);
    // cycle-a (hop 0) + cycle-b (hop 1); cycle-a revisit skipped
    expect(result.chain).toHaveLength(2);
    expect(result.chain.map(e => e.artifact_id)).toContain('cycle-a');
    expect(result.chain.map(e => e.artifact_id)).toContain('cycle-b');
  });

  it('7. contradicts hard link not traversed', () => {
    insertArtifact(db, 'dec-x', { kind: 'decision' });
    insertArtifact(db, 'dec-y', { kind: 'decision' });

    // dec-y contradicts dec-x: should NOT be included in provenance of dec-x
    writeConfirmedHardLink(db, 'dec-y', 'dec-x', 'contradicts');

    const result = walkProvenance({ db, start_artifact_id: 'dec-x', session_id: 'sess-1' });
    // Only the start artifact itself; no upstream via contradicts
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0].artifact_id).toBe('dec-x');
  });

  it("8. 'extracted_from' soft link traversed", () => {
    insertArtifact(db, 'decision-8', { kind: 'decision' });
    insertArtifact(db, 'obs-8', { kind: 'observation' });

    writeSoftLink(db, {
      src_artifact_id: 'obs-8',
      dst_artifact_id: 'decision-8',
      type: 'extracted_from',
      created_by_session: 'sess-1',
    });

    const result = walkProvenance({ db, start_artifact_id: 'decision-8', session_id: 'sess-1' });
    const ids = result.chain.map(e => e.artifact_id);
    expect(ids).toContain('obs-8');
    const entry = result.chain.find(e => e.artifact_id === 'obs-8')!;
    expect(entry.via_link_type).toBe('extracted_from');
    expect(entry.hop_distance).toBe(1);
  });

  it("9. 'triggered_by' confirmed hard link traversed", () => {
    insertArtifact(db, 'decision-9', { kind: 'decision' });
    insertArtifact(db, 'obs-trigger-9', { kind: 'observation' });

    // obs-trigger-9 triggered decision-9 (incoming to decision-9)
    writeConfirmedHardLink(db, 'obs-trigger-9', 'decision-9', 'triggered_by');

    const result = walkProvenance({ db, start_artifact_id: 'decision-9', session_id: 'sess-1' });
    const ids = result.chain.map(e => e.artifact_id);
    expect(ids).toContain('obs-trigger-9');
    const entry = result.chain.find(e => e.artifact_id === 'obs-trigger-9')!;
    expect(entry.via_link_type).toBe('triggered_by');
  });

  it("10. 'triggered_by' pending hard link NOT traversed", () => {
    insertArtifact(db, 'decision-10', { kind: 'decision' });
    insertArtifact(db, 'obs-pending-10', { kind: 'observation' });

    // Propose but do NOT confirm: remains PENDING
    proposeHardLink(db, {
      src_artifact_id: 'obs-pending-10',
      dst_artifact_id: 'decision-10',
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: 'sess-propose',
      proposer_rationale: 'pending test',
    });

    const result = walkProvenance({ db, start_artifact_id: 'decision-10', session_id: 'sess-1' });
    // Pending link should NOT be included — only confirmed hard links count.
    const ids = result.chain.map(e => e.artifact_id);
    expect(ids).not.toContain('obs-pending-10');
    expect(result.chain).toHaveLength(1);
  });

  it('11. chain sorted by hop_distance ASC, created_at_epoch_ms DESC tiebreaker', () => {
    const now = Date.now();
    insertArtifact(db, 'hub', { kind: 'decision', created_at_epoch_ms: now });
    // Two artifacts at hop 1: newer and older
    insertArtifact(db, 'upstream-newer', { kind: 'observation', created_at_epoch_ms: now - 1000 });
    insertArtifact(db, 'upstream-older', { kind: 'observation', created_at_epoch_ms: now - 5000 });
    // A hop-2 artifact
    insertArtifact(db, 'upstream-hop2', { kind: 'observation', created_at_epoch_ms: now - 2000 });

    // Both upstream-newer and upstream-older point to hub (hop 1)
    writeSoftLink(db, { src_artifact_id: 'upstream-newer', dst_artifact_id: 'hub', type: 'references', created_by_session: 'sess-1' });
    writeSoftLink(db, { src_artifact_id: 'upstream-older', dst_artifact_id: 'hub', type: 'extracted_from', created_by_session: 'sess-1' });
    // upstream-hop2 points to upstream-newer (hop 2)
    writeSoftLink(db, { src_artifact_id: 'upstream-hop2', dst_artifact_id: 'upstream-newer', type: 'references', created_by_session: 'sess-1' });

    const result = walkProvenance({ db, start_artifact_id: 'hub', session_id: 'sess-1' });

    // Verify ordering: hop 0 < hop 1 < hop 2, and within hop 1, newer > older (DESC)
    expect(result.chain[0].artifact_id).toBe('hub');       // hop 0
    // hop 1: upstream-newer (newer timestamp) should come before upstream-older
    const hop1 = result.chain.filter(e => e.hop_distance === 1);
    expect(hop1).toHaveLength(2);
    expect(hop1[0].created_at_epoch_ms).toBeGreaterThan(hop1[1].created_at_epoch_ms);
    // hop 2: upstream-hop2
    const hop2 = result.chain.filter(e => e.hop_distance === 2);
    expect(hop2).toHaveLength(1);
    expect(hop2[0].artifact_id).toBe('upstream-hop2');
  });

  it('12. dead reference (artifact deleted) skipped silently', () => {
    insertArtifact(db, 'decision-12', { kind: 'decision' });
    insertArtifact(db, 'ghost', { kind: 'observation' });

    writeSoftLink(db, {
      src_artifact_id: 'ghost',
      dst_artifact_id: 'decision-12',
      type: 'extracted_from',
      created_by_session: 'sess-1',
    });

    // Delete the upstream artifact (dead reference)
    db.prepare(`DELETE FROM artifact WHERE id = ?`).run('ghost');

    // Walker should silently skip the deleted artifact
    const result = walkProvenance({ db, start_artifact_id: 'decision-12', session_id: 'sess-1' });
    const ids = result.chain.map(e => e.artifact_id);
    expect(ids).not.toContain('ghost');
    expect(result.chain).toHaveLength(1);
  });

  it('13. missing start artifact → total_reached=0', () => {
    const result = walkProvenance({
      db,
      start_artifact_id: 'does-not-exist',
      session_id: 'sess-1',
    });
    expect(result.chain).toHaveLength(0);
    expect(result.total_reached).toBe(0);
    expect(result.cycle_detected).toBe(false);
  });

  it('14. multiple incoming links at same hop → all included', () => {
    insertArtifact(db, 'center', { kind: 'decision' });
    const upstreamIds = ['up-a', 'up-b', 'up-c'];
    for (const id of upstreamIds) {
      insertArtifact(db, id, { kind: 'observation' });
      writeSoftLink(db, {
        src_artifact_id: id,
        dst_artifact_id: 'center',
        type: 'references',
        created_by_session: 'sess-1',
      });
    }

    const result = walkProvenance({ db, start_artifact_id: 'center', session_id: 'sess-1' });
    // Should have center (hop 0) + 3 upstream (hop 1)
    expect(result.chain).toHaveLength(4);
    const hop1Ids = result.chain.filter(e => e.hop_distance === 1).map(e => e.artifact_id);
    for (const id of upstreamIds) {
      expect(hop1Ids).toContain(id);
    }
  });
});
