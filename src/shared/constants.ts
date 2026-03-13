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

/** Default config values matching Architecture Section 11.1. */
export const DEFAULT_CONFIG = {
  schema: 'claudex/config' as const,
  version: 3,
  injection: {
    budget_tokens: 4000,
    boundary_only: true,
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
