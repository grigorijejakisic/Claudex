/**
 * DIAG-05: SQLite DB schema check.
 *
 * Opens ~/.claudex/db/claudex.db readonly, reads PRAGMA user_version,
 * and compares against the build's expected TARGET_USER_VERSION. Reports
 * fail when missing, older (run setup), or newer (update Claudex). Doctor
 * never migrates — diagnose-only.
 */

import * as fs from 'fs';
import Database from 'better-sqlite3';
import type { CheckFn } from './types.js';
import { getDbPath } from '../shared/paths.js';
import { TARGET_USER_VERSION } from '../core/migrations.js';

export const checkDb: CheckFn = async () => {
  const dbPath = getDbPath();

  if (!fs.existsSync(dbPath)) {
    return {
      name: 'DB schema',
      status: 'fail',
      detail: `DB not found at ${dbPath}`,
      remediation: "DB not initialized. Run 'bun run setup'.",
    };
  }

  let actual: number;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.pragma('user_version') as Array<{ user_version: number }>;
    actual = row[0]?.user_version ?? 0;
  } catch (err) {
    return {
      name: 'DB schema',
      status: 'fail',
      detail: `Could not read user_version: ${(err as Error).message}`,
      remediation: 'DB may be corrupted. Restore from backup or run bun run setup on a fresh path.',
    };
  } finally {
    if (db) db.close();
  }

  if (actual === TARGET_USER_VERSION) {
    return {
      name: 'DB schema',
      status: 'pass',
      detail: `user_version=${actual}`,
    };
  }

  if (actual < TARGET_USER_VERSION) {
    return {
      name: 'DB schema',
      status: 'fail',
      detail: `DB schema v${actual} < build v${TARGET_USER_VERSION}`,
      remediation: "Run 'bun run setup' to migrate the DB to the current schema.",
    };
  }

  return {
    name: 'DB schema',
    status: 'fail',
    detail: `DB schema v${actual} > build v${TARGET_USER_VERSION}`,
    remediation: 'Your DB is newer than this build. Update Claudex: git pull && bun run build.',
  };
};
