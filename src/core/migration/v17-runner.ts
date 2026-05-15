/**
 * V17 migration runner — orchestrates the full V16→V17 sequence.
 *
 * Pipeline:
 *   1. Backup + verify (Plan 02-02 gate).
 *   2. Load / regenerate stale-review.md (Plan 02-03).
 *   3. Phase A — pre-embed staging via Ollama arctic-embed2 (no DB mutation).
 *   4. If dryRun: stop here with PASS verdict.
 *   5. Phase B — single BEGIN IMMEDIATE / COMMIT tx:
 *        - applyV17DDL + rename 6 legacy tables → {name}_old
 *        - drop legacy FTS5 (learnings_fts, experience_patterns_fts)
 *        - Pass 1: INSERT into artifact + legacy_id_map + artifact_embeddings
 *        - Pass 2: resolve mental_model supersedes_id via legacy_id_map
 *        - Pass 3: flag stale rows from parseStaleReview
 *        - apply generated views + triggers
 *        - backfill artifact_fts
 *        - per-kind required-paths validation
 *        - bump user_version to 17
 *   6. Post-migration row-count parity checks.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { applyV17DDL } from './v17-ddl.js';
import { applyGeneratedDDL, generateViewsAndTriggers } from './v17-triggers.js';
import { KIND_MAPPING, type LegacyTable } from './kind-mapping.js';
import {
  stageEmbeddings,
  type StagedRow,
  type EmbedderLike,
} from './v17-embed-stage.js';
import {
  createAndVerifyBackup,
  appendManifestRow,
  rotateBackups,
  backupFileName,
  type VerifyResult,
} from './v17-backup.js';
import { scanStaleRows } from './v17-stale-scan.js';
import {
  writeStaleReview,
  parseStaleReview,
  getStaleIds,
} from './stale-review-parser.js';

export interface RunnerOpts {
  dbPath: string;
  backupDir: string;
  staleReviewPath: string;
  embedder: EmbedderLike;
  /** If true, stop after Phase A (staging). Writes stale-review.md from scan. */
  dryRun: boolean;
  /** Default 'P1' — used for backup filename + manifest phase label. */
  phaseLabel?: string;
  /** Manifest file path. Default `{dirname(staleReviewPath)}/backup-manifest.md`. */
  manifestPath?: string;
}

export interface RunnerResult {
  verdict: 'PASS' | 'FAIL' | 'ABORTED';
  backupResult?: VerifyResult;
  stagedCount?: number;
  insertedCounts?: Record<string, number>;
  errors: string[];
  phase: 'backup' | 'stale-review' | 'stage' | 'phase-b' | 'post-check' | 'done';
}

const P1_LEGACY_TABLES: LegacyTable[] = [
  'learnings',
  'decisions',
  'experience_patterns',
  'angel_opinions',
  'critical_rules',
  'project_curated_context',
];

