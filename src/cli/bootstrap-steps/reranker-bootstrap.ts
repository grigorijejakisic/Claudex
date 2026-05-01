/**
 * Bootstrap step: ensure the BGE reranker is healthy on :7439.
 *
 * Steps (each idempotent / short-circuited):
 *   1. /health already 200? → skip everything (Angel/another supervisor owns it)
 *   2. Find Python 3.11+ — fail-soft if missing (best-effort fallback)
 *   3. Ensure services/.venv/ exists — `python -m venv`
 *   4. pip install -r services/requirements.txt (idempotent)
 *   5. Detached-spawn reranker.py with venv python; redirect to context/logs/reranker.log
 *   6. Poll /health for up to healthTimeoutMs (default 60s)
 *
 * Best-effort policy (CONTEXT.md INST-04 fallback): on ANY failure after step 1,
 * return ok:true with a warning describing what happened. Setup must not
 * hard-fail because the reranker is brittle on Python-installs; bi-encoder
 * fallback is documented as the degraded mode.
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { StepResult } from './types.js';

const HEALTH_URL = 'http://localhost:7439/health';
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_PYTHON_CANDIDATES = ['python3', 'python'];

export interface RerankerBootstrapOptions {
  /** Repo root — used to locate services/reranker.py and services/.venv. */
  projectRoot: string;
  fetchFn?: typeof fetch;
  spawnFn?: typeof spawn;
  execFn?: typeof execFileSync;
  /** Total budget for the /health poll loop after spawn. Default 60_000ms. */
  healthTimeoutMs?: number;
  /** Override Python lookup order. Default ['python3', 'python']. */
  pythonCandidates?: string[];
  /** Skip the actual spawn — used by tests. Returns ok:true with synthetic message. */
  dryRun?: boolean;
}

interface PythonResolution {
  /** Absolute or PATH-resolvable python executable name. */
  exe: string;
  /** Major.minor version string. */
  version: string;
}

export async function bootstrapReranker(
  opts: RerankerBootstrapOptions,
): Promise<StepResult> {
  const f = opts.fetchFn ?? fetch;
  const sp = opts.spawnFn ?? spawn;
  const ex = opts.execFn ?? execFileSync;
  const healthTimeout = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  // 1. Already serving?
  if (await healthOk(f, 1500)) {
    return { ok: true, message: 'Reranker already healthy on :7439 (skipping bootstrap)' };
  }

  // 2. Find Python 3.11+
  const python = findPython(ex, opts.pythonCandidates ?? DEFAULT_PYTHON_CANDIDATES);
  if (!python) {
    return {
      ok: true,
      message: 'Reranker bootstrap skipped',
      warning:
        'Python 3.11+ not found. Install: https://www.python.org/downloads/. ' +
        'Reranker will not run; bi-encoder fallback is degraded mode.',
    };
  }

  // 3. Ensure venv
  const venvDir = path.join(opts.projectRoot, 'services', '.venv');
  if (!fs.existsSync(venvDir)) {
    const venvResult = ensureVenv(python.exe, venvDir, ex);
    if (!venvResult.ok) {
      return { ok: true, message: 'Reranker bootstrap skipped', warning: venvResult.message };
    }
  }

  // 4. pip install (idempotent — pip skips already-satisfied)
  const reqPath = path.join(opts.projectRoot, 'services', 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    return {
      ok: true,
      message: 'Reranker bootstrap skipped',
      warning: `services/requirements.txt missing at ${reqPath}`,
    };
  }
  const pipResult = pipInstall(venvDir, reqPath, ex);
  if (!pipResult.ok) {
    return { ok: true, message: 'Reranker bootstrap skipped', warning: pipResult.message };
  }

  // 5. Spawn detached
  if (opts.dryRun) {
    return {
      ok: true,
      message: `Reranker bootstrap dry-run (Python ${python.version}, venv at ${venvDir})`,
    };
  }
  const spawnResult = spawnReranker(venvDir, opts.projectRoot, sp);
  if (!spawnResult.ok) {
    return { ok: true, message: 'Reranker bootstrap skipped', warning: spawnResult.message };
  }

  // 6. Wait for /health
  const healthy = await waitForHealth(f, healthTimeout);
  if (!healthy) {
    return {
      ok: true,
      message: 'Reranker bootstrap skipped',
      warning:
        `Reranker spawned but /health did not return 200 within ${Math.round(healthTimeout / 1000)}s. ` +
        `Check context/logs/reranker.log; bi-encoder fallback is degraded mode.`,
    };
  }

  return { ok: true, message: 'Reranker healthy on :7439' };
}

