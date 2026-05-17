/**
 * Phase 7.5 — Handoff schema module.
 *
 * Hybrid YAML status header + ADR Markdown body. ~15 lines body target,
 * down from the legacy 372-line schema.
 *
 * Header (machine-queryable):
 *   ---
 *   status: active | archived | paused
 *   phase: <N>
 *   summary: <one-line summary>      # OPTIONAL but RECOMMENDED — Phase 5 SC#4 prime reads this
 *   topic: <slug>                    # OPTIONAL — used by MEMORY.md `## Handoff` one-line
 *   created_at_epoch_ms: <ms>        # OPTIONAL — auto-set by writer if not provided
 *   last_refresh_epoch_ms: <ms>      # Phase 14-07l — set by CHR on each decision-boundary refresh
 *   ---
 *
 * Body (locked order):
 *   # <YYYY-MM-DD> — <topic-or-summary>
 *
 *   **What we found:** ...
 *
 *   **What we decided:** ...
 *
 *   **What's next:** ...
 *
 *   **Where to look:** ...
 *
 * Atomic write semantics: tmp + rename. Validation throws at the boundary.
 * Parser returns null on shape failure (fail-loud at consumer's option).
 *
 * Phase 14-01: parseHandoffHeader now supports an optional opts overload.
 * When opts.db is supplied, null-return paths emit a 'handoff_parse_failed'
 * telemetry row (best-effort; wrapped in try/catch; non-throwing).
 *
 * Phase 14-07l: recordDecisionShift — CHR boundary-driven refresh of ACTIVE.md.
 * Preserves created_at_epoch_ms; updates last_refresh_epoch_ms; appends
 * boundary entry to the correct section; emits supersedes soft-link.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'better-sqlite3';
import { recordSupersedes } from '../intelligence/soft-link-writers.js';
import { resolveProjectPath } from '../shared/scope-detector.js';
import { getHandoffsDir } from '../shared/paths.js';
import type { BoundaryType } from '../intelligence/directive-detector.js';

export type HandoffStatus = 'active' | 'archived' | 'paused';

export interface HandoffHeader {
  status: HandoffStatus;
  phase: string;
  summary?: string;
  topic?: string;
  created_at_epoch_ms?: number;
  /**
   * Phase 14-07l: epoch_ms of the most-recent CHR refresh.
   * Optional / backward-compatible — old handoffs without this field parse unchanged.
   */
  last_refresh_epoch_ms?: number;
}

export interface HandoffInput {
  status: HandoffStatus;
  phase: string | number;
  summary?: string;
  topic?: string;
  created_at_epoch_ms?: number;
  /** Phase 14-07l: epoch_ms of the most-recent CHR refresh. Optional; backward-compatible. */
  last_refresh_epoch_ms?: number;
  whatWeFound: string;
  whatWeDecided: string;
  whatsNext: string;
  whereToLook: string;
}

export interface HandoffValidationError {
  field: string;
  reason: string;
}

const VALID_STATUSES: ReadonlyArray<HandoffStatus> = ['active', 'archived', 'paused'];

/**
 * Validate a partial header for required fields and value shape.
 *
 * Returns `[]` when `status` is one of `active|archived|paused` AND `phase`
 * is a non-empty string. Otherwise returns one entry per invalid/missing field.
 */
export function validateHandoffHeader(
  header: Partial<HandoffHeader>,
): HandoffValidationError[] {
  const errors: HandoffValidationError[] = [];

  if (header.status === undefined || header.status === null) {
    errors.push({ field: 'status', reason: 'required' });
  } else if (!VALID_STATUSES.includes(header.status as HandoffStatus)) {
    errors.push({
      field: 'status',
      reason: `must be one of ${VALID_STATUSES.join('|')}; got "${String(header.status)}"`,
    });
  }

  if (header.phase === undefined || header.phase === null) {
    errors.push({ field: 'phase', reason: 'required' });
  } else if (typeof header.phase !== 'string' || header.phase.length === 0) {
    errors.push({ field: 'phase', reason: 'must be non-empty string' });
  }

  return errors;
}

/**
 * Reason codes for parseHandoffHeader null-return paths (Phase 14-01).
 *
 * - `no_frontmatter`  — no `---\n...\n---\n` block found
 * - `missing_status`  — frontmatter present but no status field
 * - `invalid_status`  — status present but not in {active, archived, paused}
 * - `missing_phase`   — frontmatter present but no phase field
 */
