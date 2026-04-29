/**
 * Read-only .planning/ filesystem reader for GSD integration.
 * Non-throwing.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GsdState } from './types.js';

/**
 * Reads GSD planning state from the .planning/ directory.
 * Returns null when .planning/ doesn't exist or content can't be parsed.
 * Non-throwing.
 */
export function readGsdState(projectDir: string): GsdState | null {
  try {
    const statePath = path.join(projectDir, '.planning', 'STATE.md');
    if (!fs.existsSync(statePath)) return null;

    const stateContent = fs.readFileSync(statePath, 'utf8');
    const parsed = parseStateMd(stateContent);
    if (!parsed) return null;

    let goal = '';
    let successCriteria: string[] = [];

    const roadmapPath = path.join(projectDir, '.planning', 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
      const phaseInfo = parsePhaseFromRoadmap(roadmapContent, parsed.phase);
      if (phaseInfo) {
        goal = phaseInfo.goal;
        successCriteria = phaseInfo.successCriteria;
      }
    }

    // Count checkboxes in phase plan files
    const phasesDir = path.join(projectDir, '.planning', 'phases');
    let completion = '0/0 requirements met';
    if (fs.existsSync(phasesDir)) {
      const phaseDir = findPhaseDir(phasesDir, parsed.phase);
      if (phaseDir) {
        const counts = countCheckboxes(phaseDir);
        completion = `${counts.checked}/${counts.total} requirements met`;
      }
    }

    return {
      phase: parsed.phase,
      phase_string: parsed.phase_string,
      phase_name: parsed.phase_name,
      plan: parsed.plan,
      status: parsed.status,
      goal,
      success_criteria: successCriteria,
      completion,
    };
  } catch {
    return null;
  }
}

/**
 * Parses phase, plan, and status from STATE.md content.
 * Handles both `Phase: N of M` (numeric) and `Current Phase: N.M` (decimal).
 * Also extracts `Current Phase Name:` for INJ-06 prime contract.
 * @internal exported for tests.
 */
export function parseStateMd(content: string): {
  phase: number;
  /** Raw phase token as written in STATE.md (e.g. "5", "4.1"). Used by INJ-06 EXACT match. */
  phase_string: string;
  phase_name?: string;
  plan: number;
  status: string;
} | null {
  // Decimal-aware match: `Current Phase: 4.1 (...)`, `**Current Phase:** 5`, or `Phase: 5`.
  // \*+ tolerates leading/trailing markdown bold (`**Current Phase:**`).
  const decimalMatch = content.match(/Current Phase:\**\s*\*?([0-9]+(?:\.[0-9]+)?)/);
  const phaseMatch = decimalMatch ?? content.match(/Phase:\**\s*\*?([0-9]+(?:\.[0-9]+)?)/);
  const planMatch =
    content.match(/Current Plan:\**\s*\*?(\d+)/) ?? content.match(/Plan:\**\s*\*?(\d+)/);
  const statusMatch = content.match(/Status:\**\s*(.+)/);
  const phaseNameMatch = content.match(/Current Phase Name:\**\s*(.+)/);

  if (!phaseMatch) return null;

  const phaseString = phaseMatch[1].trim();
  // Use parseFloat for decimal phases so callers can compare numerically;
  // round-trip through phase_string preserves canonical token for EXACT match.
  const phaseNum = parseFloat(phaseString);

  return {
    phase: Number.isFinite(phaseNum) ? phaseNum : parseInt(phaseString, 10),
    phase_string: phaseString,
    phase_name: phaseNameMatch ? phaseNameMatch[1].trim() : undefined,
    plan: planMatch ? parseInt(planMatch[1], 10) : 0,
    status: statusMatch ? statusMatch[1].trim() : 'unknown',
  };
}

/**
 * Extracts goal and success criteria for a given phase from ROADMAP.md.
 * @internal
 */
function parsePhaseFromRoadmap(
  content: string,
  phase: number
): { goal: string; successCriteria: string[] } | null {
  // Find the phase section header: ### Phase N:
  const headerPattern = new RegExp(`### Phase ${phase}:.*`, 'm');
  const headerMatch = content.match(headerPattern);
  if (!headerMatch || headerMatch.index === undefined) return null;

  // Extract content from this phase section until next ### header
  const sectionStart = headerMatch.index;
  const nextSection = content.indexOf('\n### ', sectionStart + 1);
  const sectionContent = nextSection >= 0
    ? content.slice(sectionStart, nextSection)
    : content.slice(sectionStart);

  // Extract goal
  const goalMatch = sectionContent.match(/\*\*Goal\*\*:\s*(.+)/);
  const goal = goalMatch ? goalMatch[1].trim() : '';

  // Extract success criteria (numbered items after **Success Criteria**)
  const successCriteria: string[] = [];
  const criteriaStart = sectionContent.indexOf('**Success Criteria**');
  if (criteriaStart >= 0) {
    const criteriaContent = sectionContent.slice(criteriaStart);
    const itemPattern = /^\s*\d+\.\s+(.+)/gm;
    // CACH-03: explicit reset — itemPattern is freshly declared so lastIndex is
    // 0, but be defensive in case future maintainers hoist the regex.
    itemPattern.lastIndex = 0;
    let match;
    while ((match = itemPattern.exec(criteriaContent)) !== null) {
      successCriteria.push(match[1].trim());
    }
  }

  return { goal, successCriteria };
}

/**
 * Finds the phase directory by matching zero-padded phase number prefix.
 * @internal
 */
function findPhaseDir(phasesDir: string, phase: number): string | null {
  const prefix = String(phase).padStart(2, '0');
  const entries = fs.readdirSync(phasesDir);
  const match = entries.find((e) => e.startsWith(prefix));
  if (!match) return null;

  const fullPath = path.join(phasesDir, match);
  return fs.statSync(fullPath).isDirectory() ? fullPath : null;
}

/**
 * Counts checked and unchecked checkboxes in all .md files in a directory.
 * @internal
 */
function countCheckboxes(dir: string): { checked: number; total: number } {
  let checked = 0;
  let unchecked = 0;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const checkedMatches = content.match(/- \[x\]/g);
    const uncheckedMatches = content.match(/- \[ \]/g);
    if (checkedMatches) checked += checkedMatches.length;
    if (uncheckedMatches) unchecked += uncheckedMatches.length;
  }

  return { checked, total: checked + unchecked };
}

