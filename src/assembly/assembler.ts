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
} from './sections.js';
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

    // Priority 4: Learnings (top 10)
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

    // Check reference mode trigger
    if (budget < 500) referenceMode = true;

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
        const fts5Section = formatFts5Section(fts5Results, referenceMode);
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
      } catch { /* FTS5 query failure is non-fatal */ }
    }

    // Priority 8: Recent high-quality observations
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
    } catch { /* Recent query failure is non-fatal */ }

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
 * Regular prompt assembly: post-compaction -> topic-shift -> gauge -> zero.
 * Most turns produce zero injection.
 */
export function assembleRegularPrompt(params: RegularPromptParams): InjectPayload {
  try {
    // 1. Post-compaction -> full assembly
    if (params.isPostCompaction) {
      return assembleFullContext({
        db: params.db,
        project: params.project,
        projectDir: params.projectDir,
        config: params.config,
        searchQuery: params.prompt,
        identityDir: params.identityDir,
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

    // 3. Gauge injection at >= threshold
    const gaugeSection = formatGaugeSection(params.gauge, params.config.injection.gauge_threshold);
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
