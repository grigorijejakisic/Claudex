/**
 * Three-layer assembly orchestrator.
 *
 * Layer 1: Structural — identity, project, checkpoint, session flow
 * Layer 2: Reference — packed artifact summaries (metadata only)
 * Layer 3: Materialization — FTS5-selected full content with provenance
 *
 * Boundary-only injection: full assembly at session-start and post-compaction only.
 * Topic-shift pivot and gauge injection for regular turns.
 * Assembly is primarily read-render. Experience pattern trigger counts and
 * flags are deferred to an applyEffects() callback, committed only when the
 * rendered section survives the budget check (Stop hook feedback loop).
 * All public functions are non-throwing.
 */

import { emitTelemetry, sanitizeErrorForTelemetry } from '../observability/telemetry.js';
import { estimateTokens } from '../shared/text-utils.js';
import {
  formatIdentitySection,
  formatProjectSection,
  formatCheckpointSection,
  formatGsdSection,
  formatGaugeSection,
  formatPressureResponse,
  formatTopicPivotSection,
  formatFlowSection,
  formatLearningsSection,
  formatReferenceLayer,
  formatMaterializationLayer,
  formatRulesReminderSection,
  renderSessionContinuity,
  renderExperienceWarnings as formatExperienceWarningsSection,
} from './sections.js';
import {
  findMatchingPatterns,
  incrementTriggerCount,
  generateTopicKey,
  promoteToGlobalIfCrossProject,
} from '../intelligence/experience-patterns.js';
import { setExperienceFlags } from '../intelligence/experience-flags.js';
import { redactContent } from '../extraction/redaction.js';
import { loadCheckpoint, loadFromFile } from '../checkpoint/loader.js';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import { getTopLearnings, type LearningRow } from '../core/learnings.js';
import { getHotFiles, type PressureRow } from '../core/pressure.js';
import {
  getPackedArtifacts,
  searchArtifactsGlobal,
  getMaterializedArtifacts,
  consumeInjectedArtifacts,
} from '../core/artifacts.js';
import { hybridSearchSync, spreadActivation } from '../core/hybrid-retrieval.js';
import { recordRetrievalEvent } from '../intelligence/retrieval-feedback.js';
import { getRecentFlow } from '../core/journal.js';
import { getCheckpointTracking } from '../core/checkpoint-tracking.js';
import { readGsdState } from '../gsd/state-reader.js';
import { getPressureZone, scaleBudget, GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';
import { getHandoffsDir, getSessionsDir } from '../shared/paths.js';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import type { ArtifactRow } from '../core/artifacts.js';
import type { GaugeTimingContext } from './sections.js';
import type { InjectPayload, TokenUsage } from '../shared/types.js';
import type { ClaudexConfig } from '../shared/config.js';
import type { TopicShiftResult } from '../intelligence/topic-shift.js';

export interface FullAssemblyParams {
  db: Database;
  project: string;
  projectDir: string;
  config: ClaudexConfig;
  searchQuery?: string;
  identityDir?: string;
  sessionId?: string;
  isPostCompaction?: boolean;
  /** Context window size for budget scaling. If omitted, base budget is used. */
  contextWindowTokens?: number;
}

export interface RegularPromptParams {
  isPostCompaction: boolean;
  prompt: string;
  gauge: TokenUsage | null;
  topicShift: TopicShiftResult | null;
  db: Database;
  project: string;
  projectDir: string;
  config: ClaudexConfig;
  identityDir?: string;
  sessionId?: string;
}

export interface TopicPivotParams {
  shift: TopicShiftResult;
  db: Database;
  project: string;
  config: ClaudexConfig;
}

const EMPTY_PAYLOAD: InjectPayload = { content: '', tokenEstimate: 0, sources: [] };

/**
 * Result of matching experience patterns against a query.
 *
 * Contains the rendered warning section, matched pattern metadata, and an
 * `applyEffects` callback that commits DB side effects (trigger count
 * increments, experience flags, cross-project promotion).
 *
 * **Critical contract:** Callers MUST only invoke `applyEffects()` after
 * confirming the section will be included in the assembled output. Calling it
 * unconditionally corrupts the feedback loop — the Stop hook would score
 * patterns as injected when they were actually dropped by the budget check.
 */
interface ExperienceWarningResult {
  section: string;
  injectedIds: string[];
  topicKeys: string[];
  tokenCost: number;
  /** Call ONLY after confirming section will be included in output. */
  applyEffects: () => void;
}

/**
 * Matches experience patterns against `query` and renders a warning section.
 *
 * Pure render phase — no DB writes occur until `applyEffects()` is called.
 * This split ensures that budget-gated callers (assembleFullContext) do not
 * commit side effects for sections that are ultimately dropped, while
 * ungated callers (assembleRegularPrompt) can apply effects immediately.
 *
 * Returns an ExperienceWarningResult on match, or null if no patterns matched
 * or rendering produced no output.
 * Non-throwing — failures are silently swallowed; experience warnings never block assembly.
 */
function renderExperienceWarnings(
  db: Database,
  query: string,
  project: string,
  sessionId?: string,
): ExperienceWarningResult | null {
  try {
    if (!query) return null;
    const patterns = findMatchingPatterns(db, query, project, 3);
    if (patterns.length === 0) return null;
    const section = formatExperienceWarningsSection(patterns);
    if (!section) return null;

    const injectedIds: string[] = [];
    const topicKeys: string[] = [];
    for (const p of patterns) {
      injectedIds.push(p.id);
      topicKeys.push(generateTopicKey(p));
    }

    return {
      section,
      injectedIds,
      topicKeys,
      tokenCost: estimateTokens(section),
      applyEffects: () => {
        for (const p of patterns) {
          incrementTriggerCount(db, p.id);
          // Auto-promote cross-project patterns: if a pattern was stored under a
          // different project but matched here, it proved global relevance.
          if (p.source_project !== project && p.source_project !== GLOBAL_PROJECT_SCOPE) {
            promoteToGlobalIfCrossProject(db, p.id, project);
          }
        }
        if (injectedIds.length > 0 && sessionId) {
          setExperienceFlags(db, sessionId, {
            injected_pattern_ids: injectedIds,
            // Persist topic keys alongside IDs so Stop hook can do per-pattern
            // topic-aware scoring without an extra DB read of each pattern.
            injected_topic_keys: topicKeys,
          });
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Full context assembly with priority-budgeted cascade and three-tier degradation.
 * Fires at session-start and post-compaction only.
 */
export function assembleFullContext(params: FullAssemblyParams): InjectPayload {
  // Tier 1: Full assembly
  try {
    let budget = scaleBudget(params.config.injection.budget_tokens, params.contextWindowTokens);
    const sections: string[] = [];
    const sources: string[] = [];

    // Post-compaction skips identity, project, and session continuity sections —
    // these are already in the LLM's context from the system prompt (CLAUDE.md, /starthere).
    // Saves ~780 tokens per compaction recovery.
    if (!params.isPostCompaction) {
      // Priority 1: Identity
      const identity = formatIdentitySection(params.identityDir);
      if (identity) {
        const cost = estimateTokens(identity);
        if (cost <= budget) {
          sections.push(identity);
          budget -= cost;
          sources.push('identity');
        }
      }

      // Priority 1.5: Experience pattern warnings
      // Lightweight FTS5 query — fires on every full assembly.
      // Side effects (trigger counts, flags) are deferred to applyEffects()
      // and committed ONLY after the budget check passes.
      const expWarnings = renderExperienceWarnings(
        params.db, params.searchQuery ?? '', params.project, params.sessionId,
      );
      if (expWarnings && expWarnings.tokenCost <= budget) {
        sections.push(expWarnings.section);
        budget -= expWarnings.tokenCost;
        sources.push('experience_warnings');
        expWarnings.applyEffects(); // Side effects ONLY after budget check passes
      }

      // Priority 2: Project context
      const project = formatProjectSection(params.projectDir);
      if (project) {
        const cost = estimateTokens(project);
        if (cost <= budget) {
          sections.push(project);
          budget -= cost;
          sources.push('project');
        }
      }

      // Priority 2.5: Session continuity (handoff + latest session log, compressed)
      let handoffPath: string | undefined;
      let sessionsDir: string | undefined;
      try {
        handoffPath = path.join(getHandoffsDir(params.projectDir), 'ACTIVE.md');
        sessionsDir = getSessionsDir(params.projectDir);
      } catch { /* non-fatal */ }
      const continuity = renderSessionContinuity(handoffPath, sessionsDir);
      if (continuity) {
        const cost = estimateTokens(continuity);
        if (cost <= budget) {
          sections.push(continuity);
          budget -= cost;
          sources.push('session_continuity');
        }
      }
    }

    // Priority 3: Checkpoint — skipLearnings because Priority 4 injects them separately
    const checkpoint = loadCheckpoint(params.db, params.projectDir, undefined, params.project);
    const checkpointSection = formatCheckpointSection(checkpoint, { skipLearnings: true });
    if (checkpointSection) {
      const cost = estimateTokens(checkpointSection);
      if (cost <= budget) {
        sections.push(checkpointSection);
        budget -= cost;
        sources.push('checkpoint');
      }
    }

    // Priority 4: Cross-session learnings
    try {
      const learnings = getTopLearnings(params.db, params.project, 5);
      if (learnings.length > 0) {
        const learningsSection = formatLearningsSection(learnings);
        if (learningsSection) {
          const cost = estimateTokens(learningsSection);
          if (cost <= budget) {
            sections.push(learningsSection);
            budget -= cost;
            sources.push('learnings');
          }
        }
      }
    } catch { /* non-fatal */ }

    // Priority 4.5: CLAUDE.md rules reminder — re-injected after compaction to prevent drift.
    // Only included in post-compaction assembly (identity/project already in context from CLAUDE.md).
    if (params.isPostCompaction) {
      try {
        const rulesSection = formatRulesReminderSection(params.projectDir);
        if (rulesSection) {
          const cost = estimateTokens(rulesSection);
          if (cost <= budget) {
            sections.push(rulesSection);
            budget -= cost;
            sources.push('rules_reminder');
          }
        }
      } catch { /* non-fatal */ }
    }

    // === LAYER 1 CONTINUED: Session Flow (from journal) ===
    try {
      const flowEntries = getRecentFlow(params.db, params.project, 10);
      if (flowEntries.length > 0) {
        const flowSection = formatFlowSection(flowEntries);
        if (flowSection) {
          const cost = estimateTokens(flowSection);
          if (cost <= budget) {
            sections.push(flowSection);
            budget -= cost;
            sources.push('flow');
          }
        }
      }
    } catch { /* non-fatal */ }

    // === LAYER 2: Reference (packed artifact summaries) ===
    try {
      const packedArtifacts = getPackedArtifacts(params.db, params.project, 20);
      const refSection = formatReferenceLayer(packedArtifacts);
      if (refSection) {
        const cost = estimateTokens(refSection);
        if (cost <= budget) {
          sections.push(refSection);
          budget -= cost;
          sources.push('reference_layer');
        }
      }
    } catch { /* non-fatal */ }

    // === LAYER 3: Materialization (query-driven full content) ===
    // Uses hybrid search (FTS5 + recency + three-factor scoring) for better
    // retrieval quality. Falls back to FTS5-only via hybridSearchSync.
    try {
      const query = params.searchQuery ?? checkpoint?.thread?.topic ?? null;
      let materializedArtifacts: ArtifactRow[] = [];

      if (query) {
        const searchResults = hybridSearchSync(params.db, query, params.project, {
          limit: 10,
          globalScope: true,
          excludeSuperseded: true,
        });
        if (searchResults.length > 0) {
          materializedArtifacts = searchResults;
        } else {
          // Fallback to legacy FTS5-only search if hybrid returns nothing
          const legacyResults = searchArtifactsGlobal(params.db, params.project, query, 10);
          if (legacyResults.length > 0) {
            materializedArtifacts = legacyResults;
          }
        }
      }

      const alreadyMaterialized = getMaterializedArtifacts(params.db, params.project, true);
      const seen = new Set(materializedArtifacts.map(a => a.id));
      for (const a of alreadyMaterialized) {
        if (!seen.has(a.id)) { materializedArtifacts.push(a); seen.add(a.id); }
      }

      // Dedup: exclude learning-type artifacts from materialization when
      // learnings were already injected in Priority 4 (prevents cross-contamination)
      if (sources.includes('learnings')) {
        materializedArtifacts = materializedArtifacts.filter(a => a.artifact_type !== 'learning');
      }

      // Dedup: exclude session_log and handoff artifacts when session continuity
      // already injected — the compressed handoff extract covers what matters.
      if (sources.includes('session_continuity')) {
        materializedArtifacts = materializedArtifacts.filter(a =>
          a.artifact_type !== 'session_log' && a.artifact_type !== 'handoff'
        );
      }

      // Staleness filter: observation-type artifacts older than 48h have very low
      // value for a new session. Decisions, learnings, patterns etc. persist longer.
      const STALE_OBS_CUTOFF = Math.floor(Date.now() / 1000) - 48 * 3600;
      materializedArtifacts = materializedArtifacts.filter(a =>
        a.artifact_type !== 'observation' || a.timestamp_epoch >= STALE_OBS_CUTOFF
      );

      const rationale = query ? `hybrid search on "${query}"` : undefined;
      const matSection = formatMaterializationLayer(materializedArtifacts, rationale, params.sessionId);
      if (matSection) {
        const cost = estimateTokens(matSection);
        if (cost <= budget) {
          sections.push(matSection);
          budget -= cost;
          sources.push('materialized');

          // 5.1: Record retrieval events for all materialized artifacts
          // 5.3: Spread activation to linked artifacts
          if (params.sessionId) {
            for (const art of materializedArtifacts) {
              recordRetrievalEvent(params.db, art.id, params.sessionId, query ?? undefined);
              spreadActivation(params.db, art.id);
            }
          }

          // Consume injected artifacts — pack them so the next turn's
          // assembleRegularPrompt() doesn't re-inject via getMaterializedArtifacts().
          // PostToolUse can re-materialize specific artifacts mid-session if needed.
          consumeInjectedArtifacts(params.db, materializedArtifacts.map(a => a.id));
        }
      }
    } catch { /* non-fatal */ }

    // === GSD (not redundant with artifacts) ===
    try {
      const gsd = readGsdState(params.projectDir);
      const gsdSection = formatGsdSection(gsd);
      if (gsdSection) {
        const cost = estimateTokens(gsdSection);
        if (cost <= budget) {
          sections.push(gsdSection);
          budget -= cost;
          sources.push('gsd');
        }
      }
    } catch { /* non-fatal */ }

    // Assemble content
    let content = sections.join('\n\n');
    content = redactContent(content);

    return {
      content,
      tokenEstimate: estimateTokens(content),
      sources,
    };
  } catch (e) {
    // Tier 1 failed — fall through to Tier 2
    if (params.db && params.sessionId) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'assembly/tier1_failed', error: sanitizeErrorForTelemetry(e), fallback: 'tier2' }); } catch {}
    }
  }

  // Tier 2: Checkpoint-only
  try {
    const checkpoint = loadFromFile(params.projectDir);
    if (checkpoint) {
      const checkpointMd = renderCheckpointMarkdown(checkpoint, 'RESUME');
      const identity = formatIdentitySection(params.identityDir);
      const parts = [identity, checkpointMd ? `## Checkpoint\n${checkpointMd}` : null].filter(Boolean) as string[];
      let content = parts.join('\n\n');
      content = redactContent(content);
      const tierSources: string[] = [];
      if (identity) tierSources.push('identity');
      if (checkpointMd) tierSources.push('checkpoint');
      return { content, tokenEstimate: estimateTokens(content), sources: tierSources };
    }
  } catch (e) {
    // Tier 2 failed — fall through to Tier 3
    if (params.db && params.sessionId) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'assembly/tier2_failed', error: sanitizeErrorForTelemetry(e), fallback: 'tier3' }); } catch {}
    }
  }

  // Tier 3: Identity-only
  try {
    const identity = formatIdentitySection(params.identityDir);
    if (identity) {
      let content = redactContent(identity);
      return { content, tokenEstimate: estimateTokens(content), sources: ['identity'] };
    }
  } catch (e) {
    // Tier 3 failed — all tiers exhausted
    if (params.db && params.sessionId) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'assembly/tier3_failed', error: sanitizeErrorForTelemetry(e), fallback: 'empty' }); } catch {}
    }
  }

  // Final fallback: empty
  return { ...EMPTY_PAYLOAD };
}

