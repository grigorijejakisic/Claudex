/**
 * LlamaServerSupervisor — Angel-managed lifecycle for the local Gemma 4 31B
 * llama.cpp server that backs all of Angel's LLM generation calls.
 *
 * Mirrors RerankerSupervisor tightly — same supervision discipline (piped
 * stdio, exponential-backoff health check, bounded restart with cool-down,
 * externally-managed detection, clean shutdown). Differences from the
 * reranker supervisor:
 *
 *   • Spawns llama-server.exe (C++ binary) instead of python reranker.py
 *   • 180-second health timeout vs. 60 — 31B Q6 at ~25GB takes real time to
 *     mmap and copy to VRAM even on an RTX 5090
 *   • 2 restart attempts vs. 3 — big-model OOM/load failures rarely recover
 *     on blind retry, better to cool down and let the user investigate
 *   • Uses /v1/models (OpenAI-compat) as the health endpoint — llama-server
 *     returns 200 with the loaded-model list once the model is ready, or
 *     connection-refused / empty list while still loading
 *
 * Non-blocking: failures inside the supervisor never throw to Angel's main
 * loop. If Gemma can't come up, Angel continues running; LLM-dependent
 * subsystems (pattern-extractor, curated-context-extractor, consolidator,
 * entity-summarizer, health report) skip their work and retry next tick.
 * The only signal is loud logs + heartbeat advisory.
 *
 * Default spawn paths assume the standard location documented in
 * ~/Desktop/Projects/holo3/run-gemma.sh — they can be overridden via
 * environment variables for tests or alternate installs.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WriteStream } from 'fs';
import { checkLlamaServerHealth, LLAMA_HEALTH_URL } from './llama-client.js';

export interface LlamaServerSupervisorOptions {
  /** Project root (used to resolve the log file location). */
  projectRoot: string;
  /** Absolute path to llama-server.exe. Default: $LLAMA_SERVER_EXE or ~/Desktop/Projects/llama-cpp/llama-server.exe. */
  serverExePath?: string;
  /** Absolute path to the GGUF model file. Default: $LLAMA_MODEL_PATH or ~/Desktop/Projects/llama-cpp/models/gemma-4-31B-it-Q6_K.gguf. */
  modelPath?: string;
  /** Working directory for the spawned server. Default: dirname(serverExePath). */
  serverCwd?: string;
  /** Log file path. Default: <projectRoot>/context/logs/llama-server.log. */
  logPath?: string;
  /** Health check URL. Default: LLAMA_HEALTH_URL from llama-client. */
  healthUrl?: string;
  /** Max total time to wait for health on startup (ms). Default: 180_000. */
  healthTimeoutMs?: number;
  /** Maximum restart attempts before entering cool-down. Default: 2. */
  maxRestarts?: number;
  /** After exhausting maxRestarts, wait this many ms before resetting the budget. Default: 15min. */
  cooldownMs?: number;
  /** llama-server --port (default: 8081, matches run-gemma.sh). */
  port?: number;
  /** llama-server --host (default: 127.0.0.1). */
  host?: string;
  /** GPU layer offload count. Default: 99 (all layers). */
  gpuLayers?: number;
  /** Context window size. Default: 16384 (matches run-gemma.sh). */
  contextSize?: number;
  /** CPU threads. Default: 8. */
  threads?: number;
  /** Model alias (for --alias). Default: "gemma4". */
  alias?: string;
  /** Dependency injection for tests. */
  spawnFn?: typeof spawn;
  /** Dependency injection for tests. */
  fetchFn?: typeof fetch;
  /** Optional logger (default: writes to stderr). */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface LlamaServerStatus {
  /** True if we believe a llama-server is reachable. */
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

export interface EnsureRunningResult {
  attempted: boolean;
  running: boolean;
  reason: string;
  status: LlamaServerStatus;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESTARTS = 2;
const SHUTDOWN_GRACE_MS = 5_000;
const RESTART_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Default exe / model paths. Windows absolute paths from run-gemma.sh.
 * Env overrides keep tests hermetic without hardcoding Grigorije's box.
 */
function defaultServerExePath(): string {
  return (
    process.env.LLAMA_SERVER_EXE ??
    path.join(os.homedir(), 'Desktop', 'Projects', 'llama-cpp', 'llama-server.exe')
  );
}
function defaultModelPath(): string {
  return (
    process.env.LLAMA_MODEL_PATH ??
    path.join(
      os.homedir(),
      'Desktop',
      'Projects',
      'llama-cpp',
      'models',
      'gemma-4-31B-it-Q6_K.gguf',
    )
  );
}

export class LlamaServerSupervisor {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private restartCount = 0;
  private shutdownRequested = false;
  private externallyManaged = false;
  private lastError: string | null = null;
  private starting = false;
  private lastAttemptMs = 0;
  private readonly cooldownMs: number;

  private readonly projectRoot: string;
  private readonly serverExePath: string;
  private readonly modelPath: string;
  private readonly serverCwd: string;
  private readonly logPath: string;
  private readonly healthUrl: string;
  private readonly healthTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly port: number;
  private readonly host: string;
  private readonly gpuLayers: number;
  private readonly contextSize: number;
  private readonly threads: number;
  private readonly alias: string;
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;
  private readonly logger: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(opts: LlamaServerSupervisorOptions) {
    this.projectRoot = opts.projectRoot;
    this.serverExePath = opts.serverExePath ?? defaultServerExePath();
    this.modelPath = opts.modelPath ?? defaultModelPath();
    this.serverCwd = opts.serverCwd ?? path.dirname(this.serverExePath);
    this.logPath =
      opts.logPath ?? path.join(opts.projectRoot, 'context', 'logs', 'llama-server.log');
    this.healthUrl = opts.healthUrl ?? LLAMA_HEALTH_URL;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.cooldownMs = opts.cooldownMs ?? RESTART_COOLDOWN_MS;
    this.port = opts.port ?? 8081;
    this.host = opts.host ?? '127.0.0.1';
    this.gpuLayers = opts.gpuLayers ?? 99;
    this.contextSize = opts.contextSize ?? 16384;
    this.threads = opts.threads ?? 8;
    this.alias = opts.alias ?? 'gemma4';
    this.spawnFn = opts.spawnFn ?? spawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger =
      opts.logger ??
      ((level, msg) => {
        process.stderr.write(
          `[${new Date().toISOString()}] [llama-server-supervisor/${level}] ${msg}\n`,
        );
      });
  }

  /**
   * Start supervising the llama-server. Never throws — failures are logged
   * and the supervisor moves on so Angel can continue even if Gemma can't
   * load.
   */
  async start(): Promise<void> {
    try {
      // Step 1: check if something is already serving. If so, don't spawn.
      if (await this.checkHealth()) {
        this.externallyManaged = true;
        this.logger(
          'info',
          'existing llama-server detected on health endpoint — supervising external instance, will not respawn or kill',
        );
        return;
      }

      // Step 2: verify binary and model exist before attempting to spawn.
      if (!fs.existsSync(this.serverExePath)) {
        this.lastError = `llama-server binary not found at ${this.serverExePath}`;
        this.logger('error', this.lastError + ' — Angel generation will be unavailable');
        return;
      }
      if (!fs.existsSync(this.modelPath)) {
        this.lastError = `model file not found at ${this.modelPath}`;
        this.logger('error', this.lastError + ' — Angel generation will be unavailable');
        return;
      }

      // Step 3: open log file for capturing stdout/stderr.
      this.openLogStream();

      // Step 4: spawn and wait for health.
      this.starting = true;
      this.lastAttemptMs = Date.now();
      await this.spawnAndWait();
      this.starting = false;
    } catch (err) {
      this.starting = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger(
        'error',
        `start failed: ${this.lastError} (Angel LLM generation will be unavailable until recovery)`,
      );
    }
  }

  /**
   * Ensure llama-server is running. Called by the heartbeat every tick
   * where the /v1/models probe reports the service as down. See the
   * RerankerSupervisor docstring for the full behavior matrix — this
   * follows the same rules.
   */
  async ensureRunning(): Promise<EnsureRunningResult> {
    const makeResult = (
      attempted: boolean,
      running: boolean,
      reason: string,
    ): EnsureRunningResult => ({
      attempted,
      running,
      reason,
      status: this.getStatus(),
    });

    if (this.shutdownRequested) {
      return makeResult(false, false, 'shutdown in progress');
    }
    if (this.starting) {
      return makeResult(false, false, 'spawn already in progress');
    }

    // Case 1: externally-managed path.
    if (this.externallyManaged) {
      if (await this.checkHealth()) {
        return makeResult(false, true, 'externally-managed instance healthy');
      }
      this.logger(
        'warn',
        'externally-managed llama-server no longer responding — taking over as managed supervisor',
      );
      this.externallyManaged = false;
      this.lastError = 'external llama-server died; supervisor taking over';
      this.restartCount = 0;
    }

    // Case 2: managed child already alive and healthy.
    if (this.child && !this.child.killed) {
      if (await this.checkHealth()) {
        return makeResult(false, true, 'managed child healthy');
      }
      return makeResult(false, false, 'managed child alive but /v1/models probe failed');
    }

    // Case 3: no child or child is dead — spawn.
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
      this.logger(
        'info',
        `restart budget cool-down (${Math.round(this.cooldownMs / 1000)}s) elapsed — resetting counter and retrying`,
      );
      this.restartCount = 0;
    }

    // Verify files still exist (in case user moved things between ticks).
    if (!fs.existsSync(this.serverExePath)) {
      this.lastError = `llama-server binary not found at ${this.serverExePath}`;
      return makeResult(false, false, this.lastError);
    }
    if (!fs.existsSync(this.modelPath)) {
      this.lastError = `model file not found at ${this.modelPath}`;
      return makeResult(false, false, this.lastError);
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
      this.logger('info', 'shutdown: externally-managed llama-server left running');
      return;
    }

    if (this.child && !this.child.killed) {
      const childPid = this.child.pid;
      this.logger('info', `shutdown: SIGTERM to child pid ${childPid}`);
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already dead */
      }

      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.logger(
            'warn',
            `shutdown: SIGKILL to child pid ${childPid} after ${SHUTDOWN_GRACE_MS}ms grace`,
          );
          try {
            this.child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }, SHUTDOWN_GRACE_MS).unref();
    }

    if (this.logStream) {
      try {
        this.logStream.write(`--- supervisor stop ${new Date().toISOString()} ---\n`);
        this.logStream.end();
      } catch {
        /* stream may already be closed */
      }
      this.logStream = null;
    }
  }

  getStatus(): LlamaServerStatus {
    return {
      running: this.externallyManaged || (this.child !== null && !this.child.killed),
      externallyManaged: this.externallyManaged,
      restartCount: this.restartCount,
      childPid: this.externallyManaged ? null : this.child?.pid ?? null,
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

  private openLogStream(): void {
    if (this.logStream) return;
    this.ensureLogDirectory();
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.logStream.write(`\n--- supervisor open-stream ${new Date().toISOString()} ---\n`);
  }

  private async checkHealth(): Promise<boolean> {
    return checkLlamaServerHealth({
      url: this.healthUrl,
      timeoutMs: 2000,
      fetchFn: this.fetchFn,
    });
  }

  private buildSpawnArgs(): string[] {
    return [
      '-m',
      this.modelPath,
      '-ngl',
      String(this.gpuLayers),
      '--host',
      this.host,
      '--port',
      String(this.port),
      '-c',
      String(this.contextSize),
      '--flash-attn',
      '-t',
      String(this.threads),
      '--alias',
      this.alias,
    ];
  }

  private async spawnAndWait(): Promise<void> {
    const args = this.buildSpawnArgs();
    this.logger(
      'info',
      `spawning llama-server: ${this.serverExePath} (model=${path.basename(this.modelPath)})`,
    );

    const child = this.spawnFn(this.serverExePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.serverCwd,
      shell: false,
    });

    this.child = child;
    this.logger('info', `child spawned: pid ${child.pid}`);

    if (this.logStream) {
      child.stdout?.pipe(this.logStream, { end: false });
      child.stderr?.pipe(this.logStream, { end: false });
    }

    child.on('exit', (code, signal) => this.onChildExit(code, signal));
    child.on('error', (err) => {
      this.logger('error', `spawn error: ${err.message}`);
      this.lastError = err.message;
    });

    const healthy = await this.waitForHealth();
    if (!healthy) {
      throw new Error(
        `llama-server did not become healthy within ${this.healthTimeoutMs}ms`,
      );
    }
    this.logger('info', 'llama-server is healthy and ready');
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.healthTimeoutMs;
    // Gemma 31B Q6 loads ~25GB to VRAM. Start with a 2s poll since sub-2s
    // is noise, and back off to 8s — matches reranker supervisor behavior.
    let delay = 2000;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) return true;
      if (this.child?.killed) return false;
      const remaining = deadline - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 8000);
    }
    return false;
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const msg = `child exited: code=${code} signal=${signal}`;
    this.logger(this.shutdownRequested ? 'info' : 'warn', msg);
    this.child = null;

    if (this.shutdownRequested) return;

    if (this.restartCount >= this.maxRestarts) {
      this.lastError = `llama-server died ${this.restartCount} times, giving up — Angel LLM generation unavailable until cool-down elapses`;
      this.logger('error', this.lastError);
      return;
    }

    this.restartCount++;
    this.lastAttemptMs = Date.now();
    this.logger('warn', `attempting restart ${this.restartCount}/${this.maxRestarts}`);

    try {
      this.openLogStream();
    } catch {
      /* non-fatal */
    }

    this.spawnAndWait().catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', `restart ${this.restartCount} failed: ${this.lastError}`);
    });
  }
}
