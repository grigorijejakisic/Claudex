/**
 * Claudex v2 — Configuration Loading
 *
 * Loads ClaudexConfig from ~/.claudex/config.json.
 * Returns defaults when file is missing or corrupt.
 */

import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { type ClaudexConfig, DEFAULT_CONFIG } from './types.js';

/**
 * Load Claudex configuration.
 * Deep-merges file config over defaults. Missing or corrupt file → all defaults.
 */
export function loadConfig(): ClaudexConfig {
  try {
    if (!fs.existsSync(PATHS.config)) {
      return structuredClone(DEFAULT_CONFIG);
    }

    const raw = fs.readFileSync(PATHS.config, 'utf-8');
    const fileConfig = JSON.parse(raw) as Partial<ClaudexConfig>;

    const merged = deepMerge(
      structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
      fileConfig as unknown as Record<string, unknown>,
    ) as ClaudexConfig;

    return validateConfig(merged);
  } catch {
    // Corrupt config file — use defaults silently
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Validate and normalize config values.
 * Invalid values fall back to defaults from DEFAULT_CONFIG.
 */
/** @internal Exported for testing only */
export function validateConfig(config: ClaudexConfig): ClaudexConfig {
  const defaults = DEFAULT_CONFIG;

  // Extract default sub-objects once to avoid repeated non-null assertions.
  // DEFAULT_CONFIG always defines these properties.
  const hDef = defaults.hologram!;
  const dbDef = defaults.database!;
  const hookDef = defaults.hooks!;
  const obsDef = defaults.observation!;
  const wrapDef = defaults.wrapper!;
  const vecDef = defaults.vector!;

  // Validate hologram
  if (config.hologram) {
    if (typeof config.hologram.enabled !== 'boolean') {
      config.hologram.enabled = hDef.enabled;
    }
    if (!Number.isFinite(config.hologram.timeout_ms) || config.hologram.timeout_ms < 0) {
      config.hologram.timeout_ms = hDef.timeout_ms;
    }
    if (!Number.isFinite(config.hologram.health_interval_ms) || config.hologram.health_interval_ms < 0) {
      config.hologram.health_interval_ms = hDef.health_interval_ms;
    }
    if (config.hologram.python_path !== undefined && typeof config.hologram.python_path !== 'string') {
      delete config.hologram.python_path;
    }
    if (config.hologram.sidecar_path !== undefined && typeof config.hologram.sidecar_path !== 'string') {
      delete config.hologram.sidecar_path;
    }
    if (config.hologram.project_patterns !== undefined && !Array.isArray(config.hologram.project_patterns)) {
      config.hologram.project_patterns = hDef.project_patterns;
    }
    if (config.hologram.project_exclude !== undefined && !Array.isArray(config.hologram.project_exclude)) {
      config.hologram.project_exclude = hDef.project_exclude;
    }
    if (config.hologram.project_max_files !== undefined) {
      if (!Number.isFinite(config.hologram.project_max_files) || config.hologram.project_max_files < 0) {
        config.hologram.project_max_files = hDef.project_max_files;
      }
    }
  }

  // Validate database
  if (config.database) {
    if (typeof config.database.wal_mode !== 'boolean') {
      config.database.wal_mode = dbDef.wal_mode;
    }
    if (config.database.path !== undefined && typeof config.database.path !== 'string') {
      delete config.database.path;
    }
  }

  // Validate hooks
  if (config.hooks) {
    if (!Number.isFinite(config.hooks.latency_budget_ms) || config.hooks.latency_budget_ms < 0) {
      config.hooks.latency_budget_ms = hookDef.latency_budget_ms;
    }
    if (config.hooks.context_token_budget !== undefined) {
      if (!Number.isFinite(config.hooks.context_token_budget) || config.hooks.context_token_budget < 500 || config.hooks.context_token_budget > 50000) {
        config.hooks.context_token_budget = hookDef.context_token_budget;
      }
    }
  }

  // Validate observation
  if (config.observation) {
    if (typeof config.observation.enabled !== 'boolean') {
      config.observation.enabled = obsDef.enabled;
    }
    if (typeof config.observation.redact_secrets !== 'boolean') {
      config.observation.redact_secrets = obsDef.redact_secrets;
    }
    if (config.observation.retention_days !== undefined) {
      if (!Number.isFinite(config.observation.retention_days) || config.observation.retention_days < 0) {
        config.observation.retention_days = obsDef.retention_days;
      }
    }
  }

  // Validate wrapper
  if (config.wrapper) {
    if (typeof config.wrapper.enabled !== 'boolean') {
      config.wrapper.enabled = wrapDef.enabled;
    }
    if (!Number.isFinite(config.wrapper.warnThreshold) || config.wrapper.warnThreshold < 0 || config.wrapper.warnThreshold > 1) {
      config.wrapper.warnThreshold = wrapDef.warnThreshold;
    }
    if (!Number.isFinite(config.wrapper.flushThreshold) || config.wrapper.flushThreshold < 0 || config.wrapper.flushThreshold > 1) {
      config.wrapper.flushThreshold = wrapDef.flushThreshold;
    }
    if (!Number.isFinite(config.wrapper.cooldownMs) || config.wrapper.cooldownMs < 0) {
      config.wrapper.cooldownMs = wrapDef.cooldownMs;
    }
  }

  // Validate checkpoint
  if (config.checkpoint) {
    if (config.checkpoint.window_size !== undefined) {
      if (!Number.isFinite(config.checkpoint.window_size) || config.checkpoint.window_size < 100_000 || config.checkpoint.window_size > 2_000_000) {
        config.checkpoint.window_size = undefined;
      }
    }
  }

  // Validate vector
  if (config.vector) {
    if (typeof config.vector.enabled !== 'boolean') {
      config.vector.enabled = vecDef.enabled;
    }
    if (!['fts5', 'openai', 'local'].includes(config.vector.provider)) {
      config.vector.provider = vecDef.provider;
    }
    if (config.vector.openai) {
      if (config.vector.openai.apiKey !== undefined && typeof config.vector.openai.apiKey !== 'string') {
        delete config.vector.openai.apiKey;
      }
      if (config.vector.openai.model !== undefined && typeof config.vector.openai.model !== 'string') {
        delete config.vector.openai.model;
      }
    }
  }

  return config;
}

/**
 * Deep merge source into target. Source values override target values.
 * Only merges plain objects — arrays and primitives are replaced wholesale.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result;
}
