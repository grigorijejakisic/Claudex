/**
 * Phase 6.5 (RETR-07) — per-project CLAUDE.md flag parsing.
 *
 * Default behavior: cross-project search is ENABLED. Returns false ONLY when
 * an explicit `claudex.cross_project_search: false` line exists in the
 * project's CLAUDE.md. Resilient to a missing file (returns true).
 *
 * Single-call parsing — no caching at this layer (cheap; called once per
 * claudex_search invocation; assembler-level caching is a future optimization).
 */

import * as fs from 'fs';
import * as path from 'path';

const FLAG_RE = /^\s*claudex\.cross_project_search\s*:\s*(true|false)\s*$/im;

/**
 * Read the cross-project search opt-out flag from `<projectRoot>/CLAUDE.md`.
 *
 * Returns:
 *   - true (default-on) when CLAUDE.md is missing, unparseable, or doesn't
 *     contain the flag.
 *   - true when CLAUDE.md contains `claudex.cross_project_search: true`.
 *   - false when CLAUDE.md contains `claudex.cross_project_search: false`.
 */
export function readCrossProjectSearchFlag(projectRoot: string): boolean {
  try {
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return true;
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    const match = content.match(FLAG_RE);
    if (match && match[1].toLowerCase() === 'false') return false;
    return true;
  } catch {
    return true;
  }
}
