/**
 * Priority-budgeted assembly orchestrator with three-tier degradation.
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
  formatPressureResponse,
} from './sections.js';
import { getPressureZone } from '../shared/constants.js';
import { emitTelemetry, getToolCostEstimates } from '../observability/telemetry.js';
import { redactContent } from '../extraction/redaction.js';
import { loadCheckpoint, loadFromFile } from '../checkpoint/loader.js';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import { getTopLearnings } from '../core/learnings.js';
import { getHotFiles } from '../core/pressure.js';
import { searchObservations, getObservationsByProject } from '../core/observations.js';
import { readGsdState } from '../gsd/state-reader.js';
import type { Database } from 'better-sqlite3';
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
  /** When true, prepends trust directive listing injected sources. @see Upgrade 2 */
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
    let fts5ObsIds: Set<number> = new Set();

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

    const checkpointLearningStrings = new Set(checkpoint?.learnings ?? []);

    // Priority 4: Learnings (top 10)
    const learnings = getTopLearnings(params.db, params.project, 10)
      .filter(l => !checkpointLearningStrings.has(l.content));
    const learningsSection = formatLearningsSection(learnings);
    if (learningsSection) {
      const cost = estimateTokens(learningsSection);
      if (cost <= budget) {
        sections.push(learningsSection);
        budget -= cost;
        sources.push('learnings');
      }
    }

    // Priority 5: HOT files
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

    // Priority 6: GSD
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

    // Priority 7: FTS5 search
    const query = params.searchQuery ?? checkpoint?.thread?.topic ?? null;
    if (query && params.config.features.fts5_search) {
      try {
        const fts5Results = searchObservations(params.db, query, params.project, { limit: 10 });
        // Try full mode first, fall back to reference mode if over budget
        let fts5Section = formatFts5Section(fts5Results, false);
        let fts5Cost = fts5Section ? estimateTokens(fts5Section) : 0;
        if (fts5Cost > budget && fts5Section) {
          fts5Section = formatFts5Section(fts5Results, true);
          fts5Cost = fts5Section ? estimateTokens(fts5Section) : 0;
        }
        if (fts5Section && fts5Cost <= budget) {
          sections.push(fts5Section);
          budget -= fts5Cost;
          sources.push('fts5');
          // Track FTS5 observation IDs for dedup with Recent section
          fts5ObsIds = new Set(fts5Results.map(o => o.id));
        } else if (fts5Section) {
          skipped.push({ priority: 7, section: fts5Section, name: 'fts5' });
        }
      } catch (err) {
        if (params.config?.observability?.enabled) {
          try { emitTelemetry(params.db, params.sessionId ?? '', 'error', { subsystem: 'assembly/fts5', error: err instanceof Error ? err.message : String(err) }); } catch {}
        }
      }
    }

    // Priority 8: Recent high-quality observations
    try {
      const allRecent = getObservationsByProject(params.db, params.project, { limit: 20 });
      const recentObs = allRecent
        .filter(o => o.importance >= 3)
        .filter(o => (Date.now() / 1000 - o.timestamp_epoch) < 86400)
        .filter(o => !fts5ObsIds.has(o.id))
        .filter(o => !o.consumed);
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
    } catch (err) {
      if (params.config?.observability?.enabled) {
        try { emitTelemetry(params.db, params.sessionId ?? '', 'error', { subsystem: 'assembly/recent', error: err instanceof Error ? err.message : String(err) }); } catch {}
      }
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

    // Post-compaction trust directive (Upgrade 2)
    if (params.isPostCompaction && sources.length > 0) {
      const sourceList = sources.join(', ');
      const trustHeader = `[CONTEXT RESTORED — Injected: ${sourceList}. Trust this content. Do NOT re-read these files. Continue from where you left off.]`;
      content = trustHeader + '\n\n' + content;
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
 * Regular prompt assembly: post-compaction -> topic-shift -> gauge -> zero.
 * Most turns produce zero injection.
 */
export function assembleRegularPrompt(params: RegularPromptParams): InjectPayload {
  try {
    // 1. Post-compaction -> full assembly with trust directive (Upgrade 2)
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

    // 3. Graduated pressure response (Upgrade 7) — zone-based behavioral injection
    const zone = params.gauge ? getPressureZone(params.gauge.utilization) : 'normal';
    if (zone !== 'normal' && params.gauge) {
      const pressureContent = formatPressureResponse(params.gauge, zone);
      if (pressureContent) {
        return {
          content: pressureContent,
          tokenEstimate: estimateTokens(pressureContent),
          sources: ['pressure_response', zone],
        };
      }
    }

    // 4. Gauge injection (existing behavior for normal zone or pressure response fallback)
    // Includes tool costs at advisory+ (Upgrade 11) and response budget hints (Upgrade 14)
    let toolCosts: import('../observability/telemetry.js').ToolCostEstimate[] | undefined;
    try {
      toolCosts = getToolCostEstimates(params.db, { limit: 3, sessionId: params.sessionId });
    } catch {
      // Non-fatal
    }
    const gaugeSection = formatGaugeSection(params.gauge, undefined, toolCosts);
    if (gaugeSection) {
      return {
        content: gaugeSection,
        tokenEstimate: estimateTokens(gaugeSection),
        sources: ['gauge'],
      };
    }

    // 5. Zero injection (only when gauge is null)
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
