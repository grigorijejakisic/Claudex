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
