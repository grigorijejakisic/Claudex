/**
 * 12 stateless section formatters for the assembly pipeline.
 * All are pure functions taking pre-fetched data, returning string | null.
 * All non-throwing (return null on error).
 * @see Architecture Section 7.2
 */

import * as fs from 'fs';
import * as path from 'path';
import { renderCheckpointMarkdown } from '../checkpoint/inject.js';
import type { CheckpointV3 } from '../checkpoint/types.js';
import type { ArtifactRow } from '../core/artifacts.js';
import type { LearningRow } from '../core/learnings.js';
import type { PressureRow } from '../core/pressure.js';
import type { ObservationRow } from '../core/observations.js';
import type { GsdState } from '../gsd/types.js';
import type { TokenUsage } from '../shared/types.js';
import type { TopicShiftResult } from '../intelligence/topic-shift.js';
import { getIdentityDir, getHandoffsDir, getSessionsDir } from '../shared/paths.js';
import { CONTENT_MAX_CHARS, getPressureZone } from '../shared/constants.js';
import type { PressureZone } from '../shared/constants.js';
import type { ToolCostEstimate } from '../observability/telemetry.js';
import { truncateText } from '../shared/text-utils.js';
import * as path from 'path';

/**
 * Wraps file content in <file-content>...</file-content> markers,
 * escaping any literal sentinel sequences in the payload to prevent
 * data boundary injection.
 */
export function wrapFileContent(content: string): string {
  // Escape literal closing sentinel in content to prevent boundary break
  const escaped = content.replace(/<\/file-content>/g, '<\\/file-content>');
  return `<file-content>\n${escaped}\n</file-content>`;
}

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
 * Priority 2.5: Session continuity — compressed handoff + latest session log.
 * Reads ACTIVE.md and the most recent session log, compresses into ~300 tokens.
 * Returns null if no handoff exists (cost: 0). Non-throwing.
 * @see Upgrade 4
 */
