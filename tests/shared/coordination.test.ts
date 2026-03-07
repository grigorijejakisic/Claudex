import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// We need to mock fs methods used by readCoordinationConfig
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    lstatSync: vi.fn(),
  };
});

import {
  readCoordinationConfig,
  _resetCoordinationCache,
  isOwnedByClaudex,
  type CoordinationConfig,
} from '../../src/shared/coordination.js';

const STANDALONE_DEFAULTS: CoordinationConfig = {
  version: 1,
  checkpoint_primary: 'claudex',
  injection_budget: { claudex: 4000, context_manager: 0, total: 4000 },
  post_compact_restore: 'claudex',
  tool_tracking: 'claudex',
  thread_tracking: 'claudex',
  learnings: 'claudex',
  gauge_display: 'claudex',
};

describe('readCoordinationConfig', () => {
  let mtimeCounter = 0;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.lstatSync).mockReset();
    _resetCoordinationCache();
    // Default: each call gets a unique mtime so caching doesn't interfere with existing tests
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: ++mtimeCounter }) as unknown as fs.Stats);
    // Default: not a symlink
    vi.mocked(fs.lstatSync).mockImplementation(() => ({ isSymbolicLink: () => false }) as unknown as fs.Stats);
  });

  it('returns standalone defaults when file is missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = readCoordinationConfig();
    expect(result).toEqual(STANDALONE_DEFAULTS);
  });

  it('returns parsed values from a valid full config', () => {
    const config = {
      version: 2,
      checkpoint_primary: 'context_manager',
      injection_budget: { claudex: 2000, context_manager: 2000, total: 4000 },
      post_compact_restore: 'context_manager',
      tool_tracking: 'both',
      thread_tracking: 'context_manager',
      learnings: 'context_manager',
      gauge_display: 'context_manager',
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = readCoordinationConfig();
    expect(result).toEqual(config);
  });

  it('accepts injection_budget.claudex: 0 (not rejected as falsy)', () => {
    const config = {
      injection_budget: { claudex: 0, context_manager: 4000, total: 4000 },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(0);
  });

  it('falls back to "claudex" for invalid checkpoint_primary enum', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      checkpoint_primary: 'evil',
    }));

    const result = readCoordinationConfig();
    expect(result.checkpoint_primary).toBe('claudex');
  });

  it('falls back to "claudex" for invalid tool_tracking value', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tool_tracking: 'bypass',
    }));

    const result = readCoordinationConfig();
    expect(result.tool_tracking).toBe('claudex');
  });

  it('accepts tool_tracking: "both" as valid', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tool_tracking: 'both',
    }));

    const result = readCoordinationConfig();
    expect(result.tool_tracking).toBe('both');
  });

  it('fills missing fields with defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 3,
    }));

    const result = readCoordinationConfig();
    expect(result.version).toBe(3);
    expect(result.checkpoint_primary).toBe('claudex');
    expect(result.injection_budget).toEqual({ claudex: 4000, context_manager: 0, total: 4000 });
    expect(result.tool_tracking).toBe('claudex');
  });

  it('returns defaults for malformed JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{');

    const result = readCoordinationConfig();
    expect(result).toEqual(STANDALONE_DEFAULTS);
  });

  it('falls back to default for negative budget number', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: -100, context_manager: 0, total: 4000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(4000); // fallback default
  });

  it('falls back to default for NaN budget', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: 'not-a-number', context_manager: 0, total: 4000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(4000);
  });

  it('falls back to default for Infinity budget', () => {
    // JSON.parse(JSON.stringify(Infinity)) → null, not a number
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: null, context_manager: 0, total: 4000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(4000);
  });

  it('validates all enum fields against allowed values', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      checkpoint_primary: 'invalid',
      post_compact_restore: 'invalid',
      tool_tracking: 'invalid',
      thread_tracking: 'invalid',
      learnings: 'invalid',
      gauge_display: 'invalid',
    }));

    const result = readCoordinationConfig();
    expect(result.checkpoint_primary).toBe('claudex');
    expect(result.post_compact_restore).toBe('claudex');
    expect(result.tool_tracking).toBe('claudex');
    expect(result.thread_tracking).toBe('claudex');
    expect(result.learnings).toBe('claudex');
    expect(result.gauge_display).toBe('claudex');
  });

  it('accepts all valid context_manager values', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      checkpoint_primary: 'context_manager',
      post_compact_restore: 'context_manager',
      tool_tracking: 'context_manager',
      thread_tracking: 'context_manager',
      learnings: 'context_manager',
      gauge_display: 'context_manager',
    }));

    const result = readCoordinationConfig();
    expect(result.checkpoint_primary).toBe('context_manager');
    expect(result.post_compact_restore).toBe('context_manager');
    expect(result.tool_tracking).toBe('context_manager');
    expect(result.thread_tracking).toBe('context_manager');
    expect(result.learnings).toBe('context_manager');
    expect(result.gauge_display).toBe('context_manager');
  });

  it('returns cached result when mtime is unchanged', () => {
    const config = { version: 5, tool_tracking: 'both' };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as unknown as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const first = readCoordinationConfig();
    const second = readCoordinationConfig();

    expect(first.version).toBe(5);
    expect(second).toBe(first); // same reference — cached
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
  });

  it('re-reads file when mtime changes', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ mtimeMs: 1000 } as unknown as fs.Stats)
      .mockReturnValueOnce({ mtimeMs: 2000 } as unknown as fs.Stats);
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify({ version: 1 }))
      .mockReturnValueOnce(JSON.stringify({ version: 2 }));

    const first = readCoordinationConfig();
    const second = readCoordinationConfig();

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(2);
  });

  // --- Budget clamping ---

  it('clamps excessively large budget to MAX_BUDGET (8000)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: 50000, context_manager: 50000, total: 100000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(8000);
    expect(result.injection_budget.context_manager).toBe(8000);
  });

  it('clamps too-small budget to MIN_BUDGET (256)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: 10, context_manager: 10, total: 4000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(256);
    expect(result.injection_budget.context_manager).toBe(256);
  });

  it('preserves budget of 0 (disabled) without clamping', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      injection_budget: { claudex: 0, context_manager: 0, total: 4000 },
    }));

    const result = readCoordinationConfig();
    expect(result.injection_budget.claudex).toBe(0);
    expect(result.injection_budget.context_manager).toBe(0);
  });

  // --- Symlink rejection ---

  it('returns defaults when coordination.json is a symlink', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => true,
    } as unknown as fs.Stats);

    const result = readCoordinationConfig();
    expect(result).toEqual(STANDALONE_DEFAULTS);
  });

  // --- Version validation ---

  it('rejects fractional version number and falls back to default', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1.5,
    }));

    const result = readCoordinationConfig();
    expect(result.version).toBe(1); // fallback
  });

  it('rejects version: 0 and falls back to default', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 0,
    }));

    const result = readCoordinationConfig();
    expect(result.version).toBe(1); // fallback
  });

  it('rejects negative version and falls back to default', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: -3,
    }));

    const result = readCoordinationConfig();
    expect(result.version).toBe(1); // fallback
  });
});

describe('isOwnedByClaudex', () => {
  it('returns true when field is owned by claudex', () => {
    expect(isOwnedByClaudex(STANDALONE_DEFAULTS, 'checkpoint_primary')).toBe(true);
    expect(isOwnedByClaudex(STANDALONE_DEFAULTS, 'thread_tracking')).toBe(true);
    expect(isOwnedByClaudex(STANDALONE_DEFAULTS, 'tool_tracking')).toBe(true);
    expect(isOwnedByClaudex(STANDALONE_DEFAULTS, 'learnings')).toBe(true);
  });

  it('returns false when field is owned by context_manager', () => {
    const config: CoordinationConfig = {
      ...STANDALONE_DEFAULTS,
      checkpoint_primary: 'context_manager',
      learnings: 'context_manager',
    };
    expect(isOwnedByClaudex(config, 'checkpoint_primary')).toBe(false);
    expect(isOwnedByClaudex(config, 'learnings')).toBe(false);
  });
});
