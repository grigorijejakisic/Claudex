/**
 * Claudex v2 — UserPromptSubmit Hook (WP-13)
 *
 * Fires on every user prompt. Queries the hologram sidecar for
 * pressure-scored context, queries FTS5 for relevant observations,
 * and injects assembled context into Claude's input via additionalContext.
 *
 * NEVER throws — exits 0 always. Each subsystem has independent error handling.
 * Short prompts (< 10 chars) skip heavy injection entirely.
 *
 * Database is opened ONCE per hook invocation and shared across all subsystems.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { loadConfig } from '../shared/config.js';
import { assembleContext } from '../lib/context-assembler.js';
import { normalizeFts5Query } from '../shared/fts5-utils.js';
import { getDatabase } from '../db/connection.js';
import { readGsdState, findActivePlanFile, extractPlanMustHaves, countCompletedRequirements } from '../gsd/state-reader.js';
import { readTokenGauge } from '../lib/token-gauge.js';
import { writeCheckpoint } from '../checkpoint/writer.js';
import { readDecisions, readQuestions } from '../checkpoint/state-files.js';
import { PATHS } from '../shared/paths.js';
import type { UserPromptSubmitInput, SearchResult, Observation, Scope } from '../shared/types.js';
import type { ContextSuggestion } from '../hologram/degradation.js';
import type { GsdState } from '../gsd/types.js';
import type { GaugeReading } from '../lib/token-gauge.js';
import type { Decision } from '../checkpoint/types.js';

const HOOK_NAME = 'user-prompt-submit';
const SHORT_PROMPT_THRESHOLD = 10;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;

// =============================================================================
// Subsystem queries (each independently try/caught)
// =============================================================================

/**
 * Query the hologram sidecar for pressure-scored file context.
 * Uses ResilientHologramClient for automatic retry + recency fallback.
 * Returns null if hologram is disabled or entirely unavailable.
 *
 * @param db - Shared database handle for fallback tier (caller manages lifecycle)
 */
async function queryHologram(
  promptText: string,
  sessionId: string,
  recentFiles: string[],
  scope: Scope,
  db: import('better-sqlite3').Database | null,
  boostFiles?: string[],
): Promise<ContextSuggestion | null> {
  try {
    const config = loadConfig();

    if (config.hologram?.enabled === false) {
      logToFile(HOOK_NAME, 'DEBUG', 'Hologram disabled in config, skipping');
      return null;
    }

    const { SidecarManager } = await import('../hologram/launcher.js');
    const { ProtocolHandler } = await import('../hologram/protocol.js');
    const { HologramClient } = await import('../hologram/client.js');
    const { ResilientHologramClient } = await import('../hologram/degradation.js');

    const launcher = new SidecarManager();
    const protocol = new ProtocolHandler(config.hologram?.timeout_ms ?? 2000);
    const client = new HologramClient(launcher, protocol, config);
    const resilient = new ResilientHologramClient(client, config);

    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'DB unavailable for fallback tier, continuing without');
    }

    const project = scope.type === 'project' ? scope.name : undefined;
    const projectDir = scope.type === 'project' ? scope.path : undefined;
    const result = await resilient.queryWithFallback(promptText, 0, sessionId, recentFiles, db ?? undefined, project, projectDir, boostFiles);

    logToFile(HOOK_NAME, 'DEBUG', `Hologram query complete, source=${result.source}`);
    return result;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Hologram query failed entirely', err);
    return null;
  }
}

/**
 * Extract unique file paths from recent observations for recency fallback.
 * Collects files_read and files_modified, deduplicates, returns up to 10.
 */
function extractRecentFiles(observations: Observation[]): string[] {
  const seen = new Set<string>();
  for (const obs of observations) {
    if (obs.files_modified) {
      for (const f of obs.files_modified) seen.add(f);
    }
    if (obs.files_read) {
      for (const f of obs.files_read) seen.add(f);
    }
  }
  return [...seen].slice(0, 10);
}

/**
 * Extract simple keywords from a prompt for FTS5 search.
 * Filters out short words and common stop words.
 */
