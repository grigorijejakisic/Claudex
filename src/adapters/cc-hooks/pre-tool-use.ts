/**
 * PreToolUse hook — modifies tool inputs before execution.
 *
 * Discovered in CC v2.1.88 source (hooks.ts:618): PreToolUse hooks can return
 * `updatedInput` to modify tool inputs before execution.
 *
 * Current use: inject Claudex awareness into Agent tool prompts so subagents
 * know about MCP tools. Without this, subagents are "blind" to Claudex.
 *
 * Performance: matcher is set to "Agent" in settings.json so this hook
 * ONLY fires for Agent tool calls, not every tool invocation.
 */

import { wrapHook } from './infrastructure.js';

const main = wrapHook('PreToolUse', async (input, _ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};

  // Only modify Agent tool prompts
  if (toolName !== 'Agent') return {};

  const prompt = (toolInput.prompt as string) || '';
  if (!prompt) return {};

  // Don't double-inject if already contains Claudex reference
  if (prompt.includes('claudex_search') || prompt.includes('claudex_recall')) {
    return {};
  }

  const claudexHint = `\n\nNote: This project uses Claudex for persistent memory. If you need project history or past decisions, the MCP tools claudex_search and claudex_recall are available.`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...toolInput,
        prompt: prompt + claudexHint,
      },
    },
  };
});

main();
