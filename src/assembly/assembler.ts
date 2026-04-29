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
  formatProvenPrinciplesSection,
  formatProjectSection,
  formatCuratedContextSection,
  formatCheckpointSection,
  formatGsdSection,
  formatGaugeSection,
  formatPressureResponse,
  formatTopicPivotSection,
  formatLearningsSection,
  formatMaterializationLayer,
  formatRulesReminderSection,
  formatProjectsOverview,
  renderSessionContinuity,
  renderExperienceWarnings as formatExperienceWarningsSection,
} from './sections.js';
import type { ProjectOverviewRow } from './sections.js';
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
import { findRelevantFiles, getChangedFiles } from '../indexer/codebase-indexer.js';
import { getCheckpointTracking } from '../core/checkpoint-tracking.js';
import { readGsdState } from '../gsd/state-reader.js';
import { assembleCriticalReminders } from '../intelligence/critical-reminders.js';
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
  /** Pinnable wall-clock for cache-stability tests (CACH-03). If omitted,
   * defaults to Math.floor(Date.now() / 1000) at each clock-leak site. */
  nowEpoch?: number;
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

      // Priority 2.1: Project Curated Context — agent-curated authoritative
      // slot for theory, workspace map, shipped manifest, constraints, and
      // preferences. Global entries apply cross-project; project-scoped
      // entries supersede CLAUDE.md on conflict. See context/specs/
      // CURATED_CONTEXT.md for the full design.
      try {
        const curatedSection = formatCuratedContextSection(params.db, params.project);
        if (curatedSection) {
          const cost = estimateTokens(curatedSection);
          if (cost <= budget) {
            sections.push(curatedSection);
            budget -= cost;
            sources.push('curated_context');
          }
        }
      } catch { /* non-fatal — curated context is best-effort */ }

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

    // Priority 4.05: Entity summaries — pre-computed knowledge about recurring entities.
    // Angel generates these for entities appearing in 3+ sessions. Surfaces consolidated
    // understanding so agents don't need to search for "what is X?"
    try {
      const entitySummaries = cachedPrepare(params.db,
        `SELECT title, content FROM artifacts
         WHERE artifact_type = 'entity_summary' AND project = ? AND state = 'active'
         ORDER BY importance DESC, created_at_epoch DESC LIMIT 5`
      ).all(params.project) as Array<{ title: string; content: string }>;

      if (entitySummaries.length > 0) {
        const lines = entitySummaries.map(e => `- **${e.title}**: ${e.content.slice(0, 200)}`);
        const section = `## Entity Knowledge\n${lines.join('\n')}`;
        const cost = estimateTokens(section);
        if (cost <= budget) {
          sections.push(section);
          budget -= cost;
          sources.push('entity_summaries');
        }
      }
    } catch { /* non-fatal */ }

    // Priority 4.25: Cross-project awareness — lightweight project overview.
    // Only at session-start (not post-compaction — projects don't change mid-session).
    // NOTE: this section is being DELETED in Plan 04 (Tier B). The unixepoch() leak
    // is patched here for hardening continuity through Plans 02-03 cache-stability
    // gates; the parameter binding is removed when the section is removed.
    if (!params.isPostCompaction) {
      try {
        const _nowEpoch = params.nowEpoch ?? Math.floor(Date.now() / 1000);
        const _cutoff = _nowEpoch - 604800;
        const projectRows = cachedPrepare(params.db,
          `SELECT s.project, MAX(s.created_at_epoch) AS last_active, t.topic,
                  EXISTS(SELECT 1 FROM artifacts a WHERE a.project = s.project AND a.artifact_type = 'handoff' AND a.state != 'consumed') AS has_handoff
           FROM sessions s
           LEFT JOIN thread_state t ON t.session_id = (
             SELECT s2.session_id FROM sessions s2
             WHERE s2.project = s.project ORDER BY s2.created_at_epoch DESC LIMIT 1
           )
           WHERE s.created_at_epoch > ?
           GROUP BY s.project
           ORDER BY last_active DESC
           LIMIT 10`
        ).all(_cutoff) as ProjectOverviewRow[];

        if (projectRows.length > 0) {
          const overview = formatProjectsOverview(projectRows, params.project);
          if (overview) {
            const cost = estimateTokens(overview);
            if (cost <= budget) {
              sections.push(overview);
              budget -= cost;
              sources.push('project_overview');
            }
          }
        }
      } catch { /* non-fatal */ }
    }

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

    // === CODEBASE CONTEXT (Amp Phase 3 — structural understanding) ===
    // Inject relevant symbols and recent changes from the codebase index.
    // Only at session-start (not post-compaction).
    if (!params.isPostCompaction) {
      try {
        // findRelevantFiles and getChangedFiles imported statically at top
        const query = params.searchQuery ?? checkpoint?.thread?.topic ?? null;
        const parts: string[] = [];

        // Helper: shorten file path to project-relative.
        // CACH-03: normalize backslashes to forward slashes so output bytes are
        // OS-invariant (Windows produces 'src\\' otherwise; cache hash flips per-host).
        const shortenPath = _shortenPathCacheStable;

        // Recent changes since last session on this project
        const lastSession = cachedPrepare(params.db,
          `SELECT ended_at_epoch FROM sessions
           WHERE project = ? AND status = 'completed' AND ended_at_epoch IS NOT NULL
           ORDER BY ended_at_epoch DESC LIMIT 1`
        ).get(params.project) as { ended_at_epoch: number } | undefined;
        const lastSessionEpoch = lastSession?.ended_at_epoch ?? ((params.nowEpoch ?? Math.floor(Date.now() / 1000)) - 86400);
        const changed = getChangedFiles(params.db, params.project, lastSessionEpoch);
        if (changed.length > 0) {
          parts.push('**Changed since last session:**');
          for (const f of changed.slice(0, 5)) {
            const relPath = shortenPath(f.file_path);
            const exportedSymbols = f.symbols.filter(s => s.exported).map(s => s.name).slice(0, 5).join(', ');
            parts.push(`- \`${relPath}\`${exportedSymbols ? ` (${exportedSymbols})` : ''}`);
          }
        }

        // Relevant files for current topic
        if (query) {
          const relevant = findRelevantFiles(params.db, params.project, query, 3);
          if (relevant.length > 0) {
            parts.push(parts.length > 0 ? '\n**Relevant to current task:**' : '**Relevant files:**');
            for (const f of relevant) {
              const relPath = shortenPath(f.file_path);
              const topSymbols = f.symbols.filter(s => s.exported).slice(0, 5).map(s => `${s.kind} ${s.name}`).join(', ');
              parts.push(`- \`${relPath}\`: ${topSymbols || '(no exports)'}`);
            }
          }
        }

        if (parts.length > 0) {
          const codeSection = `## Codebase Context\n${parts.join('\n')}`;
          const cost = estimateTokens(codeSection);
          if (cost <= budget && cost <= 800) { // Hard cap: 800 tokens for codebase context
            sections.push(codeSection);
            budget -= cost;
            sources.push('codebase_index');
          }
        }
      } catch { /* codebase index unavailable — non-fatal */ }
    }


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
