/**
 * Phase 8.5 — Self-narration directive (advisory voice) + /silent toggle.
 *
 * Surface-level guidance the MCP server appends to its `instructions` payload
 * so the agent narrates one line per substantial retrieval moment:
 *   - empty surface  → "no prior experience on {topic} — going in cold."
 *   - gold result    → "checking {topic} from {project} ({date}) — applying."
 *   - ambiguous      → "some prior context on {topic} but not directly
 *                       relevant — proceeding with caution."
 *
 * Phase 7 advisory-voice spirit: the directive is guidance, not enforcement.
 * Runtime suppression via `/silent` is honored by the agent reading
 * `session_flag` (key='narration_silent'), not by a separate code path.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

/**
 * Locked directive content (CONTEXT.md). Exported for tests so the body
 * shape can be asserted without scraping it from instructions output.
 */
export const NARRATION_DIRECTIVE_BODY = `

## When You Recall — Narrate (advisory)

Visibility is the curative for invisible recall: when memory tools fire,
a one-line narration in the agent's voice surfaces what surfaced (or
didn't) and what it's being applied to. Phase 7's advisory voice applies.

**When retrieval returns nothing useful** — narrate "no prior experience on {topic} — going in cold."

**When retrieval returns gold (clearly relevant prior result)** — narrate "checking {topic} from {project} ({date}) — applying."

**When retrieval returns something ambiguous** — narrate "some prior context on {topic} but not directly relevant — proceeding with caution."

Once per substantial retrieval, not per result. If the user has set
\`/silent\` for this session, suppress narration; the retrieval log still
records the event for \`/claudex-why\`.`;

/**
 * Build the narration-directive block to append to CLAUDEX_INSTRUCTIONS.
 * Returns the body when silent=false, empty string when silent=true.
 *
 * Production passes silent=false at module load — the prompt is static
 * and the per-session silent flag is read by the agent from session_flag.
 * The boolean parameter exists so tests can exercise both branches.
 */
export function buildNarrationDirective(silent: boolean): string {
  return silent ? '' : NARRATION_DIRECTIVE_BODY;
}

const NARRATION_SILENT_KEY = 'narration_silent';

/**
 * Read the per-session narration_silent flag from session_flag.
 * Returns false on a fresh session (no row), true when the flag was set.
 * Non-throwing — returns false on any error.
 */
export function isNarrationSilent(db: Database, sessionId: string): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT flag_value FROM session_flag
        WHERE session_id = ? AND flag_key = ?`
    ).get(sessionId, NARRATION_SILENT_KEY) as { flag_value: string } | undefined;
    if (!row) return false;
    return row.flag_value === '1';
  } catch {
    return false;
  }
}

/**
 * Set / clear the per-session narration_silent flag.
 * Inserts or updates the session_flag row. Non-throwing.
 */
export function setNarrationSilent(
  db: Database,
  sessionId: string,
  silent: boolean,
): void {
  try {
    if (silent) {
      cachedPrepare(db,
        `INSERT INTO session_flag (session_id, flag_key, flag_value, set_at_epoch_ms)
         VALUES (?, ?, '1', ?)
         ON CONFLICT(session_id, flag_key) DO UPDATE SET
           flag_value = '1',
           set_at_epoch_ms = excluded.set_at_epoch_ms`
      ).run(sessionId, NARRATION_SILENT_KEY, Date.now());
    } else {
      cachedPrepare(db,
        `DELETE FROM session_flag WHERE session_id = ? AND flag_key = ?`
      ).run(sessionId, NARRATION_SILENT_KEY);
    }
  } catch {
    // Non-throwing: caller treats silent as best-effort
  }
}
