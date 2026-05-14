/**
 * Vesna probe schema — canonical types per Phase 10 CONTEXT.md lines 53-70.
 *
 * Every probe traces to a real retrieval moment in real session history.
 * Schema is the source of truth for loader, runner, and authoring guide.
 */

export type ProbeCategory =
  | 'entity-recall'
  | 'constraint-recall'
  | 'handoff-pickup'
  | 'cross-project'
  | 'lesson-application'
  | 'self-instrumented'
  | 'deliberation-pipeline-fanout'
  | 'deliberation-agent-engagement'
  | 'buffer';

export interface ExpectedRecall {
  /** Reference identifier of the artifact expected to surface (used in diagnostics). */
  artifact_id_or_pattern: string;
  /** Pass requires the agent surface within this many turns. v4 corpus uses 1 or 2. */
  must_surface_within_turns: number;
  /** Regex strings; ALL must match agent_text for a pass (use alternation for OR). */
  must_contain_phrase_pattern: string[];
}

/**
 * Setup-step DSL: deterministic, idempotent DB-population primitives.
 * Step kinds are the authoring vocabulary; runtime is `applySetup` in setup.ts.
 */
export type SetupStep =
  | {
      kind: 'artifact';
      payload: {
        kind: 'decision' | 'learning' | 'observation';
        summary: string;
        content?: string;
        project: string;
        tags?: string[];
      };
    }
  | {
      kind: 'handoff';
      payload: {
        status: 'active' | 'paused' | 'archived';
        phase: string;
        summary: string;
        topic: string;
        body_what_next?: string;
      };
    }
  | {
      kind: 'critical_rule';
      payload: {
        rule: string;
        project?: string;
      };
    }
  | {
      kind: 'narration_directive';
      payload: {
        silent: boolean;
      };
    }
  | {
      /**
       * v6 Phase 10 — synthetic past-deliberation seeded as an artifact +
       * companion transcript chunks. Writes via the production write surfaces
       * (createArtifact + upsertChunk) so the deliberation-surfacing routing
       * path can fan out from the artifact reference to the surrounding
       * transcript spans. Used by the 5 deliberation-engagement probes (a-e).
       */
      kind: 'deliberation_surface';
      payload: {
        artifact: {
          kind: 'decision' | 'learning' | 'observation';
          summary: string;
          project: string;
          tags?: string[];
        };
        transcript_chunks: Array<{
          session_id: string;
          project_id: string;
          turn_index: number;
          sub_index: number;
          role: 'user' | 'assistant' | 'tool' | 'system';
          provenance: 'organic' | 'injected' | 'tool_result' | 'environmental';
          body: string;
          created_at_epoch_ms: number;
          wrapper_redacted: boolean;
        }>;
      };
    };

export interface Probe {
  /** Convention: <category>-<3-digit>, e.g. "entity-001". */
  id: string;
  category: ProbeCategory;
  /** Provenance — real session that inspired the probe (or phase-{n}-design fallback). */
  source_session_id: string;
  source_project: string;
  source_turn_idx?: number;
  /** Human-readable description of the retrieval moment. */
  scenario: string;
  /** Exact text shown to the agent. */
  user_prompt: string;
  expected_recall: ExpectedRecall;
  /** Tokens that MUST NOT appear in user_prompt (load-time pre-flight). */
  lexical_exclusions: string[];
  evaluation: 'auto' | 'semi-auto';
  setup_steps?: SetupStep[];
  /** Buffer slots are loaded but skipped at runtime; excluded from per-category totals. */
  buffer_placeholder?: boolean;
}

/** Output of a single probe trial. */
export interface ProbeTrialResult {
  passed: boolean;
  diagnostic: string;
  agent_output: string;
  turns_taken: number;
}

/** Verdict from majority over the configured trial count. */
export interface ProbeResult {
  probe_id: string;
  category: ProbeCategory;
  trials: ProbeTrialResult[];
  /** pass = all trials pass; fail = all trials fail; flaky = mixed (1/3 or 2/3). */
  verdict: 'pass' | 'fail' | 'flaky';
}

/** Final aggregated suite report. Produced by `runVesnaSuite`. */
export interface SuiteReport {
  aggregate_pass_rate: number;
  per_category: Record<
    ProbeCategory,
    { pass_rate: number; total: number; passed: number; flaky: number }
  >;
  flaky_probes: string[];
  failed_probes: { id: string; category: ProbeCategory; diagnostics: string[] }[];
  /** True iff aggregate >=0.8 AND every non-empty, non-buffer category >=0.8. */
  gated: boolean;
}

/** Thrown by the loader when a probe's user_prompt contains a lexical-exclusion token. */
export class LexicalLeakageError extends Error {
  readonly probe_id: string;
  readonly leaked: string[];
  constructor(probeId: string, leaked: string[]) {
    super(
      `LexicalLeakageError: probe '${probeId}' user_prompt leaks ${JSON.stringify(leaked)} ` +
        `(from lexical_exclusions). Probes must test perceptual recall, not keyword search.`,
    );
    this.name = 'LexicalLeakageError';
    this.probe_id = probeId;
    this.leaked = leaked;
  }
}

/** Thrown by the loader when a probe JSON is missing required fields. */
export class ProbeSchemaError extends Error {
  readonly probe_id: string;
  readonly missing: string[];
  constructor(probeId: string, missing: string[]) {
    super(`ProbeSchemaError: probe '${probeId}' missing required fields: ${missing.join(', ')}`);
    this.name = 'ProbeSchemaError';
    this.probe_id = probeId;
    this.missing = missing;
  }
}
