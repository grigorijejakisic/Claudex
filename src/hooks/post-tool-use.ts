/**
 * Claudex v2 — PostToolUse Hook (WP-14)
 *
 * Fires after every tool use. Extracts structured observations from
 * tool I/O and stores them in SQLite. Does NOT inject context —
 * always returns empty {}.
 *
 * NEVER throws — exits 0 always. Each step has independent error handling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { extractObservation } from '../lib/observation-extractor.js';
import { loadConfig } from '../shared/config.js';
import { readCoordinationConfig } from '../shared/coordination.js';
import { recordFileTouch } from '../checkpoint/state-files.js';
import { PATHS } from '../shared/paths.js';
import type { PostToolUseInput } from '../shared/types.js';

const HOOK_NAME = 'post-tool-use';

/**
 * Incremental checkpoint state — tracks which dynamic thresholds have been crossed.
 * Stored as a simple JSON file alongside other session state.
 * Tracks window_size so thresholds reset when window size changes (e.g. 200k → 1M).
 */
interface IncrementalCheckpointState {
  last_threshold_index: number;  // index into getIncrementalThresholds() result (-1 = none crossed)
  last_checkpoint_epoch: number; // ms timestamp of last checkpoint write
  window_size?: number;          // window size thresholds were computed for — reset on change
}

