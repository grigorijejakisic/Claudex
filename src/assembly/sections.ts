/**
 * 10 stateless section formatters for the assembly pipeline.
 * All are pure functions taking pre-fetched data, returning string | null.
 * All non-throwing (return null on error).
 * @see Architecture Section 7.2
 */

import * as fs from 'fs';
import * as path from 'path';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import type { CheckpointV3 } from '../checkpoint/types.js';
import type { LearningRow } from '../core/learnings.js';
import type { PressureRow } from '../core/pressure.js';
import type { ObservationRow } from '../core/observations.js';
import type { GsdState } from '../gsd/types.js';
import type { TokenUsage } from '../shared/types.js';
import type { TopicShiftResult } from '../intelligence/topic-shift.js';
import { getIdentityDir, getHandoffsDir } from '../shared/paths.js';
import { CONTENT_MAX_CHARS, getPressureZone } from '../shared/constants.js';
import type { PressureZone } from '../shared/constants.js';
import type { ToolCostEstimate } from '../observability/telemetry.js';
import { truncateText } from '../shared/text-utils.js';

/**
 * Priority 1: Identity section from USER.md.
 * Reads from identityDir or default ~/.claudex/identity/.
 */
export function formatIdentitySection(identityDir?: string): string | null {
  try {
    const dir = identityDir ?? getIdentityDir();
    const filePath = path.join(dir, 'USER.md');
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim().length === 0) return null;
    return `## Identity\n${content}`;
  } catch {
    return null;
  }
}

/**
 * Priority 2: Project context from PROJECT_PRIMER.md + ACTIVE.md.
 */
export function formatProjectSection(projectDir: string): string | null {
  try {
    let primerContent: string | null = null;
    let activeContent: string | null = null;

    try {
      const primerPath = path.join(projectDir, 'PROJECT_PRIMER.md');
      if (fs.existsSync(primerPath)) {
        const content = fs.readFileSync(primerPath, 'utf-8');
        if (content && content.trim().length > 0) primerContent = content;
      }
    } catch { /* skip */ }

    try {
      const activePath = path.join(getHandoffsDir(projectDir), 'ACTIVE.md');
      if (fs.existsSync(activePath)) {
        const content = fs.readFileSync(activePath, 'utf-8');
        if (content && content.trim().length > 0) activeContent = content;
      }
    } catch { /* skip */ }

    if (!primerContent && !activeContent) return null;

    const parts: string[] = [];
    if (primerContent) parts.push(`## Project\n${primerContent}`);
    if (activeContent) parts.push(`## Active Handoff\n${activeContent}`);
    return parts.join('\n\n');
  } catch {
    return null;
  }
}

/**
 * Priority 3: Checkpoint resume data.
 * Delegates to renderCheckpointMarkdown with RESUME preset.
 */
export function formatCheckpointSection(checkpoint: CheckpointV3 | null): string | null {
  try {
    if (!checkpoint) return null;
    const rendered = renderCheckpointMarkdown(checkpoint, 'RESUME');
    if (!rendered || rendered.trim().length === 0) return null;
    return `## Checkpoint\n${rendered}`;
  } catch {
    return null;
  }
}

/**
 * Priority 4: Cross-session learnings.
 */
