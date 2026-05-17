/**
 * artifact-id-map.ts — ID derivation, lookup, and completeness tests.
 *
 * Phase 14-07a. Covers:
 *   1-7: generateV17IdFromLegacy determinism + content sensitivity
 *   8: populateAllMappings on empty map
 *   9: populateAllMappings idempotent on partial map
 *  10: populateAllMappings creates V17 artifact rows
 *  11: round-trip lookup via lookupV17ByLegacy + lookupLegacyByV17
 *  12: lookupV17ByLegacy returns null for unknown legacy_id
 *  13: lookupLegacyByV17 returns null for unknown v17_id
 *  14: verifyMappingComplete returns unmapped=0 after clean populate
 *  15: verifyMappingComplete returns unmapped=1 if legacy row inserted after populate
 *  16: FK constraint: artifact_id_map insert without matching artifact row throws
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  generateV17IdFromLegacy,
  lookupV17ByLegacy,
  lookupLegacyByV17,
  populateAllMappings,
  verifyMappingComplete,
  type LegacyIdInput,
} from '../../core/artifact-id-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Build a DB with V17 DDL + artifact_id_map table.
 * Seeds `artifactCount` rows in the legacy `artifacts` table if provided.
 */
function buildTestDb(artifactCount = 0): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);

  // Create artifact_id_map if not already created by migration.
  if (!hasTable(db, 'artifact_id_map')) {
    db.exec(`
      CREATE TABLE artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17 ON artifact_id_map(v17_id);
    `);
  }

  if (artifactCount > 0 && hasTable(db, 'artifacts')) {
    const insert = db.prepare(`
      INSERT INTO artifacts(session_id, project, artifact_type, summary, content, state, ttl, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < artifactCount; i++) {
      insert.run(`sess-${i}`, 'test-project', 'observation', `Summary ${i}`, `Content ${i}`, 'fresh', 3, 3);
    }
  }

  return db;
}

/** Canonical test input for determinism tests. */
const BASE_INPUT: LegacyIdInput = {
  legacy_id: 42,
  project: 'claudex-v3',
  timestamp_epoch_ms: 1700000000000,
  summary: 'Test summary',
  body: 'Test body content',
};

// ---------------------------------------------------------------------------
// Tests: generateV17IdFromLegacy
// ---------------------------------------------------------------------------

describe('generateV17IdFromLegacy', () => {
  // Test 1: same inputs → same output (10 calls)
  it('1. same inputs produce identical output across 10 calls', () => {
    const first = generateV17IdFromLegacy(BASE_INPUT);
    for (let i = 0; i < 9; i++) {
      expect(generateV17IdFromLegacy(BASE_INPUT)).toBe(first);
    }
  });

  // Test 2: different legacy_id → different output
  it('2. different legacy_id produces different ID', () => {
    const a = generateV17IdFromLegacy({ ...BASE_INPUT, legacy_id: 1 });
    const b = generateV17IdFromLegacy({ ...BASE_INPUT, legacy_id: 2 });
    expect(a).not.toBe(b);
  });

  // Test 3: different project → different output
  it('3. different project produces different ID', () => {
    const a = generateV17IdFromLegacy({ ...BASE_INPUT, project: 'project-a' });
    const b = generateV17IdFromLegacy({ ...BASE_INPUT, project: 'project-b' });
    expect(a).not.toBe(b);
  });

  // Test 4: different timestamp_epoch_ms → different output
  it('4. different timestamp_epoch_ms produces different ID', () => {
    const a = generateV17IdFromLegacy({ ...BASE_INPUT, timestamp_epoch_ms: 1000 });
    const b = generateV17IdFromLegacy({ ...BASE_INPUT, timestamp_epoch_ms: 2000 });
    expect(a).not.toBe(b);
  });

  // Test 5: different summary → different output
  it('5. different summary produces different ID', () => {
    const a = generateV17IdFromLegacy({ ...BASE_INPUT, summary: 'Summary A' });
    const b = generateV17IdFromLegacy({ ...BASE_INPUT, summary: 'Summary B' });
    expect(a).not.toBe(b);
  });

  // Test 6: different body → different output
  it('6. different body produces different ID', () => {
    const a = generateV17IdFromLegacy({ ...BASE_INPUT, body: 'Body A' });
    const b = generateV17IdFromLegacy({ ...BASE_INPUT, body: 'Body B' });
    expect(a).not.toBe(b);
  });

  // Test 7: output is exactly 32 hex chars
  it('7. output is exactly 32 hex characters (matches V17 convention)', () => {
    const id = generateV17IdFromLegacy(BASE_INPUT);
    expect(id).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: populateAllMappings
// ---------------------------------------------------------------------------

describe('populateAllMappings', () => {
  let db: Database.Database;

  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 8: empty map → N rows after
  it('8. empty mapping table → N rows inserted after populateAllMappings', () => {
    db = buildTestDb(4);
    const { inserted, skipped } = populateAllMappings(db);
    expect(inserted).toBe(4);
    expect(skipped).toBe(0);

    const mapCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifact_id_map`).get() as { n: number }).n;
    expect(mapCount).toBe(4);
  });

  // Test 9: partial map → idempotent, no duplicates
  it('9. partial mapping → idempotent (skipped count > 0 for already-mapped rows)', () => {
    db = buildTestDb(4);
    populateAllMappings(db); // first run maps all 4

    const { inserted: ins2, skipped: skp2 } = populateAllMappings(db); // second run
    expect(skp2).toBe(4);
    expect(ins2).toBe(0);

    const mapCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifact_id_map`).get() as { n: number }).n;
    expect(mapCount).toBe(4); // no duplicates
  });

  // Test 10: V17 artifact rows also created
  it('10. populateAllMappings creates V17 artifact rows', () => {
    db = buildTestDb(3);
    populateAllMappings(db);

    const v17Count = (
      db.prepare(`SELECT COUNT(*) AS n FROM artifact WHERE kind = 'observation'`).get() as { n: number }
    ).n;
    expect(v17Count).toBeGreaterThanOrEqual(3);
  });

  // Test 11: round-trip via lookupV17ByLegacy + lookupLegacyByV17
  it('11. legacy_id → lookupV17ByLegacy → lookupLegacyByV17 returns original legacy id', () => {
    db = buildTestDb(3);
    populateAllMappings(db);

    const legacyRows = db.prepare(`SELECT id FROM artifacts`).all() as Array<{ id: number }>;
    for (const row of legacyRows) {
      const v17Id = lookupV17ByLegacy(db, row.id);
      expect(v17Id).toBeTruthy();
      const reverseId = lookupLegacyByV17(db, v17Id!);
      expect(reverseId).toBe(row.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: lookupV17ByLegacy / lookupLegacyByV17
// ---------------------------------------------------------------------------

describe('lookup helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb(2);
    populateAllMappings(db);
  });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 12: lookupV17ByLegacy returns null for unknown legacy_id
  it('12. lookupV17ByLegacy returns null for unknown legacy_id', () => {
    const result = lookupV17ByLegacy(db, 999999);
    expect(result).toBeNull();
  });

  // Test 13: lookupLegacyByV17 returns null for unknown v17_id
  it('13. lookupLegacyByV17 returns null for unknown v17_id', () => {
    const result = lookupLegacyByV17(db, 'nonexistent-id-xxxxxxxxxxxxxxxx');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyMappingComplete
// ---------------------------------------------------------------------------

describe('verifyMappingComplete', () => {
  let db: Database.Database;

  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 14: clean populate → unmapped=0
  it('14. clean populateAllMappings → unmapped=0', () => {
    db = buildTestDb(5);
    populateAllMappings(db);

    const result = verifyMappingComplete(db);
    expect(result.total_legacy).toBe(5);
    expect(result.mapped).toBe(5);
    expect(result.unmapped).toBe(0);
  });

  // Test 15: legacy row inserted after populate → unmapped=1
  it('15. legacy row inserted after populate → unmapped=1', () => {
    db = buildTestDb(3);
    populateAllMappings(db);

    // Insert new legacy artifact AFTER map is populated.
    db.prepare(`
      INSERT INTO artifacts(session_id, project, artifact_type, summary, state, ttl, importance)
      VALUES ('new-sess', 'test-project', 'observation', 'New artifact', 'fresh', 3, 3)
    `).run();

    const result = verifyMappingComplete(db);
    expect(result.total_legacy).toBe(4);
    expect(result.mapped).toBe(3);
    expect(result.unmapped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test: FK constraint
// ---------------------------------------------------------------------------

describe('artifact_id_map FK constraint', () => {
  let db: Database.Database;

  beforeEach(() => { db = buildTestDb(0); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 16: inserting into artifact_id_map without a matching artifact row throws FK
  it('16. FK violation: artifact_id_map insert without matching artifact row throws', () => {
    // Enable FK enforcement on this connection.
    db.pragma('foreign_keys = ON');

    expect(() => {
      db.prepare(`
        INSERT INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
        VALUES (999, 'nonexistent-v17-id-xxxxxxxxxxxxx', ${Date.now()}, 'test')
      `).run();
    }).toThrow();
  });
});
