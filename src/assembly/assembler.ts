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
  formatClaudexReadySection,
  formatRerankerHealthSection,
  formatSubstrateHealthSection,
  formatFrameExtractionDegradedSection,
  formatRecentSessionFramesSection,
  formatProvenPrinciplesSection,
  formatProjectSection,
  formatCheckpointSection,
  formatGsdSection,
  formatGaugeSection,
  formatPressureResponse,
  formatTopicPivotSection,
  formatLearningsSection,
  formatMaterializationLayer,
  formatRulesReminderSection,
  renderSessionContinuity,
  renderExperienceWarnings as formatExperienceWarningsSection,
} from './sections.js';
import { getLatestHighlights } from '../intelligence/session-highlights.js';
import {
  findMatchingPatterns,
  getProvenPrinciples,
  matchIntentTriggeredPatterns,
  incrementTriggerCount,
  generateTopicKey,
  promoteToGlobalIfCrossProject,
} from '../intelligence/experience-patterns.js';
import { setExperienceFlags, getExperienceFlags } from '../intelligence/experience-flags.js';
import { redactContent } from '../extraction/redaction.js';
import { loadCheckpoint, loadFromFile } from '../checkpoint/loader.js';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import { getTopLearnings, type LearningRow } from '../core/learnings.js';
import { getHotFiles, type PressureRow } from '../core/pressure.js';
import {
  getMaterializedArtifacts,
} from '../core/artifacts.js';
import { spreadActivation } from '../core/hybrid-retrieval.js';
import type { ExperiencePattern } from '../intelligence/experience-patterns.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { recordRetrievalEvent } from '../intelligence/retrieval-feedback.js';
import { findRelevantFiles } from '../indexer/codebase-indexer.js';
import { getCheckpointTracking } from '../core/checkpoint-tracking.js';
import { readGsdState } from '../gsd/state-reader.js';
import { assembleCriticalReminders } from '../intelligence/critical-reminders.js';
import { assembleExperienceTier, TIER_BUDGET as EXPERIENCE_TIER_BUDGET } from '../intelligence/experience-tier.js';
import type { HandleSet } from '../core/cross-project-equivalence.js';
import { getPressureZone, scaleBudget, GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';
import { getHandoffsDir, getSessionsDir } from '../shared/paths.js';
import * as path from 'path';
import * as fs from 'fs';
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
  /** Pinnable wall-clock for cache-stability tests (CACH-03). If omitted,
   * defaults to Math.floor(Date.now() / 1000) at each clock-leak site. */
  nowEpoch?: number;
  /**
   * v6 Phase 10 — opt-in deliberation surfacing (default false). When true,
   * the assembler fans out from `deliberationArtifacts` to their originating
   * transcript spans via Plan 10-01's routing surface and renders the
   * surfaced spans at the L2.5 cascade position per
   * `.claude/rules/assembly-budget.md`. Sites that don't opt in see no
   * behavior change. Per CONTEXT decision 3 — opt-in protects assembly
   * budget when callers haven't reasoned about transcript-span surfacing.
   */
  deliberationSurfacing?: boolean;
  /**
   * v6 Phase 10 — artifact references the deliberation surface fans out
   * from. Caller pre-fetches these (typically the artifacts already chosen
   * by the L2 reference layer); routing joins each on session_id +/- 2h.
   * Required when `deliberationSurfacing=true`; ignored otherwise.
   */
  deliberationArtifacts?: Array<{
    session_id: string;
    created_at_epoch_ms: number;
    query_text?: string;
  }>;
  /**
   * v6 Phase 10 — optional artifact-context labels keyed by transcript
   * chunk_id. Rendered into the citation as ", where {label}" per
   * CONTEXT § specifics format example.
   */
  deliberationLabels?: Record<number, string>;
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
  /** Pre-computed hybrid pattern matches (FTS5 + vector). Avoids re-querying in sync assembler. */
  hybridPatterns?: ExperiencePattern[];
  /** Classified intent for intent-triggered pattern matching (categorical tier). */
  classifiedIntent?: string;
}

