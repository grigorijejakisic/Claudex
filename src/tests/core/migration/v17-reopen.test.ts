/**
 * Regression test for the 2026-04-20 → 2026-04-24 session_events-write
 * outage (plan 04-07). The V15→V16 migration step calls
 *
 *   CREATE INDEX IF NOT EXISTS idx_pcc_project_status
 *     ON project_curated_context(project, status);
 *
 * which throws `views may not be indexed` once V17 has replaced the table
 * with a view. `initializeSchema` re-ran that step unconditionally on every
 * hook re-open, escaping to `wrapHook`'s top-level catch and turning every
 * CC hook into a silent no-op.
 *
 * This fixture migrates a fresh DB through to V17 exactly as prod does, then
 * re-opens via `openDatabase` and asserts:
 *   (a) open does not throw
 *   (b) session_events INSERT succeeds through the re-opened handle
 *   (c) user_version stays at 17 (not demoted back to 16)
 *
 * Without this test the 2556-test suite missed the bug because all migration
 * tests use fresh `:memory:` or temp DBs and never exercise the post-V17
 * re-open path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runV17Migration } from '../../../core/migration/v17-runner.js';
import { loadSqliteVec } from '../../../core/sqlite-vec-loader.js';
import { openDatabase } from '../../../core/storage.js';
import { writeStaleReview } from '../../../core/migration/stale-review-parser.js';
import type { EmbedderLike } from '../../../core/migration/v17-embed-stage.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-reopen-'));
}

function makeFakeEmbedder(): EmbedderLike {
  return {
    embedBatch: async (texts: string[]) =>
      texts.map((t) => Array.from({ length: 1024 }, (_, i) => (t.length + i) / 2048)),
  };
}

/**
 * Seeds a V16 DB. Copied from v17-runner.test.ts to keep this fixture
 * self-contained (out-of-scope to refactor the shared helper).
 */
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

    -- session_events lives outside the V17 consolidation (hook-written
    -- observability table; not one of the 6 legacy knowledge tables).
    -- Prod DBs have this from the V12→V13 migration step; mirror here so
    -- the re-open test can exercise the real write path.
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  db.pragma('user_version = 16');
  return db;
}

function seedMinimalRowsIntoV16(db: Database.Database): void {
  // One row per kind — enough for the V17 runner to succeed without tripping
  // empty-table guards, but not so many that runtime bloats.
  db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?,?,?,?)`)
    .run('p', 'crux', 'fp-1', 'learning 1 content');
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
}

describe('initializeSchema idempotency — post-V17 re-open', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(async () => {
    tmp = mkTempDir();
    dbPath = path.join(tmp, 'source.db');
    const db = seedV16Db(dbPath);
    seedMinimalRowsIntoV16(db);
    db.close();

    // V17 runner requires a pre-committed stale-review.md (normally produced
    // by the dry-run). Seed an empty one so `apply` mode accepts all defaults.
    const staleReviewPath = path.join(tmp, 'stale.md');
    writeStaleReview(staleReviewPath, []);

    const result = await runV17Migration({
      dbPath,
      backupDir: path.join(tmp, 'backups'),
      staleReviewPath,
      embedder: makeFakeEmbedder(),
      dryRun: false,
    });

    if (result.verdict !== 'PASS') {
      throw new Error(`V17 setup failed: ${JSON.stringify(result.errors)}`);
    }
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('openDatabase does not throw on a post-V17 DB', () => {
    let db: Database.Database | null = null;
    expect(() => {
      db = openDatabase(dbPath);
    }).not.toThrow();
    if (db) (db as Database.Database).close();
  });

  it('session_events INSERT succeeds through a re-opened handle', () => {
    const db = openDatabase(dbPath);
    try {
      const result = db.prepare(`
        INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-session', 'p', 'test_event', 'test_entity', 'test_action', null);
      expect(result.changes).toBe(1);

      const row = db.prepare(`SELECT COUNT(*) as n FROM session_events WHERE session_id = ?`)
        .get('test-session') as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('user_version reaches current TARGET_VERSION after openDatabase (V17→V21 promotion via runMigrations)', () => {
    // Phase 4.1 raised TARGET_VERSION 16→18; Phase 5.5 raised it to 19; Phase
    // 6 raised it to 20; Phase 6.5 raised it to 21 (artifact_task_pattern
    // sidecar + telemetry +cross_project_*). The original 04-07 regression
    // — silent demotion — must still be prevented.
    const db = openDatabase(dbPath);
    try {
      const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(uv).toBe(23);
    } finally {
      db.close();
    }
  });
});