export type HandoffParseFailedReason =
  | 'no_frontmatter'
  | 'missing_status'
  | 'invalid_status'
  | 'missing_phase';

/**
 * Options bag for the Phase 14-01 telemetry-on-rejection overload.
 * All fields are optional; the overload is backwards-compatible.
 */
export interface ParseHandoffOpts {
  /** When supplied, null-return paths emit a `handoff_parse_failed` telemetry row. */
  db?: Database;
  /** Stored as `session_id` on the telemetry row. Defaults to empty string. */
  sessionId?: string;
  /** Stored as `detail.source_path` on the telemetry row. */
  sourcePath?: string;
}

/**
 * Internal result from parseHandoffHeaderInner. Contains both the result
 * and the failure reason so the caller can emit telemetry without re-parsing.
 */
interface ParseResult {
  header: HandoffHeader | null;
  reason?: HandoffParseFailedReason;
}

/**
 * Non-exported inner parser. Returns both the header and, on failure, the
 * reason code so the exported overload can emit telemetry without re-running
 * the parse logic.
 */
function parseHandoffHeaderInner(raw: string): ParseResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { header: null, reason: 'no_frontmatter' };
  }

  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return { header: null, reason: 'no_frontmatter' };
  }

  const fmBody = match[1];
  const partial: Partial<HandoffHeader> = {};

  for (const line of fmBody.split('\n')) {
    const lineMatch = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (!lineMatch) continue;
    const key = lineMatch[1];
    const value = lineMatch[2].trim();
    if (value.length === 0) continue;

    switch (key) {
      case 'status':
        partial.status = value as HandoffStatus;
        break;
      case 'phase':
        partial.phase = value;
        break;
      case 'summary':
        partial.summary = value;
        break;
      case 'topic':
        partial.topic = value;
        break;
      case 'created_at_epoch_ms': {
        const n = Number(value);
        if (Number.isFinite(n)) partial.created_at_epoch_ms = n;
        break;
      }
      case 'last_refresh_epoch_ms': {
        const n = Number(value);
        if (Number.isFinite(n)) partial.last_refresh_epoch_ms = n;
        break;
      }
    }
  }

  // Determine the failure reason before running full validation.
  if (partial.status === undefined || partial.status === null) {
    return { header: null, reason: 'missing_status' };
  }
  if (!VALID_STATUSES.includes(partial.status as HandoffStatus)) {
    return { header: null, reason: 'invalid_status' };
  }
  if (partial.phase === undefined || partial.phase === null || partial.phase.length === 0) {
    return { header: null, reason: 'missing_phase' };
  }

  // Run full validation to catch any additional edge cases.
  const errors = validateHandoffHeader(partial);
  if (errors.length > 0) {
    // Map to the most specific reason we can derive.
    const phaseErr = errors.find(e => e.field === 'phase');
    const statusErr = errors.find(e => e.field === 'status');
    const reason: HandoffParseFailedReason = statusErr
      ? (partial.status !== undefined ? 'invalid_status' : 'missing_status')
      : phaseErr
        ? 'missing_phase'
        : 'missing_status';
    return { header: null, reason };
  }

  return { header: partial as HandoffHeader };
}

/**
 * Emit a `handoff_parse_failed` telemetry row. Best-effort: wrapped in
 * try/catch so a write failure never propagates to the caller.
 *
 * The event_kind `handoff_parse_failed` must be present in the telemetry
 * table's CHECK constraint (added in schema Phase 14-01). On older DBs the
 * INSERT will fail the CHECK and be silently swallowed — same pattern as
 * `reranker_fallback` on pre-V20 DBs.
 */
