/**
 * Config loading, validation, and defaults.
 * Defensive non-throwing.
 */

import { getConfigPath } from './paths.js';
import { readJsonFile } from './fs-helpers.js';
import { DEFAULT_CONFIG } from './constants.js';

/** Full config type. */
export interface ClaudexConfig {
  schema: string;
  version: number;
  injection: {
    budget_tokens: number;
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
  };
  context: {
    advisory_threshold: number;
    warning_threshold: number;
    critical_threshold: number;
    checkpoint_cooldown_seconds: number;
  };
  features: {
    fts5_search: boolean;
    /**
     * Phase 2 IDX-01 — gates ingest-time error-fingerprint computation in
     * `writeToolResult` and the explicit one-time backfill in
     * `src/benchmark/episodic-density/`. Defaults to `true` for Phase 2 so
     * the corpus is populated and the measurement harness has signal to
     * score; Plan 02-05 flips this to `false` if the empirical-phase verdict
     * lands on KILL or SCOPE_DOWN (CONTEXT item 7 negative-result handling).
     */
    error_fingerprint: boolean;
  };
  /**
   * v6 routing surface (Phase 10 — CONTEXT decisions 1-3).
   * Five locked first-principles defaults consumed by transcript-routing.ts
   * (routing layer) and deliberation-surface.ts (assembly token budget).
   */
  v6: {
    routing: {
      top_k_per_artifact: number;
      max_k_per_query: number;
      token_pct_cap: number;
      bi_encoder_budget_pct: number;
      reranker_mode: 'bi_encoder_primary' | 'cross_encoder_primary';
    };
  };
  adapter: string;
}

