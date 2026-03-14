/**
 * Three-layer assembly orchestrator with legacy fallback.
 *
 * Primary path (artifact count >= 5):
 *   Layer 1: Structural — identity, project, checkpoint, session flow
 *   Layer 2: Reference — packed artifact summaries (metadata only)
 *   Layer 3: Materialization — FTS5-selected full content with provenance
 *
 * Legacy fallback (artifact count < 5):
 *   Budget-cascade with learnings, hot files, GSD, FTS5 observations, recent.
 *   DEPRECATED — will be removed when artifact system is proven stable.
 *
 * Boundary-only injection: full assembly at session-start and post-compaction only.
 * Topic-shift pivot and gauge injection for regular turns.
 * All public functions are non-throwing.
 * @see Architecture Section 7
 */

import { estimateTokens } from './token-estimator.js';
import {
  formatIdentitySection,
  formatProjectSection,
  formatCheckpointSection,
  formatLearningsSection,
  formatHotFilesSection,
  formatGsdSection,
  formatFts5Section,
  formatRecentSection,
  formatGaugeSection,
  formatTopicPivotSection,
  formatFlowSection,
  formatReferenceLayer,
  formatMaterializationLayer,
  renderSessionContinuity,
} from './sections.js';
import { redactContent } from '../extraction/redaction.js';
import { loadCheckpoint, loadFromFile } from '../checkpoint/loader.js';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import { getTopLearnings } from '../core/learnings.js';
import { getHotFiles } from '../core/pressure.js';
import { searchObservations, getObservationsByProject } from '../core/observations.js';
import {
  getPackedArtifacts,
  searchArtifacts,
  tickArtifactTTL,
  materializeArtifacts,
  getMaterializedArtifacts,
  getArtifactCount,
} from '../core/artifacts.js';
import { getRecentFlow } from '../core/journal.js';
import { getCheckpointTracking } from '../core/checkpoint-tracking.js';
import { readGsdState } from '../gsd/state-reader.js';
import { getPressureZone } from '../shared/constants.js';
import { getHandoffsDir, getSessionsDir } from '../shared/paths.js';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import type { ArtifactRow } from '../core/artifacts.js';
import type { GaugeTimingContext } from './sections.js';
import type { InjectPayload, TokenUsage } from '../shared/types.js';
import type { ClaudexConfig } from '../shared/config.js';
import type { TopicShiftResult } from '../intelligence/topic-shift.js';

/** Minimum artifact count before switching from legacy to artifact-based assembly. */
const ARTIFACT_THRESHOLD = 5;