export interface TopicPivotParams {
  shift: TopicShiftResult;
  db: Database;
  project: string;
  config: ClaudexConfig;
}

const EMPTY_PAYLOAD: InjectPayload = { content: '', tokenEstimate: 0, sources: [] };

/**
 * Phase 13.1 Fix #6 (2026-05-15): single source of truth for "when did the
 * current handoff begin?" Reads `created_at_epoch_ms` from the ACTIVE.md
 * frontmatter and returns both ms and seconds variants. The handoff frontmatter
 * is hand-written by the operator at each significant pivot; anything (frames,
 * checkpoints) older than that timestamp describes pre-pivot work that should
 * not crowd post-pivot session-start.
 *
 * Non-throwing: returns `{}` when ACTIVE.md is missing, frontmatter absent,
 * or `created_at_epoch_ms` not parseable. The two callers (highlights / checkpoint)
 * fall back to their default unfiltered queries when the floor is undefined.
 */
function readActiveHandoffFloor(projectDir: string): { floorMs?: number; floorSec?: number } {
  try {
    const handoffPath = path.join(getHandoffsDir(projectDir), 'ACTIVE.md');
    if (!fs.existsSync(handoffPath)) return {};
    const raw = fs.readFileSync(handoffPath, 'utf-8');
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    const epochMatch = fmMatch[1].match(/^created_at_epoch_ms:\s*(\d+)\s*$/m);
    if (!epochMatch) return {};
    const ms = Number(epochMatch[1]);
    if (!Number.isFinite(ms) || ms <= 0) return {};
    return { floorMs: ms, floorSec: Math.floor(ms / 1000) };
  } catch {
    return {};
  }
}

/**
 * Cache-stable version of `shortenPath` (CACH-03).
 *
 * Normalizes backslashes to forward slashes BEFORE searching. Without this,
 * Windows-host output emits `src\foo.ts` while POSIX emits `src/foo.ts` —
 * cache prefix hash flips per-host. Hardcoded `'src/'` (no `path.sep`).
 *
 * @internal exported only so cache-stability tests can pin behavior.
 */
