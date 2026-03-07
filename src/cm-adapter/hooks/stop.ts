/**
 * CM Adapter — Stop Hook
 *
 * Fires at end of agent turn. Performs:
 * 1. Decision extraction from the transcript (if learnings/decisions assigned to CM)
 * 2. Open items capture from assistant messages
 *
 * Coordination: runs when learnings is "context_manager" (covers decisions too).
 */

import * as fs from 'node:fs';
import { runHook, logToFile } from '../../hooks/_infrastructure.js';
import { readCoordinationConfig } from '../../shared/coordination.js';
import { ensureStateDir, appendDecision } from '../state-files.js';
import { extractDecisionFromResponse, isConfirmationMessage } from '../decision-extractor.js';
import { scanAndCaptureOpenItems } from '../open-items.js';
import type { StopInput } from '../../shared/types.js';

const HOOK_NAME = 'cm-stop';

/** Parse last N bytes of transcript for user/assistant messages in the current turn. */
function extractLastTurnMessages(
  transcriptPath: string,
): { userText: string; assistantText: string } | null {
  try {
    if (!fs.existsSync(transcriptPath)) return null;

    const fd = fs.openSync(transcriptPath, 'r');
    let text: string;
    try {
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(30000, stat.size);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = text.split('\n').filter(l => l.trim().length > 0);

    // Find last user and assistant messages
    let lastUserText = '';
    let lastAssistantText = '';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry?.message?.role as string | undefined;
        const content = entry?.message?.content;

        if (!role || !content) continue;

        let messageText = '';
        if (typeof content === 'string') {
          messageText = content;
        } else if (Array.isArray(content)) {
          messageText = content
            .filter((b: Record<string, unknown>) => b?.type === 'text')
            .map((b: Record<string, unknown>) => (b?.text as string) ?? '')
            .join('\n');
        }

        if (role === 'user') {
          lastUserText = messageText;
          lastAssistantText = ''; // Reset — we want the assistant AFTER this user
        } else if (role === 'assistant' && messageText) {
          lastAssistantText = messageText;
        }
      } catch {
        // Skip partial/malformed lines
      }
    }

    if (!lastAssistantText) return null;
    return { userText: lastUserText, assistantText: lastAssistantText };
  } catch {
    return null;
  }
}

runHook(HOOK_NAME, async (input) => {
  const coordination = readCoordinationConfig();
  if (coordination.learnings !== 'context_manager') {
    return {};
  }

  const stopInput = input as StopInput;
  const sessionId = stopInput.session_id || 'unknown';
  const transcriptPath = stopInput.transcript_path;

  try {
    await ensureStateDir(sessionId);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Failed to ensure state dir', err);
    return {};
  }

  if (!transcriptPath) return {};

  const messages = extractLastTurnMessages(transcriptPath);
  if (!messages) return {};

  // Decision extraction: detect short user confirmation after long agent response
  try {
    if (
      messages.userText.length < 50 &&
      messages.assistantText.length > 500 &&
      isConfirmationMessage(messages.userText)
    ) {
      const decision = extractDecisionFromResponse(messages.assistantText);
      if (decision) {
        await appendDecision(sessionId, {
          what: decision,
          when: new Date().toISOString(),
        });
        logToFile(HOOK_NAME, 'DEBUG', `Decision captured: ${decision.slice(0, 80)}`);
      }
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Decision extraction failed', err);
  }

  // Open items capture from assistant text
  try {
    await scanAndCaptureOpenItems(sessionId, messages.assistantText);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Open items capture failed', err);
  }

  return {};
});
