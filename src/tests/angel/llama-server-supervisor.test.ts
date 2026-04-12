/**
 * Unit tests for src/angel/llama-server-supervisor.ts.
 *
 * Mirrors the reranker supervisor test pattern (fake spawn + fake fetch +
 * injectable logger), adapted for the llama-server specifics:
 *   - Health check goes through checkLlamaServerHealth which parses a
 *     { data: [...] } body — so the fake fetch must return a richer Response
 *   - Supervisor performs a file-exists preflight on serverExePath + modelPath
 *     before spawning, so tests stage both as touched files
 *
 * No real network or real process is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LlamaServerSupervisor } from '../../angel/llama-server-supervisor.js';

/**
 * Fake ChildProcess — same shape the reranker test uses. Implements only
 * what the supervisor actually reads (pid, killed, stdout/stderr pipe
 * stubs, kill(), exit events).
 */
class FakeChild extends EventEmitter {
  pid = 12345;
  killed = false;
  killCalls: string[] = [];
  stdout = new EventEmitter() as EventEmitter & { pipe: (_: unknown, __?: unknown) => void };
  stderr = new EventEmitter() as EventEmitter & { pipe: (_: unknown, __?: unknown) => void };

  constructor() {
    super();
    this.stdout.pipe = () => undefined;
    this.stderr.pipe = () => undefined;
  }

  kill(signal: string): boolean {
    this.killCalls.push(signal);
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGKILL' ? null : 0, signal));
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.killed = true;
    this.emit('exit', code, signal);
  }
}

/** Stage a project root + a fake llama-server.exe + a fake GGUF model. */
function createFakeProjectRoot(): { projectRoot: string; exePath: string; modelPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-supervisor-test-'));
  const llamaDir = path.join(projectRoot, 'llama-cpp');
  const modelsDir = path.join(llamaDir, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });

  const exePath = path.join(llamaDir, 'llama-server.exe');
  const modelPath = path.join(modelsDir, 'gemma-4-31B-it-Q6_K.gguf');
  fs.writeFileSync(exePath, '# fake binary');
  fs.writeFileSync(modelPath, '# fake model');

  return { projectRoot, exePath, modelPath };
}

/**
 * Shape of a fake response queue entry. `loaded` simulates the healthy
 * state (200 + non-empty data array); `loading` simulates the 200 + empty
 * data array state that llama-server may return briefly during startup;
 * `throw` simulates connection-refused / unreachable.
 */
type HealthReply = 'loaded' | 'loading' | 'throw' | 'down';

function makeHealthResponse(kind: HealthReply): Response {
  if (kind === 'loaded') {
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'gemma4' }] }),
      { status: 200 },
    );
  }
  if (kind === 'loading') {
    return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
  }
  if (kind === 'down') {
    return new Response('', { status: 503 });
  }
  throw new Error('fake fetch rejection');
}