export async function runV17Migration(opts: RunnerOpts): Promise<RunnerResult> {
  const result: RunnerResult = {
    verdict: 'FAIL',
    errors: [],
    phase: 'backup',
  };
  const phaseLabel = opts.phaseLabel ?? 'P1';
  const manifestPath =
    opts.manifestPath ?? path.join(path.dirname(opts.staleReviewPath), 'backup-manifest.md');

  // ── Step 1: Backup + verify ─────────────────────────────────────────
  const kind: 'real' | 'dry-run' = opts.dryRun ? 'dry-run' : 'real';
  const backupFile = path.join(opts.backupDir, backupFileName(phaseLabel, kind));

  // Rotate BEFORE create (never at verify-fail time).
  try {
    rotateBackups(opts.backupDir, phaseLabel, kind, 5);
  } catch (err) {
    // Rotation failure is non-fatal for the migration — just log.
    result.errors.push(`rotate warn: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const backup = await createAndVerifyBackup(opts.dbPath, backupFile, {
      legacyTables: [...P1_LEGACY_TABLES, 'artifacts', 'artifact_links'],
      anyVec0Table: 'vec_artifacts',
    });
    appendManifestRow(manifestPath, backup, phaseLabel, kind);
    result.backupResult = backup;
    if (backup.verdict !== 'PASS') {
      result.errors.push('backup verifier failed; aborting before DB mutation');
      result.verdict = 'FAIL';
      return result;
    }
  } catch (err) {
    result.errors.push(`backup stage: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // ── Step 2: Stale-review gate ───────────────────────────────────────
  result.phase = 'stale-review';
  let staleIds: Set<number> = new Set();

  if (opts.dryRun) {
    // Dry-run regenerates the file from a fresh scan.
    try {
      const db = new Database(opts.dbPath, { readonly: true });
      try {
        const matches = scanStaleRows(db);
        writeStaleReview(opts.staleReviewPath, matches);
      } finally {
        db.close();
      }
    } catch (err) {
      result.errors.push(`stale-review write: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  } else {
    // Apply mode requires the file to exist on disk with valid structure.
    try {
      const parsed = parseStaleReview(opts.staleReviewPath);
      staleIds = getStaleIds(parsed);
    } catch (err) {
      result.errors.push(`stale-review parse: ${err instanceof Error ? err.message : String(err)}`);
      result.verdict = 'ABORTED';
      return result;
    }
  }

  // ── Step 3: Phase A staging ─────────────────────────────────────────
  result.phase = 'stage';
  let staged: StagedRow[] = [];
  try {
    const stageDb = new Database(opts.dbPath, { readonly: true });
    try {
      staged = await stageEmbeddings(stageDb, opts.embedder, { batchSize: 32 });
    } finally {
      stageDb.close();
    }
    result.stagedCount = staged.length;
  } catch (err) {
    result.errors.push(`stage: ${err instanceof Error ? err.message : String(err)}`);
    result.verdict = 'ABORTED';
    return result;
  }

  // Dry-run ends here.
  if (opts.dryRun) {
    result.verdict = 'PASS';
    result.phase = 'done';
    return result;
  }

  // ── Step 5: Phase B — atomic tx ─────────────────────────────────────
  result.phase = 'phase-b';
  const db = new Database(opts.dbPath);

  try {
    // Pre-count legacy rows for post-check parity.
    const preCounts: Record<string, number> = {};
    for (const tbl of P1_LEGACY_TABLES) {
      try {
        preCounts[tbl] = (db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get() as { n: number }).n;
      } catch {
        preCounts[tbl] = 0;
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // 5a. DDL (kernel + registry + map + vec0 + fts5 + indexes)
      applyV17DDL(db);

      // 5b. Rename legacy tables → {name}_old
      for (const tbl of P1_LEGACY_TABLES) {
        const exists = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(tbl);
        if (exists) {
          db.exec(`ALTER TABLE ${tbl} RENAME TO ${tbl}_old`);
        }
      }

      // 5c. Drop legacy FTS5 tables + their 3 sync triggers each (Amendment 4)
      db.exec(`
        DROP TRIGGER IF EXISTS learnings_fts_ai;
        DROP TRIGGER IF EXISTS learnings_fts_au;
        DROP TRIGGER IF EXISTS learnings_fts_ad;
        DROP TABLE IF EXISTS learnings_fts;

        DROP TRIGGER IF EXISTS experience_patterns_ai;
        DROP TRIGGER IF EXISTS experience_patterns_au;
        DROP TRIGGER IF EXISTS experience_patterns_ad;
        DROP TABLE IF EXISTS experience_patterns_fts;
      `);

      // 5d. Pass 1: INSERT artifact rows + legacy_id_map + artifact_embeddings
      const insertedCounts: Record<string, number> = {};
      const insertArtifactStmt = db.prepare(`
        INSERT INTO artifact(
          id, kind, title, body, scope, status, confidence,
          created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMapStmt = db.prepare(`
        INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
        VALUES (?, ?, ?)
      `);
      const insertEmbStmt = db.prepare(`
        INSERT INTO artifact_embeddings(rowid, embedding) VALUES (?, ?)
      `);
      const updateEmbRefStmt = db.prepare(`
        UPDATE artifact SET embedding_ref = ? WHERE id = ?
      `);

      let vecRowid = 1n;
      for (const s of staged) {
        const newId =
          s.kind === 'experience_pattern' && typeof s.legacyId === 'string'
            ? s.legacyId
            : randomUuid();

        const legacyCreatedMs = msFromLegacyRow(s);
        const legacyUpdatedMs = legacyCreatedMs;

        insertArtifactStmt.run(
          newId,
          s.kind,
          s.composed.title,
          s.composed.body,
          s.composed.scope,
          s.composed.status,
          s.composed.confidence,
          legacyCreatedMs,
          legacyUpdatedMs,
          s.composed.session_id,
          s.composed.project_id,
          JSON.stringify(s.composed.data ?? {}),
        );

        if (s.kind !== 'experience_pattern') {
          insertMapStmt.run(s.legacyTable, s.legacyId as number, newId);
        }

        if (s.embedding) {
          insertEmbStmt.run(vecRowid, s.embedding);
          updateEmbRefStmt.run(Number(vecRowid), newId);
          vecRowid += 1n;
        }

        insertedCounts[s.kind] = (insertedCounts[s.kind] ?? 0) + 1;
      }
      result.insertedCounts = insertedCounts;

      // 5e. Pass 2: resolve mental_model supersedes_id via legacy_id_map
      db.exec(`
        UPDATE artifact
        SET supersedes_id = (
          SELECT m.new_uuid FROM legacy_id_map m
          WHERE m.legacy_table = 'project_curated_context'
            AND m.legacy_id = CAST(json_extract(artifact.data, '$._legacy_supersedes_id') AS INTEGER)
        )
        WHERE kind = 'mental_model'
          AND json_extract(data, '$._legacy_supersedes_id') IS NOT NULL;

        UPDATE artifact
        SET data = json_remove(data, '$._legacy_supersedes_id')
        WHERE kind = 'mental_model'
          AND json_extract(data, '$._legacy_supersedes_id') IS NOT NULL;
      `);

      // 5f. Pass 3: flag stale rows per stale-review.md
      if (staleIds.size > 0) {
        const flagStmt = db.prepare(`
          UPDATE artifact SET status = 'stale'
          WHERE id = (
            SELECT new_uuid FROM legacy_id_map
            WHERE legacy_table = 'project_curated_context' AND legacy_id = ?
          )
        `);
        for (const lid of staleIds) flagStmt.run(lid);
      }

      // 5g. Apply generated views + INSTEAD OF triggers
      applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING));

      // 5h. Backfill artifact_fts from artifact (fresh FTS5 index)
      db.exec(`INSERT INTO artifact_fts(rowid, title, body)
                 SELECT rowid, COALESCE(title, ''), body FROM artifact`);

      // 5i. Validation pass — per-kind required paths must be present.
      const malformed = db.prepare(`
        SELECT id, kind FROM artifact WHERE
          (kind='learning' AND (body IS NULL OR json_extract(data, '$.fingerprint') IS NULL))
          OR (kind='decision' AND (body IS NULL OR json_extract(data, '$.fingerprint') IS NULL))
          OR (kind='experience_pattern' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.pattern_type') IS NULL))
          OR (kind='angel_opinion' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.subject') IS NULL))
          OR (kind='critical_rule' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.drift_risk') IS NULL))
          OR (kind='mental_model' AND (body IS NULL OR json_extract(data, '$.type') IS NULL OR json_extract(data, '$.curator') IS NULL))
      `).all() as Array<{ id: string; kind: string }>;
      if (malformed.length > 0) {
        throw new Error(
          `validation pass failed: ${malformed.length} rows missing required fields (first 3: ${JSON.stringify(malformed.slice(0, 3))})`,
        );
      }

      // 5j. Bump schema version
      db.pragma('user_version = 17');
      db.prepare('INSERT OR IGNORE INTO schema_versions(version) VALUES (17)').run();

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // ── Step 6: post-check parity ─────────────────────────────────────
    result.phase = 'post-check';
    const postByKind = (
      db.prepare(`SELECT kind, COUNT(*) AS n FROM artifact GROUP BY kind`).all() as Array<{ kind: string; n: number }>
    ).reduce<Record<string, number>>((acc, r) => ((acc[r.kind] = r.n), acc), {});

    const expectedByKind: Record<string, number> = {};
    for (const tbl of P1_LEGACY_TABLES) {
      expectedByKind[KIND_MAPPING[tbl].kind] = preCounts[tbl] ?? 0;
    }
    for (const kindName of Object.keys(expectedByKind)) {
      const want = expectedByKind[kindName];
      const got = postByKind[kindName] ?? 0;
      if (got !== want) {
        result.errors.push(`post-check parity: kind=${kindName} want=${want} got=${got}`);
      }
    }

    result.verdict = result.errors.length === 0 ? 'PASS' : 'FAIL';
    result.phase = 'done';
    return result;
  } catch (err) {
    result.errors.push(`phase-b: ${err instanceof Error ? err.message : String(err)}`);
    result.verdict = 'FAIL';
    return result;
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function randomUuid(): string {
  // SQLite's `lower(hex(randomblob(16)))` is 32 hex chars — the canonical
  // claudex uuid shape used throughout artifact + legacy_id_map rows.
  const bytes = new Uint8Array(16);
  // Prefer crypto.randomFillSync when available (Node), else Math-based fallback.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as typeof import('node:crypto');
    crypto.randomFillSync(bytes);
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function msFromLegacyRow(s: StagedRow): number {
  // Legacy tables store time in seconds; kernel is ms. Prefer created_at_epoch
  // when available; fall back to first_seen_epoch (learnings) or current time.
  const row = s.legacyRow;
  const candidates = [
    'created_at_epoch',
    'first_seen_epoch',
    'timestamp_epoch',
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v) * 1000;
  }
  return Date.now();
}
