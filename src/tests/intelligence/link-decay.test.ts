/**
 * Phase 14-07f — link-decay helper tests.
 *
 * Coverage:
 *   - isDecayed: false below threshold, true at/above threshold
 *   - skipDecayedProposals: correct partition + telemetry per skip
 *   - getDecayThreshold: returns DECAY_THRESHOLD constant
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';
import { proposeHardLink, rejectHardLink, DECAY_THRESHOLD } from '../../core/link-writer.js';
import {
  isDecayed,
  skipDecayedProposals,
  getDecayThreshold,
} from '../../intelligence/link-decay.js';
import type { HardLinkType } from '../../intelligence/link-decay.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertArtifact(db: Database.Database, id: string, project: string): void {
  db.prepare(`
    INSERT INTO artifact
      (id, kind, title, body, status, created_at_epoch_ms, updated_at_epoch_ms,
       session_id, project, data)
    VALUES (?, 'observation', 'T', 'B', 'active', ?, ?, 'sess', ?, '{}')
  `).run(id, Date.now(), Date.now(), project);
}

const PROJECT = 'decay-test-proj';
const SESSION = 'decay-test-session';
const A1 = 'decay001' + '0'.repeat(24);
const A2 = 'decay002' + '0'.repeat(24);
const A3 = 'decay003' + '0'.repeat(24);
const A4 = 'decay004' + '0'.repeat(24);
const TYPE: HardLinkType = 'triggered_by';

// ─── isDecayed ────────────────────────────────────────────────────────────────

describe('isDecayed', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, status, observation_count, created_at_epoch_ms, project)
      VALUES (?, 'active', 0, ?, ?)
    `).run(SESSION, Date.now(), PROJECT);
    insertArtifact(db, A1, PROJECT);
    insertArtifact(db, A2, PROJECT);
  });

  afterEach(() => { db.close(); });

  it('returns false when decay_count is below threshold', () => {
    // No link row exists → decay_count is 0.
    expect(isDecayed(db, A1, A2, TYPE)).toBe(false);
  });

  it('returns false when decay_count is below threshold (partial rejections)', () => {
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: TYPE,
      proposed_confidence: 0.8,
      proposed_by_session: SESSION,
      proposer_rationale: 'test',
    });
    expect(id).not.toBeNull();
    // Reject once (below threshold of 3).
    rejectHardLink(db, id!, `reject-sess-0`);
    expect(isDecayed(db, A1, A2, TYPE)).toBe(false);
  });

  it('returns true at DECAY_THRESHOLD', () => {
    // Propose once, then force decay_count to DECAY_THRESHOLD via direct DB.
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: TYPE,
      proposed_confidence: 0.8,
      proposed_by_session: SESSION,
      proposer_rationale: 'test',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, id);
    expect(isDecayed(db, A1, A2, TYPE)).toBe(true);
  });

  it('returns true above DECAY_THRESHOLD', () => {
    // Force decay_count above threshold via direct DB manipulation.
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: TYPE,
      proposed_confidence: 0.8,
      proposed_by_session: SESSION,
      proposer_rationale: 'test',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD + 5, id);
    expect(isDecayed(db, A1, A2, TYPE)).toBe(true);
  });
});

// ─── skipDecayedProposals ─────────────────────────────────────────────────────

describe('skipDecayedProposals', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, status, observation_count, created_at_epoch_ms, project)
      VALUES (?, 'active', 0, ?, ?)
    `).run(SESSION, Date.now(), PROJECT);
    insertArtifact(db, A1, PROJECT);
    insertArtifact(db, A2, PROJECT);
    insertArtifact(db, A3, PROJECT);
    insertArtifact(db, A4, PROJECT);
  });

  afterEach(() => { db.close(); });

  it('partitions correctly — non-decayed kept, decayed skipped', () => {
    // Decay A1→A2 via direct DB (avoids UNIQUE constraint cycle).
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: SESSION,
      proposer_rationale: 'test',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, id);

    const proposals = [
      { src: A1, dst: A2, type: 'triggered_by' as HardLinkType },  // decayed
      { src: A3, dst: A4, type: 'evidence_for' as HardLinkType },  // not decayed
    ];

    const result = skipDecayedProposals(db, proposals, SESSION);
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.kept[0]).toEqual({ src: A3, dst: A4, type: 'evidence_for' });
    expect(result.skipped[0]).toEqual({ src: A1, dst: A2, type: 'triggered_by' });
  });

  it('emits telemetry per skip when session_id provided', () => {
    // Decay A1→A2 via direct DB.
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: 'triggered_by',
      proposed_confidence: 0.8,
      proposed_by_session: SESSION,
      proposer_rationale: 'test',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, id);

    skipDecayedProposals(
      db,
      [{ src: A1, dst: A2, type: 'triggered_by' as HardLinkType }],
      SESSION,
    );

    const rows = db.prepare(`
      SELECT detail FROM telemetry
      WHERE session_id = ?
        AND event_kind = 'session_end_action'
        AND json_extract(detail, '$.action') = 'hard_link_proposer_decay_skip'
    `).all(SESSION) as Array<{ detail: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── getDecayThreshold ────────────────────────────────────────────────────────

describe('getDecayThreshold', () => {
  it('returns the DECAY_THRESHOLD constant (3)', () => {
    expect(getDecayThreshold()).toBe(DECAY_THRESHOLD);
    expect(getDecayThreshold()).toBe(3);
  });
});
