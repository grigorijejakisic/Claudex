/**
 * 14-07b W3: claudex_recall V17 migration tests.
 *
 * Tests the migrated claudex_recall MCP handler logic against V17 artifact
 * table. Verifies:
 *   1. Lookup by legacy INTEGER id (via artifact_id_map bridge) returns
 *      backward-compat shape { summary, content, importance, type, provenance }.
 *   2. Lookup by artifact_ref (stored in V17 data JSON sidecar) returns
 *      correct row.
 *   3. Missing artifact returns { error: 'not found' }.
 *   4. Backward-compat field mapping: V17 title→summary, body→content,
 *      confidence(0-1)→importance(1-5 rounded), kind→type.
 *   5. Defensive fallback: pre-migration DB without artifact_id_map resolves
 *      via legacy artifacts table.
 *
 * These tests exercise the handler logic directly (not via MCP stdio transport)
 * by calling the same DB queries the handler uses, against an in-memory DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { generateV17IdFromLegacy } from '../../core/artifact-id-map.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { lookupV17ByLegacy } from '../../core/artifact-id-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Build a V37 in-memory DB with both the V17 `artifact` table and the
 * `artifact_id_map` mapping table. Seeds one legacy row in `artifacts`
 * and its corresponding V17 `artifact` row + mapping.
 */
