/**
 * Phase 14-07d — tests for soft-link-writers.ts site helpers.
 *
 * Covers 12 cases:
 *  1.  recordSupersedes: successful write returns row id
 *  2.  recordSupersedes: null prior → soft_link_skipped telemetry, returns null
 *  3.  recordSupersedes: missing dst artifact (FK violation) → soft_link_write_failed telemetry, returns null
 *  4.  recordPromotedTo: successful write returns row id
 *  5.  recordPromotedTo: confidence default 1.0
 *  6.  recordPromotedTo: custom confidence accepted
 *  7.  recordExtractedFrom: successful write returns row id
 *  8.  recordReferences: 3 refs → 3 soft_links written; returns 3
 *  9.  recordReferences: 0 refs → 0 written; returns 0
 * 10.  recordReferences: duplicate refs in same call → UNIQUE constraint dedupes; returns 1 (idempotent)
 * 11.  All helpers: telemetry write failure doesn't cascade into throw
 * 12.  All helpers: primary write success path does not throw
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  recordSupersedes,
  recordPromotedTo,
  recordExtractedFrom,
  recordReferences,
} from '../../intelligence/soft-link-writers.js';
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
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_kind TEXT,
      detail TEXT,
      latency_ms INTEGER,
      adapter TEXT,
      timestamp_epoch_ms INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  migrateV37toV38(db);
  return db;
}

function insertArtifact(db: Database.Database, id: string, project = 'test-proj'): string {
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, 'learning', 'test body', ?, ?, ?)
  `).run(id, Date.now(), Date.now(), project);
  return id;
}

function countSoftLinks(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM soft_link`).get() as { n: number }).n;
}

function getTelemetryRows(db: Database.Database, eventKind: string): Array<{ detail: string }> {
  return db.prepare(
    `SELECT detail FROM telemetry WHERE event_kind = ? ORDER BY id`
  ).all(eventKind) as Array<{ detail: string }>;
}

const SESSION = 'session-07d-test';

// ─── recordSupersedes ─────────────────────────────────────────────────────────

describe('recordSupersedes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertArtifact(db, 'handoff-new');
    insertArtifact(db, 'handoff-prior');
  });

  it('test 1: successful write returns row id (positive integer)', () => {
    const id = recordSupersedes({
      db,
      session_id: SESSION,
      new_handoff_artifact_id: 'handoff-new',
      prior_handoff_artifact_id: 'handoff-prior',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(countSoftLinks(db)).toBe(1);
  });

  it('test 2: null prior → soft_link_skipped telemetry, returns null', () => {
    const id = recordSupersedes({
      db,
      session_id: SESSION,
      new_handoff_artifact_id: 'handoff-new',
      prior_handoff_artifact_id: null,
    });
    expect(id).toBeNull();
    expect(countSoftLinks(db)).toBe(0);

    const rows = getTelemetryRows(db, 'soft_link_skipped');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail);
    expect(detail.reason).toBe('no_prior');
    expect(detail.site).toBe('recordSupersedes');
  });

  it('test 3: missing dst artifact (FK violation) → soft_link_write_failed telemetry, returns null', () => {
    const id = recordSupersedes({
      db,
      session_id: SESSION,
      new_handoff_artifact_id: 'handoff-new',
      prior_handoff_artifact_id: 'does-not-exist',
    });
    expect(id).toBeNull();
    expect(countSoftLinks(db)).toBe(0);

    const rows = getTelemetryRows(db, 'soft_link_write_failed');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail);
    expect(detail.site).toBe('recordSupersedes');
    expect(typeof detail.error).toBe('string');
  });
});

// ─── recordPromotedTo ─────────────────────────────────────────────────────────

describe('recordPromotedTo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertArtifact(db, 'obs-001');
    insertArtifact(db, 'lesson-001');
  });

  it('test 4: successful write returns row id', () => {
    const id = recordPromotedTo({
      db,
      session_id: SESSION,
      observation_artifact_id: 'obs-001',
      lesson_artifact_id: 'lesson-001',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(countSoftLinks(db)).toBe(1);
  });

  it('test 5: confidence defaults to 1.0 when not supplied', () => {
    recordPromotedTo({
      db,
      session_id: SESSION,
      observation_artifact_id: 'obs-001',
      lesson_artifact_id: 'lesson-001',
    });
    const row = db.prepare(
      `SELECT confidence FROM soft_link WHERE src_artifact_id = 'obs-001'`
    ).get() as { confidence: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.confidence).toBe(1.0);
  });

  it('test 6: custom confidence accepted', () => {
    recordPromotedTo({
      db,
      session_id: SESSION,
      observation_artifact_id: 'obs-001',
      lesson_artifact_id: 'lesson-001',
      promotion_confidence: 0.75,
    });
    const row = db.prepare(
      `SELECT confidence FROM soft_link WHERE src_artifact_id = 'obs-001'`
    ).get() as { confidence: number } | undefined;
    expect(row?.confidence).toBe(0.75);
  });
});

// ─── recordExtractedFrom ──────────────────────────────────────────────────────

describe('recordExtractedFrom', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertArtifact(db, 'highlight-001');
    insertArtifact(db, 'session-frame-001');
  });

  it('test 7: successful write returns row id', () => {
    const id = recordExtractedFrom({
      db,
      session_id: SESSION,
      highlight_artifact_id: 'highlight-001',
      session_frame_artifact_id: 'session-frame-001',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(countSoftLinks(db)).toBe(1);

    const row = db.prepare(
      `SELECT type FROM soft_link WHERE src_artifact_id = 'highlight-001'`
    ).get() as { type: string } | undefined;
    expect(row?.type).toBe('extracted_from');
  });
});

// ─── recordReferences ─────────────────────────────────────────────────────────

describe('recordReferences', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertArtifact(db, 'log-001');
    insertArtifact(db, 'ref-a');
    insertArtifact(db, 'ref-b');
    insertArtifact(db, 'ref-c');
  });

  it('test 8: 3 refs → 3 soft_links written; returns 3', () => {
    const count = recordReferences({
      db,
      session_id: SESSION,
      src_artifact_id: 'log-001',
      referenced_artifact_ids: ['ref-a', 'ref-b', 'ref-c'],
    });
    expect(count).toBe(3);
    expect(countSoftLinks(db)).toBe(3);
  });

  it('test 9: 0 refs → 0 written; returns 0', () => {
    const count = recordReferences({
      db,
      session_id: SESSION,
      src_artifact_id: 'log-001',
      referenced_artifact_ids: [],
    });
    expect(count).toBe(0);
    expect(countSoftLinks(db)).toBe(0);
  });

  it('test 10: duplicate refs in same call → UNIQUE constraint dedupes; returns 1 (idempotent)', () => {
    // First call writes 1 link
    const first = recordReferences({
      db,
      session_id: SESSION,
      src_artifact_id: 'log-001',
      referenced_artifact_ids: ['ref-a'],
    });
    expect(first).toBe(1);

    // Second call with same ref: writeSoftLink returns existing id (INSERT OR IGNORE);
    // recordReferences counts it as written (no throw).
    const second = recordReferences({
      db,
      session_id: SESSION,
      src_artifact_id: 'log-001',
      referenced_artifact_ids: ['ref-a'],
    });
    expect(second).toBe(1);

    // Only 1 row in the table (deduped by UNIQUE constraint).
    expect(countSoftLinks(db)).toBe(1);
  });
});

// ─── Error isolation / no-throw guarantees ────────────────────────────────────

describe('All helpers: error isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    insertArtifact(db, 'art-a');
    insertArtifact(db, 'art-b');
  });

  it('test 11: telemetry write failure does not cascade into throw', () => {
    // Drop the telemetry table to force telemetry write failures.
    db.exec(`DROP TABLE IF EXISTS telemetry`);

    // recordSupersedes with missing prior triggers soft_link_skipped telemetry.
    // Even with no telemetry table, this must not throw.
    expect(() => {
      recordSupersedes({
        db,
        session_id: SESSION,
        new_handoff_artifact_id: 'art-a',
        prior_handoff_artifact_id: null,
      });
    }).not.toThrow();

    // recordSupersedes with FK violation triggers soft_link_write_failed telemetry.
    expect(() => {
      recordSupersedes({
        db,
        session_id: SESSION,
        new_handoff_artifact_id: 'art-a',
        prior_handoff_artifact_id: 'nonexistent',
      });
    }).not.toThrow();

    // recordReferences with invalid dst triggers per-link soft_link_write_failed telemetry.
    expect(() => {
      recordReferences({
        db,
        session_id: SESSION,
        src_artifact_id: 'art-a',
        referenced_artifact_ids: ['nonexistent'],
      });
    }).not.toThrow();
  });

  it('test 12: primary write success path does not throw for any helper', () => {
    expect(() => {
      recordSupersedes({
        db,
        session_id: SESSION,
        new_handoff_artifact_id: 'art-a',
        prior_handoff_artifact_id: 'art-b',
      });
    }).not.toThrow();

    expect(() => {
      recordPromotedTo({
        db,
        session_id: SESSION,
        observation_artifact_id: 'art-a',
        lesson_artifact_id: 'art-b',
      });
    }).not.toThrow();

    // Re-use a fresh DB for these since soft_link has UNIQUE(src,dst,type).
    const db2 = buildDb();
    insertArtifact(db2, 'h-001');
    insertArtifact(db2, 'sf-001');
    expect(() => {
      recordExtractedFrom({
        db: db2,
        session_id: SESSION,
        highlight_artifact_id: 'h-001',
        session_frame_artifact_id: 'sf-001',
      });
    }).not.toThrow();

    const db3 = buildDb();
    insertArtifact(db3, 'src-001');
    insertArtifact(db3, 'ref-001');
    expect(() => {
      recordReferences({
        db: db3,
        session_id: SESSION,
        src_artifact_id: 'src-001',
        referenced_artifact_ids: ['ref-001'],
      });
    }).not.toThrow();
  });
});
