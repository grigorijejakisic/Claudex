/**
 * V17 stale-review.md file I/O.
 *
 * Two-phase migration flow (per Plan 02-03 and CONTEXT Decision 8):
 *   - `migrate:v17:dry-run` writes stale-review.md with heuristic matches
 *     (each defaulted to `decision: stale`; user flips to `keep` to veto).
 *   - Humans optionally edit the file and add rows under "Manual additions".
 *   - `migrate:v17:apply` reads the file. Missing/malformed ⇒ abort.
 *
 * File format (exact — parser regex is strict):
 *
 *   # P1 stale review
 *
 *   ## Heuristic matches (decision: stale unless flipped to keep)
 *
 *   - id=42 | status=stale | triggers=[Gemma 4 31B] | content="..."
 *   - id=47 | status=stale | triggers=[llama-server:8081] | content="..."
 *
 *   ## Manual additions (decision: stale)
 *
 *   <!-- add additional stale rows below -->
 *   - id=99 | status=stale | content="..."
 */

import * as fs from 'fs';
import type { StaleMatch, StaleKeyword } from './v17-stale-scan.js';

export interface HeuristicEntry {
  legacyId: number;
  decision: 'stale' | 'keep';
  contentPreview: string;
  triggers: string[];
}

export interface ManualEntry {
  legacyId: number;
  decision: 'stale';
  contentPreview: string;
}

export interface StaleReviewFile {
  heuristicMatches: HeuristicEntry[];
  manualAdditions: ManualEntry[];
}

const HEADER = '# P1 stale review';
const HEURISTIC_HEADING = '## Heuristic matches (decision: stale unless flipped to keep)';
const MANUAL_HEADING = '## Manual additions (decision: stale)';
const MANUAL_PLACEHOLDER = '<!-- add additional stale rows below -->';

/** Serialize a StaleMatch list to the canonical stale-review.md file. */
export function writeStaleReview(pathOnDisk: string, matches: StaleMatch[]): void {
  const lines: string[] = [];
  lines.push(HEADER);
  lines.push('');
  lines.push(HEURISTIC_HEADING);
  lines.push('');
  if (matches.length === 0) {
    lines.push('<!-- no heuristic matches found -->');
  } else {
    // Sort deterministically by legacyId ascending — scanStaleRows already
    // does this, but assert here so unit tests on writeStaleReview directly
    // don't rely on caller order.
    const sorted = [...matches].sort((a, b) => a.legacyId - b.legacyId);
    for (const m of sorted) {
      const triggersField = m.triggers.length > 0 ? ` | triggers=[${m.triggers.join(', ')}]` : '';
      const safeContent = sanitizeForLine(m.contentPreview);
      lines.push(`- id=${m.legacyId} | status=stale${triggersField} | content="${safeContent}"`);
    }
  }
  lines.push('');
  lines.push(MANUAL_HEADING);
  lines.push('');
  lines.push(MANUAL_PLACEHOLDER);
  lines.push('');
  fs.writeFileSync(pathOnDisk, lines.join('\n'), 'utf8');
}

/**
 * Parse a stale-review.md file.
 * Missing file → throws with "missing" in the message.
 * Malformed line → throws with the line number.
 */
export function parseStaleReview(pathOnDisk: string): StaleReviewFile {
  if (!fs.existsSync(pathOnDisk)) {
    throw new Error(
      `stale-review.md missing at ${pathOnDisk} — run migrate:v17:dry-run first and commit the result`,
    );
  }
  const content = fs.readFileSync(pathOnDisk, 'utf8');
  const lines = content.split(/\r?\n/);

  const heuristicMatches: HeuristicEntry[] = [];
  const manualAdditions: ManualEntry[] = [];

  let section: 'none' | 'heuristic' | 'manual' = 'none';

  // Match lines like:
  //   - id=42 | status=stale | triggers=[kw1, kw2] | content="..."
  //   - id=42 | status=keep  | content="..."   (manual additions omit triggers=[])
  const lineRe = /^-\s+id=(\d+)\s*\|\s*status=(stale|keep)(?:\s*\|\s*triggers=\[([^\]]*)\])?\s*\|\s*content="(.*)"$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const line = raw.trim();
    if (!line) continue;

    if (line === HEURISTIC_HEADING) { section = 'heuristic'; continue; }
    if (line === MANUAL_HEADING) { section = 'manual'; continue; }
    // Skip header, HTML comments, and any non-list lines.
    if (line.startsWith('#') || line.startsWith('<!--')) continue;
    if (!line.startsWith('-')) continue;

    const m = line.match(lineRe);
    if (!m) {
      throw new Error(
        `stale-review.md malformed at line ${i + 1}: ${raw}`,
      );
    }
    const legacyId = Number(m[1]);
    const decision = m[2] as 'stale' | 'keep';
    const triggersStr = m[3] ?? '';
    const contentPreview = m[4];
    const triggers = triggersStr
      ? triggersStr.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    if (section === 'heuristic') {
      heuristicMatches.push({ legacyId, decision, contentPreview, triggers });
    } else if (section === 'manual') {
      if (decision !== 'stale') {
        throw new Error(
          `stale-review.md malformed at line ${i + 1}: manual addition must have status=stale`,
        );
      }
      manualAdditions.push({ legacyId, decision, contentPreview });
    } else {
      throw new Error(
        `stale-review.md malformed at line ${i + 1}: entry outside any section — ${raw}`,
      );
    }
  }

  return { heuristicMatches, manualAdditions };
}

/**
 * Resolve the final set of legacy integer ids that should be flagged `stale`.
 *
 * Heuristic rows with `decision: stale` are included; `keep` vetoes.
 * Manual additions (always `stale`) are always included.
 */
export function getStaleIds(parsed: StaleReviewFile): Set<number> {
  const ids = new Set<number>();
  for (const h of parsed.heuristicMatches) {
    if (h.decision === 'stale') ids.add(h.legacyId);
  }
  for (const m of parsed.manualAdditions) {
    ids.add(m.legacyId);
  }
  return ids;
}

function sanitizeForLine(s: string): string {
  // Double-quotes would break our regex; escape them. Also collapse whitespace.
  return s.replace(/\s+/g, ' ').replace(/"/g, '\\"');
}

export type { StaleKeyword };
