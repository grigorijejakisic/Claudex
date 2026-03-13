import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import { getDefaultConfig, loadConfig } from './config.js';
import type { ClaudexConfig } from './config.js';
import * as paths from './paths.js';

describe('config', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-config-test-'));
    configPath = path.join(tmpDir, 'config.json');
    vi.spyOn(paths, 'getConfigPath').mockReturnValue(configPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('getDefaultConfig', () => {
    it('returns complete config matching Section 11.1 fields', () => {
      const config = getDefaultConfig();

      // Verify all top-level keys exist
      expect(config.schema).toBe('claudex/config');
      expect(config.version).toBe(3);
      expect(config.adapter).toBe('auto');

      // Verify nested sections
      expect(config.injection.budget_tokens).toBe(4000);
      expect(config.injection.gauge_threshold).toBe(0.70);
      expect(config.injection.topic_shift_budget).toBe(800);

      expect(config.observations.enabled).toBe(true);
      expect(config.observations.retention_days).toBe(90);

      expect(config.checkpoint.debounce_seconds).toBe(60);

      expect(config.learnings.max_per_project).toBe(50);
      expect(config.learnings.surface_count).toBe(10);
      expect(config.learnings.publish_to_memory_md).toBe(false);

      expect(config.enrichment.enabled).toBe(true);
      expect(config.enrichment.provider).toBe('auto');
      expect(config.enrichment.timeout_ms).toBe(10000);

      expect(config.embeddings.enabled).toBe(true);
      expect(config.embeddings.provider).toBe('ollama');
      expect(config.embeddings.model).toBe('nomic-embed-text');
      expect(config.embeddings.topic_shift_threshold).toBe(0.35);

      expect(config.observability.enabled).toBe(true);
      expect(config.observability.retention_days).toBe(7);

      expect(config.gsd.enabled).toBe(true);
      expect(config.gsd.phase_boost).toBe(0.10);

      expect(config.features.observation_capture).toBe(true);
      expect(config.features.telemetry).toBe(true);
    });

    it('returns a new object each time (not shared reference)', () => {
      const a = getDefaultConfig();
      const b = getDefaultConfig();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      a.injection.budget_tokens = 9999;
      expect(b.injection.budget_tokens).toBe(4000);
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const config = loadConfig();
      const defaults = getDefaultConfig();
      expect(config).toEqual(defaults);
    });

    it('merges partial config with defaults', () => {
      const partial = {
        injection: { budget_tokens: 8000 },
      };
      fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');

      const config = loadConfig();
      // Overridden value
      expect(config.injection.budget_tokens).toBe(8000);
      // Default values preserved
      expect(config.injection.gauge_threshold).toBe(0.70);
      expect(config.observations.enabled).toBe(true);
      expect(config.adapter).toBe('auto');
    });

    it('returns defaults on malformed JSON', () => {
      fs.writeFileSync(configPath, 'this is not json!!!', 'utf-8');
      const config = loadConfig();
      const defaults = getDefaultConfig();
      expect(config).toEqual(defaults);
    });

    it('deep-merges nested sections', () => {
      const partial = {
        embeddings: {
          topic_shift_threshold: 0.50,
        },
        features: {
          telemetry: false,
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');

      const config = loadConfig();
      expect(config.embeddings.topic_shift_threshold).toBe(0.50);
      expect(config.embeddings.enabled).toBe(true); // default preserved
      expect(config.embeddings.provider).toBe('ollama'); // default preserved
      expect(config.features.telemetry).toBe(false);
      expect(config.features.observation_capture).toBe(true); // default preserved
    });
  });

  describe('config loading from paths with spaces', () => {
    it('loads config from path with spaces', () => {
      const spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex space test-'));
      const spacedConfigPath = path.join(spacedDir, 'config.json');
      vi.spyOn(paths, 'getConfigPath').mockReturnValue(spacedConfigPath);

      const partial = { injection: { budget_tokens: 6000 } };
      fs.writeFileSync(spacedConfigPath, JSON.stringify(partial), 'utf-8');

      const config = loadConfig();
      expect(config.injection.budget_tokens).toBe(6000);
      expect(config.injection.gauge_threshold).toBe(0.70); // default preserved

      try { fs.rmSync(spacedDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    });
  });

  describe('config loading from paths with unicode characters', () => {
    it('loads config from unicode path', () => {
      const unicodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-üñî-'));
      const unicodeConfigPath = path.join(unicodeDir, 'config.json');
      vi.spyOn(paths, 'getConfigPath').mockReturnValue(unicodeConfigPath);

      const partial = { observations: { retention_days: 30 } };
      fs.writeFileSync(unicodeConfigPath, JSON.stringify(partial), 'utf-8');

      const config = loadConfig();
      expect(config.observations.retention_days).toBe(30);
      expect(config.observations.enabled).toBe(true); // default preserved

      try { fs.rmSync(unicodeDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    });
  });
});
