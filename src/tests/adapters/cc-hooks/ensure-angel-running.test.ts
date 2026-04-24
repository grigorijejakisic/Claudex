/**
 * Plan 04-06-01 — verifies that the spawn-call stdio tuple is
 * ['ignore', number, number] when the log file opens cleanly, and
 * ['ignore', 'ignore', 'ignore'] when openAngelLogForAppend returns
 * { fd: null, reason }.
 *
 * Also confirms the fall-through path records a `angel_log_open_failed`
 * session event when a db + session_id are supplied.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';

// ── mocks must be declared BEFORE the module under test is imported ────
const mockSpawn = vi.fn();
const mockOpenLog = vi.fn<() => { fd: number | null; reason: string | null }>();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

vi.mock('../../../adapters/cc-hooks/angel-log.js', () => ({
  openAngelLogForAppend: () => mockOpenLog(),
}));

// Import AFTER mocks.
import { ensureAngelRunning } from '../../../adapters/cc-hooks/angel-launcher.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

function fakeChild() {
  return {
    pid: 12345,
    unref: vi.fn(),
    kill: vi.fn(),
    on: vi.fn(),
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-angel-test-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  mockSpawn.mockReset();
  mockOpenLog.mockReset();

  // Stub the spawn return value — we only care about the args.
  mockSpawn.mockImplementation(() => fakeChild());

  // Materialize a fake Angel dist so the early-exit guard doesn't short-circuit.
  // Resolution is path.resolve(__dirname, '..', '..', 'angel', 'index.cjs')
  // from session-start.ts — when running under vitest, __dirname points at
  // src/adapters/cc-hooks, so we need to place the stub at src/angel/index.cjs
  // at the repo root. We write a zero-byte placeholder — ensureAngelRunning
  // only checks existence, it never reads the file.
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const fakeAngelDir = path.join(repoRoot, 'src', 'angel');
  const fakeAngelDist = path.join(fakeAngelDir, 'index.cjs');
  if (!fs.existsSync(fakeAngelDist)) {
    fs.mkdirSync(fakeAngelDir, { recursive: true });
    fs.writeFileSync(fakeAngelDist, '// test stub — plan 04-06-01');
    (globalThis as Record<string, unknown>).__createdAngelStub = fakeAngelDist;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  const created = (globalThis as Record<string, unknown>).__createdAngelStub as string | undefined;
  if (created) {
    try { fs.unlinkSync(created); } catch { /* */ }
    try { fs.rmdirSync(path.dirname(created)); } catch { /* non-empty or missing — fine */ }
    delete (globalThis as Record<string, unknown>).__createdAngelStub;
  }
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe('ensureAngelRunning stdio tuple — plan 04-06-01', () => {
  it("passes ['ignore', <fd>, <fd>] when openAngelLogForAppend returns a numeric fd", async () => {
    // Open a scratch file we can lend the code as the "log fd" — any writable
    // fd works; we don't actually write through the spawn.
    const fakeLog = path.join(tmpHome, 'fake.log');
    const fd = fs.openSync(fakeLog, 'a');
    try {
      mockOpenLog.mockReturnValue({ fd, reason: null });

      await ensureAngelRunning(db, 'test-session', '__global__');

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { stdio: unknown }];
      expect(Array.isArray(opts.stdio)).toBe(true);
      const stdio = opts.stdio as [unknown, unknown, unknown];
      expect(stdio[0]).toBe('ignore');
      expect(typeof stdio[1]).toBe('number');
      expect(typeof stdio[2]).toBe('number');
      expect(stdio[1]).toBe(fd);
      expect(stdio[2]).toBe(fd);
    } finally {
      // Our implementation closes the fd after spawn; tolerate either state.
      try { fs.closeSync(fd); } catch { /* already closed by SUT */ }
    }
  });

  it("falls back to 'ignore' stdio and records angel_log_open_failed when openAngelLogForAppend fails", async () => {
    mockOpenLog.mockReturnValue({ fd: null, reason: 'permission denied' });

    await ensureAngelRunning(db, 'test-session-2', '__global__');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore']);

    const events = db.prepare(
      `SELECT event_type, entity, action, detail FROM session_events
       WHERE session_id = ? AND event_type = 'angel_log_open_failed'`,
    ).all('test-session-2') as Array<{ event_type: string; entity: string; action: string; detail: string | null }>;
    expect(events.length).toBe(1);
    expect(events[0].action).toBe('fallback_stdio_ignore');
    expect(events[0].detail).toBe('permission denied');
  });

  it('does not record angel_log_open_failed when db/session are not supplied', async () => {
    mockOpenLog.mockReturnValue({ fd: null, reason: 'any error' });

    // No db/session args — should still not throw.
    await ensureAngelRunning();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore']);
  });
});
