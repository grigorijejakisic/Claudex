/**
 * Typed event detail interfaces for all 10 telemetry event kinds.
 */

export interface HookInvocationDetail {
  hook: string;
  duration_ms: number;
  result: 'inject' | 'skip' | 'error';
}

export interface InjectionDetail {
  trigger: 'session_start' | 'post_compaction' | 'topic_shift' | 'gauge';
  sections_included: string[];
  sections_skipped: string[];
  total_tokens: number;
  budget_remaining: number;
}

export interface ObservationCaptureDetail {
  tool: string;
  category?: string;
  importance?: number;
  stored: boolean;
  filtered_reason?: string;
}

export interface DecisionCaptureDetail {
  content: string;
  source?: string;
  stage1_match: boolean;
  stage2_confidence?: number;
  stored: boolean;
  reason?: string;
}

export interface CheckpointWriteDetail {
  checkpoint_id: string;
  trigger: string;
  state: 'pending' | 'committed' | 'mirrored';
  enrichment_attempted?: boolean;
  enrichment_succeeded?: boolean;
  enrichment_provider?: string;
  write_duration_ms?: number;
}

export interface TopicShiftDetail {
  method: 'embedding' | 'jaccard' | 'explicit';
  similarity: number;
  shifted: boolean;
  old_topic?: string;
  new_topic?: string;
  pivot_tokens?: number;
}

export interface DedupDetail {
  type: 'decision' | 'learning';
  tier: 'exact' | 'jaccard' | 'substring';
  similarity: number;
  action: 'skip' | 'promote';
}

export interface DecayPruneDetail {
  count: number;
  threshold: number;
}

export interface ErrorDetail {
  subsystem: string;
  error: string;
  fallback?: string;
}

export interface EnrichmentDetail {
  provider: string;
  model?: string;
  duration_ms: number;
  success: boolean;
  error?: string;
}

/** Discriminated union of all telemetry event detail types. */
export type TelemetryDetail =
  | HookInvocationDetail
  | InjectionDetail
  | ObservationCaptureDetail
  | DecisionCaptureDetail
  | CheckpointWriteDetail
  | TopicShiftDetail
  | DedupDetail
  | DecayPruneDetail
  | ErrorDetail
  | EnrichmentDetail;

/** All valid telemetry event kinds. */
export type EventKind =
  | 'hook_invocation'
  | 'injection'
  | 'observation_capture'
  | 'decision_capture'
  | 'checkpoint_write'
  | 'enrichment'
  | 'topic_shift'
  | 'dedup'
  | 'decay_prune'
  | 'error';

/** Type mapping from EventKind to its detail type. */
export interface EventKindDetailMap {
  hook_invocation: HookInvocationDetail;
  injection: InjectionDetail;
  observation_capture: ObservationCaptureDetail;
  decision_capture: DecisionCaptureDetail;
  checkpoint_write: CheckpointWriteDetail;
  enrichment: EnrichmentDetail;
  topic_shift: TopicShiftDetail;
  dedup: DedupDetail;
  decay_prune: DecayPruneDetail;
  error: ErrorDetail;
}
