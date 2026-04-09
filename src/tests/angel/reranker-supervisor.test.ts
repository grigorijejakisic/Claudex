import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RerankerSupervisor } from '../../angel/reranker-supervisor.js';

/**
 * Fake ChildProcess — implements only what RerankerSupervisor actually uses.
 * Emits 'exit' on kill() and exposes an `emitExit(code, signal)` helper for tests.
 */
class FakeChild extends EventEmitter {
  pid = 12345;
  killed = false;
  killCalls: string[] = [];
  stdout = new EventEmitter() as EventEmitter & { pipe: (_: unknown, __?: unknown) => void };
  stderr = new EventEmitter() as EventEmitter & { pipe: (_: unknown, __?: unknown) => void };

  constructor() {
    super();
    // Stub pipe — the supervisor just calls it, doesn't care about the return.
    this.stdout.pipe = () => undefined;
    this.stderr.pipe = () => undefined;
  }

  kill(signal: string): boolean {
    this.killCalls.push(signal);
    if (this.killed) return false;
    this.killed = true;
    // Synchronous exit emit for deterministic tests.
    queueMicrotask(() => this.emit('exit', signal === 'SIGKILL' ? null : 0, signal));
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.killed = true;
    this.emit('exit', code, signal);
  }
}

/** Create a sandboxed project root with a services/reranker.py stub. */
function createFakeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reranker-supervisor-test-'));
  fs.mkdirSync(path.join(dir, 'services'));
  fs.writeFileSync(path.join(dir, 'services', 'reranker.py'), '# fake reranker for tests');
  return dir;
}