export function _shortenPathCacheStable(fp: string): string {
  const norm = fp.replace(/\\/g, '/');
  const srcIdx = norm.indexOf('src/');
  return srcIdx >= 0 ? norm.substring(srcIdx) : norm.split('/').slice(-2).join('/');
}

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
  precomputedPatterns?: ExperiencePattern[],
): ExperienceWarningResult | null {
  try {
    if (!query) return null;
    // Use pre-computed hybrid results (FTS5 + vector) when available,
    // falling back to sync FTS5-only search.
    let patterns = precomputedPatterns && precomputedPatterns.length > 0
      ? precomputedPatterns
      : findMatchingPatterns(db, query, project, 3);
    if (patterns.length === 0) return null;

    // Per-session suppression: don't re-inject patterns already shown this session.
    // This prevents the same warning from appearing on every prompt.
    if (sessionId) {
      try {
        const flags = getExperienceFlags(db, sessionId);
        const seen = new Set(flags.session_injected_ids);
        if (seen.size > 0) {
          patterns = patterns.filter(p => !seen.has(p.id));
          if (patterns.length === 0) return null;
        }
      } catch { /* non-fatal — skip suppression */ }
    }

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
          if (p.source_project !== project && p.source_project !== GLOBAL_PROJECT_SCOPE) {
            promoteToGlobalIfCrossProject(db, p.id, project);
          }
          // Reconsolidation: refresh confidence + re-embed on retrieval.
          // Science says retrieval is a write operation — each surface strengthens the memory.
          // reads pre-Phase-4 experience_patterns table — write surface deleted, no
          // new INSERTs (V28 trigger blocks them). Rows persist for as long as their
          // content is useful. See .planning/reframes/2026-05-05-multi-handle-kill.md.
          try {
            const fresh = cachedPrepare(db,
              `SELECT helpful_count, harmful_count, lesson FROM experience_patterns WHERE id = ?`
            ).get(p.id) as { helpful_count: number; harmful_count: number; lesson: string } | undefined;
            if (fresh) {
              const conf = (fresh.helpful_count + 1) / (fresh.helpful_count + fresh.harmful_count + 2);
              cachedPrepare(db,
                `UPDATE experience_patterns SET confidence = ? WHERE id = ?`
              ).run(conf, p.id);

              // Re-embed if lesson was updated (e.g., by LLM consolidation).
              // Deferred to Angel via needs_reembed flag — hooks are ephemeral,
              // fire-and-forget async dies when the process exits.
              if (fresh.lesson !== p.lesson) {
                try {
                  cachedPrepare(db,
                    `UPDATE experience_patterns SET needs_reembed = 1 WHERE id = ?`
                  ).run(p.id);
                } catch { /* non-fatal — column may not exist yet */ }
              }
            }
          } catch { /* non-fatal */ }
        }
        if (injectedIds.length > 0 && sessionId) {
          // Accumulate into session_injected_ids (never cleared during session)
          const currentFlags = getExperienceFlags(db, sessionId);
          const accumulated = [...new Set([...currentFlags.session_injected_ids, ...injectedIds])];
          setExperienceFlags(db, sessionId, {
            injected_pattern_ids: injectedIds,
            injected_topic_keys: topicKeys,
            session_injected_ids: accumulated,
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

    // Phase 13.1 Fix #6 (2026-05-15): single-read ACTIVE.md freshness floor.
    // Threaded into Recent Session Frames (ms) and the Checkpoint section
    // (seconds) so neither can surface pre-handoff state into post-handoff
    // sessions. Reading once here (instead of per-section) keeps both
    // surfaces consistent on the same `created_at_epoch_ms` marker even if
    // the operator rewrites ACTIVE.md mid-cascade somehow.
    const { floorMs: activeFloorEpochMs, floorSec: activeFloorEpochSec } =
      readActiveHandoffFloor(params.projectDir);

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

      // Priority 1.1: Claudex navigation reinforcement — reminds agent about MCP tools.
      // Tiny (~40 tokens). Full reference is in global CLAUDE.md.
      // Only inject if identity loaded (skip in total degradation).
      if (identity) {
        const claudexReady = formatClaudexReadySection();
        const claudexCost = estimateTokens(claudexReady);
        if (claudexCost <= budget) {
          sections.push(claudexReady);
          budget -= claudexCost;
          sources.push('claudex_ready');
        }
      }

      // Priority 1.2: Reranker health (Phase 6 P5 — RETR-08).
      // Returns null on the happy path (no fallback events in 24h), so this
      // section is a no-op for cache stability when the cross-encoder is
      // healthy. When it does fire, the line is descriptive (not imperative)
      // and bypasses the budget cap — degraded-mode visibility is mandatory.
      const rerankerHealth = formatRerankerHealthSection(params.db);
      if (rerankerHealth) {
        sections.push(rerankerHealth);
        sources.push('reranker_health');
      }

      // Priority 1.3: Substrate health (Phase 13.1 Fix #5 — 2026-05-15).
      // Probes Angel heartbeat freshness + session_highlights extraction
      // lag. Returns null when both are within threshold (happy path adds
      // zero tokens). When degraded, bypasses the budget cap because the
      // surface is the only way to know that downstream injections are
      // stale. Mirrors reranker-health framing: descriptive note, not
      // imperative directive.
      try {
        const substrateHealth = formatSubstrateHealthSection(params.db, params.project);
        if (substrateHealth) {
          sections.push(substrateHealth);
          sources.push('substrate_health');
        }
      } catch { /* non-fatal — health surface never blocks assembly */ }

      // Priority 1.5: Experience pattern warnings auto-surface — REMOVED in
      // Phase 5 Plan 05 (Tier C). renderExperienceWarnings + applyEffects
      // remain callable; Plan 08 wires them to UPS explicit-query and
      // PreToolUse path/command triggers (INJ-07 reactive surface).

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

      // Priority 2.5: Session continuity — enumerates all ACTIVE*.md files in the
      // handoffs directory. Passes the directory; renderSessionContinuity handles
      // file enumeration and multi-agent rendering (Plan 14-08).
      let handoffsDir: string | undefined;
      let sessionsDir: string | undefined;
      try {
        handoffsDir = getHandoffsDir(params.projectDir);
        sessionsDir = getSessionsDir(params.projectDir);
      } catch { /* non-fatal */ }
      const continuity = renderSessionContinuity(handoffsDir, sessionsDir);
      if (continuity) {
        const cost = estimateTokens(continuity);
        if (cost <= budget) {
          sections.push(continuity);
          budget -= cost;
          sources.push('session_continuity');
        }
      }

      // Priority 2.6 (Phase 13 Plan 04): Recent Session Frames + Frame Extraction
      // Degraded health line. Highlights are budget-capped at 25% of injection
      // budget (per 13-CONTEXT.md). Degraded health line bypasses the budget cap
      // — degraded-mode visibility is mandatory, same posture as reranker health.
      try {
        const latestHighlights = getLatestHighlights(
          params.db,
          params.project,
          3,
          activeFloorEpochMs,
        );
        const degraded = formatFrameExtractionDegradedSection(latestHighlights);
        if (degraded) {
          sections.push(degraded);
          sources.push('frame_extraction_degraded');
        }
        const framesBudget = Math.max(
          0,
          Math.floor(params.config.injection.budget_tokens * 0.25),
        );
        const framesSection = formatRecentSessionFramesSection(latestHighlights, framesBudget);
        if (framesSection) {
          const cost = estimateTokens(framesSection);
          if (cost <= budget) {
            sections.push(framesSection);
            budget -= cost;
            sources.push('session_highlights');
          }
        }
      } catch { /* non-fatal — section is advisory, never blocks assembly */ }
    }

    // Priority 3: Checkpoint — skipLearnings because Priority 4 injects them separately.
    // Phase 13.1 Fix #6 (2026-05-15): apply the ACTIVE.md freshness floor
    // (`activeFloorEpochSec`, read once at the top of this assembler call)
    // so a stale prior-phase checkpoint can't surface a pre-pivot "Current
    // Objective" into a post-pivot session. Post-compaction path keeps the
    // floor too — the operator's last handoff is still the boundary, and
    // a checkpoint older than that handoff is stale in either path.
    const checkpoint = loadCheckpoint(params.db, params.projectDir, undefined, params.project, activeFloorEpochSec);
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

    // === CODEBASE CONTEXT relocated to UPS in Phase 5 / Plan 06 ===
    // The session-start codebase_index block was deleted: codebase relevance is
    // task-shaped, not session-start static. assembleRegularPrompt below carries
    // the per-turn query-gated equivalent under the UPS ≤1KB budget.

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
function getTurnCount(db: Database, sessionId: string): number {
  try {
    const row = cachedPrepare(db,
      'SELECT COUNT(*) as cnt FROM conversation_turns WHERE session_id = ?'
    ).get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch { return 0; }
}

/**
 * Phase 6.5 — synthesize an incoming HandleSet from the assembler params for
 * Experience Tier scoring. Pulls framing tokens from the recent prompt (when
 * present) and conservative defaults elsewhere. Empty handle sets are valid
 * — Stage 1 will return 0 shared and the tier will gracefully no-op.
 */
function synthesizeIncomingHandles(params: { prompt?: string }): HandleSet {
  const text = params.prompt ?? '';
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1);
  return {
    tools_used: [],
    files_touched: [],
    user_framing_tokens: tokens,
    errors_encountered: [],
  };
}

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
    // 1. Post-compaction -> light injection only.
    // CC fires processSessionStartHooks('compact') after compaction, which
    // triggers assembleFullContext via SessionStart hook. UPS post-compact
    // only needs truly new per-turn content (Critical Reminders with decay TTL).
    if (params.isPostCompaction) {
      const parts: string[] = [];
      const srcs: string[] = [];
      let commitFn: (() => void) | undefined;

      // Critical reminders still fire (decay-based TTL is per-turn)
      if (params.sessionId) {
        try {
          const crFlags = getExperienceFlags(params.db, params.sessionId);
          const turnCount = getTurnCount(params.db, params.sessionId);
          const reminders = assembleCriticalReminders(
            params.db, params.sessionId, turnCount, params.project,
            crFlags.critical_activity_gate, crFlags.seen_rule_domains,
            params.gauge?.contextWindowTokens,
          );
          if (reminders && reminders.tokenCost <= scaleBudget(300, params.gauge?.contextWindowTokens)) {
            parts.push(reminders.section);
            srcs.push('critical_reminders');
            commitFn = reminders.applyEffects;
          }
        } catch { /* non-fatal */ }
      }

      if (parts.length > 0) {
        return {
          content: parts.join('\n\n'),
          tokenEstimate: estimateTokens(parts.join('\n\n')),
          sources: srcs,
          commitEffects: commitFn,
        };
      }
      return { ...EMPTY_PAYLOAD };
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
    // Cooldown: inject every 5 turns in advisory zone to avoid repeating identical
    // gauge lines (~40-80 tokens/turn). Always inject on zone escalation or critical+.
    const zone = params.gauge ? getPressureZone(params.gauge.utilization) : 'normal';
    if (zone !== 'normal') {
      const gaugeTurnCount = params.sessionId ? getTurnCount(params.db, params.sessionId) : 0;
      const isEscalation = zone === 'critical' || zone === 'warning';
      const cooldownPassed = gaugeTurnCount % 5 === 0;
      if (isEscalation || cooldownPassed) {
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
    }

    // 4. Experience pattern warnings — lightweight FTS5 match on every prompt.
    // Only fires when prompt text matches a stored pattern (score >= 2).
    // Skips prompts shorter than 20 chars (too short for meaningful FTS match).
    // Non-blocking — failures return empty.
    // The assembler is the single owner of pattern injection — the hook only
    // detects corrections to avoid double injection and inflated trigger counts.
    {
      const parts: string[] = [];
      const srcs: string[] = [];
      let totalTokens = 0;
      let commitFn: (() => void) | undefined;

      // 4a. Proven principles — periodic reinforcement (every 5 turns).
      // Already injected at session-start and post-compaction. Re-injecting every turn
      // wastes ~150-250 tokens/turn with identical content. Cooldown-based: inject every
      // 5 turns to maintain anti-drift value while saving ~80% of token cost.
      // Hard cap: 500 tokens (~5 patterns × ~40 tokens each).
      // Gate: skip turns 0-1 — session-start already injected these seconds ago, so
      // re-firing on the first UPS is pure duplication. Resume at the next 5-turn mark.
      try {
        const turnCount = params.sessionId ? getTurnCount(params.db, params.sessionId) : 0;
        if (turnCount > 1 && turnCount % 5 === 0) { // Fire on turns 5, 10, 15, ...
          const principles = getProvenPrinciples(params.db, params.project, 5);
          if (principles.length > 0) {
            const section = formatProvenPrinciplesSection(principles);
            if (section) {
              const cost = estimateTokens(section);
              if (cost <= 500) {
                parts.push(section);
                totalTokens += cost;
                srcs.push('proven_principles');
              }
            }
          }
        }
      } catch { /* non-fatal */ }

      // 4a.5: Critical Reminders — conditional re-injection of CLAUDE.md behavioral rules.
      // Fires on decay TTL expiry, activity gate (phase transitions), or first-encounter domains.
      // Separate from proven principles (experience patterns) — these are CLAUDE.md rules.
      if (params.sessionId) {
        try {
          const crFlags = getExperienceFlags(params.db, params.sessionId);
          const turnCount = getTurnCount(params.db, params.sessionId);
          const reminders = assembleCriticalReminders(
            params.db,
            params.sessionId,
            turnCount,
            params.project,
            crFlags.critical_activity_gate,
            crFlags.seen_rule_domains,
            params.gauge?.contextWindowTokens,
          );
          if (reminders && reminders.tokenCost <= scaleBudget(300, params.gauge?.contextWindowTokens)) {
            parts.push(reminders.section);
            totalTokens += reminders.tokenCost;
            srcs.push('critical_reminders');
            const prevCommit = commitFn;
            commitFn = () => {
              prevCommit?.();
              reminders.applyEffects();
            };
          }
        } catch { /* non-fatal */ }
      }

      // 4a.6: Experience Tier (Phase 6.5 — Architecture B partner of Critical
      // Reminders). Surfaces top-K cross-project lessons in advisory voice.
      // Reads artifact_task_pattern (V21 sidecar) and JOINs to artifacts;
      // scoring is deterministic for cache stability (CACH-02). Budget: 200
      // tokens (≤ CR's 300 so behavioral rules win on collisions).
      if (params.sessionId) {
        try {
          const turnCount = getTurnCount(params.db, params.sessionId);
          const incomingHandles: HandleSet = synthesizeIncomingHandles(params);
          const experience = assembleExperienceTier(
            params.db,
            params.sessionId,
            turnCount,
            params.project,
            incomingHandles,
            params.gauge?.contextWindowTokens,
          );
          if (experience && experience.tokenCost <= scaleBudget(EXPERIENCE_TIER_BUDGET, params.gauge?.contextWindowTokens)) {
            parts.push(experience.section);
            totalTokens += experience.tokenCost;
            srcs.push('experience_tier');
            const prevCommit2 = commitFn;
            commitFn = () => {
              prevCommit2?.();
              experience.applyEffects();
            };
          }
        } catch { /* non-fatal — Experience Tier never breaks session-start */ }
      }

      // 4a.7: Codebase Index (Phase 5 Plan 06 — relocated from session-start).
      // Per-turn, query-gated. Fires only when params.prompt is non-empty AND
      // `findRelevantFiles` returns matches AND result fits in remaining UPS budget.
      // Hard cap: 200 cl100k_base tokens (UPS budget is 1KB ≈ 256 tokens total).
      // The session-spanning "Changed since last session" sub-block does NOT migrate —
      // per-turn relevance is task-shaped, not session-spanning.
      if (params.prompt && params.prompt.trim().length > 0) {
        try {
          const relevant = findRelevantFiles(params.db, params.project, params.prompt, 3);
          if (relevant.length > 0) {
            const codeParts: string[] = ['**Relevant files:**'];
            for (const f of relevant) {
              const relPath = _shortenPathCacheStable(f.file_path);
              const topSymbols = f.symbols
                .filter(s => s.exported)
                .slice(0, 5)
                .map(s => `${s.kind} ${s.name}`)
                .join(', ');
              codeParts.push(`- \`${relPath}\`: ${topSymbols || '(no exports)'}`);
            }
            const codeSection = `## Codebase Context\n${codeParts.join('\n')}`;
            const cost = estimateTokens(codeSection);
            // Hard cap: 200 tokens for UPS codebase index.
            if (cost <= 200) {
              parts.push(codeSection);
              totalTokens += cost;
              srcs.push('codebase_index');
            }
          }
        } catch { /* non-fatal */ }
      }

      // 4b. Categorical: intent-triggered patterns.
      // Matches patterns tagged with trigger_intents against the classified intent.
      // This is the "innate immune" channel — structural matching, not keyword.
      if (params.classifiedIntent) {
        try {
          const intentPatterns = matchIntentTriggeredPatterns(
            params.db, params.classifiedIntent, params.project, 3,
          );
          if (intentPatterns.length > 0) {
            const section = formatExperienceWarningsSection(intentPatterns);
            if (section) {
              const cost = estimateTokens(section);
              parts.push(section);
              totalTokens += cost;
              srcs.push('intent_patterns');
            }
          }
        } catch { /* non-fatal */ }
      }

      // 4c. Reactive: FTS5 + vector hybrid-matched patterns for this specific prompt.
      if (params.prompt && params.prompt.length >= 20) {
        const expWarnings = renderExperienceWarnings(
          params.db, params.prompt, params.project, params.sessionId,
          params.hybridPatterns,
        );
        if (expWarnings) {
          parts.push(expWarnings.section);
          totalTokens += expWarnings.tokenCost;
          srcs.push('experience_warnings');
          const prevCommit = commitFn;
          commitFn = () => { prevCommit?.(); expWarnings.applyEffects(); };
        }
      }

      if (parts.length > 0) {
        return {
          content: parts.join('\n\n'),
          tokenEstimate: totalTokens,
          sources: srcs,
          commitEffects: commitFn,
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

// ---------------------------------------------------------------------------
// v6 Phase 10 — opt-in deliberation surfacing (L2.5 cascade position)
// ---------------------------------------------------------------------------

import { formatDeliberationSurfaceSection } from './sections.js';

/**
 * v6 Phase 10 — append the deliberation-surface section to a payload built
 * by `assembleFullContext`. Lives at the L2.5 cascade position per
 * `.claude/rules/assembly-budget.md` (between the L2 reference layer and
 * the L3 materialization layer).
 *
 * Async because the routing surface makes network calls (Ollama / reranker).
 * Kept as a separate post-processing step so `assembleFullContext` stays
 * synchronous for the existing sync hot path.
 *
 * Opt-in per assembly site via `params.deliberationSurfacing` — sites that
 * don't opt in (the default) see no behavior change. When opted in but no
 * artifact references were supplied, returns the payload unchanged.
 *
 * Non-throwing: routing failures, formatting failures, empty surface — all
 * return the original payload unmodified.
 */
export async function appendDeliberationSurfaceToPayload(
  payload: InjectPayload,
  params: FullAssemblyParams,
): Promise<InjectPayload> {
  if (!params.deliberationSurfacing) return payload;
  const artifacts = params.deliberationArtifacts;
  if (!artifacts || artifacts.length === 0) return payload;
  try {
    const totalBudget = scaleBudget(
      params.config.injection.budget_tokens,
      params.contextWindowTokens,
    );
    const section = await formatDeliberationSurfaceSection(params.db, artifacts, {
      enabled: true,
      totalAssemblyBudgetTokens: totalBudget,
      caller_session_id: params.sessionId,
      artifactLabels: params.deliberationLabels,
    });
    if (!section) return payload;
    const newContent = payload.content
      ? `${payload.content}\n\n${section}`
      : section;
    // POLISH-02 — Gemini Assembly Finding #1: spread the original payload so
    // every field — most importantly `commitEffects?: () => void` — survives the
    // surface mutation. Cherry-picking content/tokenEstimate/sources silently
    // dropped commitEffects and broke the experience-pattern callback flush
    // discipline. Spread first; override only the fields this step mutates.
    return {
      ...payload,
      content: newContent,
      tokenEstimate: estimateTokens(newContent),
      sources: [...payload.sources, 'deliberation_surface'],
    };
  } catch {
    return payload;
  }
}