/**
 * Queries DB for session start time and last compaction time.
 * Non-throwing — returns empty context on error.
 */
function buildGaugeTiming(db: Database, sessionId?: string): GaugeTimingContext {
  const timing: GaugeTimingContext = {};
  if (!sessionId) return timing;
  try {
    const sessionRow = db.prepare(
      'SELECT created_at_epoch FROM sessions WHERE session_id = ?'
    ).get(sessionId) as { created_at_epoch: number } | undefined;
    if (sessionRow?.created_at_epoch) {
      timing.sessionStartEpoch = sessionRow.created_at_epoch;
    }
    const tracking = getCheckpointTracking(db, sessionId);
    if (tracking?.last_checkpoint_epoch) {
      timing.lastCompactionEpoch = tracking.last_checkpoint_epoch;
    }
  } catch { /* non-fatal */ }
  return timing;
}

/**
 * Regular prompt assembly: post-compaction -> topic-shift -> gauge -> zero.
 * Most turns produce zero injection.
 */
export function assembleRegularPrompt(params: RegularPromptParams): InjectPayload {
  try {
    // 1. Post-compaction -> full assembly (sans identity/project — already in system prompt)
    if (params.isPostCompaction) {
      return assembleFullContext({
        db: params.db,
        project: params.project,
        projectDir: params.projectDir,
        config: params.config,
        searchQuery: params.prompt,
        identityDir: params.identityDir,
        sessionId: params.sessionId,
        isPostCompaction: true,
        contextWindowTokens: params.gauge?.contextWindowTokens,
      });
    }

    // 2. Topic-shift -> micro-injection
    if (params.topicShift?.shifted) {
      const pivot = assembleTopicPivot({
        shift: params.topicShift,
        db: params.db,
        project: params.project,
        config: params.config,
      });
      if (pivot.tokenEstimate > 0 && pivot.tokenEstimate <= params.config.injection.topic_shift_budget) {
        return pivot;
      }
    }

    // 3. Gauge + graduated pressure response at advisory+ zone (Upgrade 7)
    const zone = params.gauge ? getPressureZone(params.gauge.utilization) : 'normal';
    if (zone !== 'normal') {
      const timing = buildGaugeTiming(params.db, params.sessionId);
      const gaugeSection = formatGaugeSection(params.gauge, undefined, timing);
      const pressureSection = formatPressureResponse(params.gauge, zone);
      const parts = [gaugeSection, pressureSection].filter(Boolean) as string[];
      if (parts.length > 0) {
        const content = parts.join('\n');
        return {
          content,
          tokenEstimate: estimateTokens(content),
          sources: ['gauge', 'pressure_response'],
        };
      }
    }

    // 4. Experience pattern warnings — lightweight FTS5 match on every prompt.
    // Only fires when prompt text matches a stored pattern (score >= 2).
    // Skips prompts shorter than 20 chars (too short for meaningful FTS match).
    // Non-blocking — failures return empty.
    // The assembler is the single owner of pattern injection — the hook only
    // detects corrections to avoid double injection and inflated trigger counts.
    if (params.prompt && params.prompt.length >= 20) {
      const expWarnings = renderExperienceWarnings(
        params.db, params.prompt, params.project, params.sessionId,
      );
      if (expWarnings) {
        // Defer effects to caller — the caller's budget check may drop this payload
        // (e.g. if extraContent exceeds budget). Effects committed only after injection.
        return {
          content: expWarnings.section,
          tokenEstimate: expWarnings.tokenCost,
          sources: ['experience_warnings'],
          commitEffects: expWarnings.applyEffects,
        };
      }
    }

    // 5. Trigger-materialized artifacts — surfaced by PostToolUse trigger engine
    // These were materialized mid-turn (not at session-start/compaction) and
    // need to be injected on the next prompt. Includes rules, feedback memories,
    // and domain-relevant knowledge triggered by file paths.
    try {
      const materialized = getMaterializedArtifacts(params.db, params.project);
      if (materialized.length > 0) {
        const section = formatMaterializationLayer(materialized, 'trigger-matched', params.sessionId);
        if (section) {
          const tokens = estimateTokens(section);
          if (tokens <= params.config.injection.budget_tokens) {
            // 5.1: Record retrieval events + 5.3: spread activation
            if (params.sessionId) {
              for (const art of materialized) {
                recordRetrievalEvent(params.db, art.id, params.sessionId, params.prompt);
                spreadActivation(params.db, art.id);
              }
            }
            return {
              content: section,
              tokenEstimate: tokens,
              sources: ['trigger_materialized'],
            };
          }
        }
      }
    } catch { /* non-throwing */ }

    // 6. Zero injection (most turns)
    return { ...EMPTY_PAYLOAD };
  } catch {
    return { ...EMPTY_PAYLOAD };
  }
}