export interface FullAssemblyParams {
  db: Database;
  project: string;
  projectDir: string;
  config: ClaudexConfig;
  searchQuery?: string;
  identityDir?: string;
  sessionId?: string;
  isPostCompaction?: boolean;
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
 * Full context assembly with priority-budgeted cascade and three-tier degradation.
 * Fires at session-start and post-compaction only.
 */
export function assembleFullContext(params: FullAssemblyParams): InjectPayload {
  // Tier 1: Full assembly
  try {
    let budget = params.config.injection.budget_tokens;
    const sections: string[] = [];
    const sources: string[] = [];
    const skipped: Array<{ priority: number; section: string; name: string }> = [];
    let referenceMode = false;

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

    // Priority 3: Checkpoint
    const checkpoint = loadCheckpoint(params.db, params.projectDir, undefined, params.project);
    const checkpointSection = formatCheckpointSection(checkpoint);
    if (checkpointSection) {
      const cost = estimateTokens(checkpointSection);
      if (cost <= budget) {
        sections.push(checkpointSection);
        budget -= cost;
        sources.push('checkpoint');
      }
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

    // === Determine artifact vs legacy path ===
    let artifactCount = 0;
    try { artifactCount = getArtifactCount(params.db, params.project); } catch { /* non-fatal */ }
    const useArtifacts = artifactCount >= ARTIFACT_THRESHOLD;

    if (useArtifacts) {
      // === LAYER 2: Reference (packed artifact summaries) ===
      try {
        const packedArtifacts = getPackedArtifacts(params.db, params.project, 30);
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
      try {
        tickArtifactTTL(params.db, params.project);

        const query = params.searchQuery ?? checkpoint?.thread?.topic ?? null;
        let materializedArtifacts: ArtifactRow[] = [];

        if (query) {
          const searchResults = searchArtifacts(params.db, params.project, query, 10);
          if (searchResults.length > 0) {
            materializeArtifacts(params.db, searchResults.map(a => a.id));
            materializedArtifacts = searchResults;
          }
        }

        const alreadyMaterialized = getMaterializedArtifacts(params.db, params.project);
        const seen = new Set(materializedArtifacts.map(a => a.id));
        for (const a of alreadyMaterialized) {
          if (!seen.has(a.id)) { materializedArtifacts.push(a); seen.add(a.id); }
        }

        const rationale = query ? `FTS5 match on "${query}"` : undefined;
        const matSection = formatMaterializationLayer(materializedArtifacts, rationale, params.sessionId);
        if (matSection) {
          const cost = estimateTokens(matSection);
          if (cost <= budget) {
            sections.push(matSection);
            budget -= cost;
            sources.push('materialized');
          }
        }
      } catch { /* non-fatal */ }

      // GSD still included in artifact path (not redundant with artifacts)
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

    } else {
      // === LEGACY FALLBACK (artifact count < threshold) ===
      // @deprecated — will be removed when artifact system is proven stable.

      const learnings = getTopLearnings(params.db, params.project, 10);
      const learningsSection = formatLearningsSection(learnings);
      if (learningsSection) {
        const cost = estimateTokens(learningsSection);
        if (cost <= budget) {
          sections.push(learningsSection);
          budget -= cost;
          sources.push('learnings');
        }
      }

      const hotFiles = getHotFiles(params.db, params.project, 20);
      const hotSection = formatHotFilesSection(hotFiles);
      if (hotSection) {
        const cost = estimateTokens(hotSection);
        if (cost <= budget) {
          sections.push(hotSection);
          budget -= cost;
          sources.push('hot_files');
        }
      }

      const gsd = readGsdState(params.projectDir);
      const gsdSection = formatGsdSection(gsd);
      if (gsdSection) {
        const cost = estimateTokens(gsdSection);
        if (cost <= budget) {
          sections.push(gsdSection);
          budget -= cost;
          sources.push('gsd');
        } else {
          skipped.push({ priority: 6, section: gsdSection, name: 'gsd' });
        }
      }

      const query = params.searchQuery ?? checkpoint?.thread?.topic ?? null;
      if (query && params.config.features.fts5_search) {
        try {
          const fts5Results = searchObservations(params.db, query, params.project, { limit: 10 });
          const fts5Section = formatFts5Section(fts5Results, budget < 500);
          if (fts5Section) {
            const cost = estimateTokens(fts5Section);
            if (cost <= budget) {
              sections.push(fts5Section);
              budget -= cost;
              sources.push('fts5');
            } else {
              skipped.push({ priority: 7, section: fts5Section, name: 'fts5' });
            }
          }
        } catch { /* non-fatal */ }
      }

      try {
        const allRecent = getObservationsByProject(params.db, params.project, { limit: 20 });
        const recentObs = allRecent
          .filter(o => o.importance >= 3)
          .filter(o => (Date.now() / 1000 - o.timestamp_epoch) < 86400);
        const recentSection = formatRecentSection(recentObs);
        if (recentSection) {
          const cost = estimateTokens(recentSection);
          if (cost <= budget) {
            sections.push(recentSection);
            budget -= cost;
            sources.push('recent');
          } else {
            skipped.push({ priority: 8, section: recentSection, name: 'recent' });
          }
        }
      } catch { /* non-fatal */ }
    }

    // Assemble content
    let content = sections.join('\n\n');

    // Post-redaction reclaim (ASMB-05)
    const preRedactionLength = content.length;
    content = redactContent(content);
    const postRedactionLength = content.length;

    if (postRedactionLength < preRedactionLength && skipped.length > 0) {
      const reclaimBudget = budget + Math.floor((preRedactionLength - postRedactionLength) / 4);

      // Re-attempt skipped sections in priority order
      skipped.sort((a, b) => a.priority - b.priority);
      for (const { section, name } of skipped) {
        const cost = estimateTokens(section);
        if (cost <= reclaimBudget) {
          content += '\n\n' + redactContent(section);
          sources.push(name);
          break; // Only reclaim one section to avoid over-budget
        }
      }
    }

    return {
      content,
      tokenEstimate: estimateTokens(content),
      sources,
    };
  } catch {
    // Tier 1 failed — fall through to Tier 2
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
  } catch {
    // Tier 2 failed — fall through to Tier 3
  }

  // Tier 3: Identity-only
  try {
    const identity = formatIdentitySection(params.identityDir);
    if (identity) {
      let content = redactContent(identity);
      return { content, tokenEstimate: estimateTokens(content), sources: ['identity'] };
    }
  } catch {
    // Tier 3 failed
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
    // Tick artifact TTL on every turn (turn boundary lifecycle)
    try { tickArtifactTTL(params.db, params.project); } catch { /* non-fatal */ }

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

    // 3. Gauge injection at advisory+ pressure zone (with temporal awareness)
    const zone = params.gauge ? getPressureZone(params.gauge.utilization) : 'normal';
    const timing = buildGaugeTiming(params.db, params.sessionId);
    const gaugeSection = zone !== 'normal' ? formatGaugeSection(params.gauge, undefined, timing) : null;
    if (gaugeSection) {
      return {
        content: gaugeSection,
        tokenEstimate: estimateTokens(gaugeSection),
        sources: ['gauge'],
      };
    }

    // 4. Zero injection (most turns)
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
    let relevantLearnings: any[] = [];
    let relevantHotFiles: any[] = [];

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