describe('RerankerSupervisor', () => {
  let tempRoot: string;
  let fakeChildren: FakeChild[];
  let spawnCallCount: number;
  let healthResponses: Array<{ ok: boolean } | 'throw'>;
  let logLines: Array<{ level: string; message: string }>;
  let supervisors: RerankerSupervisor[];

  beforeEach(() => {
    tempRoot = createFakeProjectRoot();
    fakeChildren = [];
    spawnCallCount = 0;
    healthResponses = [];
    logLines = [];
    supervisors = [];
  });

  afterEach(async () => {
    // Stop every supervisor so log streams are closed before we rm the tempdir.
    for (const sup of supervisors) {
      try { sup.stop(); } catch { /* */ }
    }
    // Let any queued stream writes/close events flush.
    await new Promise(r => setTimeout(r, 50));
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  function fakeSpawn(): FakeChild {
    spawnCallCount++;
    const child = new FakeChild();
    child.pid = 10000 + spawnCallCount;
    fakeChildren.push(child);
    return child;
  }

  function fakeFetch(): Response {
    const next = healthResponses.shift();
    if (next === 'throw' || next === undefined) {
      throw new Error('fake fetch rejection');
    }
    return { ok: next.ok } as Response;
  }

  function makeSupervisor(overrides: Partial<ConstructorParameters<typeof RerankerSupervisor>[0]> = {}): RerankerSupervisor {
    const sup = new RerankerSupervisor({
      projectRoot: tempRoot,
      healthTimeoutMs: 5000,
      maxRestarts: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: fakeSpawn as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: (async () => fakeFetch()) as any,
      logger: (level, message) => logLines.push({ level, message }),
      ...overrides,
    });
    supervisors.push(sup);
    return sup;
  }

  describe('externally-managed detection', () => {
    it('does not spawn when an existing reranker is already healthy', async () => {
      healthResponses.push({ ok: true }); // initial health check passes
      const sup = makeSupervisor();
      await sup.start();

      expect(spawnCallCount).toBe(0);
      const status = sup.getStatus();
      expect(status.externallyManaged).toBe(true);
      expect(status.running).toBe(true);
      expect(status.childPid).toBeNull();
      expect(logLines.some(l => l.message.includes('existing reranker detected'))).toBe(true);
    });

    it('stop() does not kill externally-managed instance', async () => {
      healthResponses.push({ ok: true });
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      expect(fakeChildren.length).toBe(0); // never spawned
      expect(logLines.some(l => l.message.includes('externally-managed reranker left running'))).toBe(true);
    });
  });

  describe('spawn + health ready', () => {
    it('spawns and becomes ready when health passes', async () => {
      healthResponses.push(
        { ok: false }, // initial check fails — not externally managed
        { ok: true },  // first post-spawn check succeeds
      );
      const sup = makeSupervisor();
      await sup.start();

      expect(spawnCallCount).toBe(1);
      const status = sup.getStatus();
      expect(status.externallyManaged).toBe(false);
      expect(status.running).toBe(true);
      expect(status.childPid).toBe(10001);
      expect(logLines.some(l => l.message.includes('healthy and ready'))).toBe(true);
    });

    it('creates log directory if it does not exist', async () => {
      healthResponses.push({ ok: false }, { ok: true });
      const sup = makeSupervisor();
      await sup.start();

      // The supervisor mkdir's the directory synchronously; actual file
      // creation happens async on first stream flush, so we check the
      // directory rather than the file.
      const logDir = path.join(tempRoot, 'context', 'logs');
      expect(fs.existsSync(logDir)).toBe(true);
    });
  });

  describe('health timeout', () => {
    it('does not throw when health check never succeeds', async () => {
      // Many failing responses — supervisor should time out and log, not throw.
      for (let i = 0; i < 50; i++) healthResponses.push({ ok: false });
      const sup = makeSupervisor({ healthTimeoutMs: 100 });

      await expect(sup.start()).resolves.toBeUndefined();
      expect(logLines.some(l => l.level === 'error' && l.message.includes('did not become healthy'))).toBe(true);
    });

    it('records lastError when reranker fails to become healthy', async () => {
      for (let i = 0; i < 50; i++) healthResponses.push({ ok: false });
      const sup = makeSupervisor({ healthTimeoutMs: 100 });
      await sup.start();

      const status = sup.getStatus();
      expect(status.lastError).toMatch(/did not become healthy/);
    });
  });

  describe('shutdown', () => {
    it('sends SIGTERM to the managed child on stop()', async () => {
      healthResponses.push({ ok: false }, { ok: true });
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      expect(fakeChildren[0].killCalls).toContain('SIGTERM');
    });

    it('stop() is idempotent', async () => {
      healthResponses.push({ ok: false }, { ok: true });
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      sup.stop();
      // Second stop should not add another SIGTERM because killed is true.
      expect(fakeChildren[0].killCalls.filter(s => s === 'SIGTERM').length).toBe(1);
    });

    it('shutdownRequested prevents restart on exit', async () => {
      healthResponses.push({ ok: false }, { ok: true });
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      // Simulate the child exiting after shutdown was requested.
      fakeChildren[0].emitExit(0, 'SIGTERM');
      // Wait a tick for any async restart attempts to schedule.
      await new Promise(r => setTimeout(r, 50));

      expect(spawnCallCount).toBe(1); // no restart
    });
  });

  describe('bounded restart', () => {
    it('restarts on unexpected exit up to maxRestarts', async () => {
      // Response sequence:
      //   1 × {false} for the initial "is it externally managed?" check in start()
      //   1 × {true}  for the first spawn's health probe
      //   Restart spawns go straight to spawnAndWait and only need 1 healthy probe each
      healthResponses.push({ ok: false }, { ok: true }, { ok: true }, { ok: true }, { ok: true });

      const sup = makeSupervisor({ maxRestarts: 3, healthTimeoutMs: 2000 });
      await sup.start();
      expect(spawnCallCount).toBe(1);

      // Kill the child unexpectedly → should trigger restart 1
      fakeChildren[0].emitExit(1, null);
      await new Promise(r => setTimeout(r, 100));
      expect(spawnCallCount).toBe(2);

      // Kill again → restart 2
      fakeChildren[1].emitExit(1, null);
      await new Promise(r => setTimeout(r, 100));
      expect(spawnCallCount).toBe(3);

      // Kill again → restart 3
      fakeChildren[2].emitExit(1, null);
      await new Promise(r => setTimeout(r, 100));
      expect(spawnCallCount).toBe(4);

      // Kill a fourth time → should NOT restart (over budget)
      fakeChildren[3].emitExit(1, null);
      await new Promise(r => setTimeout(r, 100));
      expect(spawnCallCount).toBe(4); // stayed at 4

      const status = sup.getStatus();
      expect(status.restartCount).toBe(3);
      expect(status.lastError).toMatch(/giving up/);
      expect(logLines.some(l => l.level === 'error' && l.message.includes('giving up'))).toBe(true);
    });
  });

  describe('script not found', () => {
    it('records an error when services/reranker.py is missing', async () => {
      fs.rmSync(path.join(tempRoot, 'services', 'reranker.py'));
      healthResponses.push({ ok: false }); // initial check fails — try to spawn
      const sup = makeSupervisor();

      await expect(sup.start()).resolves.toBeUndefined();
      expect(spawnCallCount).toBe(0); // never got to spawn
      const status = sup.getStatus();
      expect(status.lastError).toMatch(/not found/);
    });
  });

  describe('getStatus', () => {
    it('reports not running before start', () => {
      const sup = makeSupervisor();
      const status = sup.getStatus();
      expect(status.running).toBe(false);
      expect(status.childPid).toBeNull();
      expect(status.restartCount).toBe(0);
    });
  });
});