function emitHandoffParseFailure(
  db: Database,
  reason: HandoffParseFailedReason,
  sessionId: string,
  sourcePath?: string,
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'handoff_parse_failed', ?, 'handoff-parser')`,
    ).run(
      sessionId,
      JSON.stringify({ reason, source_path: sourcePath ?? null }),
    );
  } catch {
    // Non-throwing: telemetry must never break the parser's return contract.
  }
}

/**
 * Parse the YAML frontmatter at the head of `raw`. Returns the typed header,
 * or null if no frontmatter is present, the frontmatter is malformed, or the
 * resulting header fails validation.
 *
 * Overload (Phase 14-01): when `opts.db` is supplied, every null-return path
 * emits a `handoff_parse_failed` telemetry row before returning null. The
 * telemetry write is best-effort (wrapped in try/catch) and never affects
 * the return value.
 */
export function parseHandoffHeader(raw: string): HandoffHeader | null;
export function parseHandoffHeader(raw: string, opts: ParseHandoffOpts): HandoffHeader | null;
export function parseHandoffHeader(raw: string, opts?: ParseHandoffOpts): HandoffHeader | null {
  const { header, reason } = parseHandoffHeaderInner(raw);

  if (header === null && reason !== undefined && opts?.db) {
    emitHandoffParseFailure(
      opts.db,
      reason,
      opts.sessionId ?? '',
      opts.sourcePath,
    );
  }

  return header;
}

function serializePhase(phase: string | number): string {
  if (typeof phase === 'number') return String(phase);
  if (/^\d+$/.test(phase)) return phase;
  return `"${phase.replace(/"/g, '\\"')}"`;
}

