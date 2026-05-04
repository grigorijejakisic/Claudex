/**
 * Phase 1 (v5) episode substrate — typed write helpers for `episodic_events`.
 *
 * The substrate is forward-only and write-only in Phase 1; no reader exists
 * here, in the assembler, in CARA, in Angel's pattern extractor, or in
 * hybrid-retrieval. Phase 3 cuts retrieval over.
 *
 * Provenance is the structural lever: every helper writes a row with one of
 * the four enum values, enforced by the V25 CHECK constraint. Reading with
 * `WHERE provenance='organic'` therefore CANNOT return wrapper-block content
 * or tool-result content — the Mem0 trap is structurally impossible.
 *
 * Shipped helpers (Plans 01-02 and 01-03):
 *   - dualWriteUserPrompt        (Plan 01-02; UserPromptSubmit)
 *   - dualWriteAssistantMessage  (Plan 01-02; Stop)
 *   - writeToolResult            (Plan 01-03; PostToolUse)
 *   - writeEnvironmentalEvent    (Plan 01-03; session-start/end + Angel heartbeat)
 *
 * Atomicity contract: each helper wraps its writes in a single
 * `db.transaction(() => ...)()` closure. On throw, the transaction rolls
 * back AND a single telemetry row is written outside the transaction with
 * `event_kind='episodic_write_failure'` so the failure is queryable.
 *
 * EPI-03, EPI-04, EPI-07.
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { cachedPrepare } from './stmt-cache.js';
import { parseWrappers } from '../extraction/wrapper-parser.js';
import { computeErrorFingerprint } from './error-fingerprint.js';
import { loadConfig } from '../shared/config.js';

export type Provenance = 'organic' | 'injected' | 'tool_result' | 'environmental';

/**
 * `episodic_events.schema_version` default. The substrate ships at v=1; any
 * breaking change to the metadata_json contract bumps this AND ships a new
 * migration step (V26+).
 */
export const EPISODIC_SCHEMA_VERSION = 1 as const;

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface EpisodicRowInsert {
  session_id: string;
  project: string;
  turn_number: number | null;
  type: string;
  source: string;
  content: string;
  provenance: Provenance;
  parent_event_id: number | null;
  content_hash: string;
  metadata_json: string | null;
}

const INSERT_SQL = `INSERT INTO episodic_events
  (session_id, project, turn_number, type, source, content, provenance, parent_event_id, content_hash, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING id`;

function insertEpisodicRow(db: Database, row: EpisodicRowInsert): number {
  const stmt = cachedPrepare(db, INSERT_SQL);
  const result = stmt.get(
    row.session_id,
    row.project,
    row.turn_number,
    row.type,
    row.source,
    row.content,
    row.provenance,
    row.parent_event_id,
    row.content_hash,
    row.metadata_json,
  ) as { id: number } | undefined;
  if (!result) {
    throw new Error('episodic_events INSERT returned no id');
  }
  return result.id;
}

const TELEMETRY_INSERT_SQL = `INSERT INTO telemetry
  (session_id, event_kind, detail, adapter)
  VALUES (?, 'episodic_write_failure', ?, 'episodic-events')`;

interface FailureDetail {
  hook: string;
  attempted_rows?: number;
  organic_id?: number | null;
  error_message: string;
  error_stack?: string;
  [key: string]: unknown;
}

function recordEpisodicWriteFailure(db: Database, sessionId: string, detail: FailureDetail): void {
  try {
    cachedPrepare(db, TELEMETRY_INSERT_SQL).run(sessionId, JSON.stringify(detail));
  } catch {
    // Last-resort: never let telemetry failure mask the original error
    // (which is already being thrown / handled by the caller).
  }
}

function captureError(err: unknown, hook: string, extra?: Record<string, unknown>): FailureDetail {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack
    ? err.stack.split('\n').slice(0, 5).join('\n')
    : undefined;
  const trimmed = message.slice(0, 500);
  return {
    hook,
    error_message: trimmed,
    ...(stack ? { error_stack: stack } : {}),
    ...(extra ?? {}),
  };
}

// ---------------------------------------------------------------------------
// User prompt — organic + injected dual-write
// ---------------------------------------------------------------------------

