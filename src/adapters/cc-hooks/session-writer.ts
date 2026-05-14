/**
 * Per-turn Sessions/ writer — Phase 13 Plan 01.
 *
 * Writes every user turn and assistant turn to
 * `<cwd>/Sessions/<ISO-date>_<session-id>.md`, append-only, fsync after write.
 *
 * Design constraints (locked in 13-CONTEXT.md):
 * - Write-time: preserve all wrappers (system-reminder, experience-data, etc.)
 *   Redaction is extraction-time (Plan 13-02), not write-time.
 * - fsync after each write: crash-kill durability.
 * - Non-throwing: write failure emits telemetry but does NOT fail the hook.
 * - File naming: <ISO-date>_<session-id>.md, ISO-date = local wall-clock date
 *   of the session's first write. Filename does not change if date rolls over.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type TurnRole = 'user' | 'assistant' | 'tool_result';

export interface AppendTurnParams {
  cwd: string;
  sessionId: string;
  role: TurnRole;
  body: string;
  /** ISO 8601 with timezone offset, e.g. 2026-05-14T00:55:14+02:00 */
  timestampIso: string;
  /** Tool name — only used when role='tool_result' */
  toolName?: string;
}

/**
 * Derive the Sessions/ file path for a session.
 *
 * The date component is the wall-clock local date at first write.
 * Once chosen (file exists), we reuse the existing filename so the
 * date does not shift if a session spans midnight.
 */
export function getSessionFilePath(cwd: string, sessionId: string): string {
  const dir = path.join(cwd, 'Sessions');
  try {
    const existing = fs.readdirSync(dir).find(f => f.endsWith(`_${sessionId}.md`));
    if (existing) return path.join(dir, existing);
  } catch {
    // dir doesn't exist yet — normal on first write
  }
  const today = todayLocalIsoDate();
  return path.join(dir, `${today}_${sessionId}.md`);
}

/**
 * Append a single turn to the Sessions/ markdown file, fsync after write.
 *
 * Non-throwing: returns the error (if any) so the caller can emit telemetry.
 */
export function appendTurnToSessionFile(params: AppendTurnParams): Error | null {
  const { cwd, sessionId, role, body, timestampIso, toolName } = params;

  try {
    const dir = path.join(cwd, 'Sessions');
    fs.mkdirSync(dir, { recursive: true });

    const filePath = getSessionFilePath(cwd, sessionId);

    const header =
      role === 'user' ? '## User' :
      role === 'assistant' ? '## Assistant' :
      `## ToolResult: ${toolName ?? 'unknown'}`;

    const block = `\n${header}\n_${timestampIso}_\n\n${body}\n`;

    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, block);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Return the current wall-clock timestamp in ISO 8601 + local timezone offset.
 * Used by hooks when they don't have a timestamp from the hook payload.
 */
export function nowIso(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  // Build local time components to match the offset (Date.toISOString returns UTC)
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd}T${HH}:${MM}:${SS}${sign}${hh}:${mm}`;
}

function todayLocalIsoDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd}`;
}
