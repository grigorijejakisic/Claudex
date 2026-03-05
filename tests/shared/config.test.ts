/**
 * Claudex v2 — Configuration Validation Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, validateConfig } from '../../src/shared/config.js';
import { DEFAULT_CONFIG, type ClaudexConfig } from '../../src/shared/types.js';

const TEST_CONFIG_DIR = path.join(process.cwd(), '.test-config');
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.json');

// Mock PATHS module to point to test directory
import { PATHS } from '../../src/shared/paths.js';
const originalConfigPath = PATHS.config;

beforeEach(() => {
  if (!fs.existsSync(TEST_CONFIG_DIR)) {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  }
  // Redirect config path to test directory
  (PATHS as any).config = TEST_CONFIG_PATH;
});

afterEach(() => {
  // Restore original path
  (PATHS as any).config = originalConfigPath;
  // Clean up test files
  if (fs.existsSync(TEST_CONFIG_PATH)) {
    fs.unlinkSync(TEST_CONFIG_PATH);
  }
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    fs.rmdirSync(TEST_CONFIG_DIR);
  }
});

describe('loadConfig', () => {
  it('returns defaults when config file does not exist', () => {
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults when config file is empty', () => {
    fs.writeFileSync(TEST_CONFIG_PATH, '', 'utf-8');
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults when config file has malformed JSON', () => {
    fs.writeFileSync(TEST_CONFIG_PATH, '{ invalid json }', 'utf-8');
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('loads valid config and merges with defaults', () => {
    const customConfig = {
      hologram: {
        enabled: false,
        timeout_ms: 5000,
      },
      observation: {
        retention_days: 30,
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(customConfig), 'utf-8');

    const config = loadConfig();
    expect(config.hologram?.enabled).toBe(false);
    expect(config.hologram?.timeout_ms).toBe(5000);
    expect(config.observation?.retention_days).toBe(30);
    // Other fields should retain defaults
    expect(config.hologram?.health_interval_ms).toBe(DEFAULT_CONFIG.hologram!.health_interval_ms);
    expect(config.observation?.enabled).toBe(DEFAULT_CONFIG.observation!.enabled);
  });

  it('validates boolean fields and falls back to defaults', () => {
    const invalidConfig = {
      hologram: {
        enabled: 'yes' as any,  // invalid: should be boolean
      },
      observation: {
        enabled: 123 as any,  // invalid: should be boolean
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.hologram?.enabled).toBe(DEFAULT_CONFIG.hologram!.enabled);
    expect(config.observation?.enabled).toBe(DEFAULT_CONFIG.observation!.enabled);
  });

  it('validates numeric fields and falls back to defaults', () => {
    const invalidConfig = {
      hologram: {
        timeout_ms: -100,  // invalid: negative
        health_interval_ms: 'fast' as any,  // invalid: not a number
      },
      hooks: {
        latency_budget_ms: null as any,  // invalid: null
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.hologram?.timeout_ms).toBe(DEFAULT_CONFIG.hologram!.timeout_ms);
    expect(config.hologram?.health_interval_ms).toBe(DEFAULT_CONFIG.hologram!.health_interval_ms);
    expect(config.hooks?.latency_budget_ms).toBe(DEFAULT_CONFIG.hooks!.latency_budget_ms);
  });

  it('validates retention_days rejects negative values', () => {
    const invalidConfig = {
      observation: {
        retention_days: -5,  // invalid: must be >= 0
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.observation?.retention_days).toBe(DEFAULT_CONFIG.observation!.retention_days);
  });

  it('allows retention_days=0 (purge everything immediately)', () => {
    const zeroConfig = {
      observation: {
        retention_days: 0,  // valid: means purge everything
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(zeroConfig), 'utf-8');

    const config = loadConfig();
    expect(config.observation?.retention_days).toBe(0);
  });

  it('validates wrapper thresholds must be between 0 and 1', () => {
    const invalidConfig = {
      wrapper: {
        warnThreshold: 1.5,  // invalid: > 1
        flushThreshold: -0.2,  // invalid: < 0
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.wrapper?.warnThreshold).toBe(DEFAULT_CONFIG.wrapper!.warnThreshold);
    expect(config.wrapper?.flushThreshold).toBe(DEFAULT_CONFIG.wrapper!.flushThreshold);
  });

  it('validates vector provider must be valid enum', () => {
    const invalidConfig = {
      vector: {
        provider: 'custom' as any,  // invalid: not in allowed values
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.vector?.provider).toBe(DEFAULT_CONFIG.vector!.provider);
  });

  it('removes invalid optional string fields', () => {
    const invalidConfig = {
      hologram: {
        python_path: 123 as any,  // invalid: should be string
        sidecar_path: true as any,  // invalid: should be string
      },
      database: {
        path: [] as any,  // invalid: should be string
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.hologram?.python_path).toBeUndefined();
    expect(config.hologram?.sidecar_path).toBeUndefined();
    expect(config.database?.path).toBeUndefined();
  });

  it('handles partial config with missing sections', () => {
    const partialConfig = {
      hologram: {
        enabled: false,
      },
      // observation section completely missing
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(partialConfig), 'utf-8');

    const config = loadConfig();
    expect(config.hologram?.enabled).toBe(false);
    // Missing sections should use defaults
    expect(config.observation?.enabled).toBe(DEFAULT_CONFIG.observation!.enabled);
    expect(config.observation?.retention_days).toBe(DEFAULT_CONFIG.observation!.retention_days);
  });

  it('validates nested openai config', () => {
    const invalidConfig = {
      vector: {
        openai: {
          apiKey: 12345 as any,  // invalid: should be string
          model: null as any,  // invalid: should be string
        },
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig), 'utf-8');

    const config = loadConfig();
    expect(config.vector?.openai?.apiKey).toBeUndefined();
    expect(config.vector?.openai?.model).toBeUndefined();
  });

  it('rejects NaN for numeric fields — falls back to defaults', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hologram!.timeout_ms = NaN;
    config.hooks!.latency_budget_ms = NaN;
    config.wrapper!.warnThreshold = NaN;
    config.wrapper!.cooldownMs = NaN;
    config.observation!.retention_days = NaN;

    const validated = validateConfig(config);
    expect(validated.hologram?.timeout_ms).toBe(DEFAULT_CONFIG.hologram!.timeout_ms);
    expect(validated.hooks?.latency_budget_ms).toBe(DEFAULT_CONFIG.hooks!.latency_budget_ms);
    expect(validated.wrapper?.warnThreshold).toBe(DEFAULT_CONFIG.wrapper!.warnThreshold);
    expect(validated.wrapper?.cooldownMs).toBe(DEFAULT_CONFIG.wrapper!.cooldownMs);
    expect(validated.observation?.retention_days).toBe(DEFAULT_CONFIG.observation!.retention_days);
  });

  it('rejects Infinity for numeric fields — falls back to defaults', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hologram!.timeout_ms = Infinity;
    config.hologram!.health_interval_ms = -Infinity;
    config.wrapper!.flushThreshold = Infinity;

    const validated = validateConfig(config);
    expect(validated.hologram?.timeout_ms).toBe(DEFAULT_CONFIG.hologram!.timeout_ms);
    expect(validated.hologram?.health_interval_ms).toBe(DEFAULT_CONFIG.hologram!.health_interval_ms);
    expect(validated.wrapper?.flushThreshold).toBe(DEFAULT_CONFIG.wrapper!.flushThreshold);
  });

  it('preserves valid finite numbers unchanged', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hologram!.timeout_ms = 5000;
    config.hooks!.latency_budget_ms = 3000;
    config.wrapper!.warnThreshold = 0.85;
    config.wrapper!.cooldownMs = 60000;

    const validated = validateConfig(config);
    expect(validated.hologram?.timeout_ms).toBe(5000);
    expect(validated.hooks?.latency_budget_ms).toBe(3000);
    expect(validated.wrapper?.warnThreshold).toBe(0.85);
    expect(validated.wrapper?.cooldownMs).toBe(60000);
  });

  it('R30: invalid context_token_budget gets default (not deleted)', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hooks!.context_token_budget = -1; // invalid: < 500
    const validated = validateConfig(config);
    expect(validated.hooks?.context_token_budget).toBe(DEFAULT_CONFIG.hooks!.context_token_budget);
    expect(validated.hooks?.context_token_budget).toBe(4000);
  });

  it('R30: context_token_budget too high gets default', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hooks!.context_token_budget = 999999; // invalid: > 50000
    const validated = validateConfig(config);
    expect(validated.hooks?.context_token_budget).toBe(4000);
  });

  it('R30: valid context_token_budget is preserved', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hooks!.context_token_budget = 2000;
    const validated = validateConfig(config);
    expect(validated.hooks?.context_token_budget).toBe(2000);
  });

  it('R30: context_token_budget field exists after invalid value (not deleted)', () => {
    const config = structuredClone(DEFAULT_CONFIG) as ClaudexConfig;
    config.hooks!.context_token_budget = NaN; // invalid
    const validated = validateConfig(config);
    // The key must exist (not undefined) — R30 fix assigns default instead of deleting
    expect('context_token_budget' in validated.hooks!).toBe(true);
    expect(validated.hooks?.context_token_budget).toBe(4000);
  });

  it('preserves valid values across all config sections', () => {
    const validConfig = {
      hologram: {
        enabled: true,
        timeout_ms: 3000,
        health_interval_ms: 60000,
        python_path: '/usr/bin/python3',
        sidecar_path: '/opt/sidecar',
        project_patterns: ['**/*.md', '**/*.ts', '**/*.py'],
        project_exclude: [
          'node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**',
          '**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx',
          '**/test_*.py', '**/*_test.py', '**/tests/**',
        ],
        project_max_files: 200,
      },
      database: {
        path: '/custom/db.sqlite',
        wal_mode: false,
      },
      hooks: {
        latency_budget_ms: 5000,
        context_token_budget: 4000,
      },
      observation: {
        enabled: false,
        redact_secrets: false,
        retention_days: 180,
      },
      wrapper: {
        enabled: false,
        warnThreshold: 0.85,
        flushThreshold: 0.95,
        cooldownMs: 60000,
      },
      vector: {
        enabled: true,
        provider: 'openai' as const,
        openai: {
          apiKey: 'sk-test123',
          model: 'text-embedding-3-small',
        },
      },
      checkpoint: {
        window_size: undefined,
      },
    };
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(validConfig), 'utf-8');

    const config = loadConfig();
    expect(config).toEqual(validConfig);
  });
});
