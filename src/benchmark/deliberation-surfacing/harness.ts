import type { Database } from 'better-sqlite3';
import type { Probe } from './probe-schema.js';
import type { ProbeOutcome, ReplicationRunResult, ArmRunResult, JudgeVerdict } from './types.js';
import { runSummaryArm, type RunArmOpts } from './arm-summary.js';
import { runTranscriptArm, type RunTranscriptArmOpts } from './arm-transcript.js';
import { callJudge, type CallJudgeOpts, JUDGE_MODEL } from './judge.js';

export interface RunReplicationOpts {
  replication_label: string;
  agent_model?: string;
  judge_model?: string;
  /** P8 reranker-fitness verdict at run time. PASS → cross-encoder. FAIL → bi-encoder. */
  useBiEncoderOnly?: boolean;
  topK?: number;
  project?: string;
  onProbeStart?: (probe: Probe, idx: number, total: number) => void;
  onProbeComplete?: (outcome: ProbeOutcome, idx: number, total: number) => void;
  agentFetcher?: typeof fetch;
  judgeFetcher?: typeof fetch;
  rerankerFetcher?: typeof fetch;
  embeddingFetcher?: typeof fetch;
}

const ERROR_JUDGE_VERDICT: JudgeVerdict = {
  prong_1: { verdict: 'FAIL', justification: 'arm errored — no response to grade' },
  prong_2: { verdict: 'FAIL', justification: 'arm errored — no response to grade' },
  prong_3: { verdict: 'FAIL', justification: 'arm errored — no response to grade' },
  probe_pass: false,
  raw_response: '',
};

async function gradeArm(probe: Probe, arm: ArmRunResult, opts: CallJudgeOpts): Promise<JudgeVerdict> {
  if (arm.error || !arm.agent_response) return ERROR_JUDGE_VERDICT;
  try {
    return await callJudge(probe, arm.agent_response, opts);
  } catch (err) {
    return {
      ...ERROR_JUDGE_VERDICT,
      raw_response: `judge call failed: ${String(err)}`,
    };
  }
}

/**
 * Orchestrates one full replication: for each probe, run A-arm + B-arm,
 * grade each via the locked three-prong rubric, return ReplicationRunResult.
 *
 * Pure with respect to the supplied db handle and opts.fetchers.
 * No filesystem writes. No telemetry. Aggregator append is the runner's job
 * (plan 09-03).
 */
export async function runReplication(
  db: Database,
  probes: Probe[],
  opts: RunReplicationOpts,
): Promise<ReplicationRunResult> {
  const startedAtIso = new Date().toISOString();
  const armOpts: RunArmOpts = {
    fetcher: opts.agentFetcher,
    agentModel: opts.agent_model,
    project: opts.project,
  };
  const transcriptArmOpts: RunTranscriptArmOpts = {
    ...armOpts,
    useBiEncoderOnly: opts.useBiEncoderOnly,
    topK: opts.topK,
    rerankerFetcher: opts.rerankerFetcher,
    embeddingFetcher: opts.embeddingFetcher,
  };
  const judgeOpts: CallJudgeOpts = { fetcher: opts.judgeFetcher, model: opts.judge_model };

  const outcomes: ProbeOutcome[] = [];
  let summary_pass_count = 0;
  let transcript_pass_count = 0;

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    opts.onProbeStart?.(probe, i, probes.length);

    const summary_arm = await runSummaryArm(db, probe, armOpts);
    const transcript_arm = await runTranscriptArm(db, probe, transcriptArmOpts);

    const summary_judge = await gradeArm(probe, summary_arm, judgeOpts);
    const transcript_judge = await gradeArm(probe, transcript_arm, judgeOpts);

    if (summary_judge.probe_pass) summary_pass_count++;
    if (transcript_judge.probe_pass) transcript_pass_count++;

    const outcome: ProbeOutcome = {
      probe_id: probe.id,
      kind: probe.kind,
      summary_arm,
      transcript_arm,
      summary_judge,
      transcript_judge,
    };
    outcomes.push(outcome);
    opts.onProbeComplete?.(outcome, i, probes.length);
  }

  return {
    replication_label: opts.replication_label,
    started_at_iso: startedAtIso,
    completed_at_iso: new Date().toISOString(),
    agent_model: opts.agent_model ?? 'deepseek-coder-v2:16b',
    judge_model: opts.judge_model ?? JUDGE_MODEL,
    probe_count: probes.length,
    retrieval_baseline: opts.useBiEncoderOnly ? 'bi_encoder_fallback' : 'cross_encoder',
    outcomes,
    summary_pass_count,
    transcript_pass_count,
  };
}
