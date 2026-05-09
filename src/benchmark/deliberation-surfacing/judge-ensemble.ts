/**
 * POLISH-10 — 4-judge ensemble for deliberation-surfacing harness.
 *
 * 11-CONTEXT.md locked decision #3: 4-judge ensemble across families
 * (Google / Anthropic / Zhipu / Moonshot) with 3-of-4 majority + 3-of-3
 * fallback when one judge errors > 10% of probes. INCONCLUSIVE when > 1
 * judge errors > 10% (don't drop to 2-of-2; preserves the disagreement
 * signal that catches single-judge bias).
 *
 * This module exposes the ensemble adjudication shape + run-level fallback
 * computation. The per-judge dispatch wrappers are pluggable — Phase 11
 * lands the orchestration; Wave 3 (Plans 11-06, 11-07, 11-08) is responsible
 * for plumbing the actual fetch endpoints (Ollama paid cloud passthrough for
 * Gemini-3-Flash / GLM-5.1 / Kimi-K2.6, Anthropic OAuth for Claude Opus 4.7).
 *
 * Pluggable dispatch lets the harness run in two modes:
 *   - Real LLM mode: all four judges hit live endpoints (W3 measurement runs).
 *   - Test mode: dispatchToJudge mocked at the module boundary.
 */

import type {
  JudgeIdentity,
  SingleJudgeVerdict,
  EnsembleVerdict,
} from './types.js';

export const JUDGES: readonly JudgeIdentity[] = [
  { name: 'gemini-3-flash', family: 'google' },
  { name: 'claude-opus-4-7', family: 'anthropic' },
  { name: 'glm-5.1', family: 'zhipu' },
  { name: 'kimi-k2.6', family: 'moonshot' },
] as const;

/** Default per-judge error budget threshold, in percent. CONTEXT decision #3. */
export const RUN_ERROR_BUDGET_PCT = 10;

/**
 * Pluggable dispatch — caller supplies the per-judge fetcher. The judge
 * receives a rendered prompt and returns the raw response text. The
 * fetcher is responsible for endpoint selection, OAuth/credentials, and
 * temperature=0 for reproducibility (Gemini Harness Finding #3).
 */
export type JudgeDispatcher = (
  judge: JudgeIdentity,
  prompt: string,
) => Promise<string>;

/**
 * Pluggable verdict parser — takes the judge's raw response text and
 * returns true=pass, false=fail, or null=unparseable. The harness's
 * existing single-judge parser (judge.ts:parseJudgeResponse) is the
 * recommended implementation; the ensemble keeps it pluggable so test
 * suites can inject deterministic synthetic responses.
 */
export type VerdictParser = (raw: string) => boolean | null;

export interface AdjudicateOpts {
  dispatcher: JudgeDispatcher;
  parser: VerdictParser;
  /** When set, the named judge is excluded from the ensemble run-wide (3-of-3 fallback). */
  dropped_judge?: JudgeIdentity['name'];
}

/**
 * Adjudicate a single (probe, prompt) pair across the 4-judge ensemble.
 * Returns the per-judge verdicts plus the ensemble decision.
 *
 * Majority threshold:
 *   - 4 active judges → 3 of 4 pass.
 *   - 3 active judges (fallback) → 2 of 3 pass.
 * If the number of valid (non-error) verdicts is below the majority
 * threshold, ensemble.pass = null (cannot reach majority on this probe).
 */
export async function adjudicateWithEnsemble(
  prompt: string,
  opts: AdjudicateOpts,
): Promise<EnsembleVerdict> {
  const activeJudges = JUDGES.filter((j) => j.name !== opts.dropped_judge);
  const verdicts: SingleJudgeVerdict[] = await Promise.all(
    activeJudges.map((j) => callSingleJudge(j, prompt, opts.dispatcher, opts.parser)),
  );
  const validVerdicts = verdicts.filter((v) => v.pass !== null);
  const passCount = validVerdicts.filter((v) => v.pass === true).length;
  const errorCount = verdicts.length - validVerdicts.length;

  // 4 judges → ceil(4/2)+1=3. 3 judges (fallback) → ceil(3/2)+1=2.
  const majorityThreshold = Math.floor(activeJudges.length / 2) + 1;

  let pass: boolean | null;
  if (validVerdicts.length < majorityThreshold) {
    pass = null;
  } else if (passCount >= majorityThreshold) {
    pass = true;
  } else {
    pass = false;
  }

  return {
    per_judge: verdicts,
    pass,
    error_count: errorCount,
    fallback_active: !!opts.dropped_judge,
    dropped_judge: opts.dropped_judge,
  };
}

async function callSingleJudge(
  judge: JudgeIdentity,
  prompt: string,
  dispatcher: JudgeDispatcher,
  parser: VerdictParser,
): Promise<SingleJudgeVerdict> {
  try {
    const raw = await dispatcher(judge, prompt);
    const pass = parser(raw);
    return { judge: judge.name, pass, raw };
  } catch (err) {
    return {
      judge: judge.name,
      pass: null,
      raw: '',
      error: (err as Error).message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Run-level fallback computation
// ---------------------------------------------------------------------------

export interface RunErrorBudget {
  /** Error count per judge across the run-so-far */
  errorsByJudge: Record<JudgeIdentity['name'], number>;
  /** Total probes evaluated so far in this run */
  totalProbes: number;
  /** Threshold percentage above which a judge is dropped (default 10) */
  thresholdPct?: number;
}

export interface RunFallback {
  /** When set, this judge is dropped run-wide for the remainder of the run */
  dropped_judge?: JudgeIdentity['name'];
  /** When true, > 1 judge exceeded the threshold — ensemble integrity compromised; the run is INCONCLUSIVE */
  inconclusive?: boolean;
}

/**
 * Compute the run-level fallback strategy from the per-judge error budget.
 *
 * Per 11-CONTEXT.md § Methodology critique #6:
 *   - 0 judges over threshold → no fallback (continue with all 4).
 *   - 1 judge over threshold → drop that judge run-wide (3-of-3 fallback).
 *   - > 1 judge over threshold → INCONCLUSIVE (don't drop to 2-of-2; the
 *     disagreement signal that catches single-judge bias is lost below 3
 *     active judges).
 */
export function computeRunFallback(budget: RunErrorBudget): RunFallback {
  const thresholdPct = budget.thresholdPct ?? RUN_ERROR_BUDGET_PCT;
  if (budget.totalProbes === 0) return {};
  const overThreshold = (Object.entries(budget.errorsByJudge) as Array<[JudgeIdentity['name'], number]>)
    .filter(([_, n]) => (n / budget.totalProbes) * 100 > thresholdPct)
    .map(([name]) => name);
  if (overThreshold.length === 0) return {};
  if (overThreshold.length === 1) return { dropped_judge: overThreshold[0] };
  return { inconclusive: true };
}