runHook(HOOK_NAME, async (input) => {
  const postInput = input as PostToolUseInput;
  const sessionId = postInput.session_id || 'unknown';
  const cwd = postInput.cwd || process.cwd();
  const toolName = postInput.tool_name || '';
  const toolInput = postInput.tool_input || {};
  const toolResponse = postInput.tool_response;

  // Gate: skip observation capture when explicitly disabled in config
  const config = loadConfig();
  const coordination = readCoordinationConfig();
  if (config.observation?.enabled === false) {
    logToFile(HOOK_NAME, 'DEBUG', 'Observation capture disabled by config');
    return {};
  }

  // Step 1: Detect scope
  const scope = detectScope(cwd);

  // Step 1.5: Check coordination ownership before expensive extraction
  const claudexOwnsToolTracking = coordination.tool_tracking !== 'context_manager';
  const claudexOwnsThread = coordination.thread_tracking === 'claudex';
  const claudexOwnsCheckpoint = coordination.checkpoint_primary === 'claudex';

  if (!claudexOwnsToolTracking && !claudexOwnsThread && !claudexOwnsCheckpoint) {
    // Nothing for Claudex to do — skip extraction entirely
    return {};
  }

  // Step 2: Extract observation (returns null for filtered/trivial tools)
  let observation;
  try {
    observation = extractObservation(toolName, toolInput, toolResponse, sessionId, scope);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Observation extraction failed', err);
    return {};
  }

  if (!observation) {
    return {};
  }

  // Acquire DB once for Steps 3 + 3.5, close after both complete
  let db: import('better-sqlite3').Database | null = null;
  if (claudexOwnsToolTracking) {
    try {
      const { getDatabase } = await import('../db/connection.js');
      db = getDatabase();
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', 'SQLite unavailable, skipping storage (Tier 2 degradation)', err);
    }

    // Step 3: Store in SQLite
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping observation storage (Tier 2 degradation)');
    } else {
      try {
        const { storeObservation } = await import('../db/observations.js');
        const { incrementObservationCount } = await import('../db/sessions.js');

        const result = storeObservation(db, observation);
        if (result.id !== -1) {
          incrementObservationCount(db, sessionId);
          logToFile(HOOK_NAME, 'DEBUG', `Observation stored (id=${result.id}) tool=${toolName}`);
        } else {
          logToFile(HOOK_NAME, 'WARN', `storeObservation returned error sentinel for tool=${toolName}`);
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Observation storage failed (non-fatal)', err);
      }
    }

    // Step 3.5: Accumulate local pressure scores from file observations
    if (observation && db) {
      try {
        const { accumulatePressureScore } = await import('../db/pressure.js');
        const project = scope.type === 'project' ? scope.name : undefined;

        // Tool-weighted increments — only accumulate for known file-bearing tools
        const TOOL_INCREMENTS: Record<string, number> = {
          Write: 0.15, Edit: 0.15,  // mutative = high signal
          Read: 0.05,               // discovery = medium signal
          Grep: 0.02,               // search hit = low signal
        };

        const increment = TOOL_INCREMENTS[toolName];
        if (increment !== undefined) {
          // Accumulate for all touched files (dedupe: same file in both modified + read)
          const allFiles = [...new Set([
            ...(observation.files_modified || []),
            ...(observation.files_read || []),
          ])];

          for (const filePath of allFiles) {
            accumulatePressureScore(db, filePath, project, increment);
          }

          if (allFiles.length > 0) {
            logToFile(HOOK_NAME, 'DEBUG', `Accumulated pressure for ${allFiles.length} files (tool=${toolName}, increment=${increment})`);
          }
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'DEBUG', 'Pressure accumulation failed (non-fatal)', err);
      }
    }

    // Step 3.7: Update incremental state (files-touched for checkpoint system)
    if (observation.files_modified && observation.files_modified.length > 0) {
      try {
        const projectDir = scope.type === 'project' ? scope.path : PATHS.home;
        for (const filePath of observation.files_modified) {
          recordFileTouch(projectDir, sessionId, filePath, toolName, observation.title);
        }
        logToFile(HOOK_NAME, 'DEBUG', `State: recorded ${observation.files_modified.length} file touches`);
      } catch (err) {
        logToFile(HOOK_NAME, 'DEBUG', 'State file update failed (non-fatal)', err);
      }
    }

    // Close DB after Steps 3 + 3.5
    if (db) {
      try { db.close(); } catch { /* best effort */ }
    }
  }

  // Step 4: REMOVED — flat-file observation mirror killed.
  // DB is the authoritative store with decay, FTS5, and selection pressure.
  // Daily files are now curated-only (written by /endsession Step 5).

  // Step 4.5. Thread accumulation — capture agent action
  // Rolling window: trims to last 14 when reaching 20 exchanges (hysteresis pattern)
  // Optimization: only parse full YAML when file size suggests >= 20 exchanges.
  // Each exchange is ~60-120 bytes in YAML; 20 exchanges ~1.5KB+ with header.
  // Gate: skip when context_manager owns thread_tracking
  if (observation && scope.type === 'project' && coordination.thread_tracking === 'claudex') {
    try {
      const projectDir = scope.path;
      const actionGist = `${toolName}: ${observation.title}`.slice(0, 100);

      // Light file-size check to avoid full YAML parse on most invocations
      const threadPath = path.join(projectDir, 'context', 'state', sessionId, 'thread.yaml');
      let needsTrim = false;
      try {
        const stat = fs.statSync(threadPath);
        // ~1.2KB is a conservative lower bound for 20 exchanges
        needsTrim = stat.size >= 1200;
      } catch {
        // File doesn't exist yet — appendExchange will create it
      }

      if (needsTrim) {
        const { appendExchange, readThread } = await import('../checkpoint/state-files.js');
        const thread = readThread(projectDir, sessionId);
        if (thread.key_exchanges.length >= 20) {
          // Rolling window: trim to last 14, then append new exchange
          const trimmed = thread.key_exchanges.slice(-14);
          trimmed.push({ role: 'agent', gist: actionGist });

          // Rewrite thread.yaml with trimmed exchanges
          const yamlMod = await import('js-yaml');
          const newThread = { summary: thread.summary, key_exchanges: trimmed };
          const content = yamlMod.dump(newThread, { schema: yamlMod.JSON_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
          fs.writeFileSync(threadPath, content, 'utf-8');
        } else {
          appendExchange(projectDir, sessionId, { role: 'agent', gist: actionGist });
        }
      } else {
        const { appendExchange } = await import('../checkpoint/state-files.js');
        appendExchange(projectDir, sessionId, { role: 'agent', gist: actionGist });
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'Thread accumulation failed (non-fatal)', err);
    }
  }

  // Step 5: Incremental checkpoint — check token utilization and write checkpoint
  // at dynamic thresholds (via getIncrementalThresholds()). 200k gets 2 thresholds,
  // 1M gets 6 thresholds. Window size changes trigger threshold state reset.
  // Gate: skip when context_manager is checkpoint primary
  if (scope.type === 'project' && coordination.checkpoint_primary === 'claudex') {
    try {
      const transcriptPath = postInput.transcript_path;
      if (transcriptPath) {
        const { readTokenGaugeWithDetection, getIncrementalThresholds } = await import('../lib/token-gauge.js');
        const gauge = readTokenGaugeWithDetection(transcriptPath, config?.checkpoint?.window_size);
        const thresholds = getIncrementalThresholds(gauge.window_size);

        if (gauge.status === 'ok') {
          const totalTokens = gauge.usage.input_tokens + gauge.usage.cache_creation_input_tokens + gauge.usage.cache_read_input_tokens;

          // Find highest threshold crossed
          let crossedIndex = -1;
          for (let i = thresholds.length - 1; i >= 0; i--) {
            if (totalTokens >= thresholds[i]!) {
              crossedIndex = i;
              break;
            }
          }

          if (crossedIndex >= 0) {
            // Read previous state
            const projectDir = scope.path;
            const stateFilePath = path.join(projectDir, 'context', 'state', sessionId, '.incremental-cp.json');
            let prevState: IncrementalCheckpointState = { last_threshold_index: -1, last_checkpoint_epoch: 0 };
            try {
              if (fs.existsSync(stateFilePath)) {
                prevState = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
              }
            } catch { /* start fresh */ }

            // Only write if we crossed a NEW threshold (or window size changed)
            const windowSizeChanged = prevState.window_size !== undefined && prevState.window_size !== gauge.window_size;
            if (crossedIndex > prevState.last_threshold_index || windowSizeChanged) {
              // If window size changed, reset — recompute crossedIndex against new thresholds
              if (windowSizeChanged) {
                crossedIndex = -1;
                for (let j = thresholds.length - 1; j >= 0; j--) {
                  if (totalTokens >= thresholds[j]!) { crossedIndex = j; break; }
                }
              }

              // Only proceed if a threshold is actually crossed (crossedIndex may be -1 after reset)
              if (crossedIndex >= 0) {
                const { writeCheckpoint } = await import('../checkpoint/writer.js');
                const { getDatabase } = await import('../db/connection.js');
                const cpDb = getDatabase();

                try {
                  const scopeStr = `project:${scope.name}`;
                  const result = writeCheckpoint({
                    projectDir,
                    sessionId,
                    scope: scopeStr,
                    trigger: 'incremental',
                    gaugeReading: gauge,
                    db: cpDb ?? undefined,
                  });

                  if (result) {
                    // Update state (includes window_size for change detection)
                    const newState: IncrementalCheckpointState = {
                      last_threshold_index: crossedIndex,
                      last_checkpoint_epoch: Date.now(),
                      window_size: gauge.window_size,
                    };
                    const stateDir = path.dirname(stateFilePath);
                    fs.mkdirSync(stateDir, { recursive: true });
                    fs.writeFileSync(stateFilePath, JSON.stringify(newState), 'utf-8');

                    logToFile(HOOK_NAME, 'INFO',
                      `Incremental checkpoint written at ${(totalTokens / 1000).toFixed(0)}k tokens (threshold ${crossedIndex + 1}/${thresholds.length}): ${result.checkpointId}`);
                  }
                } finally {
                  if (cpDb) try { cpDb.close(); } catch { /* best effort */ }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'Incremental checkpoint failed (non-fatal)', err);
    }
  }

  return {};
});
