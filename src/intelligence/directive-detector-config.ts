/**
 * Directive-detector runtime config.
 *
 * Locked defaults per Phase 3 CONTEXT §Area 2, §Area 3, §Area 5. The harness
 * (Plan 03-05) and Angel hook (Plan 03-04) pass overrides explicitly. No env
 * var reads — config changes flow through this file, caller-supplied
 * overrides, or the precision-harness CLI flags.
 */

export interface DirectiveDetectorConfig {
  /** Minimum LLM confidence to accept `scope='session'|'project'`. Default 0.70. */
  thresholdGeneral: number;
  /** Minimum LLM confidence to accept `scope='universal'`. Default 0.85 (higher blast radius → stricter). */
  thresholdUniversal: number;
  /** Cosine threshold above which the dedup LLM relation classifier is called. Default 0.80. */
  dedupCosineThreshold: number;
  /** Slide-window cap on `data.reinforcements[]`. Oldest entries are dropped beyond this. Default 50. */
  reinforcementCap: number;
  /** Ollama model tag used for the confirmer + dedup-relation classifier. Default glm-5.1:cloud. */
  model: string;
  /** When true, skip all DB writes but return full decision records (precision harness). Default false. */
  dryRun: boolean;
}

export const DEFAULT_CONFIG: DirectiveDetectorConfig = {
  thresholdGeneral: 0.70,
  thresholdUniversal: 0.85,
  dedupCosineThreshold: 0.80,
  reinforcementCap: 50,
  model: 'glm-5.1:cloud',
  dryRun: false,
};

export function loadConfig(overrides?: Partial<DirectiveDetectorConfig>): DirectiveDetectorConfig {
  return { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
}
