/**
 * CM Adapter — PostToolUse Hook
 *
 * Captures tool observations (resource tracking) into CM state files.
 * Fires after every tool use alongside Claudex's own PostToolUse hook.
 *
 * Coordination: runs when tool_tracking is "context_manager" or "both".
 */

import { runHook, logToFile } from '../../hooks/_infrastructure.js';
import { readCoordinationConfig } from '../../shared/coordination.js';
import { ensureStateDir, appendResourceUsage } from '../state-files.js';
import type { PostToolUseInput } from '../../shared/types.js';

const HOOK_NAME = 'cm-post-tool-use';

function sanitizePath(p: string): string {
  // Strip control characters (except tab), cap length
  return p.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 500);
}

runHook(HOOK_NAME, async (input) => {
  const coordination = readCoordinationConfig();
  if (coordination.tool_tracking !== 'context_manager' && coordination.tool_tracking !== 'both') {
    return {};
  }

  const postInput = input as PostToolUseInput;
  const sessionId = postInput.session_id || 'unknown';
  const toolName = postInput.tool_name || '';
  const toolInput = postInput.tool_input || {};

  try {
    await ensureStateDir(sessionId);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Failed to ensure state dir', err);
    return {};
  }

  // Track tool + file in a single read/write cycle
  const rawPath =
    typeof toolInput.path === 'string'
      ? toolInput.path
      : typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : null;
  const filePath = rawPath ? sanitizePath(rawPath) : null;

  const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
  const kind = filePath
    ? (WRITE_TOOLS.has(toolName) ? 'modified' : 'read')
    : undefined;

  try {
    await appendResourceUsage(sessionId, toolName, filePath, kind);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', `Failed to track resource usage for ${toolName}`, err);
  }

  return {};
});
