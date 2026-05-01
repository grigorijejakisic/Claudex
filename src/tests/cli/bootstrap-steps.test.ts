/**
 * Unit tests for bootstrap-steps modules.
 *
 * Pure DI — no real bun, ollama, python, or reranker process spawned.
 */

import { describe, it, expect, vi } from 'vitest';

import { checkBunVersion, MIN_BUN_VERSION } from '../../cli/bootstrap-steps/bun-version.js';
import { detectOllama, ollamaInstallMessage } from '../../cli/bootstrap-steps/ollama-detect.js';
import { pullEmbeddingModel } from '../../cli/bootstrap-steps/model-pull.js';
import { bootstrapReranker } from '../../cli/bootstrap-steps/reranker-bootstrap.js';

// ---------------------------------------------------------------------------
// checkBunVersion
// ---------------------------------------------------------------------------

describe('checkBunVersion', () => {
  it('returns ok:true when bun reports a version >= MIN_BUN_VERSION', async () => {
    const execFn = vi.fn().mockReturnValue('1.3.6\n') as unknown as typeof import('child_process').execFileSync;
    const result = await checkBunVersion({ execFn });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1.3.6');
    expect(result.message).toContain(MIN_BUN_VERSION);
  });

  it('returns ok:false when bun is too old', async () => {
    const execFn = vi.fn().mockReturnValue('1.2.5\n') as unknown as typeof import('child_process').execFileSync;
    const result = await checkBunVersion({ execFn, minVersion: '1.3.0' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('too old');
    expect(result.message).toContain('1.3.0');
    expect(result.message).toContain('https://bun.sh');
  });

  it('returns ok:false with install link when bun is missing', async () => {
    const execFn = vi.fn(() => {
      throw new Error('command not found: bun');
    }) as unknown as typeof import('child_process').execFileSync;
    const result = await checkBunVersion({ execFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Install: https://bun.sh');
  });

  it('returns ok:false when version output cannot be parsed', async () => {
    const execFn = vi.fn().mockReturnValue('garbage') as unknown as typeof import('child_process').execFileSync;
    const result = await checkBunVersion({ execFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not parse');
  });
});

// ---------------------------------------------------------------------------
// detectOllama
// ---------------------------------------------------------------------------

describe('detectOllama', () => {
  it('returns platform-specific install message on darwin when binary missing', async () => {
    const execFn = vi.fn(() => {
      throw new Error('not found');
    }) as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('brew install ollama');
  });

  it('returns linux install message when binary missing on linux', async () => {
    const execFn = vi.fn(() => {
      throw new Error('not found');
    }) as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('install.sh');
  });

  it('returns windows install message when binary missing on win32', async () => {
    const execFn = vi.fn(() => {
      throw new Error('not found');
    }) as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'win32' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ollama.com/download/windows');
  });

  it('returns ok:false when daemon returns non-2xx', async () => {
    const execFn = vi.fn().mockReturnValue('ollama version 0.5.0\n') as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 500 })) as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('500');
  });

  it('returns ok:false when fetch throws (daemon not running)', async () => {
    const execFn = vi.fn().mockReturnValue('ollama version 0.5.0\n') as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ollama serve');
  });

  it('returns ok:true when binary present and daemon reachable', async () => {
    const execFn = vi.fn().mockReturnValue('ollama version 0.5.0\n') as unknown as typeof import('child_process').execFileSync;
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const result = await detectOllama({ execFn, fetchFn, platform: 'win32' });
    expect(result.ok).toBe(true);
  });

  it('ollamaInstallMessage falls back to generic link for unknown platforms', () => {
    expect(ollamaInstallMessage('aix' as NodeJS.Platform)).toContain('ollama.com/download');
  });
});

// ---------------------------------------------------------------------------
// pullEmbeddingModel
// ---------------------------------------------------------------------------

describe('pullEmbeddingModel', () => {
  it('short-circuits when model already present in `ollama list`', async () => {
    const execFn = vi.fn().mockReturnValue(
      'NAME                            ID              SIZE\n' +
      'snowflake-arctic-embed2:latest  abc123          1.2 GB\n'
    ) as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    const result = await pullEmbeddingModel({ execFn, spawnFn });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('already present');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('returns ok:false when ollama list fails', async () => {
    const execFn = vi.fn(() => {
      throw new Error('connection refused');
    }) as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    const result = await pullEmbeddingModel({ execFn, spawnFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ollama list');
  });

  it('returns ok:true when pull exits 0', async () => {
    const execFn = vi.fn().mockReturnValue('') as unknown as typeof import('child_process').execFileSync;
    const fakeChild = makeFakeChild(0);
    const spawnFn = vi.fn().mockReturnValue(fakeChild) as unknown as typeof import('child_process').spawn;
    const result = await pullEmbeddingModel({ execFn, spawnFn });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Pulled');
  });

  it('returns ok:false when pull exits non-zero', async () => {
    const execFn = vi.fn().mockReturnValue('') as unknown as typeof import('child_process').execFileSync;
    const fakeChild = makeFakeChild(1);
    const spawnFn = vi.fn().mockReturnValue(fakeChild) as unknown as typeof import('child_process').spawn;
    const result = await pullEmbeddingModel({ execFn, spawnFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited with code 1');
  });
});

// ---------------------------------------------------------------------------
// bootstrapReranker
// ---------------------------------------------------------------------------

describe('bootstrapReranker', () => {
  it('short-circuits when /health already returns 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const execFn = vi.fn() as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    const result = await bootstrapReranker({
      projectRoot: 'X:/no/such/path',
      fetchFn,
      execFn,
      spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('already healthy');
    expect(execFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('returns ok:true with warning when Python is missing (best-effort)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch;
    // Every python candidate throws — none found
    const execFn = vi.fn(() => {
      throw new Error('not found');
    }) as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    const result = await bootstrapReranker({
      projectRoot: 'X:/no/such/path',
      fetchFn,
      execFn,
      spawnFn,
    });
    expect(result.ok).toBe(true); // best-effort
    expect(result.warning).toContain('Python 3.11+');
    expect(result.warning).toContain('python.org');
  });

  it('returns ok:true with warning when Python found but version too old', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('refused')) as unknown as typeof fetch;
    const execFn = vi.fn().mockReturnValue('Python 3.9.7\n') as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    const result = await bootstrapReranker({
      projectRoot: 'X:/no/such/path',
      fetchFn,
      execFn,
      spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('Python 3.11+');
  });

  it('dryRun returns ok:true after Python detection without attempting pip/spawn', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('refused')) as unknown as typeof fetch;
    const execFn = vi.fn().mockReturnValue('Python 3.12.1\n') as unknown as typeof import('child_process').execFileSync;
    const spawnFn = vi.fn() as unknown as typeof import('child_process').spawn;
    // projectRoot needs to exist for the venv-existence check; use a tmp dir.
    // The flow: health fails -> findPython OK -> ensureVenv (creates) -> requirements check -> dryRun short-circuits before pip/spawn.
    // Stub: requirements.txt path won't exist, so we'll hit the requirements warning first. Use a synthetic project root we know.
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpRoot = path.join(os.tmpdir(), `claudex-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpRoot, 'services'), { recursive: true });
    // venv path also doesn't exist so ensureVenv runs (mocked exec returns success).
    // requirements.txt missing → warning short-circuits before dryRun branch.
    fs.writeFileSync(path.join(tmpRoot, 'services', 'requirements.txt'), 'pydantic\n');

    const result = await bootstrapReranker({
      projectRoot: tmpRoot,
      fetchFn,
      execFn,
      spawnFn,
      dryRun: true,
    });
    expect(result.ok).toBe(true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeFakeChild(exitCode: number): import('child_process').ChildProcess {
  // Minimal ChildProcess stub for spawn() return.
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const child = {
    on: (event: string, handler: (arg?: unknown) => void) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
      // Fire 'exit' on next tick to mimic process completion.
      if (event === 'exit') {
        setImmediate(() => handler(exitCode));
      }
      return child;
    },
    kill: () => true,
    pid: 12345,
  } as unknown as import('child_process').ChildProcess;
  return child;
}
