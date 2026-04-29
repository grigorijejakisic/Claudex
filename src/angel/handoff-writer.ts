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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type HandoffStatus = 'active' | 'archived' | 'paused';

export interface HandoffHeader {
  status: HandoffStatus;
  phase: string;
  summary?: string;
  topic?: string;
  created_at_epoch_ms?: number;
}

export interface HandoffInput {
  status: HandoffStatus;
  phase: string | number;
  summary?: string;
  topic?: string;
  created_at_epoch_ms?: number;
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
 * Parse the YAML frontmatter at the head of `raw`. Returns the typed header,
 * or null if no frontmatter is present, the frontmatter is malformed, or the
 * resulting header fails validation.
 */
export function parseHandoffHeader(raw: string): HandoffHeader | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const body = match[1];
  const partial: Partial<HandoffHeader> = {};

  for (const line of body.split('\n')) {
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
    }
  }

  const errors = validateHandoffHeader(partial);
  if (errors.length > 0) return null;

  return partial as HandoffHeader;
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
 * Atomically write a handoff file at `targetPath`. Throws if input fails
 * validation. Creates the parent directory if missing. Uses tmp + renameSync
 * so a partial-write failure leaves any prior file at `targetPath` intact.
 */
export function writeHandoff(targetPath: string, input: HandoffInput): void {
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
}