function serializeSummary(summary: string): string {
  if (/[:"\\]/.test(summary)) {
    return `"${summary.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return summary;
}

/**
 * Render the full hybrid file (frontmatter + body) for `input`. Pure function;
 * no filesystem side effects.
 */
export function renderHandoffMarkdown(input: HandoffInput): string {
  const headerLines: string[] = ['---'];
  headerLines.push(`status: ${input.status}`);
  headerLines.push(`phase: ${serializePhase(input.phase)}`);
  if (input.summary !== undefined) {
    headerLines.push(`summary: ${serializeSummary(input.summary)}`);
  }
  if (input.topic !== undefined) {
    headerLines.push(`topic: ${input.topic}`);
  }
  if (input.created_at_epoch_ms !== undefined) {
    headerLines.push(`created_at_epoch_ms: ${input.created_at_epoch_ms}`);
  }
  if (input.last_refresh_epoch_ms !== undefined) {
    headerLines.push(`last_refresh_epoch_ms: ${input.last_refresh_epoch_ms}`);
  }
  headerLines.push('---');

  const epoch = input.created_at_epoch_ms ?? Date.now();
  const date = new Date(epoch).toISOString().slice(0, 10);
  const titleSlug = input.topic ?? input.summary ?? 'untitled';
  const title = `# ${date} — ${titleSlug}`;

  const body =
    `**What we found:** ${input.whatWeFound}\n\n` +
    `**What we decided:** ${input.whatWeDecided}\n\n` +
    `**What's next:** ${input.whatsNext}\n\n` +
    `**Where to look:** ${input.whereToLook}\n`;

  return headerLines.join('\n') + '\n' + title + '\n\n' + body;
}

/**
 * Options bag for the Phase 14-07d soft-link instrumentation overload.
 * All fields are optional; the overload is backwards-compatible.
 */
export interface WriteHandoffOpts {
  /**
   * When supplied, a `supersedes` soft link is emitted after the primary
   * write succeeds. Requires sessionId and project also be supplied.
   */
  db?: Database;
  /** Session that is performing the write. Required when db is supplied. */
  sessionId?: string;
  /** Project scope for the handoff query. Required when db is supplied. */
  project?: string;
}

/**
 * Atomically write a handoff file at `targetPath`. Throws if input fails
 * validation. Creates the parent directory if missing. Uses tmp + renameSync
 * so a partial-write failure leaves any prior file at `targetPath` intact.
 *
 * Phase 14-07d overload: when `opts.db` is supplied, a `supersedes` soft
 * link is emitted post-write (new handoff → prior handoff in the artifact
 * table). Soft-link emission failure is logged via telemetry and NEVER
 * propagates to the caller — the primary write contract is unchanged.
 */
export function writeHandoff(targetPath: string, input: HandoffInput, opts?: WriteHandoffOpts): void {
  const headerForValidation: Partial<HandoffHeader> = {
    status: input.status,
    phase: typeof input.phase === 'number' ? String(input.phase) : input.phase,
  };
  const errors = validateHandoffHeader(headerForValidation);
  if (errors.length > 0) {
    throw new Error('handoff validation failed: ' + JSON.stringify(errors));
  }

  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const rendered = renderHandoffMarkdown(input);
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, rendered, 'utf8');

  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore — best-effort cleanup */
    }
    throw err;
  }

  // 14-07d: emit supersedes soft link (post-write; non-blocking).
  if (opts?.db && opts.sessionId && opts.project) {
    try {
      const db = opts.db;
      const project = opts.project;
      const sessionId = opts.sessionId;

      // Look up the V17 artifact for the file we just wrote (the new handoff).
      // Handoff artifacts are ingested by file-ingester with kind='handoff' and
      // the file path stored as json_extract(data, '$.artifact_ref') in the data column.
      const newRow = db.prepare(`
        SELECT id FROM artifact
        WHERE kind = 'handoff' AND project = ? AND json_extract(data, '$.artifact_ref') = ?
        ORDER BY created_at_epoch_ms DESC
        LIMIT 1
      `).get(project, targetPath) as { id: string } | undefined;

      // Find the most recent prior handoff artifact for the project (not the new one).
      const priorRow = newRow
        ? db.prepare(`
            SELECT id FROM artifact
            WHERE kind = 'handoff' AND project = ? AND id != ?
            ORDER BY created_at_epoch_ms DESC
            LIMIT 1
          `).get(project, newRow.id) as { id: string } | undefined
        : undefined;

      // If the new handoff is not yet ingested as a V17 artifact, skip
      // emission — there is nothing to link from. The plan allows this
      // (truths: "if either is missing, the soft-link write is skipped").
      if (newRow) {
        recordSupersedes({
          db,
          session_id: sessionId,
          new_handoff_artifact_id: newRow.id,
          prior_handoff_artifact_id: priorRow?.id ?? null,
        });
      }
    } catch {
      // Non-fatal: soft-link emission errors must never surface to callers.
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 14-07l — recordDecisionShift (additive; CHR boundary-driven refresh)
// ---------------------------------------------------------------------------

import type { BoundaryType } from '../intelligence/directive-detector.js';

export interface RecordDecisionShiftParams {
  db: Database;
  project: string;
  session_id: string;
  boundary_type: BoundaryType;
  summary: string;
  source_turn_uuid: string;
}

export interface RecordDecisionShiftResult {
  refreshed: boolean;
  new_artifact_id: string | null;
  prior_artifact_id: string | null;
}

/**
 * Append a decision-boundary entry to the active ACTIVE.md handoff.
 *
 * - Reads ACTIVE.md from {projectDir}/context/handoffs/ACTIVE.md.
 * - Parses the existing content (header + body sections).
 * - Appends the boundary line to the correct section per type:
 *     operator_pivot / spec_change  → **What's next:**
 *     operator_confirm / agent_position → **What we decided:**
 * - Updates header `last_refresh_epoch_ms`; preserves `created_at_epoch_ms`.
 * - Atomically writes via tmp + rename.
 * - Emits a supersedes soft-link (new state → prior state).
 * - Idempotent on same `source_turn_uuid` — no duplicate lines.
 *
 * Returns `{ refreshed: false, ... }` when ACTIVE.md can't be found or is
 * malformed (non-throwing). Callers should not fail on false.
 */
export function recordDecisionShift(
  p: RecordDecisionShiftParams,
): RecordDecisionShiftResult {
  const noop: RecordDecisionShiftResult = {
    refreshed: false,
    new_artifact_id: null,
    prior_artifact_id: null,
  };

  try {
    // 1. Locate ACTIVE.md.
    const projectDir = resolveProjectPath(p.project);
    if (!projectDir) return noop;

    const handoffsDir = getHandoffsDir(projectDir);
    const activePath = path.join(handoffsDir, 'ACTIVE.md');

    if (!fs.existsSync(activePath)) return noop;

    const raw = fs.readFileSync(activePath, 'utf8');
    if (!raw || raw.length === 0) return noop;

    // 2. Parse header to preserve fields.
    const header = parseHandoffHeader(raw);
    if (!header) return noop;

    // 3. Idempotency — check if this source_turn_uuid already appears in the body.
    if (raw.includes(p.source_turn_uuid)) return noop;

    // 4. Format the boundary entry line.
    const iso = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    const entryLine = `- [${iso}] [${p.boundary_type}] ${p.summary} (turn:${p.source_turn_uuid.slice(0, 8)})`;

    // 5. Determine which section to append to.
    const appendToWhatsNext =
      p.boundary_type === 'operator_pivot' || p.boundary_type === 'spec_change';

    const targetSectionHeader = appendToWhatsNext ? "**What's next:**" : '**What we decided:**';

    // 6. Append the line to the target section in the body.
    const updatedBody = appendToSection(raw, targetSectionHeader, entryLine);

    // 7. Re-render the full ACTIVE.md with updated last_refresh_epoch_ms.
    // The plan requires we re-render the FULL file atomically, preserving
    // created_at_epoch_ms and updating last_refresh_epoch_ms.
    const now = Date.now();
    const updatedContent = updateFrontmatterField(updatedBody, 'last_refresh_epoch_ms', String(now));

    // 8. Atomic write via tmp + rename.
    const tmp = activePath + '.tmp';
    fs.writeFileSync(tmp, updatedContent, 'utf8');
    fs.renameSync(tmp, activePath);

    // 9. Emit supersedes soft-link.
    let priorArtifactId: string | null = null;
    let newArtifactId: string | null = null;
    try {
      const newRow = p.db.prepare(`
        SELECT id FROM artifact
        WHERE kind = 'handoff' AND project = ? AND json_extract(data, '$.artifact_ref') = ?
        ORDER BY created_at_epoch_ms DESC
        LIMIT 1
      `).get(p.project, activePath) as { id: string } | undefined;

      if (newRow) {
        newArtifactId = newRow.id;
        const priorRow = p.db.prepare(`
          SELECT id FROM artifact
          WHERE kind = 'handoff' AND project = ? AND id != ?
          ORDER BY created_at_epoch_ms DESC
          LIMIT 1
        `).get(p.project, newRow.id) as { id: string } | undefined;

        priorArtifactId = priorRow?.id ?? null;

        recordSupersedes({
          db: p.db,
          session_id: p.session_id,
          new_handoff_artifact_id: newRow.id,
          prior_handoff_artifact_id: priorArtifactId,
        });
      }
    } catch {
      // Soft-link emission failure is non-fatal per Good Child policy.
    }

    return {
      refreshed: true,
      new_artifact_id: newArtifactId,
      prior_artifact_id: priorArtifactId,
    };
  } catch {
    return noop;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for section mutation (module-private)
// ---------------------------------------------------------------------------

/**
 * Append `line` after the first occurrence of `sectionHeader` in `raw`.
 * If the section isn't found, appends to the end of the content.
 * Does NOT alter the YAML frontmatter block.
 */
function appendToSection(raw: string, sectionHeader: string, line: string): string {
  const idx = raw.indexOf(sectionHeader);
  if (idx === -1) {
    // Section not found — append to end (graceful degradation).
    return raw.trimEnd() + '\n\n' + line + '\n';
  }

  // Find the end of the line that contains the section header.
  const newlineAfterHeader = raw.indexOf('\n', idx);
  if (newlineAfterHeader === -1) {
    // Header is the very last line — just append.
    return raw + '\n' + line + '\n';
  }

  // Find the next blank line or section header after this one.
  // We'll append our line just before the next blank line or section.
  const afterHeader = raw.slice(newlineAfterHeader + 1);

  // Find where the current section's content ends (next empty line followed by **)
  const nextSectionMatch = afterHeader.match(/\n\n\*\*/);
  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    // Insert before next section.
    const insertAt = newlineAfterHeader + 1 + nextSectionMatch.index;
    return raw.slice(0, insertAt) + '\n' + line + raw.slice(insertAt);
  }

  // No next section — append at end.
  return raw.trimEnd() + '\n' + line + '\n';
}

/**
 * Update or add a YAML frontmatter field in the raw handoff content.
 * If the field already exists, replaces its value.
 * If not, inserts it before the closing `---`.
 * Non-throwing; returns original on failure.
 */
function updateFrontmatterField(raw: string, field: string, value: string): string {
  try {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return raw;

    const fmBody = fmMatch[1];
    const fmEnd = fmMatch[0].length;
    const rest = raw.slice(fmEnd);

    // Replace existing field.
    const fieldRegex = new RegExp(`^${field}:.*$`, 'm');
    if (fieldRegex.test(fmBody)) {
      const newFmBody = fmBody.replace(fieldRegex, `${field}: ${value}`);
      return `---\n${newFmBody}\n---\n${rest}`;
    }

    // Add field before closing ---
    const newFmBody = fmBody + `\n${field}: ${value}`;
    return `---\n${newFmBody}\n---\n${rest}`;
  } catch {
    return raw;
  }
}
