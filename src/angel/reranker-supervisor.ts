/**
 * Reranker Supervisor — Angel-managed lifecycle for the Python cross-encoder service.
 *
 * Replaces the old "fire-and-forget via execSync start /B" pattern with proper
 * supervision:
 *
 *   • Spawn as a managed child with piped stdio — capture stdout/stderr to a
 *     log file so we can diagnose crashes instead of watching them die silently.
 *   • Wait for the /health endpoint with exponential backoff before declaring
 *     ready. The old spawn-and-pray pattern reported "restart attempted" while
 *     the python process was actually dying before uvicorn could bind the port.
 *   • Bounded restart on unexpected exit (3 attempts) before giving up loudly.
 *     No silent infinite retries — but the budget resets after a cool-down so
 *     a transient failure at boot doesn't kill recovery for the whole Angel run.
 *   • Clean shutdown on Angel exit (SIGTERM, then SIGKILL after 5s).
 *   • Detect externally-managed instances: if /health is already serving at
 *     startup, don't spawn or kill — treat the existing process as user-owned.
 *     If the external process later dies, `ensureRunning()` downgrades to
 *     managed mode and spawns a replacement (otherwise a single death of an
 *     external instance would leave Angel permanently blind to the reranker).
 *
 * Non-blocking: failures inside the supervisor never throw to Angel's main
 * loop. If the reranker cannot come up, Angel continues running and
 * hybrid-retrieval's bi-encoder fallback (arctic-embed2 cosine via Ollama)
 * takes over. The only signal is loud logs.
 *
 * Recovery path: the heartbeat polls `/health` every tick and calls
 * `ensureRunning()` whenever it sees the reranker as down. That gives us
 * periodic recovery without a dedicated supervisor polling loop.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WriteStream } from 'fs';

export interface RerankerSupervisorOptions {
  /** Project root (used to resolve services/reranker.py). */
  projectRoot: string;
  /** Log file path (default: <projectRoot>/context/logs/reranker.log). */
  logPath?: string;
  /** Health check URL. */
  healthUrl?: string;
  /** Max total time to wait for health on startup (ms). */
  healthTimeoutMs?: number;
  /** Maximum restart attempts before giving up. */
  maxRestarts?: number;
  /** After exhausting maxRestarts, wait this many ms before resetting the budget. */
  cooldownMs?: number;
  /** Dependency injection for tests. */
  spawnFn?: typeof spawn;
  /** Dependency injection for tests. */
  fetchFn?: typeof fetch;
  /** Optional logger (default: writes to stderr). */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface SupervisorStatus {
  /** True if the supervisor believes a reranker is reachable. */
  running: boolean;
  /** True if we detected an externally-managed process at startup. */
  externallyManaged: boolean;
  /** Number of times we've restarted the managed child. */
  restartCount: number;
  /** PID of the managed child (null if externally managed or not running). */
  childPid: number | null;
  /** Last error message, if any. */
  lastError: string | null;
}

/** Outcome of an `ensureRunning()` call, reported to the heartbeat. */
export interface EnsureRunningResult {
  /** Did we attempt to spawn/restart on this call (vs. a no-op because already healthy or in cool-down)? */
  attempted: boolean;
  /** Is the reranker reachable after this call resolved? */
  running: boolean;
  /** Human-readable explanation for the outcome. Used in advisory messages. */
  reason: string;
  /** Snapshot of supervisor state after the call. */
  status: SupervisorStatus;
}

const DEFAULT_HEALTH_URL = 'http://127.0.0.1:7439/health';
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESTARTS = 3;
const SHUTDOWN_GRACE_MS = 5_000;
/** After exhausting the restart budget, wait this long before trying again. */
const RESTART_COOLDOWN_MS = 15 * 60 * 1000;

export class RerankerSupervisor {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private restartCount = 0;
  private shutdownRequested = false;
  private externallyManaged = false;
  private lastError: string | null = null;
  /** Guards against concurrent spawns from overlapping ensureRunning() calls. */
  private starting = false;
  /** Epoch ms of the last spawn attempt — used for cool-down after budget exhaustion. */
  private lastAttemptMs = 0;
  private readonly cooldownMs: number;

  private readonly projectRoot: string;
  private readonly logPath: string;
  private readonly healthUrl: string;
  private readonly healthTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;
  private readonly logger: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(opts: RerankerSupervisorOptions) {
    this.projectRoot = opts.projectRoot;
    this.logPath = opts.logPath ?? path.join(opts.projectRoot, 'context', 'logs', 'reranker.log');
    this.healthUrl = opts.healthUrl ?? DEFAULT_HEALTH_URL;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.cooldownMs = opts.cooldownMs ?? RESTART_COOLDOWN_MS;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger ?? ((level, msg) => {
      process.stderr.write(`[${new Date().toISOString()}] [reranker-supervisor/${level}] ${msg}\n`);
    });
  }

