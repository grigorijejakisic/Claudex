import type { Probe } from './probe-schema.js';

/** Single judge-prong outcome */
export interface JudgeProngOutcome {
  verdict: 'PASS' | 'FAIL';
  justification: string;
}

/** Output of judge.ts callJudge() per probe-arm pair */
export interface JudgeVerdict {
  prong_1: JudgeProngOutcome; // surfaces-divergence
  prong_2: JudgeProngOutcome; // cites-specifically
  prong_3: JudgeProngOutcome; // concludes-engagement
  probe_pass: boolean;        // AND of all three prongs
  raw_response: string;       // raw model output for audit
}

/** One arm's output for one probe */
export interface ArmRunResult {
  arm: 'summary' | 'transcript';
  probe_id: string;
  agent_model: string;
  agent_response: string;
  injected_context_summary: {
    artifact_count: number;        // # of artifacts the A-arm received
    transcript_span_count: number; // # of transcript spans the B-arm received (0 for A-arm)
    retrieval_path: 'cross_encoder' | 'bi_encoder_fallback' | 'none';
  };
  latency_ms: number;
  error?: string;
}

/** Per-probe result of a single replication */
export interface ProbeOutcome {
  probe_id: string;
  kind: 'a' | 'b' | 'c' | 'd' | 'e';
  summary_arm: ArmRunResult;
  transcript_arm: ArmRunResult;
  summary_judge: JudgeVerdict;
  transcript_judge: JudgeVerdict;
}

/** Output of harness.runReplication() */
export interface ReplicationRunResult {
  replication_label: string;
  started_at_iso: string;
  completed_at_iso: string;
  agent_model: string;
  judge_model: string;
  probe_count: number;
  retrieval_baseline: 'cross_encoder' | 'bi_encoder_fallback';
  outcomes: ProbeOutcome[];
  summary_pass_count: number;
  transcript_pass_count: number;
}

/** Per-replication binding verdict */
export type BindVerdict = 'POSITIVE' | 'NEGATIVE' | 'INCONCLUSIVE';

/** Pooled summary across replications, computed in plan 09-03's verdict module */
export interface ReplicationSummary {
  replications: string[];
  total_probes: number;
  pooled_summary_pass_count: number;
  pooled_transcript_pass_count: number;
  pooled_n: number;
  delta_ci: { point: number; lower: number; upper: number; n: number };
  verdict: BindVerdict;
  per_kind: Array<{
    kind: 'a' | 'b' | 'c' | 'd' | 'e';
    summary_pass_rate: number;
    transcript_pass_rate: number;
    delta: number;
    descriptive_only: true;
  }>;
}

export type { Probe };

// ---------------------------------------------------------------------------
// POLISH-09 — paired-McNemar types
// ---------------------------------------------------------------------------

/**
 * Per-probe paired pass/fail across r1 + r2. Replaces the
 * pseudoreplication-prone `poolReplications` shape.
 *
 * 11-CONTEXT.md § Implementation Decisions § W2 (Q3) keeps the original 30
 * P9 probes byte-immutable. This shape is the input to `pairedMcNemar`,
 * which is the methodology-clean replacement for `poolReplications`.
 */
export interface PerProbeOutcome {
  probe_id: string;
  /** kind from the probe fixture — preserved for per-kind descriptive breakdown */
  kind?: 'a' | 'b' | 'c' | 'd' | 'e';
  /** A-arm (summary-only baseline) pass/fail per replication */
  r1_a_arm_pass: boolean;
  r2_a_arm_pass: boolean;
  /** B-arm (transcript-surfacing condition) pass/fail per replication */
  r1_b_arm_pass: boolean;
  r2_b_arm_pass: boolean;
}

export interface McNemarVerdict {
  /** Probes where A-arm passed but B-arm failed (paired across replications via OR-aggregation) */
  a_only: number;
  /** Probes where B-arm passed but A-arm failed */
  b_only: number;
  /** a_only + b_only — load-bearing for power; below the pre-committed threshold the result is INCONCLUSIVE */
  discordant_pairs: number;
  /** McNemar exact two-sided p-value (binomial CDF on min(a_only, b_only) | n=discordant_pairs, p=0.5) */
  p_value: number;
  /** Pre-committed minimum-discordant-pair threshold from 11-CONTEXT.md § Methodology critique #2 */
  min_discordant_threshold: number;
  /** BIND_POSITIVE / BIND_NEGATIVE / INCONCLUSIVE per the conditional outcomes table */
  verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE';
  /** Per-replication pass counts — descriptive transparency, not a binding gate */
  by_replication: Array<{
    replication: 1 | 2;
    a_pass: number;
    b_pass: number;
    n: number;
  }>;
}

// ---------------------------------------------------------------------------
// POLISH-10 — 4-judge ensemble types
// ---------------------------------------------------------------------------

/**
 * 11-CONTEXT.md locked decision #3: 4-judge ensemble across families
 * (Google / Anthropic / Zhipu / Moonshot) with 3-of-4 majority + 3-of-3
 * fallback when one judge errors > 10% of probes.
 */
export interface JudgeIdentity {
  name: 'gemini-3-flash' | 'claude-opus-4-7' | 'glm-5.1' | 'kimi-k2.6';
  family: 'google' | 'anthropic' | 'zhipu' | 'moonshot';
}

export interface SingleJudgeVerdict {
  judge: JudgeIdentity['name'];
  /** null = unparseable / network error / timeout */
  pass: boolean | null;
  /** Full judge response — preserved for audit trail */
  raw: string;
  error?: string;
}

export interface EnsembleVerdict {
  per_judge: SingleJudgeVerdict[];
  /** True if 3-of-4 (or 2-of-3 in fallback) of the non-error judges voted pass */
  pass: boolean | null;
  /** Number of judges that errored on this probe */
  error_count: number;
  /** Whether the ensemble used the 3-of-3 fallback (one judge dropped run-wide) */
  fallback_active: boolean;
  /** Run-level: which judge (if any) was dropped due to >10% error rate run-wide */
  dropped_judge?: JudgeIdentity['name'];
}
