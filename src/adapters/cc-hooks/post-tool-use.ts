/**
 * PostToolUse hook -> after_tool event.
 * Extracts observations, updates pressure, tracks thread, checks checkpoint threshold.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import {
  processToolAndPressure,
  trackAfterTool,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';
import { addJournalEntry } from '../../core/journal.js';
import { createArtifact } from '../../core/artifacts.js';
import { getObservationsByProject } from '../../core/observations.js';
import type Database from 'better-sqlite3';

/**
 * Detect milestone events from tool execution results.
 * Returns a concise milestone string, or null if no milestone detected.
 * Pure function — no side effects.
 */
export function detectMilestone(toolName: string, toolOutput: string): string | null {
  if (!toolOutput) return null;

  // Test suite results
  const testMatch = toolOutput.match(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i);
  const testFail = toolOutput.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ure)?/i);
  if (testMatch || testFail) {
    const passed = testMatch ? testMatch[1] : '0';
    const failed = testFail ? testFail[1] : '0';
    if (testFail && parseInt(failed) > 0) {
      return `Tests: ${passed} passed, ${failed} failed`;
    }
    if (testMatch) {
      return `Tests: ${passed} passing`;
    }
  }

  // Build results
  if (/build/i.test(toolOutput) && /success|clean|complete/i.test(toolOutput)) {
    return 'Build succeeded';
  }

  // Git commits (match [branch abc1234] pattern)
  if (toolName === 'Bash') {
    const commitMatch = toolOutput.match(/\[\S+\s+([a-f0-9]{7,})\]/);
    if (commitMatch) {
      return `Committed ${commitMatch[1].slice(0, 7)}`;
    }
  }

  // Deployment/team events
  if (/workers?\s+(?:deployed|spawned|started)/i.test(toolOutput) ||
      /agents?\s+(?:deployed|spawned|started)/i.test(toolOutput)) {
    return 'Team agents deployed';
  }

  return null;
}

/**
 * Capture a milestone journal entry if a significant event is detected.
 * Non-throwing.
 */
function captureMilestone(
  db: Database.Database,
  sessionId: string,
  project: string,
  toolName: string,
  toolOutput: Record<string, unknown> | undefined,
): void {
  try {
    // Extract text content from tool output
    const outputText = toolOutput
      ? (typeof toolOutput === 'string'
        ? toolOutput
        : (toolOutput.content as string) || (toolOutput.output as string) || (toolOutput.stdout as string) || JSON.stringify(toolOutput))
      : '';

    const milestone = detectMilestone(toolName, outputText);
    if (milestone) {
      // Truncate to 100 chars
      const content = milestone.length > 100 ? milestone.slice(0, 97) + '...' : milestone;
      addJournalEntry(db, sessionId, project, 'milestone', content);
    }
  } catch {
    // Non-throwing — milestone capture must not break tool processing
  }
}

const main = wrapHook('PostToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const toolOutput = (input.tool_output as Record<string, unknown>) || undefined;

  processToolAndPressure({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    toolName,
    toolInput,
    toolOutput,
  });

  // Create artifact from the just-captured observation (importance >= 3 only)
  try {
    const recent = getObservationsByProject(ctx.db, ctx.project, { limit: 1 });
    const obs = recent[0];
    if (obs && obs.session_id === input.session_id && obs.importance >= 3) {
      createArtifact(ctx.db, input.session_id, ctx.project, 'observation', String(obs.id), obs.title, obs.content, obs.importance);
    }
  } catch {
    // Non-throwing — artifact creation must never break tool processing
  }

  // Milestone detection — capture significant tool outcomes
  captureMilestone(ctx.db, input.session_id, ctx.project, toolName, toolOutput);

  // Thread tracking
  //
  // DESIGN LIMITATION (ephemeral CC hook process):
  // ThreadTracker.onAfterTool() accumulates pending exchanges in memory, but the
  // CC hook process exits immediately after each invocation. This means in-memory
  // pending exchange data is lost between hook calls. Thread tracking only works
  // fully in the persistent OpenClaw bridge, where the process stays alive across
  // multiple tool calls within a turn. In the CC hooks adapter, only the DB-persisted
  // state (via tracker.persist()) survives between invocations — the pending exchange
  // count and any volatile accumulation are reset on each hook call.
  trackAfterTool(
    ctx.db,
    input.session_id,
    (input.user_prompt as string) ?? undefined,
    toolName,
    toolInput,
  );

  // Checkpoint threshold check
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });

  await checkpointIfThresholdMet({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    scope: ctx.scope ?? undefined,
    config: ctx.config,
    gauge,
  });

  return {};
});

main();
