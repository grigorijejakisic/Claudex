/**
 * Schema versions, capability constants, and default configuration values.
 */

import type { RuntimeCapabilities } from './types.js';

/** CC Hook Adapter capabilities. */
export const CC_CAPABILITIES: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: true,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,
  hasLocalEmbeddings: true,
  supportsTurnEndEvent: true,
};

/** OpenClaw Bridge Adapter capabilities. */
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

/** Default custom compaction instructions for CC. */
export const DEFAULT_COMPACTION_INSTRUCTIONS = [
  'Preserve all file paths verbatim — do not abbreviate, shorten, or summarize paths.',
  'Preserve error messages and stack traces verbatim.',
  'Preserve architectural decisions and their rationale.',
  'Do NOT reproduce code blocks verbatim — reference the file path and function name instead.',
  'Strip old tool outputs (older than 10 turns) — they are stored in the observation database.',
  'The checkpoint (## Checkpoint section) is the authoritative state source. Preserve its content.',
  'Keep the most recent context gauge line verbatim.',
].join('\n');

/** Default config values. */
export const DEFAULT_CONFIG = {
  schema: 'claudex/config' as const,
  version: 3,
  injection: {
    budget_tokens: 8000,
    topic_shift_budget: 800,
  },
  observations: {
    retention_days: 90,
    prune_threshold: 1000,
    prune_count: 50,
  },
  checkpoint: {
    debounce_seconds: 60,
    compaction_instructions: DEFAULT_COMPACTION_INSTRUCTIONS,
  },
  learnings: {
    max_per_project: 50,
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
    retention_days: 7,
    retain_error_count: 1000,
  },
  context: {
    advisory_threshold: 0.50,
    warning_threshold: 0.65,
    critical_threshold: 0.80,
    checkpoint_cooldown_seconds: 300,
  },
} as const;

/**
 * Context pressure zone thresholds for gauge injection.
 * Derived from DEFAULT_CONFIG.context — single source of truth.
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

/**
 * Scales injection budget based on context window size.
 * 200K (default): 1x base budget. 1M: 2x base budget.
 * Linear interpolation between thresholds — no arbitrary jumps.
 */
export function scaleBudget(baseBudget: number, contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 200_000) return baseBudget;
  // Scale linearly: 200K→1x, 1M→2x (was 3x — too aggressive for session-start)
  const scale = 1 + Math.min((contextWindowTokens - 200_000) / 800_000, 1);
  return Math.round(baseBudget * scale);
}

/** Maximum content length for observation extraction. */
export const CONTENT_MAX_CHARS = 500;

/** Tool names that perform file edits — used for behavioral signal detection. */
export const EDIT_TOOL_NAMES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

/** Sentinel project scope for cross-project (global) patterns and artifacts. */
export const GLOBAL_PROJECT_SCOPE = '__global__';
