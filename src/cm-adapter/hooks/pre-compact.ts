/**
 * CM Adapter — PreCompact Hook
 *
 * Fires before context compaction. Performs:
 * 1. Reads in-session learnings from state files
 * 2. Promotes them to cross-session learnings store
 * 3. Resets state files for the next context window
 *
 * Coordination: runs when learnings is "context_manager".
 */

import * as crypto from 'node:crypto';
import { runHook, logToFile } from '../../hooks/_infrastructure.js';
import { readCoordinationConfig } from '../../shared/coordination.js';
import { readStateFiles, resetStateFiles } from '../state-files.js';
import { promoteLearnings } from '../learnings.js';
import type { PreCompactInput } from '../../shared/types.js';

const HOOK_NAME = 'cm-pre-compact';

runHook(HOOK_NAME, async (input) => {
  const coordination = readCoordinationConfig();
  if (coordination.learnings !== 'context_manager') {
    return {};
  }

  const preInput = input as PreCompactInput;
  const sessionId = preInput.session_id || 'unknown';

  // Read only learnings before reset
  let stateFiles;
  try {
    stateFiles = await readStateFiles(sessionId, ['learnings']);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Failed to read state files', err);
    return {};
  }

  // Promote in-session learnings to cross-session store
  if (stateFiles.learnings && stateFiles.learnings.length > 0) {
    const checkpointId = crypto.randomUUID();
    try {
      await promoteLearnings(stateFiles.learnings, checkpointId, sessionId);
      logToFile(HOOK_NAME, 'INFO',
        `Promoted ${stateFiles.learnings.length} learnings to cross-session store`);
      // Only reset learnings after successful promotion
      try {
        await resetStateFiles(sessionId, ['learnings']);
        logToFile(HOOK_NAME, 'DEBUG', 'Learnings state reset after promotion');
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Learnings reset failed', err);
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', 'Learnings promotion failed — state NOT reset', err);
    }
  }

  // Reset non-learnings state (safe to reset regardless)
  try {
    await resetStateFiles(sessionId, ['decisions', 'open_items', 'resources']);
    logToFile(HOOK_NAME, 'DEBUG', 'Non-learnings state reset');
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'State reset failed', err);
  }

  return {};
});
