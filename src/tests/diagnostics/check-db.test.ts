import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

let mockDbPath = '';

vi.mock('../../shared/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/paths.js')>('../../shared/paths.js');
  return {
    ...actual,
    getDbPath: () => mockDbPath,
  };
});

import { checkDb } from '../../diagnostics/check-db.js';
import { TARGET_USER_VERSION } from '../../core/migrations.js';

let tmpDir = '';

function newDbWithUserVersion(version: number): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-doctor-db-'));
  const dbFile = path.join(tmpDir, 'claudex.db');
  const db = new Database(dbFile);
  db.pragma(`user_version = ${version}`);
  db.close();
  return dbFile;
}

describe('checkDb', () => {
  beforeEach(() => {
    mockDbPath = '';
    tmpDir = '';
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('passes when DB user_version === TARGET_USER_VERSION', async () => {
    mockDbPath = newDbWithUserVersion(TARGET_USER_VERSION);
    const result = await checkDb();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe(`user_version=${TARGET_USER_VERSION}`);
    expect(result.remediation).toBeUndefined();
  });

  it('fails when DB file is missing', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-doctor-db-'));
    mockDbPath = path.join(tmpDir, 'does-not-exist.db');
    const result = await checkDb();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('DB not found');
    expect(result.remediation).toContain('bun run setup');
  });

  it('fails when DB schema is older than build', async () => {
    mockDbPath = newDbWithUserVersion(TARGET_USER_VERSION - 1);
    const result = await checkDb();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`v${TARGET_USER_VERSION - 1}`);
    expect(result.detail).toContain('<');
    expect(result.remediation).toContain('bun run setup');
  });

  it('fails when DB schema is newer than build', async () => {
    mockDbPath = newDbWithUserVersion(TARGET_USER_VERSION + 1);
    const result = await checkDb();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`v${TARGET_USER_VERSION + 1}`);
    expect(result.detail).toContain('>');
    expect(result.remediation).toContain('git pull');
  });
});
