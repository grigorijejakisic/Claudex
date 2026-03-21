/**
 * Cross-hook state for experience pattern detection.
 *
 * Each CC hook runs as a fresh process, so state that must survive across
 * UserPromptSubmit → PostToolUse → Stop must be persisted to the DB.
 *
 * This module piggybacks on thread_state.key_exchanges (the same mechanism
 * used by cooldown_state) using reserved '__exp_*' role entries.
 *
 * State tracked per-turn:
 *   - correction_flagged: boolean — set in UserPromptSubmit, read in Stop
 *   - injected_pattern_ids: string[] — patterns injected this turn (for scoring)
 *   - file_edit_counts: Record<string, number> — per-file edit counter (PostToolUse)
 *   - tool_call_patterns: Array<{tool: string; sig: string}> — loop detection
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { getThreadState, upsertThreadState } from '../core/thread.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';

// Reserved role keys for experience pattern state
const EXP_FLAGS_ROLE = '__exp_flags';
const EXP_BEHAVIORAL_ROLE = '__exp_behavioral';

// ---------------------------------------------------------------------------
// Internal helpers — read/write a single keyed slot in thread_state.key_exchanges
// ---------------------------------------------------------------------------

/**
 * Reads and JSON-parses a single role slot from thread_state.key_exchanges.
 * Returns `defaults` if the session, role entry, or JSON parse fails.
 */
function readRoleExchange<T>(
  db: Database,
  sessionId: string,
  role: string,
  defaults: T,
): T {
  try {
    const state = getThreadState(db, sessionId);
    if (!state) return defaults;
    const entry = state.key_exchanges.find(e => e.role === role);
    if (!entry) return defaults;
    const parsed = JSON.parse(entry.gist);
    return parsed as T;
  } catch {
    return defaults;
  }
}

/**
 * Serialises `data` into the named role slot and persists thread_state.
 * Other role slots are preserved unchanged.
 *
 * KNOWN LIMITATION — race condition: the read-filter-write sequence is not
 * atomic. Two concurrent hook processes (e.g. PostToolUse and Stop running
 * simultaneously) could both read the same state, each write their own slot,
 * and the second write would silently overwrite the first writer's slot value.
 * In practice CC hook processes are sequential within a single turn, so this
 * is benign; but it would become a real issue if hooks were ever parallelised.
 */
function writeRoleExchange(
  db: Database,
  sessionId: string,
  role: string,
  data: unknown,
): void {
  const state = getThreadState(db, sessionId);
  const exchanges = (state?.key_exchanges ?? []).filter(e => e.role !== role);
  exchanges.push({ role, gist: JSON.stringify(data) });
  upsertThreadState(db, {
    session_id: sessionId,
    topic: state?.topic ?? undefined,
    summary: state?.summary ?? undefined,
    key_exchanges: exchanges,
  });
}

export interface ExperienceFlags {
  /** True if a correction signal was detected in the current turn's user prompt. */
  correction_flagged: boolean;
  /** IDs of experience patterns injected this turn (for score feedback at Stop). */
  injected_pattern_ids: string[];
  /**
   * Topic keys parallel to injected_pattern_ids (one key per pattern).
   * Generated at injection time in the assembler from each pattern's trigger_context.
   * Promoted to awaiting_topic_keys at end of Stop alongside awaiting_feedback_ids.
   */
  injected_topic_keys: string[];
  /**
   * IDs of patterns that were injected in the PREVIOUS turn and are awaiting
   * feedback scoring in this turn's Stop hook.
   * Set at the end of Stop (from injected_pattern_ids), cleared after scoring.
   */
  awaiting_feedback_ids: string[];
  /**
   * Topic keys for each awaiting pattern (parallel array to awaiting_feedback_ids).
   * Each key is a lightweight fingerprint of the pattern's trigger_context,
   * used by the Stop hook to match corrections to specific patterns rather
   * than penalising all injected patterns when only one was relevant.
   */
  awaiting_topic_keys: string[];
  /**
   * The user prompt text from a turn where a correction was detected.
   * Set by UserPromptSubmit when correction_flagged goes true.
   * Read by Stop hook to extract topic words for per-pattern scoring.
   * Capped at 500 chars to bound storage size.
   */
  correction_prompt: string;
  /**
   * Knowledge domains matched by the trigger engine in PostToolUse.
   * Consumed by UserPromptSubmit to augment FTS5 search queries.
   * Cleared after consumption.
   */
  pending_trigger_domains: string[];
}

