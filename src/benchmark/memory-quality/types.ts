/**
 * SC#3 — MEMORY.md content-quality mechanical scorer types.
 *
 * Per Phase 11 CONTEXT.md (lines 54-62), the rubric is 5 dimensions × 20 pts = 100:
 *   1. Parsing            — top sentinel + line-anchored marker + no duplicate ## headers
 *   2. Project-specific   — pointers reference project-local files / project's own slug
 *   3. Topics not session-IDs — pointer titles don't look like raw session UUIDs
 *   4. Pointer density    — ≥1 pointer per 10 nonblank lines
 *   5. Handoff freshness  — MEMORY.md ## Handoff agrees with context/handoffs/ACTIVE.md
 *
 * Pass threshold: 80/100. Plan 11-01 hard rule: every active project ≥80
 * (no aggregate masking).
 */

export interface DimensionScore {
  /** points awarded, integer 0..max */
  score: number;
  /** ceiling for this dimension */
  max: number;
}

export interface ParsingDimension extends DimensionScore {
  details: string;
}

export interface ProjectSpecificDimension extends DimensionScore {
  total: number;
  specific: number;
}

export interface TopicsDimension extends DimensionScore {
  total: number;
  topicLabeled: number;
}

export interface DensityDimension extends DimensionScore {
  ratio: number;
  nonblankLines: number;
  pointers: number;
}

export interface HandoffFreshnessDimension extends DimensionScore {
  details: string;
}

export interface MemoryQualityScore {
  /** Project slug (e.g. "claudex-v3"). */
  project: string;
  /** Absolute path to the MEMORY.md scored. */
  memoryPath: string;
  /** Sum of dimension scores, 0..100. */
  total: number;
  /** total >= 80 */
  pass: boolean;
  dimensions: {
    parsing: ParsingDimension;
    projectSpecific: ProjectSpecificDimension;
    topicsNotSessionIds: TopicsDimension;
    pointerDensity: DensityDimension;
    handoffFreshness: HandoffFreshnessDimension;
  };
}

export interface MissingProjectResult {
  project: string;
  missing: true;
  memoryPath: string;
  reason: string;
}

export type ProjectScoreResult = MemoryQualityScore | MissingProjectResult;

export function isMissing(r: ProjectScoreResult): r is MissingProjectResult {
  return (r as MissingProjectResult).missing === true;
}