export interface DualWriteUserPromptResult {
  /** turn_number assigned to the new conversation_turns + organic episodic row. */
  turnNumber: number;
  /** id of the organic episodic row, or null if the transaction rolled back. */
  organicId: number | null;
  /** number of injected wrapper-block rows written (0 when no wrappers). */
  injectedCount: number;
}

/**
 * Single-transaction dual-write: legacy `conversation_turns` (raw prompt
 * unchanged) + organic `episodic_events` row (wrapper-stripped) + N injected
 * `episodic_events` rows (one per wrapper, linked via parent_event_id to the
 * organic row).
 *
 * Throws on DB failure (caller-friendly: tests can assert atomicity). Always
 * writes one telemetry row on rollback before re-throwing.
 */
export function dualWriteUserPrompt(
  db: Database,
  sessionId: string,
  project: string,
  rawPrompt: string,
): DualWriteUserPromptResult {
  const parsed = parseWrappers(rawPrompt);
  const attemptedRows = 1 + parsed.injected.length;
  let turnNumber = -1;
  let organicId: number | null = null;
  let injectedCount = 0;

  try {
    const tx = db.transaction(() => {
      // 1) Legacy conversation_turns row — raw prompt, unchanged. Compute
      //    turn_number inside the transaction so concurrent hooks can't race.
      const lastTurn = cachedPrepare(db,
        `SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?`
      ).get(sessionId) as { max_turn: number | null } | undefined;
      turnNumber = (lastTurn?.max_turn ?? -1) + 1;

      cachedPrepare(db,
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text)
         VALUES (?, ?, ?, ?, NULL)`
      ).run(sessionId, project, turnNumber, rawPrompt);

      // 2) Organic episodic row.
      organicId = insertEpisodicRow(db, {
        session_id: sessionId,
        project,
        turn_number: turnNumber,
        type: 'user_prompt',
        source: 'cc-hooks/user-prompt-submit',
        content: parsed.organic,
        provenance: 'organic',
        parent_event_id: null,
        content_hash: sha256(parsed.organic),
        metadata_json: null,
      });

      // 3) Injected episodic rows — one per wrapper, parent_event_id ties to
      //    the organic row. metadata_json carries tag + attribute string so
      //    Phase 3 retrieval can filter by wrapper type without parsing.
      for (const block of parsed.injected) {
        insertEpisodicRow(db, {
          session_id: sessionId,
          project,
          turn_number: turnNumber,
          type: 'hook_injection',
          source: `wrapper:${block.tag}`,
          content: block.content,
          provenance: 'injected',
          parent_event_id: organicId,
          content_hash: sha256(block.content),
          metadata_json: JSON.stringify({
            tag: block.tag,
            attributes: block.attributes ?? null,
          }),
        });
        injectedCount += 1;
      }
    });
    tx();
  } catch (err) {
    recordEpisodicWriteFailure(db, sessionId, captureError(err, 'user-prompt-submit', {
      attempted_rows: attemptedRows,
      organic_id: organicId,
    }));
    throw err;
  }

  return { turnNumber, organicId, injectedCount };
}

// ---------------------------------------------------------------------------
// Assistant message — organic single-row dual-write
// ---------------------------------------------------------------------------

export interface DualWriteAssistantMessageResult {
  /** turn_number of the row written / updated. */
  turnNumber: number;
  /** id of the new assistant_message episodic row. */
  episodicId: number;
  /** true if a pending conversation_turns row was UPDATEd; false if a new row was INSERTed. */
  updatedLegacy: boolean;
}

/**
 * Single-transaction dual-write for the assistant message:
 *   1. UPDATE the latest conversation_turns row whose assistant_text IS NULL,
 *      preserving the v4 split-write pattern. Fallback: INSERT a fresh row
 *      (user_text=NULL, assistant_text=...) so Stop fires before any user
 *      prompt are still captured.
 *   2. INSERT one episodic_events row with type='assistant_message',
 *      provenance='organic'. parent_event_id stays NULL — Phase 3/4 link
 *      tool_result rows back to assistant_message via parent_event_id, but
 *      assistant_message itself does not need a parent in Phase 1.
 *
 * Assistant text is treated as raw organic — the wrapper parser is NOT
 * invoked here (assistant output is the LLM's own text, not a CC injection).
 */
export function dualWriteAssistantMessage(
  db: Database,
  sessionId: string,
  project: string,
  assistantText: string,
): DualWriteAssistantMessageResult {
  let turnNumber = -1;
  let episodicId = -1;
  let updatedLegacy = false;

  try {
    const tx = db.transaction(() => {
      // 1) Try to UPDATE a pending row from a prior UserPromptSubmit.
      const pending = cachedPrepare(db,
        `SELECT id, turn_number FROM conversation_turns
         WHERE session_id = ? AND assistant_text IS NULL
         ORDER BY turn_number DESC LIMIT 1`
      ).get(sessionId) as { id: number; turn_number: number } | undefined;

      if (pending) {
        cachedPrepare(db,
          `UPDATE conversation_turns SET assistant_text = ? WHERE id = ?`
        ).run(assistantText, pending.id);
        turnNumber = pending.turn_number;
        updatedLegacy = true;
      } else {
        // Fallback: INSERT a fresh conversation_turns row (no prior user
        // prompt exists). turn_number computed inside the transaction.
        const lastTurn = cachedPrepare(db,
          `SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?`
        ).get(sessionId) as { max_turn: number | null } | undefined;
        turnNumber = (lastTurn?.max_turn ?? -1) + 1;

        cachedPrepare(db,
          `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text)
           VALUES (?, ?, ?, NULL, ?)`
        ).run(sessionId, project, turnNumber, assistantText);
      }

      // 2) Episodic assistant_message row.
      episodicId = insertEpisodicRow(db, {
        session_id: sessionId,
        project,
        turn_number: turnNumber,
        type: 'assistant_message',
        source: 'cc-hooks/stop',
        content: assistantText,
        provenance: 'organic',
        parent_event_id: null,
        content_hash: sha256(assistantText),
        metadata_json: null,
      });
    });
    tx();
  } catch (err) {
    recordEpisodicWriteFailure(db, sessionId, captureError(err, 'stop', {
      attempted_rows: 2,
    }));
    throw err;
  }

  return { turnNumber, episodicId, updatedLegacy };
}

// ---------------------------------------------------------------------------
// Tool result — single-row write (no legacy mirror; tool results are not turns)
// ---------------------------------------------------------------------------

export interface ToolResultWriteParams {
  db: Database;
  sessionId: string;
  project: string;
  /** Becomes `source` (literal tool name, not prefixed). */
  toolName: string;
  /** Serialized into metadata_json under `tool_input` for Phase 2 indexing. */
  toolInput: Record<string, unknown>;
  /** Becomes `content`. Stringified verbatim — no decomposition. */
  toolResult: string;
  /** Current turn for this session, or undefined if no user prompt has fired yet. */
  turnNumber?: number;
  /** Optional FK to the assistant_message row that called this tool. Null in Phase 1. */
  parentEventId?: number;
  /**
   * Phase 2 IDX-01 — when true (the default), `writeToolResult` computes an
   * error fingerprint over `toolResult` and stores it under
   * `metadata_json.error_fingerprint` if `looksLikeStackTrace(toolResult)`
   * matches. Set to false to bypass — used by Plan 02-05's verdict-driven
   * flag flip on KILL/SCOPE_DOWN. When omitted, falls back to
   * `loadConfig().features.error_fingerprint`.
   */
  errorFingerprintEnabled?: boolean;
}

export interface ToolResultWriteResult {
  episodicId: number | null;
}

/**
 * Single-transaction write for a tool_result event. Per CONTEXT.md, tool
 * results are NOT decomposed into sub-rows — the tool boundary is the
 * natural split, and Phase 4's extractor will treat tool_result rows as
 * non-extraction-eligible by default.
 *
 * No legacy mirror: `conversation_turns` was never the home for tool calls.
 * Single-row write inside a transaction so the rollback-and-telemetry
 * pattern matches Plan 02.
 */
export function writeToolResult(params: ToolResultWriteParams): ToolResultWriteResult {
  // Phase 2 IDX-01: best-effort fingerprint on tool_result content. The
  // fingerprinter is pure CPU; any failure is recorded to telemetry and
  // swallowed so the Phase 1 atomicity contract (single transactional row,
  // never blocked by metadata) is preserved.
  let fpKey: { error_fingerprint: ReturnType<typeof computeErrorFingerprint> } | Record<string, never> = {};
  const flagOn = params.errorFingerprintEnabled ?? resolveErrorFingerprintFlag();
  if (flagOn && typeof params.toolResult === 'string' && params.toolResult.length > 0) {
    try {
      const fp = computeErrorFingerprint(params.toolResult);
      if (fp) fpKey = { error_fingerprint: fp };
    } catch (err) {
      recordEpisodicWriteFailure(params.db, params.sessionId, captureError(err, 'post-tool-use', {
        tool: params.toolName,
        kind: 'fingerprint_error',
      }));
      // fp omitted; fall through with the original metadata only
    }
  }

  let episodicId: number | null = null;
  try {
    const tx = params.db.transaction(() => {
      episodicId = insertEpisodicRow(params.db, {
        session_id: params.sessionId,
        project: params.project,
        turn_number: params.turnNumber ?? null,
        type: 'tool_result',
        source: params.toolName,
        content: params.toolResult,
        provenance: 'tool_result',
        parent_event_id: params.parentEventId ?? null,
        content_hash: sha256(params.toolResult),
        metadata_json: JSON.stringify({ tool_input: params.toolInput, ...fpKey }),
      });
    });
    tx();
  } catch (err) {
    recordEpisodicWriteFailure(params.db, params.sessionId, captureError(err, 'post-tool-use', {
      tool: params.toolName,
      kind: 'tool_result',
    }));
    throw err;
  }
  return { episodicId };
}

/**
 * Resolve the `features.error_fingerprint` flag from on-disk config without
 * letting any I/O exception surface as a write-path failure. Uses
 * `loadConfig()` (which is itself non-throwing) and treats a missing /
 * malformed flag as `true` — matching the Phase 2 default in DEFAULT_CONFIG.
 */
function resolveErrorFingerprintFlag(): boolean {
  try {
    const cfg = loadConfig();
    const flag = cfg?.features?.error_fingerprint;
    return typeof flag === 'boolean' ? flag : true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Environmental event — session boundaries, Angel heartbeat, and friends
// ---------------------------------------------------------------------------

export interface EnvironmentalWriteParams {
  db: Database;
  sessionId: string;
  project: string;
  /** Locked subset for Phase 1; future phases extend through metadata_json. */
  type: 'session_boundary' | 'environmental_event';
  /** Identifier of the producer, e.g. 'cc-hooks/session-start' or 'angel/heartbeat'. */
  source: string;
  /** Human-readable description, e.g. "Session opened: <id>". */
  content: string;
  /** Modality-specific fields (PIDs, idle minutes, error fingerprints, etc.). */
  metadata?: Record<string, unknown>;
}

export interface EnvironmentalWriteResult {
  episodicId: number | null;
}

/**
 * Single-row write for an environmental event. Always writes with
 * `provenance='environmental'`, `turn_number=NULL`, `parent_event_id=NULL`.
 * Used by session-start, session-end, Angel heartbeat. Phase 6 will revisit
 * this writer when fsnotify-driven boundaries land.
 */
export function writeEnvironmentalEvent(params: EnvironmentalWriteParams): EnvironmentalWriteResult {
  let episodicId: number | null = null;
  try {
    const tx = params.db.transaction(() => {
      episodicId = insertEpisodicRow(params.db, {
        session_id: params.sessionId,
        project: params.project,
        turn_number: null,
        type: params.type,
        source: params.source,
        content: params.content,
        provenance: 'environmental',
        parent_event_id: null,
        content_hash: sha256(params.content),
        metadata_json: params.metadata ? JSON.stringify(params.metadata) : null,
      });
    });
    tx();
  } catch (err) {
    recordEpisodicWriteFailure(params.db, params.sessionId, captureError(err, params.source, {
      kind: 'environmental',
      type: params.type,
    }));
    throw err;
  }
  return { episodicId };
}
