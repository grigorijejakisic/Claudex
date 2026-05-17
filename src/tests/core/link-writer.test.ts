/**
 * Phase 14-07-LINKS-SCHEMA — link-writer helper tests.
 *
 * Covers (24 tests):
 *  1. writeSoftLink: commits a soft_link row; returns new id
 *  2. writeSoftLink: duplicate (src, dst, type) returns existing id (no error)
 *  3. writeSoftLink: confidence defaults to 1.0 when not supplied
 *  4. writeSoftLink: data JSON serialized correctly
 *  5. listSoftLinks: outgoing direction filters by src
 *  6. listSoftLinks: incoming direction filters by dst
 *  7. listSoftLinks: both direction returns union
 *  8. listSoftLinks: types filter narrows the result
 *  9. proposeHardLink: creates PENDING row (confirmed_by_session IS NULL)
 * 10. proposeHardLink: returns the new row id
 * 11. proposeHardLink: history row inserted with action='proposed'
 * 12. proposeHardLink: UNIQUE blocks second insert of same (src,dst,type) — inspected by decay check first
 * 13. proposeHardLink: when getDecayCount >= DECAY_THRESHOLD, returns null
 * 14. confirmHardLink: sets confirmed_by_session + confirmed_at_epoch_ms; history row inserted
 * 15. confirmHardLink: throws on already-confirmed row
 * 16. confirmHardLink: throws on rejected row
 * 17. rejectHardLink: sets rejected_by_session + rejected_at_epoch_ms; increments decay_count; history row inserted
 * 18. rejectHardLink: throws on already-confirmed row
 * 19. decayHardLink: marks decayed state; history row inserted
 * 20. listPendingHardLinks: returns only PENDING rows (NULL confirm, NULL reject)
 * 21. listConfirmedHardLinks: returns only CONFIRMED rows
 * 22. getDecayCount: returns 0 for (src, dst, type) never rejected
 * 23. getDecayCount: returns N after N rejections via rejectHardLink
 * 24. DECAY_THRESHOLD constant === 3 (locked default)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  writeSoftLink,
  listSoftLinks,
  proposeHardLink,
  confirmHardLink,
  rejectHardLink,
  decayHardLink,
  listPendingHardLinks,
  listConfirmedHardLinks,
  getDecayCount,
  DECAY_THRESHOLD,
} from '../../core/link-writer.js';
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
  project = 'proj-alpha'
): string {
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, 'learning', 'body', Date.now(), Date.now(), project);
  return id;
}

function getHardLinkRow(
  db: Database.Database,
  id: number
): {
  confirmed_by_session: string | null;
  confirmed_at_epoch_ms: number | null;
  rejected_by_session: string | null;
  rejected_at_epoch_ms: number | null;
  decay_count: number;
} {
  return db.prepare(
    `SELECT confirmed_by_session, confirmed_at_epoch_ms, rejected_by_session, rejected_at_epoch_ms, decay_count
     FROM hard_link WHERE id = ?`
  ).get(id) as {
    confirmed_by_session: string | null;
    confirmed_at_epoch_ms: number | null;
    rejected_by_session: string | null;
    rejected_at_epoch_ms: number | null;
    decay_count: number;
  };
}

function historyRows(
  db: Database.Database,
  hard_link_id: number
): Array<{ action: string; session_id: string }> {
  return db.prepare(
    `SELECT action, session_id FROM hard_link_history WHERE hard_link_id = ? ORDER BY id`
  ).all(hard_link_id) as Array<{ action: string; session_id: string }>;
}

// ─── writeSoftLink ────────────────────────────────────────────────────────────

describe('writeSoftLink', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'sl-src-1');
    dst = insertArtifact(db, 'sl-dst-1');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-1: commits a soft_link row; returns new INTEGER id > 0', () => {
    const id = writeSoftLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'supersedes',
      created_by_session: 'sess-a',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    const row = db.prepare(`SELECT id FROM soft_link WHERE id = ?`).get(id);
    expect(row).toBeTruthy();
  });

  it('test-2: duplicate (src, dst, type) returns existing id without error', () => {
    const id1 = writeSoftLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'supersedes',
      created_by_session: 'sess-a',
    });
    const id2 = writeSoftLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'supersedes',
      created_by_session: 'sess-b', // different session — still a duplicate on (src, dst, type)
    });
    expect(id1).toBe(id2);
    // Verify only one row exists.
    const count = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM soft_link WHERE src_artifact_id = ? AND dst_artifact_id = ? AND type = 'supersedes'`
      ).get(src, dst) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('test-3: confidence defaults to 1.0 when not supplied', () => {
    const id = writeSoftLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'references',
      created_by_session: 'sess-a',
    });
    const row = db.prepare(`SELECT confidence FROM soft_link WHERE id = ?`).get(id) as { confidence: number };
    expect(row.confidence).toBe(1.0);
  });

  it('test-4: data JSON is serialized to text column correctly', () => {
    const data = { note: 'some context', count: 42 };
    const id = writeSoftLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'extracted_from',
      created_by_session: 'sess-a',
      data,
    });
    const row = db.prepare(`SELECT data FROM soft_link WHERE id = ?`).get(id) as { data: string };
    expect(JSON.parse(row.data)).toEqual(data);
  });
});

// ─── listSoftLinks ────────────────────────────────────────────────────────────

describe('listSoftLinks', () => {
  let db: Database.Database;
  let artA: string;
  let artB: string;
  let artC: string;

  beforeEach(() => {
    db = buildDb();
    artA = insertArtifact(db, 'ls-a');
    artB = insertArtifact(db, 'ls-b');
    artC = insertArtifact(db, 'ls-c');
    // A → B (supersedes), A → C (references), B → C (promoted_to)
    writeSoftLink(db, { src_artifact_id: artA, dst_artifact_id: artB, type: 'supersedes', created_by_session: 's1' });
    writeSoftLink(db, { src_artifact_id: artA, dst_artifact_id: artC, type: 'references', created_by_session: 's1' });
    writeSoftLink(db, { src_artifact_id: artB, dst_artifact_id: artC, type: 'promoted_to', created_by_session: 's1' });
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-5: outgoing direction returns rows where src = artifact_id', () => {
    const rows = listSoftLinks(db, artA, 'outgoing');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.src === artA)).toBe(true);
  });

  it('test-6: incoming direction returns rows where dst = artifact_id', () => {
    const rows = listSoftLinks(db, artC, 'incoming');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.dst === artC)).toBe(true);
  });

  it('test-7: both direction returns union of outgoing and incoming (deduplicated)', () => {
    // artB is src for (B→C) and dst for (A→B) — 2 rows total.
    const rows = listSoftLinks(db, artB, 'both');
    expect(rows).toHaveLength(2);
    const ids = new Set(rows.map(r => r.id));
    expect(ids.size).toBe(2); // no duplicates
  });

  it('test-8: types filter narrows the result', () => {
    const rows = listSoftLinks(db, artA, 'outgoing', ['supersedes']);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('supersedes');
  });
});

// ─── proposeHardLink ──────────────────────────────────────────────────────────

describe('proposeHardLink', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'hl-src-1');
    dst = insertArtifact(db, 'hl-dst-1');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-9: creates PENDING row — confirmed_by_session IS NULL', () => {
    const id = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: 'sess-p1',
      proposer_rationale: 'rationale text',
    });
    expect(id).not.toBeNull();
    const row = db.prepare(`SELECT confirmed_by_session FROM hard_link WHERE id = ?`).get(id!) as {
      confirmed_by_session: string | null;
    };
    expect(row.confirmed_by_session).toBeNull();
  });

  it('test-10: returns the new row id (positive integer)', () => {
    const id = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'evidence_for',
      proposed_confidence: 0.9,
      proposed_by_session: 'sess-p1',
      proposer_rationale: 'rationale',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('test-11: history row inserted with action=proposed', () => {
    const id = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'contradicts',
      proposed_confidence: 0.7,
      proposed_by_session: 'sess-proposer',
      proposer_rationale: 'contradiction rationale',
    });
    const hist = historyRows(db, id!);
    expect(hist).toHaveLength(1);
    expect(hist[0].action).toBe('proposed');
    expect(hist[0].session_id).toBe('sess-proposer');
  });

  it('test-12: UNIQUE constraint blocks second proposal of same (src,dst,type)', () => {
    // First proposal succeeds.
    proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: 'sess-1',
      proposer_rationale: 'first',
    });
    // Second proposal of same tuple — UNIQUE conflict (row exists, not decayed).
    expect(() => {
      proposeHardLink(db, {
        src_artifact_id: src,
        dst_artifact_id: dst,
        type: 'triggered_by',
        proposed_confidence: 0.9,
        proposed_by_session: 'sess-2',
        proposer_rationale: 'second',
      });
    }).toThrow(); // UNIQUE violation from SQLite
  });

  it('test-13: returns null when decay_count >= DECAY_THRESHOLD', () => {
    // Simulate a row with decay_count at threshold.
    db.prepare(`
      INSERT INTO hard_link(src_artifact_id, dst_artifact_id, type, proposed_confidence,
                            proposed_by_session, proposed_at_epoch_ms, decay_count, project)
      VALUES (?, ?, 'evidence_for', 0.5, 'sess-old', 1000, ?, 'proj-alpha')
    `).run(src, dst, DECAY_THRESHOLD);

    const id = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'evidence_for',
      proposed_confidence: 0.9,
      proposed_by_session: 'sess-new',
      proposer_rationale: 'should be blocked',
    });
    expect(id).toBeNull();
  });
});

// ─── confirmHardLink ──────────────────────────────────────────────────────────

describe('confirmHardLink', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;
  let pendingId: number;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'cf-src');
    dst = insertArtifact(db, 'cf-dst');
    pendingId = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'triggered_by',
      proposed_confidence: 0.75,
      proposed_by_session: 'sess-proposer',
      proposer_rationale: 'confirm test',
    })!;
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-14: sets confirmed_by_session + confirmed_at_epoch_ms; history row inserted', () => {
    confirmHardLink(db, pendingId, 'sess-operator');
    const row = getHardLinkRow(db, pendingId);
    expect(row.confirmed_by_session).toBe('sess-operator');
    expect(row.confirmed_at_epoch_ms).toBeGreaterThan(0);

    const hist = historyRows(db, pendingId);
    const confirmed = hist.find(h => h.action === 'confirmed');
    expect(confirmed).toBeTruthy();
    expect(confirmed!.session_id).toBe('sess-operator');
  });

  it('test-15: throws on already-confirmed row', () => {
    confirmHardLink(db, pendingId, 'sess-operator');
    expect(() => confirmHardLink(db, pendingId, 'sess-operator-2')).toThrow(/already confirmed/);
  });

  it('test-16: throws on rejected row', () => {
    rejectHardLink(db, pendingId, 'sess-rejecter');
    expect(() => confirmHardLink(db, pendingId, 'sess-operator')).toThrow(/rejected/);
  });
});

// ─── rejectHardLink ───────────────────────────────────────────────────────────

describe('rejectHardLink', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;
  let pendingId: number;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'rj-src');
    dst = insertArtifact(db, 'rj-dst');
    pendingId = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'evidence_for',
      proposed_confidence: 0.6,
      proposed_by_session: 'sess-proposer',
      proposer_rationale: 'reject test',
    })!;
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-17: sets rejected fields, increments decay_count, inserts history row', () => {
    rejectHardLink(db, pendingId, 'sess-operator');
    const row = getHardLinkRow(db, pendingId);
    expect(row.rejected_by_session).toBe('sess-operator');
    expect(row.rejected_at_epoch_ms).toBeGreaterThan(0);
    expect(row.decay_count).toBe(1);

    const hist = historyRows(db, pendingId);
    const rejected = hist.find(h => h.action === 'rejected');
    expect(rejected).toBeTruthy();
    expect(rejected!.session_id).toBe('sess-operator');
  });

  it('test-18: throws on already-confirmed row', () => {
    confirmHardLink(db, pendingId, 'sess-operator');
    expect(() => rejectHardLink(db, pendingId, 'sess-rejecter')).toThrow(/already confirmed/);
  });
});

// ─── decayHardLink ────────────────────────────────────────────────────────────

describe('decayHardLink', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;
  let pendingId: number;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'dc-src');
    dst = insertArtifact(db, 'dc-dst');
    pendingId = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'contradicts',
      proposed_confidence: 0.5,
      proposed_by_session: 'sess-proposer',
      proposer_rationale: 'decay test',
    })!;
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-19: decayHardLink sets decay_count to at least DECAY_THRESHOLD and inserts history row', () => {
    decayHardLink(db, pendingId, 'sess-proposer');
    const row = getHardLinkRow(db, pendingId);
    expect(row.decay_count).toBeGreaterThanOrEqual(DECAY_THRESHOLD);

    const hist = historyRows(db, pendingId);
    const decayed = hist.find(h => h.action === 'decayed');
    expect(decayed).toBeTruthy();
    expect(decayed!.session_id).toBe('sess-proposer');
  });
});

// ─── listPendingHardLinks ─────────────────────────────────────────────────────

describe('listPendingHardLinks', () => {
  let db: Database.Database;
  let src1: string;
  let src2: string;
  let dst1: string;

  beforeEach(() => {
    db = buildDb();
    src1 = insertArtifact(db, 'lp-s1', 'proj-a');
    src2 = insertArtifact(db, 'lp-s2', 'proj-a');
    dst1 = insertArtifact(db, 'lp-d1', 'proj-a');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-20: returns only PENDING rows (confirmed=NULL AND rejected=NULL)', () => {
    // Pending link 1.
    const id1 = proposeHardLink(db, {
      src_artifact_id: src1,
      dst_artifact_id: dst1,
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: 'sess-1',
      proposer_rationale: 'r1',
    })!;

    // Pending link 2.
    const id2 = proposeHardLink(db, {
      src_artifact_id: src2,
      dst_artifact_id: dst1,
      type: 'evidence_for',
      proposed_confidence: 0.9,
      proposed_by_session: 'sess-1',
      proposer_rationale: 'r2',
    })!;

    // Confirm link 2 — should not appear in pending.
    confirmHardLink(db, id2, 'sess-op');

    const pending = listPendingHardLinks(db, 'proj-a');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id1);
    expect(pending[0].src).toBe(src1);
    expect(pending[0].type).toBe('triggered_by');
  });
});

// ─── listConfirmedHardLinks ───────────────────────────────────────────────────

describe('listConfirmedHardLinks', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'lc-src');
    dst = insertArtifact(db, 'lc-dst');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-21: returns only CONFIRMED rows (confirmed_by_session IS NOT NULL)', () => {
    const pendingId = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'triggered_by',
      proposed_confidence: 0.85,
      proposed_by_session: 'sess-proposer',
      proposer_rationale: 'r',
    })!;

    // Not confirmed yet — should not appear in confirmed list.
    const beforeConfirm = listConfirmedHardLinks(db, src, 'outgoing');
    expect(beforeConfirm).toHaveLength(0);

    confirmHardLink(db, pendingId, 'sess-operator');

    const afterConfirm = listConfirmedHardLinks(db, src, 'outgoing');
    expect(afterConfirm).toHaveLength(1);
    expect(afterConfirm[0].id).toBe(pendingId);
    expect(afterConfirm[0].type).toBe('triggered_by');
  });
});

// ─── getDecayCount ────────────────────────────────────────────────────────────

describe('getDecayCount', () => {
  let db: Database.Database;
  let src: string;
  let dst: string;

  beforeEach(() => {
    db = buildDb();
    src = insertArtifact(db, 'gdc-src');
    dst = insertArtifact(db, 'gdc-dst');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-22: returns 0 for (src, dst, type) never proposed', () => {
    expect(getDecayCount(db, src, dst, 'triggered_by')).toBe(0);
  });

  it('test-23: returns N after N rejectHardLink calls', () => {
    // Propose once.
    const id = proposeHardLink(db, {
      src_artifact_id: src,
      dst_artifact_id: dst,
      type: 'contradicts',
      proposed_confidence: 0.6,
      proposed_by_session: 'sess-p',
      proposer_rationale: 'test',
    })!;

    // Reject twice — decay_count should be 2.
    rejectHardLink(db, id, 'sess-op');
    rejectHardLink(db, id, 'sess-op-2');

    expect(getDecayCount(db, src, dst, 'contradicts')).toBe(2);
  });
});

// ─── DECAY_THRESHOLD ─────────────────────────────────────────────────────────

describe('DECAY_THRESHOLD', () => {
  it('test-24: DECAY_THRESHOLD constant equals 3 (locked default)', () => {
    expect(DECAY_THRESHOLD).toBe(3);
  });
});
