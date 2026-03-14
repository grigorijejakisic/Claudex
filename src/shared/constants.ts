/**
 * Schema versions, capability constants, and default configuration values.
 * @see Architecture Sections 3.1, 11.1
 */

import type { RuntimeCapabilities } from './types.js';

/** CC Hook Adapter capabilities. @see Architecture Section 3.1 */
export const CC_CAPABILITIES: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: true,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,
  hasLocalEmbeddings: true,
  supportsTurnEndEvent: true,
};

/** OpenClaw Bridge Adapter capabilities. @see Architecture Section 3.1 */
export const OPENCLAW_CAPABILITIES: RuntimeCapabilities = {
  hasFullMessageHistory: true,
  hasNativeContextUsage: true,
  hasTranscriptAccess: false,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,
  hasLocalEmbeddings: true,
  supportsTurnEndEvent: true,
};

/** Database schema version. */
export const SCHEMA_VERSION = 300;

/** Default custom compaction instructions for CC. @see Upgrade 13 */
export const DEFAULT_COMPACTION_INSTRUCTIONS = [
  'Preserve all file paths verbatim — do not abbreviate, shorten, or summarize paths.',
  'Preserve error messages and stack traces verbatim.',
  'Preserve architectural decisions and their rationale.',
  'Do NOT reproduce code blocks verbatim — reference the file path and function name instead.',
  'Strip old tool outputs (older than 10 turns) — they are stored in the observation database.',
  'The checkpoint (## Checkpoint section) is the authoritative state source. Preserve its content.',
  'Keep the most recent context gauge line verbatim.',
].join('\n');

/** Default config values matching Architecture Section 11.1. */
export const DEFAULT_CONFIG = {
  schema: 'claudex/config' as const,
  version: 3,
  injection: {
    budget_tokens: 4000,
    gauge_threshold: 0.70,
    topic_shift_budget: 800,
  },
  observations: {
    enabled: true,
    retention_days: 90,
    prune_threshold: 1000,
    prune_count: 50,
  },
  checkpoint: {
    debounce_seconds: 60,
    compression: false,
    compaction_instructions: DEFAULT_COMPACTION_INSTRUCTIONS,
  },
  learnings: {
    max_per_project: 50,
    surface_count: 10,
    publish_to_memory_md: false,
  },
  enrichment: {
    enabled: true,
    provider: 'auto' as const,
    ollama_base_url: 'http://localhost:11434',
    ollama_model: 'auto' as const,
    timeout_ms: 10000,
  },
  embeddings: {
    enabled: true,
    provider: 'ollama' as const,
    model: 'nomic-embed-text',
    ollama_base_url: 'http://localhost:11434',
    topic_shift_threshold: 0.35,
    topic_shift_window: 3,
    decision_confidence_threshold: 0.15,
    jaccard_shift_threshold: 0.15,
  },
  observability: {
    enabled: true,
    retention_days: 7,
    retain_error_count: 1000,
  },
  gsd: {
    enabled: true,
    phase_boost: 0.10,
  },
  context: {
    advisory_threshold: 0.50,
    warning_threshold: 0.65,
    critical_threshold: 0.80,
    checkpoint_cooldown_seconds: 300,
  },
  features: {
    observation_capture: true,
    checkpoint_system: true,
    token_gauge: true,
    fts5_search: true,
    decision_capture: true,
    learnings_promotion: true,
    telemetry: true,
  },
  adapter: 'auto' as const,
} as const;

/**
 * Context pressure zone thresholds for gauge injection. @see Upgrade 1
 * R50: Derived from DEFAULT_CONFIG.context — single source of truth.
 */
export const PRESSURE_ZONES = {
  normal:   { max: DEFAULT_CONFIG.context.advisory_threshold },
  advisory: { min: DEFAULT_CONFIG.context.advisory_threshold, max: DEFAULT_CONFIG.context.warning_threshold },
  warning:  { min: DEFAULT_CONFIG.context.warning_threshold,  max: DEFAULT_CONFIG.context.critical_threshold },
  critical: { min: DEFAULT_CONFIG.context.critical_threshold },
} as const;

export type PressureZone = 'normal' | 'advisory' | 'warning' | 'critical';

/** Determine pressure zone from utilization ratio (0.0-1.0). */
export function getPressureZone(utilization: number): PressureZone {
  if (utilization >= PRESSURE_ZONES.critical.min) return 'critical';
  if (utilization >= PRESSURE_ZONES.warning.min) return 'warning';
  if (utilization >= PRESSURE_ZONES.advisory.min) return 'advisory';
  return 'normal';
}

/** Maximum content length for observation extraction. @see Architecture Section 5.2 */
export const CONTENT_MAX_CHARS = 500;
