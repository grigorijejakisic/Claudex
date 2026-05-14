/**
 * Phase 12 context-pull cue builders (12-08).
 * Three advisory cues injected at high-value moments during autonomous work.
 * All cues are non-blocking — failure never surfaces to the agent.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { loadConfig } from '../shared/config.js';

// ── Config ────────────────────────────────────────────────────────────────────

export function areCuesEnabled(): boolean {
  try {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const v6 = cfg.v6 as Record<string, unknown> | undefined;
    const cues = v6?.cues as Record<string, unknown> | undefined;
    return (cues?.enabled as boolean | undefined) ?? true;
  } catch {
    return true;
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

const MAX_SNIPPET_CHARS = 200;
const MAX_RESULTS = 3;

function formatResult(
  artifactType: string,
  id: number | string,
  summary: string,
): string {
  const snippet = summary.length > MAX_SNIPPET_CHARS
    ? summary.slice(0, MAX_SNIPPET_CHARS) + '…'
    : summary;
  return `[${artifactType}:${id}] ${snippet}`;
}

function buildCueBlock(header: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  const body = lines.slice(0, MAX_RESULTS).join('\n');
  const full = `<system-reminder>\n${header}\n\n${body}\n</system-reminder>`;
  if (full.length > 1024) {
    return `<system-reminder>\n${header}\n\n${body.slice(0, 800)}…\n</system-reminder>`;
  }
  return full;
}

// ── Cue 1: Handoff-reading ────────────────────────────────────────────────────

/**
 * Fires when the agent reads a handoff file.
 * Surfaces top-3 project artifacts mentioning the handoff slug + recent session
 * events, advisory only.
 */
export async function buildHandoffReadCue(
  db: Database,
  handoffPath: string,
  sessionId: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const slug = handoffPath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(md|yaml|yml|json)$/, '')
    ?.toLowerCase() ?? 'handoff';

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE (summary LIKE ? OR summary LIKE ?)
         AND state != 'packed'
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`,
    ).all(`%${slug}%`, '%handoff%', MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  if (lines.length < MAX_RESULTS) {
    try {
      const limit = MAX_RESULTS - lines.length;
      const existing = new Set(lines);
      const rows = cachedPrepare(
        db,
        `SELECT id, artifact_type, summary
         FROM artifacts
         WHERE session_id = ?
           AND state != 'packed'
         ORDER BY timestamp_epoch DESC
         LIMIT ?`,
      ).all(sessionId, limit + 2) as Array<{
        id: number;
        artifact_type: string;
        summary: string;
      }>;
      for (const r of rows) {
        const line = formatResult(r.artifact_type, r.id, r.summary);
        if (!existing.has(line)) lines.push(line);
        if (lines.length >= MAX_RESULTS) break;
      }
    } catch { /* non-blocking */ }
  }

  return buildCueBlock(
    '## Context Pull Cue — Handoff Reading\nBefore interpreting this handoff, prior session context that may be relevant:',
    lines,
  );
}

// ── Cue 2: Decision-locking ──────────────────────────────────────────────────

/**
 * Fires when the agent writes to a config or curated-context file.
 * Surfaces prior decisions that may have established, contradicted, or flagged
 * the value being set.
 */
export async function buildDecisionLockCue(
  db: Database,
  filePath: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const basename = filePath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(json|yaml|yml|ts|js|md)$/, '')
    ?.toLowerCase() ?? 'config';

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE artifact_type IN ('decision', 'learning')
         AND (summary LIKE ? OR summary LIKE ?)
         AND state != 'packed'
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`,
    ).all(`%${basename}%`, '%UNVALIDATED%', MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  return buildCueBlock(
    '## Context Pull Cue — Decision Locking\nDid any prior session establish, contradict, or flag a value in this file as UNVALIDATED?',
    lines,
  );
}

// ── Cue 3: Wait-for-direction ─────────────────────────────────────────────────

const WAIT_FOR_DIRECTION_PATTERNS = [
  /(?<!previously )(waiting for (your )?direction)/i,
  /let me know (what|how|when)/i,
  /what would you like me to/i,
  /should I proceed/i,
  /awaiting (your )?confirmation/i,
  /\bholding\b.*\bfor\b.*\b(you|direction|input)\b/i,
];

/**
 * Returns true if the assistant's response suggests passive deferral
 * on a task that likely has remaining work.
 */
export function detectsWaitForDirection(assistantText: string): boolean {
  return WAIT_FOR_DIRECTION_PATTERNS.some((p) => p.test(assistantText));
}

/**
 * Fires when the stop hook detects a wait-for-direction phrase.
 * Surfaces the most recent unresolved investigation thread from session artifacts.
 */
export async function buildWaitForDirectionCue(
  db: Database,
  sessionId: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE session_id = ?
         AND artifact_type IN ('observation', 'learning', 'decision')
         AND state != 'packed'
       ORDER BY timestamp_epoch DESC
       LIMIT ?`,
    ).all(sessionId, MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  return buildCueBlock(
    '## Context Pull Cue — Wait-for-Direction\nLatest session context before pausing — unresolved threads that may still need work:',
    lines,
  );
}
