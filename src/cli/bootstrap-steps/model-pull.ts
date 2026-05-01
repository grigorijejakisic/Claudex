/**
 * Bootstrap step: ensure `snowflake-arctic-embed2` is present in Ollama.
 *
 * Idempotent — `ollama pull` itself skips already-pulled layers.
 * Short-circuit: if `ollama list` already shows the model, no spawn happens.
 */

import { execFileSync, spawn } from 'child_process';
import type { StepResult } from './types.js';

const DEFAULT_MODEL = 'snowflake-arctic-embed2';
const PULL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export interface ModelPullOptions {
  execFn?: typeof execFileSync;
  spawnFn?: typeof spawn;
  modelName?: string;
  timeoutMs?: number;
}

export async function pullEmbeddingModel(
  opts: ModelPullOptions = {},
): Promise<StepResult> {
  const exec = opts.execFn ?? execFileSync;
  const sp = opts.spawnFn ?? spawn;
  const model = opts.modelName ?? DEFAULT_MODEL;
  const timeout = opts.timeoutMs ?? PULL_TIMEOUT_MS;

  // 1. Already pulled?
  try {
    const list = exec('ollama', ['list'], {
      encoding: 'utf-8',
      shell: true,
    }).toString();
    if (list.includes(model)) {
      return { ok: true, message: `Model ${model} already present` };
    }
  } catch (err) {
    return {
      ok: false,
      message: `'ollama list' failed: ${(err as Error).message}`,
    };
  }

  // 2. Pull (timeout, stream progress to terminal so the user sees Ollama's bar)
  return new Promise<StepResult>((resolve) => {
    const child = sp('ollama', ['pull', model], { stdio: 'inherit', shell: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
      resolve({
        ok: false,
        message: `'ollama pull ${model}' timed out after ${Math.round(timeout / 60_000)} min`,
      });
    }, timeout);

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, message: `Pulled ${model}` });
      } else {
        resolve({
          ok: false,
          message: `'ollama pull ${model}' exited with code ${code ?? 'unknown'}`,
        });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `'ollama pull ${model}' failed to spawn: ${err.message}`,
      });
    });
  });
}
