/**
 * CM Adapter — Stop Hook
 *
 * Fires at end of agent turn. Performs:
 * 1. Decision extraction from the transcript (if learnings/decisions assigned to CM)
 * 2. Open items capture from assistant messages
 *
 * Coordination: runs when learnings is "context_manager" (covers decisions too).
 */

import { runHook, logToFile } from '../../hooks/_infrastructure.js';
import { readCoordinationConfig } from '../../shared/coordination.js';
import { readTranscriptTail } from '../../shared/transcript-tail.js';
import { ensureStateDir, appendDecision } from '../state-files.js';
import { extractDecisionFromResponse, isConfirmationMessage } from '../decision-extractor.js';
import { scanAndCaptureOpenItems } from '../open-items.js';
import type { StopInput } from '../../shared/types.js';

const HOOK_NAME = 'cm-stop';

/** Extract last user/assistant turn from transcript using shared tail reader. */
function extractLastTurnMessages(
  transcriptPath: string,
): { userText: string; assistantText: string } | null {
  const entries = readTranscriptTail(transcriptPath);
  if (entries.length === 0) return null;

  let lastUserText = '';
  let lastAssistantText = '';
  for (const entry of entries) {
    if (entry.role === 'user') {
      lastUserText = entry.text;
      lastAssistantText = '';
    } else if (entry.role === 'assistant' && entry.text) {
      lastAssistantText = entry.text;
    }
  }

  return lastAssistantText ? { userText: lastUserText, assistantText: lastAssistantText } : null;
}

runHook(HOOK_NAME, async (input) => {
  const coordination = readCoordinationConfig();
  if (coordination.learnings !== 'context_manager') {
    return {};
  }

  const stopInput = input as StopInput;
  const sessionId = stopInput.session_id || 'unknown';
  const transcriptPath = stopInput.transcript_path;

  if (!transcriptPath) return {};

  const messages = extractLastTurnMessages(transcriptPath);
  if (!messages) return {};

  // Extract decision (if applicable)
  let decision: string | null = null;
  if (
    messages.userText.length < 50 &&
    messages.assistantText.length > 500 &&
    isConfirmationMessage(messages.userText)
  ) {
    decision = extractDecisionFromResponse(messages.assistantText);
  }

  // Only ensure state dir if we have assistant text to scan for decisions/open-items
  const hasAssistantText = messages.assistantText.length > 0;
  if (!decision && !hasAssistantText) return {};

  try {
    await ensureStateDir(sessionId);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Failed to ensure state dir', err);
    return {};
  }

  // Decision capture
  if (decision) {
    try {
      await appendDecision(sessionId, {
        what: decision,
        when: new Date().toISOString(),
      });
      logToFile(HOOK_NAME, 'DEBUG', `Decision captured: ${decision.slice(0, 80)}`);
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', 'Decision extraction failed', err);
    }
  }

  // Open items capture from assistant text
  try {
    await scanAndCaptureOpenItems(sessionId, messages.assistantText);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Open items capture failed', err);
  }

  return {};
});
