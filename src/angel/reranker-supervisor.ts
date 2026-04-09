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
 *     No silent infinite retries.
 *   • Clean shutdown on Angel exit (SIGTERM, then SIGKILL after 5s).
 *   • Detect externally-managed instances: if /health is already serving at
 *     startup, don't spawn or kill — treat the existing process as user-owned.
 *
 * Non-blocking: failures inside the supervisor never throw to Angel's main
 * loop. If the reranker cannot come up, Angel continues running and
 * hybrid-retrieval's bi-encoder fallback (arctic-embed2 cosine via Ollama)
 * takes over. The only signal is loud logs.
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

const DEFAULT_HEALTH_URL = 'http://127.0.0.1:7439/health';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 3;
const SHUTDOWN_GRACE_MS = 5_000;

export class RerankerSupervisor {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private restartCount = 0;
  private shutdownRequested = false;
  private externallyManaged = false;
  private lastError: string | null = null;

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
    this.spawnFn = opts.spawnFn ?? spawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger ?? ((level, msg) => {
      process.stderr.write(`[${new Date().toISOString()}] [reranker-supervisor/${level}] ${msg}\n`);
    });
  }

  /**
   * Start supervising the reranker. Never throws — failures are logged and the
   * supervisor moves on so Angel can continue even if the reranker can't load.
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
      this.ensureLogDirectory();
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.logStream.write(`\n--- supervisor start ${new Date().toISOString()} ---\n`);

      // Step 3: spawn and wait for health.
      await this.spawnAndWait();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `start failed: ${this.lastError} (bi-encoder fallback will be used)`);
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
    this.logger('warn', `attempting restart ${this.restartCount}/${this.maxRestarts}`);

    // Fire-and-forget restart — we're inside an event handler, can't await.
    this.spawnAndWait().catch(err => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `restart ${this.restartCount} failed: ${this.lastError}`);
    });
  }
}
