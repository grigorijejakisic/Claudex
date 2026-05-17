/**
 * last-session-synthesis.ts — Phase 14-07k session-start render section.
 *
 * Reads the most-recent LastSessionSynthesis V17 artifact for the current
 * project and renders it as a P0 block at session-start (first-class,
 * before handoff summary and all other sections).
 *
 * Fallback discipline: returns empty string when no synthesis exists
 * (first session; prior session's LSS failed; Ollama was down). Never
 * shows a placeholder or error message to the operator.
 *
 * Section priority: P0 — rendered first by assembler.ts.
 */

import type { Database } from 'better-sqlite3';
import { estimateTokens } from '../../shared/text-utils.js';
import type { LastSessionSynthesis } from '../../angel/last-session-synthesis.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FormatLSSParams {
  db: Database;
  project: string;
}

// ---------------------------------------------------------------------------
// Token budget for this section
// ---------------------------------------------------------------------------

/** Maximum tokens for the rendered LSS section. */
export const LSS_SECTION_BUDGET_TOKENS = 400;

/** Maximum pivots/positions to render (favoring most recent). */
const MAX_BULLETS_PER_LIST = 5;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Phase 14-07k — session-start render of the most-recent LastSessionSynthesis.
 *
 * Reads V17 artifact (kind='session_synthesis') for the current project.
 * Returns the rendered section, or empty string when no synthesis exists.
 * Silent fallback — no placeholder, no error message visible to operator.
 *
 * Section priority: P0 (top of session-start, above the handoff summary).
 */
export function formatLastSessionSynthesisSection(p: FormatLSSParams): string {
  try {
    // Detect project column (V34+ 'project', V33- 'project_id')
    const projectCol = _getProjectCol(p.db);

    // Query most-recent session_synthesis artifact for this project
    const row = p.db.prepare(
      `SELECT body, created_at_epoch_ms FROM artifact
       WHERE ${projectCol} = ? AND kind = 'session_synthesis'
       ORDER BY created_at_epoch_ms DESC LIMIT 1`
    ).get(p.project) as { body: string; created_at_epoch_ms: number } | undefined;

    if (!row) {
      // Silent fallback — no synthesis yet for this project
      return '';
    }

    // Parse body
    let synthesis: LastSessionSynthesis;
    try {
      synthesis = JSON.parse(row.body) as LastSessionSynthesis;
    } catch {
      // Emit render-failure telemetry via session_events
      try {
        p.db.prepare(
          `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
           VALUES ('render', ?, 'lss_render_failed', 'lss', 'parse', ?)`
        ).run(p.project, JSON.stringify({ reason: 'parse', project: p.project }));
      } catch { /* non-throwing */ }
      return '';
    }

    // Validate basic structure
    if (!synthesis || typeof synthesis !== 'object') return '';

    return _renderSection(synthesis);
  } catch {
    // Non-throwing — section is advisory
    return '';
  }
}

// ---------------------------------------------------------------------------
// Internal rendering
// ---------------------------------------------------------------------------

function _renderSection(s: LastSessionSynthesis): string {
  const lines: string[] = [];

  lines.push('## Last Session — Synthesis\n');

  // Low-confidence annotation
  if (s.degraded === true) {
    lines.push('_[low-confidence synthesis — verify against transcript before relying]_\n');
  }

  // Operator pivots
  if (s.operator_pivots && s.operator_pivots.length > 0) {
    lines.push('**Operator\'s pivots:**');
    // Sort by at_turn desc to favor most recent; cap at MAX_BULLETS_PER_LIST
    const sorted = [...s.operator_pivots].sort((a, b) => b.at_turn - a.at_turn);
    const capped = sorted.slice(0, MAX_BULLETS_PER_LIST);
    for (const pivot of capped) {
      lines.push(`- ${pivot.pivot_summary}`);
    }
    lines.push('');
  } else {
    lines.push('**Operator\'s pivots:**');
    lines.push('- (none recorded)');
    lines.push('');
  }

  // Agent positions
  if (s.agent_positions && s.agent_positions.length > 0) {
    lines.push('**Agent\'s positions:**');
    const sorted = [...s.agent_positions].sort((a, b) => b.at_turn - a.at_turn);
    const capped = sorted.slice(0, MAX_BULLETS_PER_LIST);
    for (const pos of capped) {
      lines.push(`- ${pos.position_summary}`);
    }
    lines.push('');
  } else {
    lines.push('**Agent\'s positions:**');
    lines.push('- (none recorded)');
    lines.push('');
  }

  // Unresolved
  const unresolved = s.last_unresolved_question ?? '—';
  lines.push(`**Unresolved:** ${unresolved}\n`);

  // Next action
  const nextAction = s.recommended_next_action ?? '(none)';
  lines.push(`**Next action:** ${nextAction}\n`);

  const rendered = lines.join('\n');

  // Token cap enforcement — truncate bullets if over budget
  if (estimateTokens(rendered) <= LSS_SECTION_BUDGET_TOKENS) {
    return rendered;
  }

  return _truncateToBudget(s);
}

