/**
 * Claudex v3 — Stop Hook (WP-12)
 *
 * Fires at the end of each agent turn. Detects structural signals that suggest
 * decisions were made (file modifications) but not recorded, then nudges the
 * agent to log them via appendDecision().
 *
 * NEVER throws — always returns {}. File reads only, no database access.
 * Must complete in <500ms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { readCoordinationConfig } from '../shared/coordination.js';
import type { StopInput } from '../shared/types.js';

const HOOK_NAME = 'stop';

// Min turns between nudges to avoid spamming
const NUDGE_COOLDOWN_TURNS = 5;

// Min file-modifying tools to consider nudge-worthy
const FILE_MODIFY_THRESHOLD = 2;

// =============================================================================
// Nudge State
// =============================================================================

interface NudgeState {
  lastNudgeTurn: number;
  turnCount: number;
  lastKnownDecisionCount: number;
}

function emptyNudgeState(): NudgeState {
  return { lastNudgeTurn: 0, turnCount: 0, lastKnownDecisionCount: 0 };
}

/** Read nudge state from YAML. Returns empty state on any error. */
export function readNudgeState(stateDir: string): NudgeState {
  try {
    const filePath = path.join(stateDir, '.nudge-state.yaml');
    if (!fs.existsSync(filePath)) return emptyNudgeState();
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return emptyNudgeState();
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const data = yaml.load(normalized, { schema: yaml.JSON_SCHEMA });
    if (!data || typeof data !== 'object') return emptyNudgeState();
    const obj = data as Record<string, unknown>;
    return {
      lastNudgeTurn: typeof obj['lastNudgeTurn'] === 'number' ? obj['lastNudgeTurn'] : 0,
      turnCount: typeof obj['turnCount'] === 'number' ? obj['turnCount'] : 0,
      lastKnownDecisionCount: typeof obj['lastKnownDecisionCount'] === 'number' ? obj['lastKnownDecisionCount'] : 0,
    };
  } catch {
    return emptyNudgeState();
  }
}

