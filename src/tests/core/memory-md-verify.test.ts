/**
 * Unit tests for memory-md-verify (CUR-03 SC-5).
 *
 * Each case uses a temp HOME redirection so `os.homedir()/.claude/projects/
 * <slug>/memory/MEMORY.md` points inside the tempdir. Verifies flag() side
 * effects by querying `session_events` on an in-memory SQLite DB.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../../core/migrations.js';
import { verifyMemoryMd } from '../../core/memory-md-verify.js';
import { getSessionEvents } from '../../core/session-events.js';
import { pathToCcSlug } from '../../shared/cc-slug.js';

const PROJECT = 'verify-test-proj';
const SESSION_ID = 'verify-test-session';

function createDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  initializeSchema(d);
  d.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, ?, 'active', 0, ?)`,
  ).run(SESSION_ID, PROJECT, Math.floor(Date.now() / 1000));
  return d;
}

function validSentinel(body: string): string {
  // Canonical 64-char sha256-ish hex placeholder. The verifier doesn't
  // re-compute the hash — it only checks the line shape and hex length.
  const fakeHash = '0'.repeat(64);
  return `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->\n${body}`;
}

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

function memoryDirFor(scope: string): string {
  return path.join(tmpHome, '.claude', 'projects', scope, 'memory');
}

function writeMemoryMd(scope: string, content: string): string {
  const dir = memoryDirFor(scope);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(p, content);
  return p;
}

function getInvalidEvents(): ReturnType<typeof getSessionEvents> {
  return getSessionEvents(db, SESSION_ID).filter(e => e.event_type === 'memory_md_invalid');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-mmv-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = createDb();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('verifyMemoryMd', () => {
  it('returns file_missing silently when MEMORY.md does not exist', () => {
    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });
    expect(result.reason).toBe('file_missing');
    expect(getInvalidEvents()).toHaveLength(0);
  });

  it('returns not_angel_managed silently for a plain file with no sentinel and no marker', () => {
    writeMemoryMd(PROJECT, '# Some user file\n\nArbitrary content without sentinel or marker.\n');
    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });
    expect(result.reason).toBe('not_angel_managed');
    expect(getInvalidEvents()).toHaveLength(0);
  });

  it('flags size_exceeded when file exceeds 25KB even with valid sentinel', () => {
    const padding = 'x'.repeat(26_000);
    writeMemoryMd(PROJECT, validSentinel(`body\n${padding}\n<!-- USER EDITABLE -->\n## User Notes\n`));

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });

    expect(result.reason).toBe('size_exceeded');
    expect(result.bytes).toBeGreaterThan(25_000);
    const events = getInvalidEvents();
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!);
    expect(detail.reason).toBe('size_exceeded');
    expect(detail.bytes).toBe(result.bytes);
    expect(detail.lines).toBe(result.lines);
  });

  it('flags lines_exceeded when file has more than 200 lines but is under 25KB', () => {
    const body = Array.from({ length: 210 }, (_, i) => `line ${i}`).join('\n');
    writeMemoryMd(PROJECT, validSentinel(`${body}\n<!-- USER EDITABLE -->\n## User Notes\n`));

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });

    expect(result.reason).toBe('lines_exceeded');
    expect(result.lines).toBeGreaterThan(200);
    const events = getInvalidEvents();
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!);
    expect(detail.reason).toBe('lines_exceeded');
  });

  it('flags sentinel_missing when USER EDITABLE marker is present but first line is not a sentinel', () => {
    writeMemoryMd(
      PROJECT,
      '# Not a sentinel\n\nSome content.\n<!-- USER EDITABLE -->\n## User Notes\n',
    );

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });

    expect(result.reason).toBe('sentinel_missing');
    const events = getInvalidEvents();
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!);
    expect(detail.reason).toBe('sentinel_missing');
  });

  it('flags sentinel_invalid when sentinel hash is not 64 hex chars', () => {
    const content =
      '<!-- CLAUDEX-MANAGED: do not edit above user section. hash=abc123 -->\n' +
      'body\n<!-- USER EDITABLE -->\n## User Notes\n';
    writeMemoryMd(PROJECT, content);

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });

    expect(result.reason).toBe('sentinel_invalid');
    expect(result.hash).toBe('abc123');
    const events = getInvalidEvents();
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!);
    expect(detail.reason).toBe('sentinel_invalid');
  });

  it('returns ok without recording event when file is valid', () => {
    writeMemoryMd(
      PROJECT,
      validSentinel('preamble\n\n## Entities\n- a — x\n\n<!-- USER EDITABLE -->\n## User Notes\n'),
    );

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { scope: PROJECT });

    expect(result.reason).toBe('ok');
    expect(result.hash).toBe('0'.repeat(64));
    expect(getInvalidEvents()).toHaveLength(0);
  });

  it('swallows errors silently and returns ok-shaped fallback', () => {
    // Drive the outer try/catch: pass an input that makes the internal path
    // resolution throw. `{ cwd: undefined, scope: undefined }` with a project
    // string that contains no separators resolves to `project` as the slug,
    // which is fine — so we pass an object whose `scope` accessor throws.
    const evilOpts = Object.defineProperty(
      {}, 'scope',
      { get() { throw new Error('simulated IO failure'); } },
    ) as { scope?: string; cwd?: string };

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, evilOpts);
    expect(result.reason).toBe('ok');
    expect(result.path).toBe('');
    expect(getInvalidEvents()).toHaveLength(0);
  });

  it('derives slug from cwd when scope is not supplied', () => {
    // Use a cwd string that pathToCcSlug encodes the same way on Windows.
    const cwd = 'C:/Users/Test/Desktop/Projects/alpha';
    const slug = pathToCcSlug(cwd);
    writeMemoryMd(slug, validSentinel('body\n<!-- USER EDITABLE -->\n## User Notes\n'));

    const result = verifyMemoryMd(db, PROJECT, SESSION_ID, { cwd });

    expect(result.reason).toBe('ok');
    expect(result.path.endsWith(path.join(slug, 'memory', 'MEMORY.md'))).toBe(true);
  });
});