async function healthOk(f: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const r = await f(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

function findPython(
  ex: typeof execFileSync,
  candidates: string[],
): PythonResolution | null {
  for (const cand of candidates) {
    try {
      const out = ex(cand, ['--version'], { encoding: 'utf-8', timeout: 5000 })
        .toString()
        .trim();
      // Format: "Python 3.11.4"
      const m = out.match(/Python\s+(\d+)\.(\d+)/);
      if (!m) continue;
      const major = +m[1];
      const minor = +m[2];
      if (major < 3) continue;
      if (major === 3 && minor < 11) continue;
      return { exe: cand, version: `${major}.${minor}` };
    } catch {
      /* try next */
    }
  }
  return null;
}

function ensureVenv(
  python: string,
  venvDir: string,
  ex: typeof execFileSync,
): { ok: boolean; message: string } {
  try {
    ex(python, ['-m', 'venv', venvDir], {
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, message: `venv created at ${venvDir}` };
  } catch (err) {
    return {
      ok: false,
      message:
        `Failed to create venv at ${venvDir}: ${(err as Error).message}. ` +
        `Reranker will not run; bi-encoder fallback is degraded mode.`,
    };
  }
}

function venvBin(venvDir: string, name: string): string {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', `${name}.exe`);
  }
  return path.join(venvDir, 'bin', name);
}

function pipInstall(
  venvDir: string,
  reqPath: string,
  ex: typeof execFileSync,
): { ok: boolean; message: string } {
  const pip = venvBin(venvDir, 'pip');
  if (!fs.existsSync(pip)) {
    return {
      ok: false,
      message: `pip not found in venv at ${pip}. Reranker will not run.`,
    };
  }
  try {
    // 10-min budget — torch download can be heavy on first install
    ex(pip, ['install', '-r', reqPath], {
      encoding: 'utf-8',
      timeout: 10 * 60_000,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return { ok: true, message: 'pip install -r services/requirements.txt complete' };
  } catch (err) {
    return {
      ok: false,
      message:
        `pip install failed: ${(err as Error).message}. ` +
        `Re-run setup once network/wheels are available; bi-encoder fallback is degraded mode.`,
    };
  }
}

function spawnReranker(
  venvDir: string,
  projectRoot: string,
  sp: typeof spawn,
): { ok: boolean; message: string } {
  const python = venvBin(venvDir, 'python');
  const script = path.join(projectRoot, 'services', 'reranker.py');
  if (!fs.existsSync(python)) {
    return { ok: false, message: `venv python not found at ${python}` };
  }
  if (!fs.existsSync(script)) {
    return { ok: false, message: `reranker script not found at ${script}` };
  }

  const logDir = path.join(projectRoot, 'context', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const logPath = path.join(logDir, 'reranker.log');
  const logFd = fs.openSync(logPath, 'a');

  try {
    const child = sp(python, [script], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: projectRoot,
    });
    child.unref();
    return { ok: true, message: `Reranker spawned (pid ${child.pid})` };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to spawn reranker: ${(err as Error).message}`,
    };
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      /* best-effort */
    }
  }
}

async function waitForHealth(
  f: typeof fetch,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let delay = 500;
  while (Date.now() < deadline) {
    if (await healthOk(f, 1500)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 5000);
  }
  return false;
}