/** Write nudge state to YAML. Silently swallows write errors. */
export function writeNudgeState(stateDir: string, state: NudgeState): void {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const filePath = path.join(stateDir, '.nudge-state.yaml');
    const content = yaml.dump(state, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch {
    // Non-fatal — nudge state loss is acceptable
  }
}

// =============================================================================
// Transcript Signal Detection
// =============================================================================

interface TranscriptSignals {
  fileModifyCount: number;
  /** Tool names used during this turn (for gist extraction) */
  toolActions: Array<{ name: string; target?: string }>;
}

/**
 * Parse the last 10000 bytes of the transcript JSONL for structural signals.
 * Counts tool_use blocks with file-modifying tool names.
 *
 * NOTE: First line in buffer may be partial (mid-line read) — JSON.parse
 * naturally skips it via try/catch. This is intentional.
 */
export function detectDecisionSignals(transcriptPath: string | undefined): TranscriptSignals {
  if (!transcriptPath) return { fileModifyCount: 0, toolActions: [] };

  try {
    if (!fs.existsSync(transcriptPath)) return { fileModifyCount: 0, toolActions: [] };

    // R24 fix: wrap fd in try/finally to prevent leak on exception
    let text: string;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(10000, stat.size);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = text.split('\n').filter(l => l.trim().length > 0);

    // First pass: parse all entries and track turn boundaries
    const parsedEntries: Array<{ role?: string; toolUseBlocks: Array<{ name: string; target?: string }> }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry?.message?.role as string | undefined;
        const toolUseBlocks: Array<{ name: string; target?: string }> = [];

        const content = entry?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block != null &&
              typeof block === 'object' &&
              block.type === 'tool_use'
            ) {
              const toolName = block.name as string;
              const input = block.input as Record<string, unknown> | undefined;
              const target = (input?.file_path as string) || (input?.command as string) || undefined;
              toolUseBlocks.push({ name: toolName, target });
            }
          }
        }

        parsedEntries.push({ role, toolUseBlocks });
      } catch {
        // Skip malformed lines (includes partial first line from mid-buffer read)
      }
    }

    // R22 fix: find last user turn boundary — only count tool_use from current turn
    let lastUserIdx = -1;
    for (let i = parsedEntries.length - 1; i >= 0; i--) {
      if (parsedEntries[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    const currentTurnEntries = lastUserIdx >= 0
      ? parsedEntries.slice(lastUserIdx + 1)
      : parsedEntries; // No user message found — treat all as current turn

    // Second pass: count signals from current turn only
    let fileModifyCount = 0;
    const toolActions: Array<{ name: string; target?: string }> = [];
    for (const entry of currentTurnEntries) {
      for (const block of entry.toolUseBlocks) {
        toolActions.push(block);
        // R23 fix: only Write and Edit count as file modifications (not Bash)
        if (block.name === 'Write' || block.name === 'Edit') {
          fileModifyCount++;
        }
      }
    }

    return { fileModifyCount, toolActions };
  } catch {
    return { fileModifyCount: 0, toolActions: [] };
  }
}

// =============================================================================
// Assistant Action Gist Extraction
// =============================================================================

const GIST_MAX_LEN = 100;

/**
 * Build a compact gist (<=100 chars) summarizing assistant actions from transcript signals.
 * Prioritizes file edits > file reads > bash commands > test runs > generic response.
 */
export function extractAssistantGist(signals: TranscriptSignals): string {
  const { toolActions } = signals;
  if (toolActions.length === 0) return 'Responded to user query';

  // Categorize actions
  const edits: string[] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const bashCmds: string[] = [];
  const otherTools: string[] = [];

  for (const action of toolActions) {
    const shortTarget = action.target ? path.basename(action.target) : undefined;
    switch (action.name) {
      case 'Edit':
        if (shortTarget) edits.push(shortTarget);
        else edits.push('file');
        break;
      case 'Write':
        if (shortTarget) writes.push(shortTarget);
        else writes.push('file');
        break;
      case 'Read':
        if (shortTarget) reads.push(shortTarget);
        else reads.push('file');
        break;
      case 'Bash':
        if (action.target) bashCmds.push(action.target);
        else bashCmds.push('command');
        break;
      default:
        otherTools.push(action.name);
        break;
    }
  }

  // Build gist with priority: edits > writes > reads > bash > other
  const parts: string[] = [];

  if (edits.length > 0) {
    const unique = [...new Set(edits)];
    parts.push(`Edited ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ` +${unique.length - 3} more` : ''}`);
  }
  if (writes.length > 0) {
    const unique = [...new Set(writes)];
    parts.push(`Created ${unique.slice(0, 2).join(', ')}${unique.length > 2 ? ` +${unique.length - 2} more` : ''}`);
  }
  if (reads.length > 0) {
    parts.push(`Read ${reads.length} file${reads.length > 1 ? 's' : ''}`);
  }
  if (bashCmds.length > 0) {
    // Detect test runs
    const testRuns = bashCmds.filter(c => /test|jest|vitest|pytest/i.test(c));
    if (testRuns.length > 0) {
      parts.push('Ran tests');
    } else {
      parts.push(`Ran ${bashCmds.length} command${bashCmds.length > 1 ? 's' : ''}`);
    }
  }
  if (parts.length === 0 && otherTools.length > 0) {
    const unique = [...new Set(otherTools)];
    parts.push(`Used ${unique.slice(0, 3).join(', ')}`);
  }

  if (parts.length === 0) return 'Responded to user query';

  // Join and truncate to GIST_MAX_LEN
  let gist = parts.join('; ');
  if (gist.length > GIST_MAX_LEN) {
    gist = gist.slice(0, GIST_MAX_LEN - 3) + '...';
  }
  return gist;
}

// =============================================================================
// Hook Entry Point
// =============================================================================

runHook(HOOK_NAME, async (input) => {
  let result: { systemMessage?: string } = {};

  try {
    const stopInput = input as StopInput;
    const sessionId = stopInput.session_id || 'unknown';
    const cwd = stopInput.cwd || process.cwd();
    const transcriptPath = stopInput.transcript_path;

    // 1. Only operate in project scope
    const scope = detectScope(cwd);
    if (scope.type !== 'project') {
      return {};
    }

    const projectDir = scope.path;
    const sessionStateDir = path.join(projectDir, 'context', 'state', sessionId);

    // 2. Detect structural signals from transcript (needed for both nudge + gist)
    const signals = detectDecisionSignals(transcriptPath);

    // 3. Capture assistant action gist into thread
    // Gate: skip when context_manager owns thread_tracking
    const coordination = readCoordinationConfig();
    if (coordination.thread_tracking === 'claudex') {
      try {
        const gist = extractAssistantGist(signals);
        const { appendExchange } = await import('../checkpoint/state-files.js');
        appendExchange(projectDir, sessionId, { role: 'agent', gist });
        logToFile(HOOK_NAME, 'DEBUG', `Thread: appended agent gist: "${gist}"`);
      } catch (err) {
        logToFile(HOOK_NAME, 'DEBUG', 'Thread gist append failed (non-fatal)', err);
      }
    }

    // 4. Read nudge state and increment turn counter
    const nudgeState = readNudgeState(sessionStateDir);
    nudgeState.turnCount++;

    // 5. Check rate limit
    const turnsSinceLastNudge = nudgeState.turnCount - nudgeState.lastNudgeTurn;
    const rateLimited = nudgeState.lastNudgeTurn > 0 && turnsSinceLastNudge < NUDGE_COOLDOWN_TURNS;

    if (rateLimited) {
      // Still write updated turn count
      writeNudgeState(sessionStateDir, nudgeState);
      return result;
    }

    // 6. Read decision count for this session
    let decisionCount = 0;
    try {
      const { readDecisions } = await import('../checkpoint/state-files.js');
      const decisions = readDecisions(projectDir, sessionId);
      decisionCount = decisions.length;
    } catch {
      // Non-fatal — proceed without decision count
    }

    // 7. Nudge condition: significant file changes AND no new decisions recorded since last nudge
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const shouldNudge = signals.fileModifyCount >= FILE_MODIFY_THRESHOLD && noNewDecisions;

    if (shouldNudge) {
      nudgeState.lastNudgeTurn = nudgeState.turnCount;
      nudgeState.lastKnownDecisionCount = decisionCount;
      writeNudgeState(sessionStateDir, nudgeState);

      logToFile(HOOK_NAME, 'DEBUG',
        `Nudge: fileModifyCount=${signals.fileModifyCount}, decisionCount=${decisionCount}, turn=${nudgeState.turnCount}`
      );

      result = {
        systemMessage: 'Tip: You made significant file changes this turn but logged no decisions. Consider recording key decisions via appendDecision() to context/state/decisions.yaml — this preserves decision rationale across compactions.',
      };
      return result;
    }

    // Update state with current decision count (no nudge this turn)
    nudgeState.lastKnownDecisionCount = decisionCount;
    writeNudgeState(sessionStateDir, nudgeState);

  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Stop hook error (non-fatal)', err);
  }

  return result;
});
