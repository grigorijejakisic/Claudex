/**
 * RL scoring disabled — in-memory process-scoped counter.
 *
 * Incremented each time the CLAUDEX_DISABLE_RL_SCORING env-var gate fires.
 * The category lets the Phase 8 A/B harness assert which sub-system
 * intercepted the path.
 *
 * NOTE: This is a deliberately lightweight counter — it is NOT persisted
 * to the `telemetry` table because the gate is a Phase-8-only ablation
 * mechanism (Phase 9.8 will either delete the gate when the RL stack is
 * deleted, or it stays as a runtime toggle with no production reporting
 * need). For DB-backed runtime telemetry use `telemetry-counters.ts` and
 * its `event_kind` enum.
 *
 * Categories used by Phase 8 (ABL-01):
 *   'qmultiplier'           — hybrid-retrieval read path
 *   'memrl-scorer'          — write path (q_value column mutators + decay)
 *   'retrieval-rl'          — updateSessionQValues confidence-blend path
 *   'rl-trainer-heartbeat'  — Angel heartbeat trainer tick
 */

export type RlScoringDisabledCategory =
  | 'qmultiplier'
  | 'memrl-scorer'
  | 'retrieval-rl'
  | 'rl-trainer-heartbeat';

const counters = new Map<RlScoringDisabledCategory, number>();

export function incrementRlScoringDisabledCounter(
  category: RlScoringDisabledCategory,
): void {
  counters.set(category, (counters.get(category) ?? 0) + 1);
}

export function getRlScoringDisabledCount(
  category?: RlScoringDisabledCategory,
): number {
  if (category !== undefined) {
    return counters.get(category) ?? 0;
  }
  let total = 0;
  for (const v of counters.values()) total += v;
  return total;
}

export function resetRlScoringDisabledCounter(): void {
  counters.clear();
}