describe('LlamaServerSupervisor', () => {
  let tempRoot: string;
  let exePath: string;
  let modelPath: string;
  let fakeChildren: FakeChild[];
  let spawnCallCount: number;
  let healthQueue: HealthReply[];
  let logLines: Array<{ level: string; message: string }>;
  let supervisors: LlamaServerSupervisor[];

  beforeEach(() => {
    const stage = createFakeProjectRoot();
    tempRoot = stage.projectRoot;
    exePath = stage.exePath;
    modelPath = stage.modelPath;
    fakeChildren = [];
    spawnCallCount = 0;
    healthQueue = [];
    logLines = [];
    supervisors = [];
  });

  afterEach(async () => {
    for (const sup of supervisors) {
      try { sup.stop(); } catch { /* */ }
    }
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
    const next = healthQueue.shift();
    if (!next) throw new Error('health queue exhausted');
    return makeHealthResponse(next);
  }

  function makeSupervisor(overrides: Partial<ConstructorParameters<typeof LlamaServerSupervisor>[0]> = {}): LlamaServerSupervisor {
    const sup = new LlamaServerSupervisor({
      projectRoot: tempRoot,
      serverExePath: exePath,
      modelPath,
      healthTimeoutMs: 5000,
      maxRestarts: 2,
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
    it('does not spawn when an existing llama-server is already healthy', async () => {
      healthQueue.push('loaded'); // initial probe
      const sup = makeSupervisor();
      await sup.start();

      expect(spawnCallCount).toBe(0);
      const status = sup.getStatus();
      expect(status.externallyManaged).toBe(true);
      expect(status.running).toBe(true);
      expect(status.childPid).toBeNull();
      expect(logLines.some(l => l.message.includes('existing llama-server detected'))).toBe(true);
    });

    it('does not kill the externally-managed instance on stop()', async () => {
      healthQueue.push('loaded');
      const sup = makeSupervisor();
      await sup.start();
      sup.stop();
      expect(fakeChildren.length).toBe(0);
      expect(logLines.some(l => l.message.includes('externally-managed llama-server left running'))).toBe(true);
    });
  });

  describe('managed spawn happy path', () => {
    it('spawns the binary when no external instance is running and waits for health', async () => {
      healthQueue.push('down');   // initial probe → nothing serving
      healthQueue.push('loading'); // first wait poll → loading
      healthQueue.push('loaded');  // second wait poll → ready
      const sup = makeSupervisor();
      await sup.start();

      expect(spawnCallCount).toBe(1);
      const status = sup.getStatus();
      expect(status.externallyManaged).toBe(false);
      expect(status.running).toBe(true);
      expect(status.childPid).toBe(10001);
      expect(logLines.some(l => l.message.includes('llama-server is healthy'))).toBe(true);
    });

    it('passes correct args to the spawned binary', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');

      let capturedExe = '';
      let capturedArgs: readonly string[] = [];
      const captureSpawn = ((exe: string, args: readonly string[]) => {
        capturedExe = exe;
        capturedArgs = args;
        return fakeSpawn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const sup = makeSupervisor({ spawnFn: captureSpawn });
      await sup.start();

      expect(capturedExe).toBe(exePath);
      expect(capturedArgs).toContain('-m');
      expect(capturedArgs).toContain(modelPath);
      expect(capturedArgs).toContain('-ngl');
      expect(capturedArgs).toContain('99');
      expect(capturedArgs).toContain('--host');
      expect(capturedArgs).toContain('127.0.0.1');
      expect(capturedArgs).toContain('--port');
      expect(capturedArgs).toContain('8081');
      expect(capturedArgs).toContain('-c');
      expect(capturedArgs).toContain('16384');
      expect(capturedArgs).toContain('--flash-attn');
      // --flash-attn now requires an explicit value — verify 'on' follows it
      const fa = capturedArgs.indexOf('--flash-attn');
      expect(capturedArgs[fa + 1]).toBe('on');
      expect(capturedArgs).toContain('--alias');
      expect(capturedArgs).toContain('gemma4');
    });
  });

  describe('preflight file-exists checks', () => {
    it('refuses to spawn if the binary does not exist', async () => {
      const bogus = path.join(tempRoot, 'does-not-exist.exe');
      healthQueue.push('down');
      const sup = makeSupervisor({ serverExePath: bogus });
      await sup.start();

      expect(spawnCallCount).toBe(0);
      const status = sup.getStatus();
      expect(status.running).toBe(false);
      expect(status.lastError).toMatch(/binary not found/);
    });

    it('refuses to spawn if the model does not exist', async () => {
      const bogusModel = path.join(tempRoot, 'missing.gguf');
      healthQueue.push('down');
      const sup = makeSupervisor({ modelPath: bogusModel });
      await sup.start();

      expect(spawnCallCount).toBe(0);
      const status = sup.getStatus();
      expect(status.running).toBe(false);
      expect(status.lastError).toMatch(/model file not found/);
    });
  });

  describe('ensureRunning', () => {
    it('returns running=true immediately when managed child is healthy', async () => {
      healthQueue.push('down');   // start probe
      healthQueue.push('loaded'); // wait poll
      const sup = makeSupervisor();
      await sup.start();

      healthQueue.push('loaded'); // ensureRunning probe
      const result = await sup.ensureRunning();

      expect(result.attempted).toBe(false);
      expect(result.running).toBe(true);
      expect(result.reason).toMatch(/managed child healthy/);
    });

    it('spawns a replacement when the managed child is missing and budget is available', async () => {
      healthQueue.push('down');   // start
      healthQueue.push('loaded'); // wait poll
      const sup = makeSupervisor();
      await sup.start();

      // Drop the child reference without firing onChildExit (so the
      // supervisor's auto-restart path doesn't race with the test).
      (sup as unknown as { child: null }).child = null;

      healthQueue.push('loaded'); // ensureRunning wait poll for the new spawn
      const result = await sup.ensureRunning();

      expect(result.attempted).toBe(true);
      expect(result.running).toBe(true);
      expect(spawnCallCount).toBe(2);
    });

    it('reports cool-down when restart budget is exhausted', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ maxRestarts: 0 });
      await sup.start();

      // Force state to exceeded-budget
      (sup as unknown as { restartCount: number }).restartCount = 5;
      (sup as unknown as { child: null }).child = null;
      (sup as unknown as { lastAttemptMs: number }).lastAttemptMs = Date.now();

      const result = await sup.ensureRunning();
      expect(result.attempted).toBe(false);
      expect(result.running).toBe(false);
      expect(result.reason).toMatch(/cool-down/);
    });

    it('takes over when an externally-managed server dies', async () => {
      healthQueue.push('loaded'); // initial: external alive
      const sup = makeSupervisor();
      await sup.start();
      expect(sup.getStatus().externallyManaged).toBe(true);

      // External dies mid-flight
      healthQueue.push('throw');   // ensureRunning probe for external: fails
      healthQueue.push('loaded');  // wait poll for managed spawn
      const result = await sup.ensureRunning();

      expect(result.attempted).toBe(true);
      expect(result.running).toBe(true);
      expect(sup.getStatus().externallyManaged).toBe(false);
      expect(logLines.some(l => l.message.includes('taking over'))).toBe(true);
    });
  });

  describe('idle shutdown', () => {
    it('kills the managed child when idle timeout is exceeded', async () => {
      healthQueue.push('down');   // start probe
      healthQueue.push('loaded'); // wait poll
      const sup = makeSupervisor({ idleTimeoutMs: 100 });
      await sup.start();

      // Fast-forward lastUsedMs so idle check triggers
      (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 200;

      const result = sup.checkIdleAndShutdown();
      expect(result.shutdown).toBe(true);
      expect(result.idleMs).toBeGreaterThanOrEqual(200);
      expect(fakeChildren[0].killCalls).toContain('SIGTERM');
      expect(sup.idledDown).toBe(true);
      expect(logLines.some(l => l.message.includes('idle shutdown'))).toBe(true);
    });

    it('does not kill when not yet idle', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ idleTimeoutMs: 60_000 });
      await sup.start();

      const result = sup.checkIdleAndShutdown();
      expect(result.shutdown).toBe(false);
      expect(result.reason).toMatch(/not yet idle/);
      expect(fakeChildren[0].killCalls.length).toBe(0);
    });

    it('does not kill externally-managed instances', async () => {
      healthQueue.push('loaded'); // initial: external alive
      const sup = makeSupervisor({ idleTimeoutMs: 100 });
      await sup.start();

      (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 200;

      const result = sup.checkIdleAndShutdown();
      expect(result.shutdown).toBe(false);
      expect(result.reason).toMatch(/externally managed/);
    });

    it('blocks ensureRunning after idle shutdown until wakeFromIdle', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ idleTimeoutMs: 100 });
      await sup.start();

      // Trigger idle shutdown
      (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 200;
      sup.checkIdleAndShutdown();
      // Wait for the exit event to propagate
      await new Promise(r => setTimeout(r, 50));

      // ensureRunning should refuse to restart
      const result = await sup.ensureRunning();
      expect(result.running).toBe(false);
      expect(result.reason).toMatch(/idled down/);
      expect(spawnCallCount).toBe(1); // only the initial spawn

      // After wakeFromIdle, ensureRunning should restart
      sup.wakeFromIdle();
      expect(sup.idledDown).toBe(false);

      healthQueue.push('loaded'); // wait poll for respawn
      const result2 = await sup.ensureRunning();
      expect(result2.attempted).toBe(true);
      expect(result2.running).toBe(true);
      expect(spawnCallCount).toBe(2);
    });

    it('resets restart counter so idle cycles do not exhaust budget', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ idleTimeoutMs: 100, maxRestarts: 2 });
      await sup.start();

      // Simulate idle → shutdown → wake → restart, twice
      for (let i = 0; i < 3; i++) {
        (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 200;
        sup.checkIdleAndShutdown();
        await new Promise(r => setTimeout(r, 50));

        sup.wakeFromIdle();
        healthQueue.push('loaded');
        const res = await sup.ensureRunning();
        expect(res.running).toBe(true);
      }

      // After 3 idle cycles, should still be able to restart (budget not exhausted)
      expect(spawnCallCount).toBe(4); // 1 initial + 3 restarts
    });

    it('markUsed resets the idle timer', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ idleTimeoutMs: 100 });
      await sup.start();

      (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 80;
      sup.markUsed();

      const result = sup.checkIdleAndShutdown();
      expect(result.shutdown).toBe(false);
      expect(result.reason).toMatch(/not yet idle/);
    });

    it('is disabled when idleTimeoutMs is 0', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor({ idleTimeoutMs: 0 });
      await sup.start();

      (sup as unknown as { lastUsedMs: number }).lastUsedMs = Date.now() - 999999;

      const result = sup.checkIdleAndShutdown();
      expect(result.shutdown).toBe(false);
      expect(result.reason).toMatch(/disabled/);
    });
  });

  describe('stop()', () => {
    it('SIGTERMs the managed child on stop', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      expect(fakeChildren[0].killCalls).toContain('SIGTERM');
    });

    it('is idempotent across multiple stop() calls', async () => {
      healthQueue.push('down');
      healthQueue.push('loaded');
      const sup = makeSupervisor();
      await sup.start();

      sup.stop();
      sup.stop(); // second stop should not throw
      expect(fakeChildren[0].killCalls).toContain('SIGTERM');
    });
  });
});
