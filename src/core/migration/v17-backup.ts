/**
 * V17 migration backup verifier.
 *
 * Per 02-CONTEXT.md Decision 10:
 *   Create DB backup via better-sqlite3 Database.backup() native API, then run
 *   6 sequential checks. Any FAIL short-circuits the gate; migration aborts
 *   before touching real tables.
 *
 * Non-goals:
 *   - Not responsible for *running* the migration. Just proves the backup is
 *     restorable and the live DB is healthy enough to proceed.
 *   - Not responsible for rotation scheduling. Caller invokes rotateBackups()
 *     at backup-create time (never at verify-fail time).
 *
 * Retention: 5 newest per phase per kind (real | dry-run).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { loadSqliteVec } from '../sqlite-vec-loader.js';

export type BackupKind = 'real' | 'dry-run';

export type CheckName =
  | 'create'
  | 'reopen_with_vec'
  | 'integrity_check'
  | 'quick_check'
  | 'parity'
  | 'vec0_smoke';

export interface VerifyCheck {
  name: CheckName;
  passed: boolean;
  error?: string;
  detail?: string;
  durationMs: number;
}

export interface VerifyResult {
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  checks: VerifyCheck[];
  verdict: 'PASS' | 'FAIL';
  totalMs: number;
}

export interface VerifyOpts {
  /**
   * Legacy tables to parity-check between source and backup.
   * Expected: the 6 P1 legacy tables + 'artifacts' + 'artifact_links'.
   * Non-existing tables count as 0/0 (match).
   */
  legacyTables: string[];
  /** Vec0 table used for smoke-query. Default 'vec_artifacts'. */
  anyVec0Table?: string;
}

/**
 * Native backup + 6-check verify.
 *
 * Caller is responsible for:
 *   - ensuring backupPath's parent dir exists
 *   - closing any open write handles to sourcePath (better-sqlite3 Database.backup
 *     is safe against concurrent readers but a writer would lock us out)
 */
