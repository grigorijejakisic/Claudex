/**
 * Bootstrap step: verify Ollama is installed AND its daemon is reachable.
 *
 * - Binary missing → ok:false with platform-specific install link
 * - Binary present but daemon unreachable → ok:false with "ollama serve" hint
 * - Both present → ok:true
 */

import { execFileSync } from 'child_process';
import type { StepResult } from './types.js';

const OLLAMA_API = 'http://localhost:11434/api/tags';

export interface OllamaDetectOptions {
  execFn?: typeof execFileSync;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export async function detectOllama(
  opts: OllamaDetectOptions = {},
): Promise<StepResult> {
  const exec = opts.execFn ?? execFileSync;
  const f = opts.fetchFn ?? fetch;
  const platform = opts.platform ?? process.platform;
  const timeout = opts.timeoutMs ?? 3000;

  // 1. Is the binary on PATH?
  try {
    exec('ollama', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return { ok: false, message: ollamaInstallMessage(platform) };
  }

  // 2. Is the daemon running?
  try {
    const r = await f(OLLAMA_API, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) {
      return {
        ok: false,
        message: `Ollama installed but daemon returned ${r.status}. Start: 'ollama serve'`,
      };
    }
  } catch {
    return {
      ok: false,
      message: `Ollama installed but not running. Start: 'ollama serve' (or restart if launched via app)`,
    };
  }

  return { ok: true, message: 'Ollama present and daemon reachable' };
}

export function ollamaInstallMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return `Install Ollama: https://ollama.com/download/mac (or 'brew install ollama')`;
  }
  if (platform === 'linux') {
    return `Install Ollama: curl -fsSL https://ollama.com/install.sh | sh`;
  }
  if (platform === 'win32') {
    return `Install Ollama: https://ollama.com/download/windows`;
  }
  return `Install Ollama: https://ollama.com/download`;
}
