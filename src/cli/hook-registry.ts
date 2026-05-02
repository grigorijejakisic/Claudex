/**
 * Canonical Claude Code hook registry.
 *
 * Lives in its own module (split out of setup.ts) so that read-only
 * consumers — `claudex doctor` (DIAG-06), tests, and any future inspection
 * tooling — can import the canonical hook list and the settings.json path
 * WITHOUT pulling in setup.ts's top-level main() bootstrap, which spawns
 * console output and a fresh-install flow when bundled.
 *
 * setup.ts now re-exports HOOK_FILES, EXPECTED_HOOK_NAMES, and
 * getSettingsJsonPath from here for back-compat.
 */

import * as os from 'os';
import * as path from 'path';

/** Hook file paths matching build.ts output in dist/adapters/cc-hooks/. */
export const HOOK_FILES: Record<string, string> = {
  SessionStart: path.join('adapters', 'cc-hooks', 'session-start.cjs'),
  UserPromptSubmit: path.join('adapters', 'cc-hooks', 'user-prompt-submit.cjs'),
  PostToolUse: path.join('adapters', 'cc-hooks', 'post-tool-use.cjs'),
  Stop: path.join('adapters', 'cc-hooks', 'stop.cjs'),
  PreCompact: path.join('adapters', 'cc-hooks', 'pre-compact.cjs'),
  SessionEnd: path.join('adapters', 'cc-hooks', 'session-end.cjs'),
  PostCompact: path.join('adapters', 'cc-hooks', 'post-compact.cjs'),
  SubagentStart: path.join('adapters', 'cc-hooks', 'subagent-start.cjs'),
  SubagentStop: path.join('adapters', 'cc-hooks', 'subagent-stop.cjs'),
  TaskCreated: path.join('adapters', 'cc-hooks', 'task-created.cjs'),
  TaskCompleted: path.join('adapters', 'cc-hooks', 'task-completed.cjs'),
  PermissionRequest: path.join('adapters', 'cc-hooks', 'permission-request.cjs'),
  PermissionDenied: path.join('adapters', 'cc-hooks', 'permission-denied.cjs'),
  Elicitation: path.join('adapters', 'cc-hooks', 'elicitation.cjs'),
  ElicitationResult: path.join('adapters', 'cc-hooks', 'elicitation-result.cjs'),
  PostToolUseFailure: path.join('adapters', 'cc-hooks', 'post-tool-use-failure.cjs'),
  StopFailure: path.join('adapters', 'cc-hooks', 'stop-failure.cjs'),
  ConfigChange: path.join('adapters', 'cc-hooks', 'config-change.cjs'),
  InstructionsLoaded: path.join('adapters', 'cc-hooks', 'instructions-loaded.cjs'),
  CwdChanged: path.join('adapters', 'cc-hooks', 'cwd-changed.cjs'),
  Setup: path.join('adapters', 'cc-hooks', 'setup.cjs'),
  WorktreeCreate: path.join('adapters', 'cc-hooks', 'worktree-create.cjs'),
  WorktreeRemove: path.join('adapters', 'cc-hooks', 'worktree-remove.cjs'),
  TeammateIdle: path.join('adapters', 'cc-hooks', 'teammate-idle.cjs'),
  PreToolUse: path.join('adapters', 'cc-hooks', 'pre-tool-use.cjs'),
};

/**
 * Canonical list of hook names Claudex expects to register in
 * ~/.claude/settings.json. Used by `claudex doctor` (DIAG-06) to compare
 * against the actually-registered set.
 */
export const EXPECTED_HOOK_NAMES: readonly string[] = Object.freeze(Object.keys(HOOK_FILES));

/**
 * Returns the path to ~/.claude/settings.json.
 */
export function getSettingsJsonPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Returns absolute paths to all hook dist files for the given install directory.
 */
export function getHookPaths(installDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [hookName, fileName] of Object.entries(HOOK_FILES)) {
    result[hookName] = path.resolve(installDir, 'dist', fileName);
  }
  return result;
}