export async function createAndVerifyBackup(
  sourcePath: string,
  backupPath: string,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  const totalStart = Date.now();
  const checks: VerifyCheck[] = [];
  let sha256 = '';
  let sizeBytes = 0;
  let shortCircuited = false;

  const parentDir = path.dirname(backupPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // ─── Check 1: create ─────────────────────────────────────────────
  let srcDb: Database.Database | null = null;
  {
    const t0 = Date.now();
    try {
      srcDb = new Database(sourcePath, { readonly: true });
      await srcDb.backup(backupPath);
      sizeBytes = fs.statSync(backupPath).size;
      checks.push({
        name: 'create',
        passed: true,
        detail: `${sizeBytes} bytes`,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      checks.push({
        name: 'create',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      shortCircuited = true;
    } finally {
      if (srcDb) {
        try { srcDb.close(); } catch { /* best-effort */ }
        srcDb = null;
      }
    }
  }

  // ─── Check 2: reopen_with_vec ────────────────────────────────────
  let backupDb: Database.Database | null = null;
  if (!shortCircuited) {
    const t0 = Date.now();
    try {
      backupDb = new Database(backupPath);
      const loaded = loadSqliteVec(backupDb);
      if (!loaded) {
        throw new Error('sqlite-vec extension failed to load on backup connection');
      }
      checks.push({
        name: 'reopen_with_vec',
        passed: true,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      checks.push({
        name: 'reopen_with_vec',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      shortCircuited = true;
      if (backupDb) {
        try { backupDb.close(); } catch { /* best-effort */ }
        backupDb = null;
      }
    }
  }

  // ─── Check 3: integrity_check ────────────────────────────────────
  if (!shortCircuited && backupDb) {
    const t0 = Date.now();
    try {
      const result = backupDb.pragma('integrity_check', { simple: true }) as string;
      const ok = result === 'ok';
      checks.push({
        name: 'integrity_check',
        passed: ok,
        detail: result,
        durationMs: Date.now() - t0,
        ...(ok ? {} : { error: `integrity_check returned: ${result}` }),
      });
      if (!ok) shortCircuited = true;
    } catch (err) {
      checks.push({
        name: 'integrity_check',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      shortCircuited = true;
    }
  }

  // ─── Check 4: quick_check ────────────────────────────────────────
  if (!shortCircuited && backupDb) {
    const t0 = Date.now();
    try {
      const result = backupDb.pragma('quick_check', { simple: true }) as string;
      const ok = result === 'ok';
      checks.push({
        name: 'quick_check',
        passed: ok,
        detail: result,
        durationMs: Date.now() - t0,
        ...(ok ? {} : { error: `quick_check returned: ${result}` }),
      });
      if (!ok) shortCircuited = true;
    } catch (err) {
      checks.push({
        name: 'quick_check',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      shortCircuited = true;
    }
  }

  // ─── Check 5: parity ─────────────────────────────────────────────
  if (!shortCircuited && backupDb) {
    const t0 = Date.now();
    try {
      const srcCheckDb = new Database(sourcePath, { readonly: true });
      const mismatches: string[] = [];
      for (const tbl of opts.legacyTables) {
        const srcCount = tableCount(srcCheckDb, tbl);
        const bakCount = tableCount(backupDb, tbl);
        if (srcCount !== bakCount) {
          mismatches.push(`${tbl}: src=${srcCount} bak=${bakCount}`);
        }
      }
      srcCheckDb.close();
      if (mismatches.length === 0) {
        checks.push({
          name: 'parity',
          passed: true,
          detail: `${opts.legacyTables.length} tables matched`,
          durationMs: Date.now() - t0,
        });
      } else {
        checks.push({
          name: 'parity',
          passed: false,
          error: `parity mismatch: ${mismatches.join('; ')}`,
          durationMs: Date.now() - t0,
        });
        shortCircuited = true;
      }
    } catch (err) {
      checks.push({
        name: 'parity',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      shortCircuited = true;
    }
  }

  // ─── Check 6: vec0_smoke ─────────────────────────────────────────
  if (!shortCircuited && backupDb) {
    const t0 = Date.now();
    const vecTable = opts.anyVec0Table ?? 'vec_artifacts';
    try {
      // Existence check first — missing table is not a vec0 failure, just skip.
      const exists = backupDb
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get(vecTable);
      if (!exists) {
        checks.push({
          name: 'vec0_smoke',
          passed: true,
          detail: `${vecTable} does not exist; skipped`,
          durationMs: Date.now() - t0,
        });
      } else {
        const row = backupDb.prepare(`SELECT COUNT(*) AS n FROM ${vecTable}`).get() as { n: number };
        checks.push({
          name: 'vec0_smoke',
          passed: true,
          detail: `${vecTable}: ${row.n} rows`,
          durationMs: Date.now() - t0,
        });
      }
    } catch (err) {
      checks.push({
        name: 'vec0_smoke',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
    }
  }

  // Close backup handle before SHA-256 (Windows file-lock safety)
  if (backupDb) {
    try { backupDb.close(); } catch { /* best-effort */ }
    backupDb = null;
  }

  // Compute SHA-256 only if file exists — otherwise leave empty + fail verdict.
  if (fs.existsSync(backupPath)) {
    sha256 = await sha256File(backupPath);
  }

  const verdict: 'PASS' | 'FAIL' = checks.every((c) => c.passed) && checks.length === 6 ? 'PASS' : 'FAIL';
  return {
    backupPath,
    sha256,
    sizeBytes,
    checks,
    verdict,
    totalMs: Date.now() - totalStart,
  };
}

function tableCount(db: Database.Database, tbl: string): number {
  try {
    // Not all tables exist on every schema version; treat missing as 0.
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(tbl);
    if (!exists) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Manifest + Rotation ──────────────────────────────────────────────

const MANIFEST_HEADER = `# P1 Backup Manifest

Audit trail for \`~/.claudex/backups/pre-v4-P1-*.db\` files. \`.db\` binaries are
gitignored; this file is git-tracked.

| timestamp | path | size_bytes | sha256 | integrity | quick | parity | vec0 | total_ms | verdict |
|---|---|---|---|---|---|---|---|---|---|
`;

/**
 * Append a markdown table row describing a verify result.
 * Creates the manifest file with header if missing.
 */
export function appendManifestRow(
  manifestPath: string,
  result: VerifyResult,
  _phaseLabel: string,
  _kind: BackupKind,
): void {
  const parentDir = path.dirname(manifestPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, MANIFEST_HEADER, 'utf8');
  }

  const pickStatus = (name: CheckName): string => {
    const c = result.checks.find((x) => x.name === name);
    if (!c) return '-';
    return c.passed ? 'ok' : 'FAIL';
  };

  const ts = new Date().toISOString();
  const row = `| ${ts} | ${result.backupPath} | ${result.sizeBytes} | ${result.sha256.slice(0, 16)}... | ${pickStatus(
    'integrity_check',
  )} | ${pickStatus('quick_check')} | ${pickStatus('parity')} | ${pickStatus('vec0_smoke')} | ${result.totalMs} | ${result.verdict} |\n`;
  fs.appendFileSync(manifestPath, row, 'utf8');
}

/**
 * Rotation: keep `keep` newest backups matching the phase + kind pattern.
 * Delete the rest. Returns deleted paths.
 *
 * Matches files: `pre-v4-{phaseLabel}[-dry]-*.db` in `backupDir`.
 */
export function rotateBackups(
  backupDir: string,
  phaseLabel: string,
  kind: BackupKind,
  keep: number = 5,
): string[] {
  if (!fs.existsSync(backupDir)) return [];
  const prefix = kind === 'dry-run' ? `pre-v4-${phaseLabel}-dry-` : `pre-v4-${phaseLabel}-`;
  const suffix = '.db';

  const entries = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    // Exclude the other kind. For real: exclude any file whose prefix is `pre-v4-{phase}-dry-`.
    .filter((name) => {
      if (kind === 'real') {
        return !name.startsWith(`pre-v4-${phaseLabel}-dry-`);
      }
      return true;
    })
    .map((name) => {
      const full = path.join(backupDir, name);
      return { name, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const toDelete = entries.slice(keep);
  const deleted: string[] = [];
  for (const entry of toDelete) {
    try {
      fs.unlinkSync(entry.full);
      deleted.push(entry.full);
    } catch {
      // best-effort rotation; surface nothing
    }
  }
  return deleted;
}

/**
 * Build the canonical backup file name for a given phase + kind + timestamp.
 * Example: `pre-v4-P1-1745145296000.db` or `pre-v4-P1-dry-1745145296000.db`.
 */
export function backupFileName(phaseLabel: string, kind: BackupKind, epochMs: number = Date.now()): string {
  return kind === 'dry-run'
    ? `pre-v4-${phaseLabel}-dry-${epochMs}.db`
    : `pre-v4-${phaseLabel}-${epochMs}.db`;
}