  /**
   * Start supervising the reranker. Never throws — failures are logged and the
   * supervisor moves on so Angel can continue even if the reranker can't load.
   *
   * If spawn fails at boot, the heartbeat will keep calling `ensureRunning()`
   * every tick, so recovery doesn't depend on a successful initial start.
   */
  async start(): Promise<void> {
    try {
      // Step 1: check if something is already serving. If so, don't spawn.
      if (await this.checkHealth()) {
        this.externallyManaged = true;
        this.logger('info', 'existing reranker detected on health port — supervising external instance, will not respawn or kill');
        return;
      }

      // Step 2: open log file for capturing stdout/stderr.
      this.openLogStream();

      // Step 3: spawn and wait for health.
      this.starting = true;
      this.lastAttemptMs = Date.now();
      await this.spawnAndWait();
      this.starting = false;
    } catch (err) {
      this.starting = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `start failed: ${this.lastError} (bi-encoder fallback will be used)`);
    }
  }

  /**
   * Ensure the reranker is running. Called by the heartbeat on every tick where
   * the /health probe reports the service as down.
   *
   * Behavior matrix:
   *   • Healthy + externally-managed           → no-op, report running
   *   • Healthy + managed child alive          → no-op, report running
   *   • externally-managed + external died     → downgrade to managed, spawn
   *   • managed child dead, under budget       → spawn (restart counter untouched;
   *                                               child-exit handler tracks deaths)
   *   • budget exhausted, inside cool-down     → no-op, report remaining cool-down
   *   • budget exhausted, past cool-down       → reset counter, spawn
   *   • another spawn currently in progress    → no-op, report starting
   *
   * Never throws. Returns a structured result so the caller can build an
   * honest advisory message (as opposed to the prior hardcoded "Auto-restart
   * attempted" string that was printed even when nothing was attempted).
   */
  async ensureRunning(): Promise<EnsureRunningResult> {
    const makeResult = (attempted: boolean, running: boolean, reason: string): EnsureRunningResult => ({
      attempted, running, reason, status: this.getStatus(),
    });

    if (this.shutdownRequested) {
      return makeResult(false, false, 'shutdown in progress');
    }
    if (this.starting) {
      return makeResult(false, false, 'spawn already in progress');
    }

    // Case 1: externally-managed path. Verify the external process is still alive.
    if (this.externallyManaged) {
      if (await this.checkHealth()) {
        return makeResult(false, true, 'externally-managed instance healthy');
      }
      // External died — we take over. Clear the flag and fall through to spawn.
      this.logger('warn', 'externally-managed reranker no longer responding on /health — taking over as managed supervisor');
      this.externallyManaged = false;
      this.lastError = 'external reranker died; supervisor taking over';
      // Reset restart budget since we're effectively starting a new lifecycle.
      this.restartCount = 0;
    }

    // Case 2: managed child already alive and healthy.
    if (this.child && !this.child.killed) {
      if (await this.checkHealth()) {
        return makeResult(false, true, 'managed child healthy');
      }
      // Child is alive but not serving. Don't force-kill here — let onChildExit
      // handle it naturally if it dies, and report unhealthy to the caller.
      return makeResult(false, false, 'managed child alive but /health probe failed');
    }

    // Case 3: no child, or child is dead. Time to spawn.
    //
    // Check the restart budget + cool-down before attempting.
    if (this.restartCount >= this.maxRestarts) {
      const elapsed = Date.now() - this.lastAttemptMs;
      if (elapsed < this.cooldownMs) {
        const remainingSec = Math.round((this.cooldownMs - elapsed) / 1000);
        return makeResult(
          false,
          false,
          `restart budget exhausted, cool-down ${remainingSec}s remaining`,
        );
      }
      // Cool-down elapsed — reset budget and try again.
      this.logger('info', `restart budget cool-down (${Math.round(this.cooldownMs / 1000)}s) elapsed — resetting counter and retrying`);
      this.restartCount = 0;
    }

    // Attempt the spawn.
    this.starting = true;
    this.lastAttemptMs = Date.now();
    try {
      this.openLogStream();
      await this.spawnAndWait();
      this.starting = false;
      this.lastError = null;
      return makeResult(true, true, 'spawn succeeded');
    } catch (err) {
      this.starting = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `ensureRunning spawn failed: ${this.lastError}`);
      return makeResult(true, false, `spawn failed: ${this.lastError}`);
    }
  }

  /**
   * Stop the managed child (or leave externally-managed instance alone).
   * Safe to call multiple times.
   */
  stop(): void {
    this.shutdownRequested = true;

    if (this.externallyManaged) {
      this.logger('info', 'shutdown: externally-managed reranker left running');
      return;
    }

    if (this.child && !this.child.killed) {
      const childPid = this.child.pid;
      this.logger('info', `shutdown: SIGTERM to child pid ${childPid}`);
      try { this.child.kill('SIGTERM'); } catch { /* already dead */ }

      // Force-kill after grace period if still alive.
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.logger('warn', `shutdown: SIGKILL to child pid ${childPid} after ${SHUTDOWN_GRACE_MS}ms grace`);
          try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, SHUTDOWN_GRACE_MS).unref();
    }

    if (this.logStream) {
      try {
        this.logStream.write(`--- supervisor stop ${new Date().toISOString()} ---\n`);
        this.logStream.end();
      } catch { /* stream may already be closed */ }
      this.logStream = null;
    }
  }

  /** Get current supervisor status (for heartbeat reporting). */
  getStatus(): SupervisorStatus {
    return {
      running: this.externallyManaged || (this.child !== null && !this.child.killed),
      externallyManaged: this.externallyManaged,
      restartCount: this.restartCount,
      childPid: this.externallyManaged ? null : (this.child?.pid ?? null),
      lastError: this.lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private ensureLogDirectory(): void {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Idempotent: creates the log directory and opens the write stream if it
   * isn't already open. Called from both `start()` and `ensureRunning()` so
   * that log capture works regardless of which spawn path got us here.
   */
  private openLogStream(): void {
    if (this.logStream) return;
    this.ensureLogDirectory();
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.logStream.write(`\n--- supervisor open-stream ${new Date().toISOString()} ---\n`);
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await this.fetchFn(this.healthUrl, { signal: controller.signal });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async spawnAndWait(): Promise<void> {
    const scriptPath = path.join(this.projectRoot, 'services', 'reranker.py');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`reranker script not found at ${scriptPath}`);
    }

    this.logger('info', `spawning python ${scriptPath}`);

    // stdio: ignore stdin, pipe stdout/stderr so we capture logs.
    // detached: false — we want the child tied to Angel's process group so
    // SIGTERM propagates correctly on clean shutdown.
    const child = this.spawnFn('python', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.projectRoot,
      shell: false,
    });

    this.child = child;
    this.logger('info', `child spawned: pid ${child.pid}`);

    // Pipe stdout and stderr to log file.
    if (this.logStream) {
      child.stdout?.pipe(this.logStream, { end: false });
      child.stderr?.pipe(this.logStream, { end: false });
    }

    // Attach exit handler for unexpected deaths.
    child.on('exit', (code, signal) => this.onChildExit(code, signal));
    child.on('error', (err) => {
      this.logger('error', `spawn error: ${err.message}`);
      this.lastError = err.message;
    });

    // Wait for health endpoint with exponential backoff.
    const healthy = await this.waitForHealth();
    if (!healthy) {
      throw new Error(`reranker did not become healthy within ${this.healthTimeoutMs}ms`);
    }
    this.logger('info', 'reranker is healthy and ready');
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.healthTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) return true;
      if (this.child?.killed) return false; // Child died during wait.
      const remaining = deadline - Date.now();
      await new Promise(r => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 8000); // 1s, 2s, 4s, 8s, 8s, ...
    }
    return false;
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const msg = `child exited: code=${code} signal=${signal}`;
    this.logger(this.shutdownRequested ? 'info' : 'warn', msg);
    this.child = null;

    if (this.shutdownRequested) return;

    // Unexpected death — attempt restart if under budget.
    if (this.restartCount >= this.maxRestarts) {
      this.lastError = `reranker died ${this.restartCount} times, giving up — bi-encoder fallback will be used`;
      this.logger('error', this.lastError);
      return;
    }

    this.restartCount++;
    this.lastAttemptMs = Date.now();
    this.logger('warn', `attempting restart ${this.restartCount}/${this.maxRestarts}`);

    // Defensive: if the log stream is not open (e.g., we downgraded from
    // externally-managed after it died), open it now so the restart's stdio
    // gets captured.
    try { this.openLogStream(); } catch { /* non-fatal */ }

    // Fire-and-forget restart — we're inside an event handler, can't await.
    this.spawnAndWait().catch(err => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `restart ${this.restartCount} failed: ${this.lastError}`);
    });
  }
}
