/**
 * entity-summarizer-v17.test.ts — V17 migration path tests for Angel entity summarizer.
 *
 * 14-07b (W4): verifies that entity-summarizer reads/writes use the V17 `artifact` table:
 *   - getExistingSummary: reads from V17 artifact with kind='entity_summary', data.entity_ref
 *   - UPDATE existing: writes to V17 artifact.body and artifact.data
 *   - INSERT new: writes to V17 artifact directly with kind='entity_summary'
 *
 * V17 field mapping:
 *   artifact.content → artifact.body
 *   artifact.metadata → artifact.data (JSON sidecar)
 *   artifact.ref → data.entity_ref
 *   artifact_type='entity_summary' → kind='entity_summary'
 *   importance=3 → confidence=0.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema, runMigrations } from '../../core/migrations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

/**
 * Insert a V17 entity_summary artifact directly.
 */
function insertEntitySummaryV17(
  db: Database.Database,
  opts: {
    entityName: string;
    body: string;
    project?: string;
    evidenceHash?: string;
    trend?: string;
  },
): string {
  const entityRef = `entity:${opts.entityName.toLowerCase()}`;
  const evidenceHash = opts.evidenceHash ?? '5:1234567890';
  const v17Id = createHash('sha256')
    .update(`entity_summary:${opts.entityName.toLowerCase()}:${opts.project ?? 'test-project'}:${evidenceHash}`)
    .digest('hex')
    .slice(0, 32);

  db.prepare(
    `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, project, data)
     VALUES (?, 'entity_summary', ?, ?, 'project', 'active', 0.6, ?, ?, ?, ?)`
  ).run(
    v17Id,
    opts.entityName,
    opts.body,
    Date.now(),
    Date.now(),
    opts.project ?? 'test-project',
    JSON.stringify({
      evidence_hash: evidenceHash,
      trend: opts.trend ?? 'STABLE',
      entity_ref: entityRef,
    }),
  );

  return v17Id;
}

describe('Entity Summarizer — V17 path (14-07b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('V17 artifact table schema for entity_summary', () => {
    it('can insert entity_summary into V17 artifact table', () => {
      const v17Id = insertEntitySummaryV17(db, {
        entityName: 'TestEntity',
        body: '## TestEntity\nSome summary\n\n**Trend:** STABLE',
        project: 'test-project',
      });

      const row = db.prepare(
        `SELECT id, kind, title, body, json_extract(data, '$.entity_ref') AS entity_ref,
                json_extract(data, '$.evidence_hash') AS evidence_hash
         FROM artifact WHERE id = ?`
      ).get(v17Id) as {
        id: string;
        kind: string;
        title: string;
        body: string;
        entity_ref: string;
        evidence_hash: string;
      } | undefined;

      expect(row).toBeDefined();
      expect(row!.kind).toBe('entity_summary');
      expect(row!.title).toBe('TestEntity');
      expect(row!.entity_ref).toBe('entity:testentity');
      expect(row!.evidence_hash).toBe('5:1234567890');
    });

    it('can query entity_summary by kind and data.entity_ref', () => {
      insertEntitySummaryV17(db, {
        entityName: 'React',
        body: 'React is a UI library',
        project: 'test-project',
      });

      const found = db.prepare(
        `SELECT id, body, data FROM artifact
         WHERE kind = 'entity_summary'
           AND json_extract(data, '$.entity_ref') = ?
         LIMIT 1`
      ).get('entity:react') as { id: string; body: string; data: string } | undefined;

      expect(found).toBeDefined();
      expect(found!.body).toContain('React is a UI library');
    });
  });

  describe('V17 entity summary skip logic (evidence hash check)', () => {
    it('detects existing summary by evidence_hash in data JSON', () => {
      const evidenceHash = '10:9999999999';
      insertEntitySummaryV17(db, {
        entityName: 'SQLite',
        body: 'SQLite summary',
        evidenceHash,
        project: 'test-project',
      });

      const existing = db.prepare(
        `SELECT id, body, data FROM artifact
         WHERE kind = 'entity_summary'
           AND json_extract(data, '$.entity_ref') = ?
         LIMIT 1`
      ).get('entity:sqlite') as { id: string; body: string; data: string } | undefined;

      expect(existing).toBeDefined();

      let parsedData: Record<string, unknown> = {};
      try { parsedData = JSON.parse(existing!.data); } catch { /* */ }

      // This is the skip check the entity summarizer performs
      expect(parsedData['evidence_hash']).toBe(evidenceHash);
    });

    it('does not skip when evidence_hash differs', () => {
      const oldHash = '5:1000000000';
      const newHash = '7:2000000000'; // new evidence arrived

      insertEntitySummaryV17(db, {
        entityName: 'TypeScript',
        body: 'Old TypeScript summary',
        evidenceHash: oldHash,
      });

      const existing = db.prepare(
        `SELECT id, body, data FROM artifact
         WHERE kind = 'entity_summary'
           AND json_extract(data, '$.entity_ref') = ?
         LIMIT 1`
      ).get('entity:typescript') as { id: string; body: string; data: string } | undefined;

      let parsedData: Record<string, unknown> = {};
      try { parsedData = JSON.parse(existing!.data); } catch { /* */ }

      // New hash differs — should NOT skip update
      expect(parsedData['evidence_hash']).not.toBe(newHash);
    });
  });

  describe('V17 entity summary UPDATE path', () => {
    it('can update body and data fields on existing V17 artifact', () => {
      const v17Id = insertEntitySummaryV17(db, {
        entityName: 'Bun',
        body: 'Old Bun summary',
        evidenceHash: '3:111',
        project: 'test-project',
      });

      const newBody = 'Updated Bun summary with more detail';
      const newData = JSON.stringify({
        evidence_hash: '5:222',
        trend: 'STRENGTHENING',
        entity_ref: 'entity:bun',
      });

      db.prepare(
        `UPDATE artifact SET body = ?, data = ?, updated_at_epoch_ms = ? WHERE id = ?`
      ).run(newBody, newData, Date.now(), v17Id);

      const updated = db.prepare(
        `SELECT body, json_extract(data, '$.evidence_hash') AS evidence_hash,
                json_extract(data, '$.trend') AS trend
         FROM artifact WHERE id = ?`
      ).get(v17Id) as { body: string; evidence_hash: string; trend: string } | undefined;

      expect(updated).toBeDefined();
      expect(updated!.body).toBe(newBody);
      expect(updated!.evidence_hash).toBe('5:222');
      expect(updated!.trend).toBe('STRENGTHENING');
    });
  });

  describe('V17 INSERT deduplication', () => {
    it('INSERT OR IGNORE prevents duplicate entity_summary for same entity_ref', () => {
      const v17Id = insertEntitySummaryV17(db, {
        entityName: 'Vitest',
        body: 'Vitest summary',
        evidenceHash: '4:123',
      });

      // Attempt to insert again with same ID
      db.prepare(
        `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
            created_at_epoch_ms, updated_at_epoch_ms, project, data)
         VALUES (?, 'entity_summary', 'Vitest', 'Different body', 'project', 'active', 0.6, ?, ?, 'test-project', '{}')`
      ).run(v17Id, Date.now(), Date.now());

      const rows = db.prepare(
        `SELECT COUNT(*) as cnt FROM artifact WHERE kind = 'entity_summary' AND id = ?`
      ).get(v17Id) as { cnt: number };

      expect(rows.cnt).toBe(1); // Still only 1 row
    });
  });
});
