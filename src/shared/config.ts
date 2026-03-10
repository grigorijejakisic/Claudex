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
    boundary_only: boolean;
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
    return deepMerge(getDefaultConfig() as unknown as Record<string, unknown>, loaded as unknown as Record<string, unknown>) as unknown as ClaudexConfig;
  } catch {
    return getDefaultConfig();
  }
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
