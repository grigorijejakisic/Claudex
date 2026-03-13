/**
 * Config loading, validation, and defaults.
 * Defensive non-throwing (QUAL-01).
 * @see Architecture Section 11.1
 */

import { getConfigPath } from './paths.js';
import { readJsonFile } from './fs-helpers.js';
import { DEFAULT_CONFIG } from './constants.js';

/** Full config type matching Architecture Section 11.1 JSON schema. */
export interface ClaudexConfig {
  schema: string;
  version: number;
  injection: {
    budget_tokens: number;
    gauge_threshold: number;
    topic_shift_budget: number;
  };
  observations: {
    enabled: boolean;
    retention_days: number;
    prune_threshold: number;
    prune_count: number;
  };
  checkpoint: {
    debounce_seconds: number;
    compression: boolean;
    compaction_instructions: string;
  };
  learnings: {
    max_per_project: number;
    surface_count: number;
    publish_to_memory_md: boolean;
  };
  enrichment: {
    enabled: boolean;
    provider: string;
    ollama_base_url: string;
    ollama_model: string;
    timeout_ms: number;
  };
  embeddings: {
    enabled: boolean;
    provider: string;
    model: string;
    ollama_base_url: string;
    topic_shift_threshold: number;
    topic_shift_window: number;
    decision_confidence_threshold: number;
    jaccard_shift_threshold: number;
  };
  observability: {
    enabled: boolean;
    retention_days: number;
    retain_error_count: number;
  };
  gsd: {
    enabled: boolean;
    phase_boost: number;
  };
  context: {
    advisory_threshold: number;
    warning_threshold: number;
    critical_threshold: number;
    checkpoint_cooldown_seconds: number;
  };
  features: {
    observation_capture: boolean;
    checkpoint_system: boolean;
    token_gauge: boolean;
    fts5_search: boolean;
    decision_capture: boolean;
    learnings_promotion: boolean;
    telemetry: boolean;
  };
  adapter: string;
}

/** Returns the full default config object matching Architecture Section 11.1. Never throws. */
export function getDefaultConfig(): ClaudexConfig {
  try {
    return deepClone(DEFAULT_CONFIG) as ClaudexConfig;
  } catch {
    return deepClone(DEFAULT_CONFIG) as ClaudexConfig;
  }
}

/**
 * Reads ~/.claudex/config.json and deep-merges with defaults.
 * Returns full defaults if file is missing or malformed. Never throws.
 */
export function loadConfig(): ClaudexConfig {
  try {
    const loaded = readJsonFile<Partial<ClaudexConfig>>(getConfigPath());
    if (!loaded || typeof loaded !== 'object') {
      return getDefaultConfig();
    }
    const merged = deepMerge(getDefaultConfig() as unknown as Record<string, unknown>, loaded as unknown as Record<string, unknown>) as unknown as ClaudexConfig;
    return validateConfig(merged);
  } catch {
    return getDefaultConfig();
  }
}

/**
 * Validates critical config fields have correct types after merge.
 * Falls back to defaults for any field with an invalid type. Never throws.
 */
function validateConfig(config: ClaudexConfig): ClaudexConfig {
  const defaults = getDefaultConfig();

  // Validate top-level string fields
  if (typeof config.schema !== 'string') config.schema = defaults.schema;
  if (typeof config.version !== 'number') config.version = defaults.version;
  if (typeof config.adapter !== 'string') config.adapter = defaults.adapter;

  // Validate each section: must be an object, then check field types within
  const sectionChecks: Array<{
    key: keyof ClaudexConfig;
    fields: Record<string, 'boolean' | 'number' | 'string'>;
  }> = [
    { key: 'injection', fields: { budget_tokens: 'number', gauge_threshold: 'number', topic_shift_budget: 'number' } },
    { key: 'observations', fields: { enabled: 'boolean', retention_days: 'number', prune_threshold: 'number', prune_count: 'number' } },
    { key: 'checkpoint', fields: { debounce_seconds: 'number', compression: 'boolean', compaction_instructions: 'string' } },
    { key: 'learnings', fields: { max_per_project: 'number', surface_count: 'number', publish_to_memory_md: 'boolean' } },
    { key: 'enrichment', fields: { enabled: 'boolean', provider: 'string', ollama_base_url: 'string', ollama_model: 'string', timeout_ms: 'number' } },
    { key: 'embeddings', fields: { enabled: 'boolean', provider: 'string', model: 'string', ollama_base_url: 'string', topic_shift_threshold: 'number', topic_shift_window: 'number', decision_confidence_threshold: 'number', jaccard_shift_threshold: 'number' } },
    { key: 'observability', fields: { enabled: 'boolean', retention_days: 'number', retain_error_count: 'number' } },
    { key: 'gsd', fields: { enabled: 'boolean', phase_boost: 'number' } },
    { key: 'context', fields: { advisory_threshold: 'number', warning_threshold: 'number', critical_threshold: 'number', checkpoint_cooldown_seconds: 'number' } },
    { key: 'features', fields: { observation_capture: 'boolean', checkpoint_system: 'boolean', token_gauge: 'boolean', fts5_search: 'boolean', decision_capture: 'boolean', learnings_promotion: 'boolean', telemetry: 'boolean' } },
  ];

  for (const { key, fields } of sectionChecks) {
    if (typeof config[key] !== 'object' || config[key] === null || Array.isArray(config[key])) {
      // Entire section is invalid — replace with default
      (config as unknown as Record<string, unknown>)[key] = (defaults as unknown as Record<string, unknown>)[key];
      continue;
    }

    const section = config[key] as Record<string, unknown>;
    const defaultSection = defaults[key] as Record<string, unknown>;
    for (const [field, expectedType] of Object.entries(fields)) {
      if (typeof section[field] !== expectedType) {
        section[field] = defaultSection[field];
      }
    }
  }

  return config;
}

/** Simple recursive deep merge. Loaded values override defaults. */
function deepMerge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const defaultVal = defaults[key];
    const overrideVal = overrides[key];
    if (
      defaultVal !== null && overrideVal !== null &&
      typeof defaultVal === 'object' && typeof overrideVal === 'object' &&
      !Array.isArray(defaultVal) && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(defaultVal as Record<string, unknown>, overrideVal as Record<string, unknown>);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

/** Deep clone via JSON roundtrip. */
function deepClone(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj));
}