/** Returns the full default config object. Never throws. */
export function getDefaultConfig(): ClaudexConfig {
  try {
    return deepClone(DEFAULT_CONFIG) as ClaudexConfig;
  } catch {
    // Non-throwing: if first clone fails (shouldn't happen), retry — caller always gets valid config
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
    // Non-throwing: no DB access — caller handles missing config via getDefaultConfig() fallback
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
    { key: 'injection', fields: { budget_tokens: 'number', topic_shift_budget: 'number' } },
    { key: 'observations', fields: { enabled: 'boolean', retention_days: 'number', prune_threshold: 'number', prune_count: 'number' } },
    { key: 'checkpoint', fields: { debounce_seconds: 'number', compression: 'boolean', compaction_instructions: 'string' } },
    { key: 'learnings', fields: { max_per_project: 'number', surface_count: 'number' } },
    { key: 'enrichment', fields: { enabled: 'boolean', provider: 'string', ollama_base_url: 'string', ollama_model: 'string', timeout_ms: 'number' } },
    { key: 'embeddings', fields: { enabled: 'boolean', provider: 'string', model: 'string', ollama_base_url: 'string', topic_shift_threshold: 'number', topic_shift_window: 'number', decision_confidence_threshold: 'number', jaccard_shift_threshold: 'number' } },
    { key: 'observability', fields: { enabled: 'boolean', retention_days: 'number', retain_error_count: 'number' } },
    { key: 'gsd', fields: { enabled: 'boolean' } },
    { key: 'context', fields: { advisory_threshold: 'number', warning_threshold: 'number', critical_threshold: 'number', checkpoint_cooldown_seconds: 'number' } },
    { key: 'features', fields: { fts5_search: 'boolean', error_fingerprint: 'boolean' } },
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

  // v6.routing nested validation (CONTEXT decision 3 — five locked keys)
  const cfgAny = config as unknown as Record<string, unknown>;
  if (typeof cfgAny.v6 !== 'object' || cfgAny.v6 === null || Array.isArray(cfgAny.v6)) {
    cfgAny.v6 = (defaults as unknown as Record<string, unknown>).v6;
  } else {
    const v6 = cfgAny.v6 as Record<string, unknown>;
    if (typeof v6.routing !== 'object' || v6.routing === null || Array.isArray(v6.routing)) {
      v6.routing = (defaults.v6 as unknown as Record<string, unknown>).routing;
    } else {
      const r = v6.routing as Record<string, unknown>;
      const dr = defaults.v6.routing;
      if (typeof r.top_k_per_artifact !== 'number') r.top_k_per_artifact = dr.top_k_per_artifact;
      if (typeof r.max_k_per_query !== 'number') r.max_k_per_query = dr.max_k_per_query;
      if (typeof r.token_pct_cap !== 'number') r.token_pct_cap = dr.token_pct_cap;
      if (typeof r.bi_encoder_budget_pct !== 'number') r.bi_encoder_budget_pct = dr.bi_encoder_budget_pct;
      if (r.reranker_mode !== 'bi_encoder_primary' && r.reranker_mode !== 'cross_encoder_primary') {
        r.reranker_mode = dr.reranker_mode;
      }
    }
  }

  // Semantic range validation for numeric fields
  validateNumericRanges(config, defaults);

  return config;
}

/**
 * Validates numeric config fields have sensible ranges.
 * Falls back to defaults for out-of-range values. Never throws.
 * Ensures finiteness, non-negativity, and domain-specific bounds.
 */
function validateNumericRanges(config: ClaudexConfig, defaults: ClaudexConfig): void {
  // Helper: clamp to finite positive integer with optional max
  const posInt = (val: number, def: number, max?: number): number => {
    if (!Number.isInteger(val) || val <= 0) return def;
    if (max !== undefined && val > max) return def;
    return val;
  };
  // Helper: clamp to finite non-negative number
  const nonNeg = (val: number, def: number): number => {
    if (!Number.isFinite(val) || val < 0) return def;
    return val;
  };
  // Helper: value must be in (0, 1] range (thresholds)
  const threshold = (val: number, def: number): number => {
    if (!Number.isFinite(val) || val <= 0 || val > 1) return def;
    return val;
  };

  // injection
  config.injection.budget_tokens = posInt(config.injection.budget_tokens, defaults.injection.budget_tokens);
  config.injection.topic_shift_budget = posInt(config.injection.topic_shift_budget, defaults.injection.topic_shift_budget);

  // observations
  config.observations.retention_days = posInt(config.observations.retention_days, defaults.observations.retention_days, 365);
  config.observations.prune_threshold = posInt(config.observations.prune_threshold, defaults.observations.prune_threshold);
  config.observations.prune_count = posInt(config.observations.prune_count, defaults.observations.prune_count);

  // checkpoint
  config.checkpoint.debounce_seconds = nonNeg(config.checkpoint.debounce_seconds, defaults.checkpoint.debounce_seconds);

  // learnings
  config.learnings.max_per_project = posInt(config.learnings.max_per_project, defaults.learnings.max_per_project);
  config.learnings.surface_count = posInt(config.learnings.surface_count, defaults.learnings.surface_count);

  // enrichment
  config.enrichment.timeout_ms = posInt(config.enrichment.timeout_ms, defaults.enrichment.timeout_ms);

  // embeddings
  config.embeddings.topic_shift_threshold = threshold(config.embeddings.topic_shift_threshold, defaults.embeddings.topic_shift_threshold);
  config.embeddings.topic_shift_window = posInt(config.embeddings.topic_shift_window, defaults.embeddings.topic_shift_window);
  config.embeddings.decision_confidence_threshold = threshold(config.embeddings.decision_confidence_threshold, defaults.embeddings.decision_confidence_threshold);
  config.embeddings.jaccard_shift_threshold = threshold(config.embeddings.jaccard_shift_threshold, defaults.embeddings.jaccard_shift_threshold);

  // observability
  config.observability.retention_days = posInt(config.observability.retention_days, defaults.observability.retention_days, 365);
  config.observability.retain_error_count = posInt(config.observability.retain_error_count, defaults.observability.retain_error_count);

  // context thresholds — must be in (0, 1] and ordered: advisory < warning < critical
  config.context.advisory_threshold = threshold(config.context.advisory_threshold, defaults.context.advisory_threshold);
  config.context.warning_threshold = threshold(config.context.warning_threshold, defaults.context.warning_threshold);
  config.context.critical_threshold = threshold(config.context.critical_threshold, defaults.context.critical_threshold);
  if (!(config.context.advisory_threshold < config.context.warning_threshold &&
        config.context.warning_threshold < config.context.critical_threshold)) {
    config.context.advisory_threshold = defaults.context.advisory_threshold;
    config.context.warning_threshold = defaults.context.warning_threshold;
    config.context.critical_threshold = defaults.context.critical_threshold;
  }
  config.context.checkpoint_cooldown_seconds = nonNeg(config.context.checkpoint_cooldown_seconds, defaults.context.checkpoint_cooldown_seconds);
}

/** Simple recursive deep merge. Only copies keys present in defaults (R28). */
function deepMerge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, key)) continue; // strip unknown keys
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
