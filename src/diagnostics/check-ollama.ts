/**
 * DIAG-03: Ollama check.
 *
 * Three sequential gates (short-circuit on first failure):
 *   1. Binary on PATH (`ollama --version`)
 *   2. Daemon reachable (GET /api/tags within 2s)
 *   3. snowflake-arctic-embed2 model present in /api/tags response
 *
 * Re-uses Phase 14's `ollamaInstallMessage` for platform-aware install
 * remediation. Doctor never pulls models — diagnose-only.
 */

import { execFileSync } from 'child_process';
import type { CheckFn } from './types.js';
import { ollamaInstallMessage } from '../cli/bootstrap-steps/ollama-detect.js';

const OLLAMA_API_TAGS = 'http://localhost:11434/api/tags';
const TIMEOUT_MS = 2000;
const REQUIRED_MODEL_PREFIX = 'snowflake-arctic-embed2';

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export interface CheckOllamaOptions {
  execFn?: typeof execFileSync;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export function makeCheckOllama(opts: CheckOllamaOptions = {}): CheckFn {
  const exec = opts.execFn ?? execFileSync;
  const f = opts.fetchFn ?? fetch;
  const platform = opts.platform ?? process.platform;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;

  return async () => {
    try {
      exec('ollama', ['--version'], { encoding: 'utf-8', timeout: 5000, shell: true });
    } catch {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: 'Ollama not found in PATH',
        remediation: ollamaInstallMessage(platform),
      };
    }

    let response: Response;
    try {
      response = await f(OLLAMA_API_TAGS, { signal: AbortSignal.timeout(timeout) });
    } catch {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: 'Ollama daemon not running on :11434',
        remediation: "Start Ollama: 'ollama serve' (or restart the desktop app).",
      };
    }

    if (!response.ok) {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: `Ollama daemon returned HTTP ${response.status}`,
        remediation: "Start Ollama: 'ollama serve' (or restart the desktop app).",
      };
    }

    let body: OllamaTagsResponse;
    try {
      body = (await response.json()) as OllamaTagsResponse;
    } catch (err) {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: `Could not parse /api/tags response: ${(err as Error).message}`,
        remediation: 'Restart Ollama and retry.',
      };
    }

    const hasModel = (body.models ?? []).some(
      (m) => typeof m.name === 'string' && m.name.startsWith(REQUIRED_MODEL_PREFIX),
    );
    if (!hasModel) {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: `${REQUIRED_MODEL_PREFIX} model not pulled`,
        remediation: `Pull the embedding model: 'ollama pull ${REQUIRED_MODEL_PREFIX}'`,
      };
    }

    return {
      name: 'Ollama',
      status: 'pass',
      detail: `daemon up, ${REQUIRED_MODEL_PREFIX} pulled`,
    };
  };
}

export const checkOllama: CheckFn = makeCheckOllama();
