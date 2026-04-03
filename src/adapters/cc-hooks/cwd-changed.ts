/**
 * CwdChanged hook (H10/H15) — when the working directory changes.
 * Non-trivial: rewrites CLAUDE_ENV_FILE, re-detects project scope,
 * builds watchPaths for the new directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';
import { writeClaudeEnvFile } from '../../adapters/shared/env-file.js';
import { detectProjectScope, deriveProjectId } from '../../shared/scope-detector.js';

const main = wrapHook('CwdChanged', async (input, ctx) => {
  const oldCwd = (input.old_cwd as string) || '';
  const newCwd = (input.new_cwd as string) || '';

  // Rewrite env flags for the new directory
  writeClaudeEnvFile();

  // Re-detect project scope for new_cwd (ctx.project reflects old cwd)
  const newScope = detectProjectScope(newCwd);
  const newProjectId = deriveProjectId(newCwd);

  const detail = JSON.stringify({
    new_project: newProjectId,
    new_scope: newScope ?? undefined,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'cwd_changed',
    newCwd,
    oldCwd,
    detail,
  );

  // Build watchPaths for the new project (same logic as session-start.ts)
  const watchPaths: string[] = [];
  try {
    const handoffPath = path.join(newCwd, 'context', 'handoffs', 'ACTIVE.md');
    if (fs.existsSync(handoffPath)) watchPaths.push(handoffPath);
    const claudeMdPath = path.join(newCwd, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) watchPaths.push(claudeMdPath);
  } catch { /* non-fatal */ }

  return {
    hookSpecificOutput: {
      hookEventName: 'CwdChanged',
      watchPaths,
    },
  };
});

main();