export function renderSessionContinuity(handoffPath?: string, sessionsDir?: string): string | null {
  try {
    let handoffContent: string | null = null;
    let sessionContent: string | null = null;

    // 1. Read handoff
    if (handoffPath) {
      try {
        if (fs.existsSync(handoffPath)) {
          handoffContent = fs.readFileSync(handoffPath, 'utf-8');
        }
      } catch { /* skip */ }
    }

    // 2. Read most recent session log (by filename sort, descending)
    if (sessionsDir) {
      try {
        if (fs.existsSync(sessionsDir)) {
          const files = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.md') && !f.includes('compact'))
            .sort();
          if (files.length > 0) {
            const latestFile = files[files.length - 1];
            sessionContent = fs.readFileSync(path.join(sessionsDir, latestFile), 'utf-8');
          }
        }
      } catch { /* skip */ }
    }

    if (!handoffContent && !sessionContent) return null;

    const parts: string[] = ['## Session Continuity'];

    // Extract current task from handoff (first heading after "What I Was Working On" or "Current State")
    if (handoffContent) {
      const taskLine = extractSection(handoffContent, ['## Current State', '## What I Was Working On', '# Handoff:']);
      if (taskLine) {
        parts.push(`**Task:** ${taskLine}`);
      }

      // Extract progress from handoff (checkbox items from "COMPLETED" or numbered items)
      const progress = extractProgress(handoffContent);
      if (progress.length > 0) {
        parts.push('**Progress:**');
        for (const item of progress.slice(0, 5)) {
          parts.push(`- ${item}`);
        }
      }

      // Extract pending decisions
      const pending = extractSection(handoffContent, ['## DEFERRED', '## Key Decisions']);
      if (pending) {
        parts.push(`**Pending:** ${pending}`);
      }
    }

    // Extract "Where We Left Off" from session log
    if (sessionContent) {
      const whereLeftOff = extractSection(sessionContent, ['## Where We Left Off', '## Notes for Next Session']);
      if (whereLeftOff) {
        parts.push(`**Left off:** ${whereLeftOff}`);
      }
    }

    // If we only got the header and nothing else, skip
    if (parts.length <= 1) return null;

    // Hard cap at ~1200 chars (~300 tokens)
    let result = parts.join('\n');
    if (result.length > 1200) {
      result = result.slice(0, 1197) + '...';
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Extracts the first non-empty paragraph after a matching heading.
 * Looks for the first match among headingPrefixes, then returns
 * the first 2 content lines after that heading (trimmed, joined).
 * Returns null if no heading matches. Non-throwing.
 */
function extractSection(content: string, headingPrefixes: string[]): string | null {
  try {
    const lines = content.split('\n');
    for (const prefix of headingPrefixes) {
      const idx = lines.findIndex(l => l.trim().startsWith(prefix));
      if (idx === -1) continue;
      // Collect up to 2 non-empty content lines after the heading
      const collected: string[] = [];
      for (let i = idx + 1; i < lines.length && collected.length < 2; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // Stop at next heading
        if (line.startsWith('#')) break;
        // Skip front-matter markers and tables
        if (line.startsWith('---') || line.startsWith('|')) continue;
        collected.push(line);
      }
      if (collected.length > 0) return collected.join(' ');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts progress items from handoff content.
 * Looks for completed checkbox items `- [x]` and recent bullet items from
 * sections titled "COMPLETED" or "Progress Made".
 * Returns array of progress strings (max 5). Non-throwing.
 */
function extractProgress(content: string): string[] {
  try {
    const results: string[] = [];
    const lines = content.split('\n');

    // Strategy 1: Find [x] checkbox items
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
        results.push(trimmed.replace(/^- \[[xX]\]\s*/, ''));
        if (results.length >= 5) return results;
      }
    }

    // Strategy 2: Find items under "COMPLETED" or "Progress" heading
    if (results.length === 0) {
      const headingIdx = lines.findIndex(l => {
        const t = l.trim().toUpperCase();
        return t.includes('COMPLETED') || t.includes('PROGRESS MADE') || t.includes('PROGRESS');
      });
      if (headingIdx >= 0) {
        for (let i = headingIdx + 1; i < lines.length && results.length < 5; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) break;
          if (line.startsWith('- ')) {
            results.push(line.replace(/^- /, ''));
          }
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Gauge section: token utilization display with pressure zones.
 * Always fires when gauge is available (Upgrade 1).
 * Includes tool cost estimates at advisory+ (Upgrade 11).
 * Includes response budget hint at advisory+ (Upgrade 14).
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

/** Type abbreviation map for reference layer rendering. */
const ARTIFACT_TYPE_ABBREV: Record<string, string> = {
  observation: 'obs',
  learning: 'learn',
  decision: 'decision',
  hot_file: 'hot',
  flow: 'flow',
  milestone: 'milestone',
};

/**
 * Reference layer: renders packed artifact summaries.
 * Always injected — gives the model awareness of all available context
 * without paying full token cost. Each entry is ~30-50 tokens.
 */
export function formatReferenceLayer(artifacts: ArtifactRow[]): string | null {
  try {
    if (!artifacts || artifacts.length === 0) return null;

    const bullets = artifacts.map((a) => {
      const abbrev = ARTIFACT_TYPE_ABBREV[a.artifact_type] ?? a.artifact_type;
      const parts = [`- [${abbrev}] "${a.summary}"`];
      if (a.importance > 0) parts.push(`(importance: ${a.importance}`);
      else parts.push('(');

      // Add relative time if available
      if (a.timestamp_epoch) {
        const timeStr = formatRelativeTime(a.timestamp_epoch);
        if (a.importance > 0) {
          parts.push(`, ${timeStr})`);
        } else {
          parts.push(`${timeStr})`);
        }
      } else {
        parts.push(')');
      }

      return parts.join('');
    });

    return `## Available Context\n${bullets.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Materialization layer: renders full artifact content.
 * Only included for items selected by FTS5 search, topic relevance,
 * and recency scoring. Artifacts in 'fresh' or 'materialized' state.
 */
export function formatMaterializationLayer(artifacts: ArtifactRow[]): string | null {
  try {
    if (!artifacts || artifacts.length === 0) return null;

    // Only render artifacts that have content
    const withContent = artifacts.filter((a) => a.content && a.content.trim().length > 0);
    if (withContent.length === 0) return null;

    const entries = withContent.map((a) => {
      const abbrev = ARTIFACT_TYPE_ABBREV[a.artifact_type] ?? a.artifact_type;
      return `### [${abbrev}] ${a.summary}\n${a.content}`;
    });

    return `## Materialized Context\n${entries.join('\n\n')}`;
  } catch {
    return null;
  }
}