export function formatLearningsSection(learnings: LearningRow[]): string | null {
  try {
    if (!learnings || learnings.length === 0) return null;
    const bullets = learnings.map(l => `- ${l.content} (x${l.promotion_count})`);
    return `## Learnings\n${bullets.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Priority 5: HOT files (pressure >= 0.851).
 */
export function formatHotFilesSection(hotFiles: PressureRow[]): string | null {
  try {
    if (!hotFiles || hotFiles.length === 0) return null;
    const filtered = hotFiles.filter(f => f.raw_pressure >= 0.851);
    if (filtered.length === 0) return null;
    const bullets = filtered.map(f => `- ${f.file_path} (pressure: ${f.raw_pressure.toFixed(2)})`);
    return `## Hot Files\n${bullets.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Priority 6: GSD planning state.
 */
export function formatGsdSection(gsd: GsdState | null): string | null {
  try {
    if (!gsd) return null;
    const lines: string[] = [
      '## GSD State',
      `**Phase ${gsd.phase}:** ${gsd.goal}`,
      `**Status:** ${gsd.status}`,
      `**Completion:** ${gsd.completion}`,
    ];
    if (gsd.success_criteria && gsd.success_criteria.length > 0) {
      lines.push('**Success Criteria:**');
      for (const criterion of gsd.success_criteria) {
        lines.push(`- ${criterion}`);
      }
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * Internal helper: formats a timestamp as relative time.
 */
function formatRelativeTime(epochSeconds: number): string {
  const ageSec = Math.floor(Date.now() / 1000) - epochSeconds;
  if (ageSec < 60) return 'just now';
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

/**
 * Priority 7: FTS5 search results.
 * referenceMode=true produces compact one-line format.
 */
export function formatFts5Section(observations: ObservationRow[], referenceMode?: boolean): string | null {
  try {
    if (!observations || observations.length === 0) return null;

    let body: string;
    if (referenceMode) {
      const bullets = observations.map(o =>
        `- [${o.category}] ${o.title} (${formatRelativeTime(o.timestamp_epoch)})`
      );
      body = bullets.join('\n');
    } else {
      const entries = observations.map(o => {
        const cappedContent = truncateText(o.content, CONTENT_MAX_CHARS);
        return `### ${o.title}\n*${o.category} | ${formatRelativeTime(o.timestamp_epoch)}*\n${cappedContent}`;
      });
      body = entries.join('\n\n');
    }

    return `## Relevant Observations\n${body}`;
  } catch {
    return null;
  }
}

/**
 * Priority 8: Recent high-quality observations (always compact format).
 */
export function formatRecentSection(observations: ObservationRow[]): string | null {
  try {
    if (!observations || observations.length === 0) return null;
    const bullets = observations.map(o =>
      `- [${o.category}] ${o.title} (${formatRelativeTime(o.timestamp_epoch)})`
    );
    return `## Recent Observations\n${bullets.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Gauge section: token utilization display with pressure zones.
 * Always fires when gauge is available (Upgrade 1).
 * Includes tool cost estimates at advisory+ (Upgrade 11).
 * Includes response budget hint at advisory+ (Upgrade 14).
 *
 * @param gauge - Token usage data
 * @param threshold - DEPRECATED (ignored, kept for API compat)
 * @param toolCosts - Optional tool cost estimates for advisory+ zones
 */
export function formatGaugeSection(
  gauge: TokenUsage | null,
  threshold?: number,
  toolCosts?: ToolCostEstimate[],
): string | null {
  try {
    if (!gauge) return null;
    const pct = Math.round(gauge.utilization * 100);
    const zone: PressureZone = getPressureZone(gauge.utilization);
    const inputK = Math.round(gauge.inputTokens / 1000);
    const windowK = Math.round(gauge.contextWindowTokens / 1000);

    // Build gauge line
    let line = `[Context: ${inputK}k/${windowK}k (${pct}%)`;

    // Tool costs at advisory+ (Upgrade 11)
    if (zone !== 'normal' && toolCosts && toolCosts.length > 0) {
      const costParts = toolCosts.slice(0, 3).map(
        (tc) => `${tc.tool} ~${Math.round(tc.avgTokens / 1000)}k`
      );
      line += ` | Costs: ${costParts.join(', ')}`;
    }

    line += ` | Zone: ${zone}`;

    // Response budget hint (Upgrade 14)
    if (zone === 'advisory') {
      line += ' | Respond concisely';
    } else if (zone === 'warning') {
      line += ' | ≤5 lines';
    } else if (zone === 'critical') {
      line += ' | ≤3 lines, essentials only';
    }

    line += ']';

    return line;
  } catch {
    return null;
  }
}

/**
 * Graduated pressure response — behavioral changes at different utilization levels.
 * Returns zone-appropriate advisory/warning/critical message, or null for normal zone.
 * @see Upgrade 7: Graduated Pressure Response
 */
export function formatPressureResponse(
  gauge: TokenUsage | null,
  zone: PressureZone,
): string | null {
  try {
    if (!gauge || zone === 'normal') return null;

    const pct = Math.round(gauge.utilization * 100);
    const used = gauge.inputTokens.toLocaleString();
    const total = gauge.contextWindowTokens.toLocaleString();
    const gaugeLine = `[Context: ${used}/${total} (${pct}%) | Zone: ${zone}]`;

    switch (zone) {
      case 'advisory':
        return `${gaugeLine}\n[Advisory: Consider using sub-agents for exploration tasks. Auto-checkpoint triggered.]`;
      case 'warning':
        return `${gaugeLine}\n[WARNING: Context at ${pct}%. Wrap up current task and prepare handoff. Auto-checkpoint triggered. Write key decisions and progress to handoff document.]`;
      case 'critical':
        return `${gaugeLine}\n[CRITICAL: Context at ${pct}%. STOP new work immediately. Write structured handover document NOW. Save all progress to ACTIVE.md. Do NOT start new tasks or explorations.]`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Topic pivot section: context switch marker + relevant data.
 */
export function formatTopicPivotSection(params: {
  shift: TopicShiftResult;
  learnings?: LearningRow[];
  hotFiles?: PressureRow[];
  decisions?: Array<{ content: string; source: string }>;
}): string | null {
  try {
    const { shift, learnings, hotFiles, decisions } = params;
    if (!shift.shifted) return null;

    const parts: string[] = [
      `## Context Pivot`,
      `Switching context: ${shift.previousTopic ?? 'unknown'} -> ${shift.newTopic ?? 'unknown'}`,
    ];

    if (learnings && learnings.length > 0) {
      parts.push('');
      parts.push('**Relevant Learnings:**');
      for (const l of learnings.slice(0, 3)) {
        parts.push(`- ${l.content}`);
      }
    }

    if (hotFiles && hotFiles.length > 0) {
      parts.push('');
      parts.push('**Related Files:**');
      for (const f of hotFiles) {
        parts.push(`- ${f.file_path}`);
      }
    }

    if (decisions && decisions.length > 0) {
      parts.push('');
      parts.push('**Related Decisions:**');
      for (const d of decisions) {
        parts.push(`- ${d.content}`);
      }
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}