/**
 * Renders a budget-constrained version of the synthesis.
 * Progressively drops bullets (oldest first) until under LSS_SECTION_BUDGET_TOKENS.
 */
function _truncateToBudget(s: LastSessionSynthesis): string {
  // Start with 1 pivot and 1 position, expand until budget is hit
  const pivotsSorted = [...(s.operator_pivots ?? [])].sort((a, b) => b.at_turn - a.at_turn);
  const positionsSorted = [...(s.agent_positions ?? [])].sort((a, b) => b.at_turn - a.at_turn);

  let pivotCount = Math.min(1, pivotsSorted.length);
  let posCount = Math.min(1, positionsSorted.length);

  while (pivotCount <= pivotsSorted.length || posCount <= positionsSorted.length) {
    const candidate = _buildRendered(
      pivotsSorted.slice(0, pivotCount),
      positionsSorted.slice(0, posCount),
      s.last_unresolved_question ?? '—',
      s.recommended_next_action ?? '(none)',
      s.degraded === true,
    );

    if (estimateTokens(candidate) <= LSS_SECTION_BUDGET_TOKENS) {
      // Try adding one more of whichever list still has more
      const canAddPivot = pivotCount < pivotsSorted.length;
      const canAddPos = posCount < positionsSorted.length;

      if (!canAddPivot && !canAddPos) return candidate;
      if (canAddPivot) pivotCount++;
      else if (canAddPos) posCount++;
    } else {
      // Over budget: back off last increment
      if (pivotCount > 1) pivotCount--;
      else if (posCount > 1) posCount--;
      break;
    }
  }

  return _buildRendered(
    pivotsSorted.slice(0, pivotCount),
    positionsSorted.slice(0, posCount),
    s.last_unresolved_question ?? '—',
    s.recommended_next_action ?? '(none)',
    s.degraded === true,
  );
}

function _buildRendered(
  pivots: Array<{ at_turn: number; pivot_summary: string }>,
  positions: Array<{ at_turn: number; position_summary: string }>,
  unresolved: string,
  nextAction: string,
  degraded: boolean,
): string {
  const lines: string[] = [];
  lines.push('## Last Session — Synthesis\n');

  if (degraded) {
    lines.push('_[low-confidence synthesis — verify against transcript before relying]_\n');
  }

  lines.push('**Operator\'s pivots:**');
  if (pivots.length > 0) {
    for (const p of pivots) lines.push(`- ${p.pivot_summary}`);
  } else {
    lines.push('- (none recorded)');
  }
  lines.push('');

  lines.push('**Agent\'s positions:**');
  if (positions.length > 0) {
    for (const p of positions) lines.push(`- ${p.position_summary}`);
  } else {
    lines.push('- (none recorded)');
  }
  lines.push('');

  lines.push(`**Unresolved:** ${unresolved}\n`);
  lines.push(`**Next action:** ${nextAction}\n`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project column detection (V34+ uses 'project'; V33- uses 'project_id')
// ---------------------------------------------------------------------------

const _projectColCache = new WeakMap<Database, string>();

function _getProjectCol(db: Database): string {
  const cached = _projectColCache.get(db);
  if (cached) return cached;
  try {
    const cols = (db.pragma('table_info(artifact)') as Array<{ name: string }>).map(c => c.name);
    const col = cols.includes('project') ? 'project' : 'project_id';
    _projectColCache.set(db, col);
    return col;
  } catch {
    return 'project';
  }
}