export interface BehavioralCounters {
  /** file_path → number of edits this session */
  file_edit_counts: Record<string, number>;
  /** Recent tool call signatures for loop detection: [{tool, sig}] */
  tool_call_patterns: Array<{ tool: string; sig: string }>;
  /** Epoch (seconds) of last loop signal emission — 30s cooldown between signals. */
  last_loop_signal_epoch?: number;
}

// ---------------------------------------------------------------------------
// Experience flags (correction_flagged + injected_pattern_ids)
// ---------------------------------------------------------------------------

/**
 * Reads the experience flags for the current turn.
 * Returns defaults if no flags exist yet. Non-throwing.
 */
export function getExperienceFlags(
  db: Database,
  sessionId: string,
): ExperienceFlags {
  const defaults: ExperienceFlags = {
    correction_flagged: false,
    injected_pattern_ids: [],
    injected_topic_keys: [],
    awaiting_feedback_ids: [],
    awaiting_topic_keys: [],
    correction_prompt: '',
    pending_trigger_domains: [],
  };
  try {
    const parsed = readRoleExchange<Record<string, unknown>>(db, sessionId, EXP_FLAGS_ROLE, {});
    return {
      correction_flagged: parsed.correction_flagged === true,
      injected_pattern_ids: Array.isArray(parsed.injected_pattern_ids)
        ? parsed.injected_pattern_ids as string[]
        : [],
      injected_topic_keys: Array.isArray(parsed.injected_topic_keys)
        ? parsed.injected_topic_keys as string[]
        : [],
      awaiting_feedback_ids: Array.isArray(parsed.awaiting_feedback_ids)
        ? parsed.awaiting_feedback_ids as string[]
        : [],
      awaiting_topic_keys: Array.isArray(parsed.awaiting_topic_keys)
        ? parsed.awaiting_topic_keys as string[]
        : [],
      correction_prompt: typeof parsed.correction_prompt === 'string'
        ? parsed.correction_prompt
        : '',
      pending_trigger_domains: Array.isArray(parsed.pending_trigger_domains)
        ? parsed.pending_trigger_domains as string[]
        : [],
    };
  } catch {
    return defaults;
  }
}

/**
 * Persists experience flags (merges with existing — only provided fields are updated).
 * Accepts an optional `existingFlags` parameter to skip the DB re-read when the
 * caller already holds the current flags (e.g. Stop hook reads once at the top,
 * then calls setExperienceFlags at the end — passing the already-read flags avoids
 * a second SELECT on every Stop invocation).
 * Non-throwing.
 */
export function setExperienceFlags(
  db: Database,
  sessionId: string,
  updates: Partial<ExperienceFlags>,
  existingFlags?: ExperienceFlags,
): void {
  try {
    const current = existingFlags ?? getExperienceFlags(db, sessionId);
    const merged: ExperienceFlags = {
      correction_flagged: updates.correction_flagged ?? current.correction_flagged,
      injected_pattern_ids: updates.injected_pattern_ids ?? current.injected_pattern_ids,
      injected_topic_keys: updates.injected_topic_keys ?? current.injected_topic_keys,
      awaiting_feedback_ids: updates.awaiting_feedback_ids ?? current.awaiting_feedback_ids,
      awaiting_topic_keys: updates.awaiting_topic_keys ?? current.awaiting_topic_keys,
      correction_prompt: updates.correction_prompt ?? current.correction_prompt,
      pending_trigger_domains: updates.pending_trigger_domains ?? current.pending_trigger_domains,
    };
    writeRoleExchange(db, sessionId, EXP_FLAGS_ROLE, merged);
  } catch (e) {
    emitErrorTelemetry(db, sessionId, 'set_experience_flags', e);
  }
}

// ---------------------------------------------------------------------------
// Behavioral counters (session-scoped, persist across turns)
// ---------------------------------------------------------------------------

/**
 * Reads behavioral counters for the session.
 * Returns empty counters if none exist yet. Non-throwing.
 */