export function extractKeywords(prompt: string): string {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
    'that', 'it', 'not', 'but', 'and', 'or', 'if', 'then', 'so',
    'what', 'which', 'who', 'how', 'when', 'where', 'why',
    'all', 'each', 'every', 'any', 'no', 'some', 'just', 'also',
    'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
    'please', 'thanks', 'thank',
    // Technical stop words — noise in a code-centric memory system
    'file', 'code', 'function', 'const', 'let', 'var', 'import', 'export',
    'return', 'true', 'false', 'null', 'undefined', 'new', 'class', 'type',
    'interface',
  ]);

  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.has(w));

  // Deduplicate and take top 8 keywords (more = better recall with OR-expansion)
  const unique = [...new Set(words)].slice(0, 8);
  const keywords = unique.join(' ');

  // Normalize for FTS5 (strips hyphens and other special chars)
  return normalizeFts5Query(keywords);
}

/**
 * Query FTS5 search across all tables (observations, reasoning, consensus).
 * Uses strict-then-relax strategy: AND first, OR fallback if < 2 results.
 * Applies temporal re-ranking to boost recent results.
 * Returns empty array if database is unavailable or query fails.
 *
 * @param db - Shared database handle (caller manages lifecycle)
 */
function queryFts5(promptText: string, scope: Scope, db: import('better-sqlite3').Database | null): SearchResult[] {
  try {
    const keywords = extractKeywords(promptText);
    if (!keywords) {
      logToFile(HOOK_NAME, 'DEBUG', 'No keywords extracted from prompt, skipping FTS5');
      return [];
    }

    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database unavailable, skipping FTS5');
      return [];
    }

    const { searchAll } = require('../db/search.js') as typeof import('../db/search.js');

    const project = scope.type === 'project' ? scope.name : undefined;

    // Strict-then-relax: try AND first, fall back to OR if < 2 results
    let results = searchAll(db, keywords, {
      project,
      limit: 8,
      prefix: true,
    });

    if (results.length < 2) {
      const andCount = results.length;
      const orResults = searchAll(db, keywords, {
        project,
        limit: 8,
        mode: 'OR',
        prefix: true,
      });
      if (orResults.length > andCount) {
        results = orResults;
        logToFile(HOOK_NAME, 'DEBUG', `FTS5 OR fallback: ${orResults.length} results (AND had ${andCount})`);
      }
    }

    // Temporal re-ranking: blend BM25 relevance with recency
    if (results.length > 0) {
      const now = Date.now();
      // FTS5 rank is negative (more negative = better match)
      // Find the "best" (most negative) rank to normalize against
      const minRank = Math.min(...results.map(r => r.rank));
      const maxRank = Math.max(...results.map(r => r.rank));
      const rankRange = maxRank - minRank;

      const scored = results.map(r => {
        // Normalize BM25: 0 = worst match, 1 = best match
        // rank is negative, so minRank is the best. Map minRank→1, maxRank→0
        const normalizedBM25 = rankRange === 0 ? 1 : (maxRank - r.rank) / rankRange;

        // Recency score: 1/(1 + daysSinceCreation)
        const epochMs = r.observation.timestamp_epoch;
        const daysSince = Math.max(0, (now - epochMs) / (1000 * 60 * 60 * 24));
        const recencyScore = 1 / (1 + daysSince);

        const finalScore = 0.7 * normalizedBM25 + 0.3 * recencyScore;
        return { result: r, finalScore };
      });

      scored.sort((a, b) => b.finalScore - a.finalScore);
      results = scored.map(s => s.result);
    }

    logToFile(HOOK_NAME, 'DEBUG', `FTS5 search returned ${results.length} results for "${keywords}"`);
    return results;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'FTS5 search failed, skipping', err);
    return [];
  }
}

/**
 * Get recent observations as fallback context.
 * Returns empty array if database is unavailable.
 *
 * @param db - Shared database handle (caller manages lifecycle)
 */
function getRecent(scope: Scope, db: import('better-sqlite3').Database | null): Observation[] {
  try {
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database unavailable, skipping recent observations');
      return [];
    }

    const { getRecentObservations } = require('../db/observations.js') as typeof import('../db/observations.js');

    const project = scope.type === 'project' ? scope.name : undefined;
    const recent = getRecentObservations(db, 8, project);
    logToFile(HOOK_NAME, 'DEBUG', `Got ${recent.length} recent observations`);
    return recent;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Recent observations query failed, skipping', err);
    return [];
  }
}

