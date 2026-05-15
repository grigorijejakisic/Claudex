import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';

function openFreshDb(): Database.Database {
  return new Database(':memory:');
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name);
  return !!row;
}

describe('applyV17DDL', () => {
  let db: Database.Database;

  beforeEach(() => { db = openFreshDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('creates artifact, kind_registry, legacy_id_map, artifact_embeddings, artifact_fts', () => {
    applyV17DDL(db);
    expect(tableExists(db, 'artifact')).toBe(true);
    expect(tableExists(db, 'kind_registry')).toBe(true);
    expect(tableExists(db, 'legacy_id_map')).toBe(true);
    expect(tableExists(db, 'artifact_embeddings')).toBe(true);
    expect(tableExists(db, 'artifact_fts')).toBe(true);
  });

  it('is idempotent — second call does not throw', () => {
    applyV17DDL(db);
    expect(() => applyV17DDL(db)).not.toThrow();
  });

  it('artifact kernel has expected columns in order', () => {
    applyV17DDL(db);
    const cols = (db.pragma('table_info(artifact)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'kind', 'title', 'body', 'scope', 'status', 'confidence',
      'created_at_epoch_ms', 'updated_at_epoch_ms', 'session_id', 'project',
      'embedding_ref', 'supersedes_id', 'data',
    ]);
  });

  it('kind_registry trigger fires on INSERT and updates last_seen_epoch_ms on conflict', () => {
    applyV17DDL(db);
    db.prepare(`
      INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run('a1', 'learning', 'content 1', 1000, 1000);

    const reg1 = db.prepare('SELECT * FROM kind_registry WHERE kind = ?').get('learning') as {
      kind: string;
      first_seen_epoch_ms: number;
      last_seen_epoch_ms: number;
    };
    expect(reg1.first_seen_epoch_ms).toBe(1000);
    expect(reg1.last_seen_epoch_ms).toBe(1000);

    db.prepare(`
      INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run('a2', 'learning', 'content 2', 2000, 2000);

    const reg2 = db.prepare('SELECT * FROM kind_registry WHERE kind = ?').get('learning') as {
      kind: string;
      first_seen_epoch_ms: number;
      last_seen_epoch_ms: number;
    };
    expect(reg2.first_seen_epoch_ms).toBe(1000); // unchanged
    expect(reg2.last_seen_epoch_ms).toBe(2000); // updated
  });

  it('data CHECK constraint rejects invalid JSON', () => {
    applyV17DDL(db);
    const stmt = db.prepare(`
      INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() => stmt.run('a1', 'learning', 'b', 0, 0, 'not valid json')).toThrow();
  });

  it('data CHECK accepts valid JSON and default {}', () => {
    applyV17DDL(db);
    // Default — no data column
    db.prepare(`
      INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run('a1', 'learning', 'b', 0, 0);
    // Explicit
    db.prepare(`
      INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('a2', 'learning', 'b', 0, 0, '{"x":1}');

    const rows = db.prepare('SELECT id, data FROM artifact ORDER BY id').all() as Array<{ id: string; data: string }>;
    expect(rows[0].data).toBe('{}');
    expect(JSON.parse(rows[1].data)).toEqual({ x: 1 });
  });

  it('artifact_fts AFTER INSERT trigger populates the fts5 index', () => {
    applyV17DDL(db);
    db.prepare(`
      INSERT INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('a1', 'learning', 'jose library', 'JWT auth with refresh rotation using jose', 0, 0);

    const hits = db.prepare(`
      SELECT a.id FROM artifact_fts f
      JOIN artifact a ON a.rowid = f.rowid
      WHERE artifact_fts MATCH ?
    `).all('jose') as Array<{ id: string }>;
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('a1');
  });

  it('artifact_fts AFTER DELETE trigger removes from the fts5 index', () => {
    applyV17DDL(db);
    db.prepare(`
      INSERT INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('a1', 'learning', 'keyword-foo', 'body foo', 0, 0);
    db.prepare('DELETE FROM artifact WHERE id = ?').run('a1');
    const hits = db.prepare(`SELECT COUNT(*) AS n FROM artifact_fts WHERE artifact_fts MATCH 'foo'`).get() as { n: number };
    expect(hits.n).toBe(0);
  });

  it('kind naming-convention lint: all inserted kinds match lowercase_snake_case_singular', () => {
    applyV17DDL(db);
    const kinds = ['learning', 'decision', 'experience_pattern', 'angel_opinion', 'critical_rule', 'mental_model'];
    for (const k of kinds) {
      db.prepare(`
        INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(k + '-id', k, 'body', 0, 0);
    }
    const rows = (db.prepare('SELECT DISTINCT kind FROM artifact').all() as Array<{ kind: string }>).map((r) => r.kind);
    for (const k of rows) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('expression indexes exist on artifact', () => {
    applyV17DDL(db);
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifact'`).all() as Array<{ name: string }>).map((r) => r.name);
    for (const want of [
      'idx_artifact_kind',
      'idx_artifact_project',
      'idx_artifact_status',
      'idx_artifact_learning_agent',
      'uq_artifact_learning',
      'uq_artifact_decision',
      'idx_artifact_decision_session',
      'idx_artifact_expat_score',
      'idx_artifact_expat_project_score',
      'uq_artifact_opinion',
      'idx_artifact_opinion_confidence',
      'idx_artifact_critrule_source',
      'uq_artifact_critrule_dedup',
      'idx_artifact_mentalmodel_status',
      'idx_artifact_mentalmodel_type',
    ]) {
      expect(indexes).toContain(want);
    }
  });

  it('uq_artifact_learning UNIQUE partial index enforces dedup', () => {
    applyV17DDL(db);
    db.prepare(`
      INSERT INTO artifact(id, kind, body, project, created_at_epoch_ms, updated_at_epoch_ms, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('a1', 'learning', 'b', 'proj', 0, 0, JSON.stringify({ agent_id: 'x', fingerprint: 'fp1' }));

    expect(() => {
      db.prepare(`
        INSERT INTO artifact(id, kind, body, project, created_at_epoch_ms, updated_at_epoch_ms, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('a2', 'learning', 'b2', 'proj', 0, 0, JSON.stringify({ agent_id: 'x', fingerprint: 'fp1' }));
    }).toThrow();
  });
});