export function getBehavioralCounters(
  db: Database,
  sessionId: string,
): BehavioralCounters {
  const defaults: BehavioralCounters = {
    file_edit_counts: {},
    tool_call_patterns: [],
  };
  try {
    const parsed = readRoleExchange<Record<string, unknown>>(db, sessionId, EXP_BEHAVIORAL_ROLE, {});
    return {
      file_edit_counts: parsed.file_edit_counts && typeof parsed.file_edit_counts === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.file_edit_counts as Record<string, unknown>)
              .map(([k, v]) => [k, Number(v)])
              .filter(([, v]) => Number.isFinite(v))
          ) as Record<string, number>
        : {},
      tool_call_patterns: Array.isArray(parsed.tool_call_patterns)
        ? (parsed.tool_call_patterns as Array<{ tool: string; sig: string }>).slice(-20)
        : [],
      last_loop_signal_epoch: typeof parsed.last_loop_signal_epoch === 'number'
        ? parsed.last_loop_signal_epoch
        : undefined,
    };
  } catch {
    return defaults;
  }
}

/**
 * Persists behavioral counters back to thread_state.
 * Non-throwing.
 */
export function setBehavioralCounters(
  db: Database,
  sessionId: string,
  counters: BehavioralCounters,
): void {
  try {
    // Cap tool_call_patterns at 20 entries to avoid unbounded growth
    const capped: BehavioralCounters = {
      ...counters,
      tool_call_patterns: counters.tool_call_patterns.slice(-20),
    };
    writeRoleExchange(db, sessionId, EXP_BEHAVIORAL_ROLE, capped);
  } catch (e) {
    emitErrorTelemetry(db, sessionId, 'set_behavioral_counters', e);
  }
}

/**
 * Reads behavioral counters once, calls `fn` with the in-memory counters to
 * allow multiple mutations, then writes once. Eliminates the N×2 DB round-trips
 * that separate `applyFileEditIncrement` + `applyToolCallPattern` calls produce.
 *
 * Returns the final counters after the write. Non-throwing — returns empty
 * counters on error.
 */
export function withBehavioralBatch(
  db: Database,
  sessionId: string,
  fn: (counters: BehavioralCounters) => void,
): BehavioralCounters {
  try {
    const counters = getBehavioralCounters(db, sessionId);
    fn(counters);
    setBehavioralCounters(db, sessionId, counters);
    return counters;
  } catch {
    return { file_edit_counts: {}, tool_call_patterns: [] };
  }
}

/**
 * Increments the edit count for a file in an already-loaded counters object.
 * Mutates `counters` in place. Caps total entries at 50 — evicts least-edited
 * file if over the limit. Returns the new count for the given file.
 *
 * Use inside `withBehavioralBatch` to avoid extra DB round-trips.
 */
export function applyFileEditIncrement(
  counters: BehavioralCounters,
  filePath: string,
): number {
  const current = counters.file_edit_counts[filePath] ?? 0;
  const next = current + 1;
  counters.file_edit_counts[filePath] = next;
  // Cap total entries at 50 — evict the least-edited file to bound memory usage.
  const entries = Object.entries(counters.file_edit_counts);
  if (entries.length > 50) {
    const minEntry = entries.reduce((a, b) => (a[1] <= b[1] ? a : b));
    delete counters.file_edit_counts[minEntry[0]];
  }
  return next;
}

/** Minimum seconds between loop signal emissions to prevent telemetry flooding. */
const LOOP_SIGNAL_COOLDOWN_SECONDS = 30;

/**
 * Appends a tool call signature in an already-loaded counters object and checks
 * for a loop (3+ identical consecutive patterns). Mutates `counters` in place.
 * Returns true when a loop is detected AND the 30s cooldown has elapsed since
 * the last signal. Prevents telemetry flooding from rapid parallel tool calls.
 *
 * Use inside `withBehavioralBatch` to avoid extra DB round-trips.
 */
export function applyToolCallPattern(
  counters: BehavioralCounters,
  tool: string,
  sig: string,
): boolean {
  counters.tool_call_patterns.push({ tool, sig });
  // Check for 3+ identical consecutive patterns
  const patterns = counters.tool_call_patterns;
  if (patterns.length < 3) return false;
  const last3 = patterns.slice(-3);
  const isLoop = last3.every(p => p.tool === tool && p.sig === sig);
  if (!isLoop) return false;

  // Enforce 30s cooldown between loop signals
  const now = Math.floor(Date.now() / 1000);
  const lastSignal = counters.last_loop_signal_epoch ?? 0;
  if (now - lastSignal < LOOP_SIGNAL_COOLDOWN_SECONDS) return false;

  counters.last_loop_signal_epoch = now;
  return true;
}

