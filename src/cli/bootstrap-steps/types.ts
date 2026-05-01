/**
 * Shared shape for bootstrap-step results.
 * Each step returns one of these; the orchestrator decides exit code based on
 * `ok` and emits `warning` (when present) as a non-fatal advisory.
 */
export interface StepResult {
  /** True if the step succeeded. False = setup must exit 1 (unless caller treats this as best-effort). */
  ok: boolean;
  /** Human-readable summary printed by the orchestrator. */
  message: string;
  /** Optional non-fatal advisory — printed alongside [WARN] when present. */
  warning?: string;
}
