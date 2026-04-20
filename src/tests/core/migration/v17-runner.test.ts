import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runV17Migration } from '../../../core/migration/v17-runner.js';
import { loadSqliteVec } from '../../../core/sqlite-vec-loader.js';
import { writeStaleReview } from '../../../core/migration/stale-review-parser.js';
import type { EmbedderLike } from '../../../core/migration/v17-embed-stage.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-runner-'));
}

/** Deterministic fake embedder: returns a vector derived from the input length. */
function makeFakeEmbedder(): EmbedderLike {
  return {
    embedBatch: async (texts: string[]) =>
      texts.map((t) => Array.from({ length: 1024 }, (_, i) => (t.length + i) / 2048)),
  };
}

/** Embedder that throws — simulates Ollama down. */
function makeFailingEmbedder(): EmbedderLike {
  return { embedBatch: async () => { throw new Error('Ollama unreachable'); } };
}

/** Embedder returning nulls — simulates per-row failure. */
function makeNullEmbedder(): EmbedderLike {
  return { embedBatch: async (texts: string[]) => texts.map(() => null) };
}

function seedV16Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  loadSqliteVec(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT '__global__',
      agent_id TEXT NOT NULL DEFAULT 'default',
      fingerprint TEXT NOT NULL,
      content TEXT NOT NULL,
      promotion_count INTEGER NOT NULL DEFAULT 1,
      first_seen_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      last_promoted_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
      content, tokenize='porter unicode61', content=learnings, content_rowid=id
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__global__',
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS experience_patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL,
      trigger_context TEXT NOT NULL,
      lesson TEXT NOT NULL,
      anti_pattern TEXT,
      severity TEXT NOT NULL DEFAULT 'important',
      score INTEGER NOT NULL DEFAULT 2,
      times_triggered INTEGER NOT NULL DEFAULT 0,
      times_useful INTEGER NOT NULL DEFAULT 0,
      source_session TEXT,
      source_project TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      confidence REAL DEFAULT 0.5
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS experience_patterns_fts USING fts5(
      trigger_context, lesson, anti_pattern, content='experience_patterns', content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS angel_opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      subject TEXT NOT NULL,
      opinion TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      reinforced_count INTEGER NOT NULL DEFAULT 0,
      weakened_count INTEGER NOT NULL DEFAULT 0,
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'inferred',
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS critical_rules (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      variants TEXT,
      source TEXT NOT NULL,
      drift_risk TEXT NOT NULL,
      domain_tags TEXT,
      base_ttl INTEGER NOT NULL,
      current_ttl INTEGER,
      last_injected_turn INTEGER,
      injection_count INTEGER DEFAULT 0,
      violation_count INTEGER DEFAULT 0,
      compliance_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_curated_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      supersedes_id INTEGER REFERENCES project_curated_context(id),
      curator TEXT NOT NULL,
      trust_tier INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active',
      source_session_id TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'fresh',
      ttl INTEGER NOT NULL DEFAULT 3,
      importance INTEGER NOT NULL DEFAULT 3,
      retrieval_score REAL NOT NULL DEFAULT 1.0,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      activation_score REAL NOT NULL DEFAULT 1.0,
      confidence REAL NOT NULL DEFAULT 1.0,
      novelty_score REAL NOT NULL DEFAULT 0.5
    );

    CREATE TABLE IF NOT EXISTS artifact_links (
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      link_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (source_id, target_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(embedding float[1024]);
    CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(summary, content='artifacts', content_rowid=id);
  `);

  db.pragma('user_version = 16');
  return db;
}

function seedRowsIntoV16(db: Database.Database): void {
  db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?,?,?,?)`)
    .run('p', 'crux', 'fp-1', 'learning 1 content');
  db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?,?,?,?)`)
    .run('p', 'crux', 'fp-2', 'learning 2 content Gemma 4 31B');

  db.prepare(`INSERT INTO decisions(session_id, project, content, source, fingerprint) VALUES (?,?,?,?,?)`)
    .run('sess-1', 'p', 'decision 1', 'explicit', 'dfp-1');

  db.prepare(`INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch) VALUES (?,?,?,?,?,?)`)
    .run('uuid-1', 'correction', 'ctx', 'lesson 1', 'p', 1700000000);

  db.prepare(`INSERT INTO angel_opinions(project, subject, opinion) VALUES (?,?,?)`)
    .run('p', 'subj-1', 'op 1');

  db.prepare(`INSERT INTO critical_rules(project, rule_text, source, drift_risk, base_ttl) VALUES (?,?,?,?,?)`)
    .run('p', 'rule 1 text', 'author', 'safety', 10);

  db.prepare(`INSERT INTO project_curated_context(project, type, content, curator, trust_tier) VALUES (?,?,?,?,?)`)
    .run('p', 'mental_model', 'mm 1 content', 'agent', 3);
  db.prepare(`INSERT INTO project_curated_context(project, type, content, curator, trust_tier) VALUES (?,?,?,?,?)`)
    .run('p', 'mental_model', 'Uses Gemma 4 31B locally', 'agent', 2);
}

describe('runV17Migration — happy path', () => {
  let tmp: string;
  let dbPath: string;
  let backupDir: string;
  let staleReview: string;

  beforeEach(() => {
    tmp = mkTempDir();
    dbPath = path.join(tmp, 'source.db');
    backupDir = path.join(tmp, 'backups');
    staleReview = path.join(tmp, 'stale-review.md');
    const db = seedV16Db(dbPath);
    seedRowsIntoV16(db);
    db.close();
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('dry-run produces stale-review.md + stages rows without mutating the DB', async () => {
    const result = await runV17Migration({
      dbPath,
      backupDir,
      staleReviewPath: staleReview,
      embedder: makeFakeEmbedder(),
      dryRun: true,
    });

    expect(result.verdict).toBe('PASS');
    expect(result.stagedCount).toBe(8);
    expect(fs.existsSync(staleReview)).toBe(true);

    // No V17 tables exist on the source DB (write happens on a fresh connection
    // inside Phase B; dry-run never enters Phase B).
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE name='artifact'`).get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('apply migrates all 8 rows into artifact across 6 kinds', async () => {
    // Pre-commit a stale-review.md accepting all heuristic defaults.
    writeStaleReview(staleReview, [
      { legacyId: 2, contentPreview: 'Uses Gemma 4 31B locally', triggers: ['Gemma 4 31B'] },
    ]);

    const result = await runV17Migration({
      dbPath,
      backupDir,
      staleReviewPath: staleReview,
      embedder: makeFakeEmbedder(),
      dryRun: false,
    });

    expect(result.verdict, JSON.stringify(result.errors)).toBe('PASS');
    expect(result.insertedCounts).toEqual({
      learning: 2, decision: 1, experience_pattern: 1,
      angel_opinion: 1, critical_rule: 1, mental_model: 2,
    });

    const db = new Database(dbPath);
    loadSqliteVec(db);
    try {
      const artCount = (db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number }).n;
      expect(artCount).toBe(8);

      // Legacy tables renamed to {name}_old
      for (const tbl of ['learnings_old', 'decisions_old', 'experience_patterns_old',
        'angel_opinions_old', 'critical_rules_old', 'project_curated_context_old']) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tbl);
        expect(exists, `expected ${tbl} to exist`).toBeTruthy();
      }

      // Legacy FTS5 tables dropped
      for (const tbl of ['learnings_fts', 'experience_patterns_fts']) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tbl);
        expect(exists, `expected ${tbl} to be dropped`).toBeFalsy();
      }

      // artifacts_fts still exists (untouched per Amendment 1)
      const artifactsFts = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifacts_fts'`).get();
      expect(artifactsFts).toBeTruthy();

      // artifact_fts MATCH returns hits
      const match = db.prepare(`SELECT a.id FROM artifact_fts f JOIN artifact a ON a.rowid = f.rowid WHERE artifact_fts MATCH ?`).all('lesson') as Array<{ id: string }>;
      expect(match.length).toBeGreaterThan(0);

      // user_version bumped
      const uv = db.pragma('user_version', { simple: true });
      expect(uv).toBe(17);

      // Stale flag applied to the 2nd mental_model row (id=2 in project_curated_context_old)
      const staleCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifact WHERE kind='mental_model' AND status='stale'`).get() as { n: number }).n;
      expect(staleCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('apply ABORTs when stale-review.md is missing', async () => {
    // No file written
    const result = await runV17Migration({
      dbPath,
      backupDir,
      staleReviewPath: staleReview,
      embedder: makeFakeEmbedder(),
      dryRun: false,
    });
    expect(result.verdict).toBe('ABORTED');
    expect(result.errors.some((e) => /stale-review/.test(e))).toBe(true);

    // DB un-migrated
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(16);
    } finally {
      db.close();
    }
  });

  it('ABORTs when embedder throws during staging', async () => {
    writeStaleReview(staleReview, []);
    const result = await runV17Migration({
      dbPath,
      backupDir,
      staleReviewPath: staleReview,
      embedder: makeFailingEmbedder(),
      dryRun: false,
    });
    expect(result.verdict).toBe('ABORTED');
    // DB un-migrated
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(16);
    } finally {
      db.close();
    }
  });

  it('ABORTs when embedder returns null and abortOnEmbedFailure default', async () => {
    writeStaleReview(staleReview, []);
    const result = await runV17Migration({
      dbPath,
      backupDir,
      staleReviewPath: staleReview,
      embedder: makeNullEmbedder(),
      dryRun: false,
    });
    expect(result.verdict).toBe('ABORTED');
  });
});

describe('runV17Migration — view round-trip after migration', () => {
  let tmp: string;
  let dbPath: string;
  let backupDir: string;
  let staleReview: string;

  beforeEach(() => {
    tmp = mkTempDir();
    dbPath = path.join(tmp, 'source.db');
    backupDir = path.join(tmp, 'backups');
    staleReview = path.join(tmp, 'stale-review.md');
    const db = seedV16Db(dbPath);
    seedRowsIntoV16(db);
    db.close();
    writeStaleReview(staleReview, []);
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('v3 callers SELECT * FROM learnings still work after migration', async () => {
    const result = await runV17Migration({
      dbPath, backupDir, staleReviewPath: staleReview,
      embedder: makeFakeEmbedder(), dryRun: false,
    });
    expect(result.verdict).toBe('PASS');

    const db = new Database(dbPath);
    loadSqliteVec(db);
    try {
      const rows = db.prepare('SELECT id, project, agent_id, fingerprint, content FROM learnings ORDER BY id').all() as Array<{
        id: number; project: string; agent_id: string; fingerprint: string; content: string;
      }>;
      expect(rows.length).toBe(2);
      expect(rows[0].project).toBe('p');
      expect(rows[0].agent_id).toBe('crux');
      expect(typeof rows[0].id).toBe('number');
    } finally {
      db.close();
    }
  });

  it('v3 INSERT into learnings view creates an artifact row', async () => {
    const result = await runV17Migration({
      dbPath, backupDir, staleReviewPath: staleReview,
      embedder: makeFakeEmbedder(), dryRun: false,
    });
    expect(result.verdict).toBe('PASS');

    const db = new Database(dbPath);
    loadSqliteVec(db);
    try {
      db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?,?,?,?)`)
        .run('new-proj', 'crux', 'fp-new', 'fresh content');
      const artCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifact WHERE kind='learning'`).get() as { n: number }).n;
      expect(artCount).toBe(3); // 2 migrated + 1 new
    } finally {
      db.close();
    }
  });
});