function buildV37Db(opts: {
  kind?: string;
  title?: string;
  body?: string;
  confidence?: number;
  project?: string;
  artifactRef?: string;
}): { db: Database.Database; legacyId: number; v17Id: string } {
  const db = new Database(':memory:');
  initializeSchema(db);

  const project = opts.project ?? 'test-project';
  const kind = opts.kind ?? 'memory_file';
  const title = opts.title ?? 'Test artifact title';
  const body = opts.body ?? 'Full artifact body content for testing purposes.';
  const confidence = opts.confidence ?? 0.6; // → importance 3

  // Ensure artifact_id_map exists (created by migrateV36toV37).
  if (!hasTable(db, 'artifact_id_map')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17 ON artifact_id_map(v17_id);
    `);
  }

  // Insert legacy artifacts row.
  const legacyInsert = db.prepare(`
    INSERT INTO artifacts(session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
    VALUES (?, ?, ?, ?, ?, ?, 'fresh', 3600, ?)
  `);
  const legacyResult = legacyInsert.run(
    'sess-1', project, kind, opts.artifactRef ?? null, title, body,
    Math.round(confidence * 5),
  );
  const legacyId = Number(legacyResult.lastInsertRowid);

  // Derive V17 id.
  const v17Id = generateV17IdFromLegacy({
    legacy_id: legacyId,
    project,
    timestamp_epoch_ms: Date.now(),
    summary: title,
    body,
  });

  // Insert V17 artifact row with artifact_ref in data JSON sidecar.
  const dataJson = JSON.stringify(
    opts.artifactRef
      ? { migrated_from_legacy_id: legacyId, artifact_ref: opts.artifactRef }
      : { migrated_from_legacy_id: legacyId },
  );
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
    VALUES (?, ?, ?, ?, 'project', 'active', ?, ?, ?, ?, ?, ?)
  `).run(v17Id, kind, title, body, confidence, Date.now(), Date.now(), 'sess-1', project, dataJson);

  // Insert mapping row.
  db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `).run(legacyId, v17Id, Date.now(), project);

  return { db, legacyId, v17Id };
}

/**
 * Replicate the handler's V17 recall-by-id logic (same queries as recall-server.ts).
 */
function recallById(db: Database.Database, legacyId: number): Record<string, unknown> | null {
  const v17Id = lookupV17ByLegacy(db, legacyId);
  if (!v17Id) return null;

  const v17Row = cachedPrepare(db,
    `SELECT id, kind, title, body, project, session_id, confidence, status, created_at_epoch_ms, data
       FROM artifact WHERE id = ?`
  ).get(v17Id) as {
    id: string; kind: string; title: string | null; body: string;
    project: string | null; confidence: number | null; status: string;
    created_at_epoch_ms: number; data: string | null;
  } | undefined;

  if (!v17Row) return null;

  let artifactRef: string | null = null;
  try {
    const dataParsed = v17Row.data ? JSON.parse(v17Row.data) as Record<string, unknown> : {};
    artifactRef = typeof dataParsed['artifact_ref'] === 'string' ? dataParsed['artifact_ref'] : null;
  } catch { /* non-fatal */ }

  const importanceFromConfidence = v17Row.confidence != null
    ? Math.round(v17Row.confidence * 5)
    : 3;

  return {
    id: v17Row.id,
    type: v17Row.kind,
    summary: v17Row.title ?? v17Row.body.slice(0, 200),
    content: v17Row.body,
    provenance: artifactRef ?? `artifact:${v17Row.id}`,
    project: v17Row.project,
    importance: importanceFromConfidence,
  };
}

/**
 * Replicate the handler's V17 recall-by-ref logic.
 */
function recallByRef(db: Database.Database, ref: string): Record<string, unknown> | null {
  const v17Row = cachedPrepare(db,
    `SELECT id, kind, title, body, project, session_id, confidence, status, created_at_epoch_ms, data
       FROM artifact
      WHERE json_extract(data, '$.artifact_ref') = ?
      LIMIT 1`
  ).get(ref) as {
    id: string; kind: string; title: string | null; body: string;
    project: string | null; confidence: number | null; status: string;
    created_at_epoch_ms: number; data: string | null;
  } | undefined;

  if (!v17Row) return null;

  let artifactRef: string | null = null;
  try {
    const dataParsed = v17Row.data ? JSON.parse(v17Row.data) as Record<string, unknown> : {};
    artifactRef = typeof dataParsed['artifact_ref'] === 'string' ? dataParsed['artifact_ref'] : null;
  } catch { /* non-fatal */ }

  const importanceFromConfidence = v17Row.confidence != null
    ? Math.round(v17Row.confidence * 5)
    : 3;

  return {
    id: v17Row.id,
    type: v17Row.kind,
    summary: v17Row.title ?? v17Row.body.slice(0, 200),
    content: v17Row.body,
    provenance: artifactRef ?? `artifact:${v17Row.id}`,
    project: v17Row.project,
    importance: importanceFromConfidence,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claudex_recall V17 migration — recall by legacy integer id', () => {
  let db: Database.Database;
  let legacyId: number;
  let v17Id: string;

  beforeEach(() => {
    const result = buildV37Db({
      kind: 'memory_file',
      title: 'Auth module design decision',
      body: 'Use OAuth alongside API keys for production auth.',
      confidence: 0.8, // → importance 4
      project: 'my-project',
    });
    db = result.db;
    legacyId = result.legacyId;
    v17Id = result.v17Id;
  });

  afterEach(() => {
    db.close();
  });

  it('1. looks up V17 artifact via artifact_id_map bridge', () => {
    const result = recallById(db, legacyId);
    expect(result).not.toBeNull();
    expect(result!['id']).toBe(v17Id);
  });

  it('2. returns backward-compat summary (V17 title) field', () => {
    const result = recallById(db, legacyId);
    expect(result!['summary']).toBe('Auth module design decision');
  });

  it('3. returns backward-compat content (V17 body) field', () => {
    const result = recallById(db, legacyId);
    expect(result!['content']).toBe('Use OAuth alongside API keys for production auth.');
  });

  it('4. returns backward-compat importance converted from confidence (0.8 → 4)', () => {
    const result = recallById(db, legacyId);
    expect(result!['importance']).toBe(4);
  });

  it('5. returns type from V17 kind field', () => {
    const result = recallById(db, legacyId);
    expect(result!['type']).toBe('memory_file');
  });

  it('6. returns project field', () => {
    const result = recallById(db, legacyId);
    expect(result!['project']).toBe('my-project');
  });

  it('7. returns null for unknown legacy id (no mapping)', () => {
    const result = recallById(db, 99999);
    expect(result).toBeNull();
  });

  it('8. confidence 1.0 maps to importance 5', () => {
    const { db: db2, legacyId: lid } = buildV37Db({ confidence: 1.0 });
    try {
      const result = recallById(db2, lid);
      expect(result!['importance']).toBe(5);
    } finally {
      db2.close();
    }
  });

  it('9. confidence 0.2 maps to importance 1', () => {
    const { db: db2, legacyId: lid } = buildV37Db({ confidence: 0.2 });
    try {
      const result = recallById(db2, lid);
      expect(result!['importance']).toBe(1);
    } finally {
      db2.close();
    }
  });
});

describe('claudex_recall V17 migration — recall by artifact_ref', () => {
  let db: Database.Database;

  beforeEach(() => {
    const result = buildV37Db({
      kind: 'handoff',
      title: 'Phase 14 handoff',
      body: 'Ship cutover gate after W1-W5 merge.',
      confidence: 0.9,
      project: 'claudex-v3',
      artifactRef: 'context/handoffs/ACTIVE.md',
    });
    db = result.db;
  });

  afterEach(() => {
    db.close();
  });

  it('10. looks up V17 artifact by artifact_ref in data JSON sidecar', () => {
    const result = recallByRef(db, 'context/handoffs/ACTIVE.md');
    expect(result).not.toBeNull();
    expect(result!['type']).toBe('handoff');
  });

  it('11. returns provenance as artifact_ref when present', () => {
    const result = recallByRef(db, 'context/handoffs/ACTIVE.md');
    expect(result!['provenance']).toBe('context/handoffs/ACTIVE.md');
  });

  it('12. returns null for unknown artifact_ref', () => {
    const result = recallByRef(db, 'nonexistent/path.md');
    expect(result).toBeNull();
  });

  it('13. returns backward-compat summary from title', () => {
    const result = recallByRef(db, 'context/handoffs/ACTIVE.md');
    expect(result!['summary']).toBe('Phase 14 handoff');
  });
});

describe('claudex_recall V17 migration — defensive fallback', () => {
  it('14. falls back to legacy artifacts table when artifact_id_map is absent', () => {
    // DB without artifact_id_map (pre-migration state).
    const db = new Database(':memory:');
    initializeSchema(db);

    // Drop artifact_id_map if migration created it.
    try { db.exec('DROP TABLE IF EXISTS artifact_id_map'); } catch { /* non-critical */ }

    // Insert only a legacy artifacts row.
    const result = db.prepare(`
      INSERT INTO artifacts(session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
      VALUES ('s1', 'proj', 'memory_file', null, 'Legacy summary', 'Legacy body', 'fresh', 3600, 4)
    `).run();
    const legacyId = Number(result.lastInsertRowid);

    // V17 lookup returns null (no mapping) but legacy fallback is separate path.
    // Verify that lookupV17ByLegacy correctly returns null.
    const v17Id = lookupV17ByLegacy(db, legacyId);
    expect(v17Id).toBeNull();

    // The legacy fallback query should still find the row.
    const legacyRow = cachedPrepare(db,
      `SELECT id, artifact_type, summary, content, artifact_ref, project, importance
         FROM artifacts WHERE id = ?`
    ).get(legacyId) as {
      id: number; artifact_type: string; summary: string; content: string | null;
      artifact_ref: string | null; project: string; importance: number;
    } | undefined;
    expect(legacyRow).toBeDefined();
    expect(legacyRow!['summary']).toBe('Legacy summary');
    expect(legacyRow!['importance']).toBe(4);

    db.close();
  });
});
