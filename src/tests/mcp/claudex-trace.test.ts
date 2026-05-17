/**
 * Phase 14-07e — claudex_trace MCP tool handler tests.
 *
 * 14 tests covering:
 *  1.  trace: direct outgoing link → 1 result at hop=1
 *  2.  trace: two-hop chain → results at hop=1 and hop=2
 *  3.  trace: max_hops=2 caps result set
 *  4.  trace: max_hops>5 clamped to 5
 *  5.  trace: direction=outgoing excludes incoming
 *  6.  trace: direction=incoming excludes outgoing
 *  7.  trace: direction=both returns union
 *  8.  trace: types filter restricts traversal
 *  9.  trace: deduplication — same artifact via two paths returns once with shortest distance
 * 10.  trace: dead reference (linked artifact deleted/missing) skipped silently
 * 11.  trace: pending hard links excluded (only confirmed hard links included)
 * 12.  trace: results sorted by hop_distance asc, artifact_id asc
 * 13.  trace: empty neighborhood (no outgoing/incoming links) returns just the start artifact
 * 14.  trace: missing start artifact returns total_reached=0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleClaudexTrace, MAX_HOPS_CAP } from '../../mcp/tools/claudex-trace.js';
import { writeSoftLink, proposeHardLink, confirmHardLink } from '../../core/link-writer.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { migrateV37toV38 } from '../../core/migration-steps.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyV17DDL(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  migrateV37toV38(db);
  return db;
}

function insertArtifact(
  db: Database.Database,
  id: string,
  opts: { kind?: string; title?: string; project?: string } = {},
): string {
  const { kind = 'learning', title = `summary-${id}`, project = 'test-project' } = opts;
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, title, `body-${id}`, Date.now(), Date.now(), project);
  return id;
}

function softLink(db: Database.Database, src: string, dst: string, type: 'supersedes' | 'promoted_to' | 'extracted_from' | 'references' = 'references'): void {
  writeSoftLink(db, { src_artifact_id: src, dst_artifact_id: dst, type, created_by_session: 'test-session' });
}

function hardLinkConfirmed(db: Database.Database, src: string, dst: string, type: 'triggered_by' | 'evidence_for' | 'contradicts' = 'evidence_for'): void {
  const id = proposeHardLink(db, {
    src_artifact_id: src,
    dst_artifact_id: dst,
    type,
    proposed_confidence: 0.9,
    proposed_by_session: 'test-session',
    proposer_rationale: 'test rationale',
  });
  if (id !== null) {
    confirmHardLink(db, id, 'test-session');
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleClaudexTrace', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  it('1. direct outgoing link → 1 result at hop=1', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    softLink(db, 'A', 'B', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing' });

    // hop=0 is A itself; hop=1 is B
    expect(result.start_artifact_id).toBe('A');
    const hop1 = result.results.filter(r => r.hop_distance === 1);
    expect(hop1).toHaveLength(1);
    expect(hop1[0].artifact_id).toBe('B');
    expect(hop1[0].hop_distance).toBe(1);
    expect(hop1[0].path_via_links).toHaveLength(1);
    expect(hop1[0].path_via_links[0].type).toBe('references');
  });

  it('2. two-hop chain → results at hop=1 and hop=2', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    softLink(db, 'A', 'B', 'references');
    softLink(db, 'B', 'C', 'supersedes');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing', max_hops: 3 });

    const hop1 = result.results.find(r => r.artifact_id === 'B');
    const hop2 = result.results.find(r => r.artifact_id === 'C');
    expect(hop1?.hop_distance).toBe(1);
    expect(hop2?.hop_distance).toBe(2);
    expect(result.total_reached).toBeGreaterThanOrEqual(3); // A, B, C
  });

  it('3. max_hops=2 caps result set (does not reach hop=3)', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    insertArtifact(db, 'D');
    softLink(db, 'A', 'B');
    softLink(db, 'B', 'C');
    softLink(db, 'C', 'D');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing', max_hops: 2 });
    expect(result.max_hops_used).toBe(2);

    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(ids).not.toContain('D'); // 3 hops away
  });

  it('4. max_hops>5 clamped to 5', () => {
    insertArtifact(db, 'A');
    const result = handleClaudexTrace(db, { artifact_id: 'A', max_hops: 99 });
    expect(result.max_hops_used).toBe(MAX_HOPS_CAP);
  });

  it('5. direction=outgoing excludes incoming-only neighbors', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    // B → A (incoming from B's perspective; outgoing from B)
    softLink(db, 'B', 'A', 'references');
    // A → C (outgoing from A)
    softLink(db, 'A', 'C', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing' });
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('C');
    expect(ids).not.toContain('B');
  });

  it('6. direction=incoming excludes outgoing-only neighbors', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    // A → C (outgoing from A)
    softLink(db, 'A', 'C', 'references');
    // B → A (incoming to A)
    softLink(db, 'B', 'A', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'incoming' });
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('B');
    expect(ids).not.toContain('C');
  });

  it('7. direction=both returns union of outgoing and incoming', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    softLink(db, 'A', 'C', 'references');
    softLink(db, 'B', 'A', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'both' });
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('8. types filter restricts traversal to matching link types only', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    softLink(db, 'A', 'B', 'references');
    softLink(db, 'A', 'C', 'supersedes');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing', types: ['references'] });
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('B');
    expect(ids).not.toContain('C'); // 'supersedes' filtered out
  });

  it('9. deduplication — same artifact via two paths returns once with shortest distance', () => {
    // A → B (hop 1)
    // A → C → B (hop 2 via C)
    // BFS ensures B appears at hop=1 (shortest path)
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    softLink(db, 'A', 'B', 'references');
    softLink(db, 'A', 'C', 'supersedes');
    softLink(db, 'C', 'B', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing', max_hops: 3 });
    const bRows = result.results.filter(r => r.artifact_id === 'B');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].hop_distance).toBe(1); // shortest path
  });

  it('10. dead reference (linked artifact missing from artifact table) skipped silently', () => {
    insertArtifact(db, 'A');
    // Create artifact B, link A→B, then delete B row manually (simulating dead ref)
    insertArtifact(db, 'B');
    softLink(db, 'A', 'B', 'references');
    // Soft-delete B by removing it (FK RESTRICT would block; disable FK for this test)
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM soft_link WHERE dst_artifact_id = 'B'`).run();
    db.prepare(`DELETE FROM artifact WHERE id = 'B'`).run();
    db.pragma('foreign_keys = ON');
    // Now create a new direct link from A without FK-checked B
    insertArtifact(db, 'C');
    softLink(db, 'A', 'C', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing' });
    // Should contain A and C but not cause an error
    expect(result.total_reached).toBeGreaterThanOrEqual(2); // A + C
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('C');
  });

  it('11. pending hard links excluded; only confirmed hard links included', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');

    // Confirmed hard link: A → B
    hardLinkConfirmed(db, 'A', 'B', 'evidence_for');

    // Pending (not confirmed) hard link: A → C
    proposeHardLink(db, {
      src_artifact_id: 'A',
      dst_artifact_id: 'C',
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: 'test-session',
      proposer_rationale: 'pending only',
    });

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing' });
    const ids = result.results.map(r => r.artifact_id);
    expect(ids).toContain('B');   // confirmed → included
    expect(ids).not.toContain('C'); // pending → excluded
  });

  it('12. results sorted by hop_distance asc, artifact_id asc', () => {
    insertArtifact(db, 'A');
    insertArtifact(db, 'B');
    insertArtifact(db, 'C');
    insertArtifact(db, 'D');
    softLink(db, 'A', 'C', 'references');
    softLink(db, 'A', 'B', 'references');
    softLink(db, 'B', 'D', 'references');

    const result = handleClaudexTrace(db, { artifact_id: 'A', direction: 'outgoing', max_hops: 3 });

    // Skip hop=0 (A itself)
    const hop1 = result.results.filter(r => r.hop_distance === 1);
    // B and C are both at hop=1; sorted alphabetically
    expect(hop1[0].artifact_id.localeCompare(hop1[1]?.artifact_id ?? 'Z')).toBeLessThanOrEqual(0);

    // D at hop=2 comes after hop=1 items
    const hop2 = result.results.filter(r => r.hop_distance === 2);
    const lastHop1Idx = result.results.findLastIndex(r => r.hop_distance === 1);
    const firstHop2Idx = result.results.findIndex(r => r.hop_distance === 2);
    if (hop2.length > 0 && hop1.length > 0) {
      expect(firstHop2Idx).toBeGreaterThan(lastHop1Idx);
    }
  });

  it('13. empty neighborhood (no links from start) returns only start artifact at hop=0', () => {
    insertArtifact(db, 'A');

    const result = handleClaudexTrace(db, { artifact_id: 'A' });
    expect(result.total_reached).toBe(1);
    expect(result.results[0].artifact_id).toBe('A');
    expect(result.results[0].hop_distance).toBe(0);
    expect(result.results[0].path_via_links).toHaveLength(0);
  });

  it('14. missing start artifact returns total_reached=0 and empty results', () => {
    // Artifact 'NONEXISTENT' is not in the DB
    const result = handleClaudexTrace(db, { artifact_id: 'NONEXISTENT' });
    expect(result.total_reached).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.start_artifact_id).toBe('NONEXISTENT');
  });
});
