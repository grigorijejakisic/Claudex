/**
 * Unit tests for the Angel memory monitor's Angel-managed-file guard
 * (Plan 04-04-04). The monitor's legacy prune-down pass must continue to
 * work for CC-managed files but must NOT touch files carrying the Angel
 * sentinel on line 1 — those are owned by `src/angel/memory-md-writer.ts`.
 *
 * The memory monitor resolves `CC_PROJECTS_DIR` from `os.homedir()` at
 * module-load time, so these tests set HOME/USERPROFILE BEFORE the module
 * is imported (via dynamic `await import`) and reset the module registry
 * between cases via `vi.resetModules`.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../../core/migrations.js';
import { pathToCcSlug } from '../../shared/cc-slug.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

const PROJECT_PATH = '/tmp/test/mm-proj';
const PROJECT_NAME = 'mm-proj';
const SLUG = pathToCcSlug(PROJECT_PATH);

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  initializeSchema(d);
  return d;
}

function writeRegistry(): void {
  const registryDir = path.join(tmpHome, '.claudex');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'projects.json'),
    JSON.stringify({ projects: { [PROJECT_NAME]: { path: PROJECT_PATH } } }),
  );
}

function memoryDir(): string {
  return path.join(tmpHome, '.claude', 'projects', SLUG, 'memory');
}

function memoryMdPath(): string {
  return path.join(memoryDir(), 'MEMORY.md');
}

function ensureMemoryDir(): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-mmtest-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = makeDb();
  writeRegistry();
  ensureMemoryDir();
  // Force the memory-monitor module to be reloaded per test so its
  // module-scope `CC_PROJECTS_DIR = path.join(os.homedir(), ...)` captures
  // the test tmp HOME rather than the developer's real HOME.
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('monitorMemoryFiles — sentinel guard (plan 04-04-04)', () => {
  it('migrates excess entries when MEMORY.md has NO sentinel (legacy prune path)', async () => {
    const entryLines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const filename = `note-${i}.md`;
      entryLines.push(`- [${filename}](${filename}) — note ${i}`);
      fs.writeFileSync(
        path.join(memoryDir(), filename),
        `---\ntype: feedback\n---\n\nContent of note ${i} — long enough to be ingested and non-empty.`,
      );
    }
    const memoryMd = `# Memory\n\n${entryLines.join('\n')}\n`;
    fs.writeFileSync(memoryMdPath(), memoryMd);

    const { monitorMemoryFiles } = await import('../../angel/memory-monitor.js');
    const r = monitorMemoryFiles(db);

    expect(r.projects_scanned).toBeGreaterThan(0);
    expect(r.entries_migrated).toBeGreaterThan(0);
    expect(r.projects_with_migrations).toContain(PROJECT_NAME);

    const obsCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM observations WHERE tool_name = 'angel-memory-monitor'`)
      .get() as { c: number }).c;
    expect(obsCount).toBeGreaterThan(0);
  });

  it('skips migration when MEMORY.md carries the Angel sentinel on line 1', async () => {
    const entryLines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const filename = `note-${i}.md`;
      entryLines.push(`- [${filename}](${filename}) — note ${i}`);
      fs.writeFileSync(
        path.join(memoryDir(), filename),
        `---\ntype: feedback\n---\n\nContent of note ${i}.`,
      );
    }
    const sentinel =
      '<!-- CLAUDEX-MANAGED: do not edit above user section. hash=' +
      'a'.repeat(64) +
      ' -->';
    const memoryMd = `${sentinel}\n${entryLines.join('\n')}\n`;
    fs.writeFileSync(memoryMdPath(), memoryMd);

    const bytesBefore = fs.readFileSync(memoryMdPath());
    const mtimeBefore = fs.statSync(memoryMdPath()).mtimeMs;

    const { monitorMemoryFiles } = await import('../../angel/memory-monitor.js');
    const r = monitorMemoryFiles(db);

    expect(r.entries_migrated).toBe(0);
    expect(r.projects_with_migrations).not.toContain(PROJECT_NAME);

    const bytesAfter = fs.readFileSync(memoryMdPath());
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
    const mtimeAfter = fs.statSync(memoryMdPath()).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    const obsCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM observations WHERE tool_name = 'angel-memory-monitor'`)
      .get() as { c: number }).c;
    expect(obsCount).toBe(0);
  });
});
