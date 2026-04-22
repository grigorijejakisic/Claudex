/**
 * CLAUDE_ENV_FILE injection and CC auto-memory conflict detection.
 *
 * writeClaudeEnvFile(): Writes session-agnostic env flags to the file path
 * specified by CC's CLAUDE_ENV_FILE env var. CC sources this file before every
 * BashTool command for the session.
 *
 * detectCcMemoryConflict(): Scans CC's auto-memory directory for files modified
 * after the last session baseline. If found, CC's auto-memory may be active
 * despite our CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 flag.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Database from 'better-sqlite3';
import { cachedPrepare } from '../../core/stmt-cache.js';

/**
 * Write CLAUDE_ENV_FILE — inject env flags for CC's bash environment.
 * CC sources this file before every BashTool command for the session.
 *
 * T1/T2: Disable CC auto-memory (~11K tokens/turn saved).
 * T8: Preserve hook additionalContext in transcripts for session resume.
 * CUR-03: Disable CC auto-dream (guards Angel-owned MEMORY.md from consolidation
 *   subagent overwrites). Exact CC env var name is not documented in
 *   context/research/cc-source/06-dream-kairos.md — CC's autoDream.ts gates on
 *   `settings.autoDreamEnabled` / `tengu_onyx_plover` GrowthBook / auto-memory
 *   disable, not on a named env var. The `CLAUDE_CODE_DISABLE_AUTO_DREAM=1`
 *   form is provisional, mirroring the T1/T2 pattern; update when CC exposes
 *   a canonical var or when GrowthBook override plumbing lands.
 * B6: Only session-agnostic flags — session ID sourced from hook payload, not env file.
 *
 * Non-throwing. Silently skips if CLAUDE_ENV_FILE is not set.
 */
export function writeClaudeEnvFile(): void {
  try {
    const envFilePath = process.env.CLAUDE_ENV_FILE;
    if (!envFilePath) return;

    fs.writeFileSync(envFilePath, [
      'export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
      'export CLAUDE_CODE_DISABLE_AUTO_DREAM=1',
      'export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1',
      '',
    ].join('\n'));
  } catch { /* Non-fatal — env file mechanism is best-effort */ }
}

/**
 * C1: GrowthBook flag conflict detection — verify CC auto-memory stays disabled.
 * Scans CC's auto-memory directory for .md files modified after the last session's
 * start time. If found, the env flag mechanism may have failed and CC's memory
 * subsystems could be active.
 *
 * Returns list of conflicting file names (empty if no conflict detected).
 * Non-throwing — detection is best-effort.
 */
export function detectCcMemoryConflict(
  db: Database,
  sessionId: string,
  project: string,
  scope: string | undefined,
): string[] {
  try {
    const ccAutoMemDir = path.join(os.homedir(), '.claude', 'projects',
      scope ?? project, 'memory');

    if (!fs.existsSync(ccAutoMemDir)) return [];

    // Get last session's start time as baseline
    const lastSession = cachedPrepare(db,
      `SELECT created_at_epoch FROM sessions WHERE project = ? AND session_id != ? ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(project, sessionId) as { created_at_epoch: number } | undefined;

    if (!lastSession) return [];

    const baselineMs = lastSession.created_at_epoch * 1000;
    const entries = fs.readdirSync(ccAutoMemDir).filter(f => f.endsWith('.md'));
    const newFiles = entries.filter(f => {
      try {
        const stat = fs.statSync(path.join(ccAutoMemDir, f));
        return stat.mtimeMs > baselineMs;
      } catch { return false; }
    });

    return newFiles;
  } catch { return []; }
}