/**
 * Topic pivot injection: transition marker + relevant learnings/files/decisions.
 * Capped at config.injection.topic_shift_budget (default 800) tokens.
 */
export function assembleTopicPivot(params: TopicPivotParams): InjectPayload {
  try {
    const { shift, config } = params;
    const budget = config.injection.topic_shift_budget;

    // Fetch relevant data for new topic
    let relevantLearnings: LearningRow[] = [];
    let relevantHotFiles: PressureRow[] = [];

    if (shift.newTopic) {
      try {
        const allLearnings = getTopLearnings(params.db, params.project, 10);
        const keyword = shift.newTopic.toLowerCase().split(' ')[0];
        relevantLearnings = allLearnings
          .filter(l => l.content.toLowerCase().includes(keyword))
          .slice(0, 3);
      } catch { /* non-fatal */ }

      try {
        relevantHotFiles = getHotFiles(params.db, params.project, 5);
      } catch { /* non-fatal */ }
    }

    const pivotSection = formatTopicPivotSection({
      shift,
      learnings: relevantLearnings,
      hotFiles: relevantHotFiles,
    });

    if (!pivotSection) {
      return { ...EMPTY_PAYLOAD };
    }

    // Apply redaction
    let content = redactContent(pivotSection);
    const tokenEst = estimateTokens(content);

    // Enforce budget cap
    if (tokenEst > budget) {
      const lines = content.split('\n');
      const truncated = lines.slice(0, 3).join('\n');
      return {
        content: truncated,
        tokenEstimate: estimateTokens(truncated),
        sources: ['topic_pivot'],
      };
    }

    return {
      content,
      tokenEstimate: tokenEst,
      sources: ['topic_pivot'],
    };
  } catch {
    return { ...EMPTY_PAYLOAD };
  }
}
