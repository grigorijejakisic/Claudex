/**
 * PreToolUse hook — modifies tool inputs before execution.
 *
 * Fires for ALL tools (matcher: ""). Two responsibilities:
 * 1. Agent tool: inject Claudex awareness into subagent prompts (existing)
 * 2. All tools: permission decision lookup (X8 — currently pass-through)
 *
 * X8: permissionDecision infrastructure wired but defaults to undefined
 * (pass-through to normal CC permission flow). Future: Angel promotes
 * auto-allow rules based on H5/H6 data.
 */

import { wrapHook } from './infrastructure.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { buildHandoffReadCue, buildDecisionLockCue } from '../../core/context-pull-cues.js';

/**
 * Looks up permission decision for a tool call.
 * Currently always returns undefined (pass-through).
 * Future: Angel promotes auto-allow rules based on H5/H6 data.
 */
function lookupPermissionDecision(
  _toolName: string,
  _toolInput: unknown,
): { decision: 'allow' | 'deny' | 'ask'; reason?: string } | undefined {
  return undefined;
}

function isHandoffPath(filePath: string): boolean {
  return /[/\\](handoffs|ACTIVE[^/\\]*)/.test(filePath) ||
         /[/\\]context[/\\]handoffs[/\\]/.test(filePath);
}

function isDecisionLockPath(filePath: string): boolean {
  return /[/\\]config[/\\]/.test(filePath) ||
         /\.(config)\.(json|yaml|yml|ts|js)$/.test(filePath) ||
         /[/\\](curated-context|CURATED)[^/\\]*\.md$/.test(filePath) ||
         /[/\\]\.claudex[/\\]/.test(filePath);
}

const main = wrapHook('PreToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};

  // Phase 6 EBD-02: heartbeat tick. Best-effort; never fails the hook.
  try {
    const now = Math.floor(Date.now() / 1000);
    cachedPrepare(ctx.db,
      `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?`
    ).run(now, input.session_id);
  } catch { /* swallow */ }

  // X8: Permission decision lookup (all tools)
  const permissionResult = lookupPermissionDecision(toolName, toolInput);

  // Agent tool: inject Claudex MCP hint into subagent prompts
  if (toolName === 'Agent') {
    const prompt = (toolInput.prompt as string) || '';
    if (!prompt) {
      return permissionResult
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: permissionResult.decision, permissionDecisionReason: permissionResult.reason } }
        : {};
    }

    // Don't double-inject if already contains Claudex reference
    if (prompt.includes('claudex_search') || prompt.includes('claudex_recall')) {
      return permissionResult
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: permissionResult.decision, permissionDecisionReason: permissionResult.reason } }
        : {};
    }

    const claudexHint = `\n\nNote: This project uses Claudex for persistent memory. If you need project history or past decisions, the MCP tools claudex_search and claudex_recall are available.`;

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...(permissionResult ? { permissionDecision: permissionResult.decision, permissionDecisionReason: permissionResult.reason } : {}),
        updatedInput: {
          ...toolInput,
          prompt: prompt + claudexHint,
        },
      },
    };
  }

  // 12-08: Context-pull cues — handoff-read and decision-lock
  let contextCue: string | null = null;
  try {
    const filePath = (toolInput.file_path as string) ?? (toolInput.path as string) ?? '';
    if (toolName === 'Read' && filePath && isHandoffPath(filePath)) {
      contextCue = await buildHandoffReadCue(ctx.db, filePath, input.session_id);
    } else if ((toolName === 'Write' || toolName === 'Edit') && filePath && isDecisionLockPath(filePath)) {
      contextCue = await buildDecisionLockCue(ctx.db, filePath, input.session_id);
    }
  } catch { /* non-blocking */ }

  // Non-Agent tools: return permission decision + optional cue, otherwise {}
  if (permissionResult || contextCue) {
    return {
      ...(contextCue ? { additionalContext: contextCue } : {}),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...(permissionResult ? { permissionDecision: permissionResult.decision, permissionDecisionReason: permissionResult.reason } : {}),
      },
    };
  }

  return {};
});

main();