// =============================================================================
// Main hook
// =============================================================================

runHook(HOOK_NAME, async (input) => {
  const startMs = Date.now();
  const promptInput = input as UserPromptSubmitInput;
  const sessionId = promptInput.session_id || 'unknown';
  const cwd = promptInput.cwd || process.cwd();

  // 1. Extract prompt text (field name may vary across Claude Code versions)
  const inputAny = input as unknown as Record<string, unknown>;
  const promptText = (inputAny.prompt as string)
    || (inputAny.user_message as string)
    || '';

  // 2. Detect scope (needed before short-prompt gate for thread accumulation)
  const scope = detectScope(cwd);
  logToFile(HOOK_NAME, 'DEBUG', `Scope: ${scope.type === 'project' ? `project:${scope.name}` : 'global'}`);

  // 2.0. Resolve configurable token budget
  const config = loadConfig();
  const CONTEXT_TOKEN_BUDGET = config.hooks?.context_token_budget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

  // 2.1. Thread accumulation — capture user message gist + detect approvals
  // Runs BEFORE short-prompt gate so "yes"/"ok" approvals are captured
  if (scope.type === 'project' && typeof promptText === 'string' && promptText.length > 0) {
    try {
      const { extractGist, detectDecisionSignal } = await import('../lib/decision-detector.js');
      const { appendExchange, appendDecision } = await import('../checkpoint/state-files.js');

      const projectDir = scope.path;
      const { readThread } = await import('../checkpoint/state-files.js');
      const gist = extractGist(promptText, 100);
      appendExchange(projectDir, sessionId, { role: 'user', gist });

      // Rolling-window cap: trim thread to 15 exchanges when >= 20
      try {
        const thread = readThread(projectDir, sessionId);
        if (thread.key_exchanges.length >= 20) {
          const trimmed = thread.key_exchanges.slice(-15);
          const yamlMod = await import('js-yaml');
          const fsMod = await import('node:fs');
          const pathMod = await import('node:path');
          const threadPath = pathMod.join(projectDir, 'context', 'state', sessionId, 'thread.yaml');
          const newThread = { summary: thread.summary, key_exchanges: trimmed };
          const content = yamlMod.dump(newThread, { schema: yamlMod.JSON_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
          fsMod.writeFileSync(threadPath, content, 'utf-8');
        }
      } catch { /* rolling-window trim non-fatal */ }

      // Auto-detect decision signals (approval, choice, rejection)
      const signal = detectDecisionSignal(promptText);
      if (signal?.detected && signal.type === 'approval') {
        appendDecision(projectDir, sessionId, {
          id: `auto-${Date.now()}`,
          what: `User approved: "${gist}"`,
          why: '(auto-detected from approval pattern, confidence: low)',
          when: new Date().toISOString(),
          reversible: true,
        });
        logToFile(HOOK_NAME, 'DEBUG', `Auto-detected approval decision: "${gist}"`);
      } else if (signal?.detected && signal.type === 'choice') {
        appendDecision(projectDir, sessionId, {
          id: `auto-${Date.now()}`,
          what: `User chose: "${gist}"`,
          why: '(auto-detected from choice pattern, confidence: low)',
          when: new Date().toISOString(),
          reversible: true,
        });
        logToFile(HOOK_NAME, 'DEBUG', `Auto-detected choice decision: "${gist}"`);
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'Thread accumulation failed (non-fatal)', err);
    }
  }

  // 3. Short prompt check — skip heavy injection for trivial prompts
  if (typeof promptText === 'string' && promptText.length < SHORT_PROMPT_THRESHOLD) {
    logToFile(HOOK_NAME, 'DEBUG', `Short prompt (${promptText.length} chars), skipping injection`);
    return {};
  }

  // 3.3. Token gauge from transcript
  const transcriptPath = promptInput.transcript_path;
  const gauge: GaugeReading = readTokenGauge(transcriptPath, 200_000);
  logToFile(HOOK_NAME, 'DEBUG', `Token gauge: ${gauge.formatted} (${gauge.threshold})`);

  // 3.5. Read GSD state (fast-path: skip if not a project or no .planning/STATE.md)
  let gsdState: GsdState | undefined;
  let gsdPlanMustHaves: string[] | undefined;
  let gsdRequirementStatus: { complete: number; total: number } | undefined;

  if (scope.type === 'project') {
    try {
      const statePath = path.join(scope.path, '.planning', 'STATE.md');
      if (fs.existsSync(statePath)) {
        gsdState = readGsdState(scope.path);

        if (gsdState.active && gsdState.position) {
          // Extract plan must-haves if there's an active plan
          if (gsdState.position.plan > 0) {
            const phasesDir = path.join(scope.path, '.planning', 'phases');
            const planFile = findActivePlanFile(phasesDir, gsdState.position.phase, gsdState.position.plan);
            if (planFile) {
              gsdPlanMustHaves = extractPlanMustHaves(planFile);
            }
          }

          // Count requirement completion for current phase
          const currentPhase = gsdState.phases.find(p => p.number === gsdState!.position!.phase);
          if (currentPhase?.requirements.length) {
            const reqPath = path.join(scope.path, '.planning', 'REQUIREMENTS.md');
            gsdRequirementStatus = countCompletedRequirements(currentPhase.requirements, reqPath);
          }

          logToFile(HOOK_NAME, 'DEBUG', `GSD active: Phase ${gsdState.position.phase}, plan ${gsdState.position.plan}`);
        }
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', 'GSD state read failed (non-fatal)', err);
    }
  }

  // 4. Open database ONCE for the entire hook invocation
  const db = getDatabase();
  if (!db) {
    logToFile(HOOK_NAME, 'WARN', 'Database connection failed — proceeding with degraded context');
  }

  try {
    // 5. Get recent observations early — needed for both context AND hologram fallback
    const recentObservations = getRecent(scope, db);

    // 5.3. Read incremental state for context enrichment
    let decisions: Decision[] = [];
    let openQuestions: string[] = [];
    if (scope.type === 'project') {
      try {
        decisions = readDecisions(scope.path, sessionId);
        openQuestions = readQuestions(scope.path, sessionId);
      } catch (err) {
        logToFile(HOOK_NAME, 'DEBUG', 'Incremental state read failed (non-fatal)', err);
      }
    }

    // 5.5. Feature 3 — Post-compact active file bridge
    let boostFiles: string[] | undefined;
    let boostNewCount = 0;
    let boostAppliedAt = 0;
    if (db) {
      try {
        const { getCheckpointState } = await import('../db/checkpoint.js');
        const cpState = getCheckpointState(db, sessionId);
        if (cpState?.active_files?.length) {
          const STALENESS_MS = 30 * 60 * 1000; // 30 minutes
          const MAX_BOOST_TURNS = 3;
          const isRecent = (Date.now() - cpState.last_epoch) < STALENESS_MS;
          const turnsRemaining = !cpState.boost_applied_at
            || (cpState.boost_turn_count ?? 0) < MAX_BOOST_TURNS;

          if (isRecent && turnsRemaining) {
            boostFiles = cpState.active_files;
            boostNewCount = (cpState.boost_turn_count ?? 0) + 1;
            boostAppliedAt = cpState.boost_applied_at ?? Date.now();
            logToFile(HOOK_NAME, 'DEBUG', `Post-compact boost: ${boostFiles.length} files, turn ${boostNewCount}/${MAX_BOOST_TURNS} (pending sidecar result)`);
          }
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Post-compact boost query failed (non-fatal)', err);
      }
    }

    // 6. Query hologram sidecar (with degradation fallback using recent file paths)
    const recentFiles = extractRecentFiles(recentObservations);
    const hologramResult = await queryHologram(promptText, sessionId, recentFiles, scope, db, boostFiles);

    // 6.1. Commit boost turn when hologram returned any result (including fallback sources)
    if (hologramResult !== null && boostFiles && db) {
      try {
        const { updateBoostState } = await import('../db/checkpoint.js');
        updateBoostState(db, sessionId, boostAppliedAt, boostNewCount);
        logToFile(HOOK_NAME, 'DEBUG', `Post-compact boost committed: turn ${boostNewCount}`);
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Post-compact boost state update failed (non-fatal)', err);
      }
    }

    // 6.5. Persist hologram pressure scores to DB so wrapper/pre-flush sees fresh data
    if (hologramResult && db) {
      try {
        const { upsertPressureScore } = await import('../db/pressure.js');

        const project = scope.type === 'project' ? scope.name : '__global__';
        const nowEpoch = Date.now();

        const entries: Array<{ list: typeof hologramResult.hot; temp: 'HOT' | 'WARM' | 'COLD'; pressure: number }> = [
          { list: hologramResult.hot, temp: 'HOT', pressure: 0.9 },
          { list: hologramResult.warm, temp: 'WARM', pressure: 0.5 },
          { list: hologramResult.cold, temp: 'COLD', pressure: 0.1 },
        ];

        let persisted = 0;
        for (const { list, temp, pressure } of entries) {
          for (const file of list) {
            upsertPressureScore(db, {
              file_path: file.path,
              project,
              raw_pressure: file.raw_pressure ?? pressure,
              temperature: temp,
              last_accessed_epoch: nowEpoch,
              decay_rate: 0.05,
            });
            persisted++;
          }
        }

        logToFile(HOOK_NAME, 'DEBUG', `Persisted ${persisted} pressure scores to DB`);
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Failed to persist hologram pressure scores (non-fatal)', err);
      }
    }

    // 6.7. Apply phase boost to hologram result (transparent: boosts phase-relevant files' scores)
    let boostedHologram = hologramResult;
    if (gsdState?.active && gsdState.position && hologramResult && scope.type === 'project') {
      try {
        const { getPhaseRelevanceSet, applyPhaseBoost } = await import('../gsd/phase-relevance.js');
        const phasesDir = path.join(scope.path, '.planning', 'phases');
        const relevance = getPhaseRelevanceSet(phasesDir, gsdState.position.phase, gsdState.position.plan);
        if (relevance.activePlanFiles.size > 0 || relevance.otherPlanFiles.size > 0) {
          const allFiles = [...hologramResult.hot, ...hologramResult.warm, ...hologramResult.cold];
          const boosted = applyPhaseBoost(allFiles, relevance);
          boostedHologram = {
            hot: boosted.filter(f => f.temperature === 'HOT'),
            warm: boosted.filter(f => f.temperature === 'WARM'),
            cold: boosted.filter(f => f.temperature === 'COLD'),
            source: hologramResult.source,
          };
          logToFile(HOOK_NAME, 'DEBUG', `Phase boost applied: ${relevance.activePlanFiles.size} active, ${relevance.otherPlanFiles.size} other files`);
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Phase boost failed (non-fatal)', err);
      }
    }

    // 6.8. Write phase summary (debounced)
    if (gsdState?.active && gsdState.position && scope.type === 'project' && db) {
      try {
        const { writePhaseSummary } = await import('../gsd/summary-writer.js');
        const wrote = writePhaseSummary(scope.path, scope.name, db, gsdState);
        if (wrote) {
          logToFile(HOOK_NAME, 'DEBUG', 'Phase summary written to .planning/context/SUMMARY.md');
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Phase summary write failed (non-fatal)', err);
      }
    }

    // 6.9. Write cross-phase summary (debounced)
    if (gsdState?.active && gsdState.position && scope.type === 'project') {
      try {
        const { writeCrossPhaseSummary } = await import('../gsd/cross-phase-writer.js');
        const claudexDir = path.join(scope.path, 'Claudex');
        const wrote = writeCrossPhaseSummary(scope.path, claudexDir);
        if (wrote) {
          logToFile(HOOK_NAME, 'DEBUG', 'Cross-phase summary written');
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Cross-phase summary failed (non-fatal)', err);
      }
    }

    // 7. Query FTS5 search (keywords from prompt)
    const ftsResults = queryFts5(promptText, scope, db);

    // 7.3. Bump access counts for observations that appeared in search results
    if (ftsResults.length > 0 && db) {
      try {
        const { bumpAccessCount } = await import('../db/observations.js');
        for (const result of ftsResults) {
          if (result.observation.id) {
            bumpAccessCount(db, result.observation.id);
          }
        }
        logToFile(HOOK_NAME, 'DEBUG', `Bumped access counts for ${ftsResults.length} search results`);
      } catch (err) {
        logToFile(HOOK_NAME, 'DEBUG', 'Access count bump failed (non-fatal)', err);
      }
    }

    // 8. Assemble context
    const assembled = assembleContext(
      {
        hologram: boostedHologram,
        searchResults: ftsResults,
        recentObservations,
        gsdState,
        gsdPlanMustHaves,
        gsdRequirementStatus,
        scope,
      },
      { maxTokens: CONTEXT_TOKEN_BUDGET },
    );

    // 8.3. Enrich assembled context with gauge + incremental state
    let contextMarkdown = assembled.markdown;
    if (contextMarkdown) {
      contextMarkdown = gauge.formatted + '\n\n' + contextMarkdown;
      if (decisions.length > 0) {
        const decisionBlock = decisions.map(d => `- **${d.what}**: ${d.why}`).join('\n');
        contextMarkdown += '\n\n### Active Decisions\n' + decisionBlock;
      }
      if (openQuestions.length > 0) {
        contextMarkdown += '\n\n### Open Questions\n' + openQuestions.map(q => `- ${q}`).join('\n');
      }
    }

    const elapsedMs = Date.now() - startMs;
    logToFile(HOOK_NAME, 'INFO', `Completed in ${elapsedMs}ms, tokens=${assembled.tokenEstimate}, sources=[${assembled.sources.join(',')}]`);

    // 8.5. Audit log: context assembly
    if (db) {
      try {
        const { logAudit } = await import('../db/audit.js');
        const now = new Date();
        logAudit(db, {
          timestamp: now.toISOString(),
          timestamp_epoch: now.getTime(),
          session_id: sessionId,
          event_type: 'context_assembly',
          actor: 'hook:user-prompt-submit',
          details: {
            sources: assembled.sources,
            tokenEstimate: assembled.tokenEstimate,
            durationMs: elapsedMs,
          },
        });
      } catch (auditErr) {
        logToFile(HOOK_NAME, 'WARN', 'Audit logging failed (non-fatal)', auditErr);
      }
    }

    // 8.7. Write checkpoint if utilization ≥75%
    if (gauge.status === 'ok' && (gauge.threshold === 'checkpoint' || gauge.threshold === 'critical')) {
      try {
        const projectDir = scope.type === 'project' ? scope.path : PATHS.home;
        const latestPath = path.join(projectDir, 'context', 'checkpoints', 'latest.yaml');
        let shouldWrite = true;
        try {
          const stat = fs.statSync(latestPath);
          if (Date.now() - stat.mtimeMs < 60_000) {
            shouldWrite = false;
            logToFile(HOOK_NAME, 'DEBUG', 'Checkpoint debounced — written <60s ago');
          }
        } catch { /* latest.yaml doesn't exist — should write */ }

        if (shouldWrite) {
          const scopeStr = scope.type === 'project' ? `project:${scope.name}` : 'global';
          const result = writeCheckpoint({
            projectDir,
            sessionId,
            scope: scopeStr,
            trigger: 'auto-75pct',
            gaugeReading: gauge,
            gsdState,
            db: db ?? undefined,
          });
          if (result) {
            logToFile(HOOK_NAME, 'INFO', `Checkpoint written: ${result.checkpointId} at ${(gauge.utilization * 100).toFixed(0)}%`);
          }
        }
      } catch (err) {
        logToFile(HOOK_NAME, 'WARN', 'Checkpoint write failed (non-fatal)', err);
      }
    }

    // 9. Return — empty if nothing assembled
    if (!contextMarkdown) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: contextMarkdown,
      },
    };
  } finally {
    // Close the shared DB handle once, regardless of success or failure
    if (db) {
      try {
        db.close();
      } catch {
        // Close failure is non-fatal
      }
    }
  }
});
