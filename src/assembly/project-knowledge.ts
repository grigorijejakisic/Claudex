/**
 * Phase 14 Plan 14-04 — P2.7 Project Knowledge surface.
 *
 * Surfaces top-K substantive same-project artifacts at session-start,
 * routed through hybrid retrieval with ACTIVE.md `summary` as the
 * implicit query. Closes the same-project starvation gap that
 * Experience Tier (cross-project only) and Recent Session Frames
 * (highlight-dependent) leave open.
 *
 * Returns null when ACTIVE.md missing OR summary empty OR no
 * substantive artifacts retrieved. Cache-stable: no clock data.
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { parseHandoffHeader } from '../angel/handoff-writer.js';
import { hybridSearchAsync, hybridSearchSync } from '../core/hybrid-retrieval.js';
import { getHandoffsDir } from '../shared/paths.js';
import { estimateTokens, normalizeText } from '../shared/text-utils.js';

export const P27_TOP_K = 3;
export const P27_TITLE_MAX_CHARS = 120;
export const P27_EXCERPT_LINES = 3;

/**
 * Minimal row shape consumed by the P2.7 renderer.
 * Covers both legacy `artifacts` columns and V17 `artifact` columns.
 */
interface ArtifactLike {
  id?: number;
  summary?: string;
  title?: string;         // V17 artifact table
  artifact_ref?: string | null;
  artifact_type?: string;
  kind?: string;           // V17 artifact table
  content?: string | null;
  body?: string;           // V17 artifact table
}

/**
 * Read the ACTIVE.md summary field for a given project directory.
 * Returns null when ACTIVE.md is missing, has no frontmatter, or has an empty summary.
 * Non-throwing.
 */
function readActiveSummary(projectDir: string): string | null {
  try {
    const handoffPath = path.join(getHandoffsDir(projectDir), 'ACTIVE.md');
    if (!fs.existsSync(handoffPath)) return null;
    const raw = normalizeText(fs.readFileSync(handoffPath, 'utf-8'));
    const header = parseHandoffHeader(raw);
    if (!header) return null;
    const summary = (header.summary ?? '').trim();
    return summary || null;
  } catch {
    return null;
  }
}

/**
 * Apply budget enforcement: drop lowest-ranked entries until within budget,
 * with single-entry excerpt truncation as final fallback. Returns null if
 * even a truncated single entry exceeds the cap.
 */
function applyBudget(entries: ArtifactLike[], budgetTokens: number): string | null {
  let candidates = entries.slice();
  while (candidates.length > 0) {
    const rendered = renderSection(candidates);
    if (estimateTokens(rendered) <= budgetTokens) return rendered;
    if (candidates.length === 1) {
      const truncated = renderSectionTruncated(candidates, budgetTokens);
      if (truncated && estimateTokens(truncated) <= budgetTokens) return truncated;
      return null;
    }
    candidates = candidates.slice(0, candidates.length - 1); // drop lowest-ranked
  }
  return null;
}

/**
 * Format the P2.7 Project Knowledge section (synchronous variant).
 *
 * Used by assembleFullContext (sync cascade). Uses the FTS5 + recency
 * channels only (no vector search) — same as hybridSearchSync.
 *
 * Returns null when ACTIVE.md missing OR summary empty OR no
 * substantive artifacts retrieved. Cache-stable: no clock data.
 *
 * @param db           - Open SQLite database handle.
 * @param project      - Project slug (matches artifacts.project column).
 * @param projectDir   - Absolute path to the project root.
 * @param budgetTokens - Maximum token budget (hard cap 800 per plan).
 */
export function formatProjectKnowledgeSectionSync(
  db: Database,
  project: string,
  projectDir: string,
  budgetTokens: number,
): string | null {
  try {
    const summary = readActiveSummary(projectDir);
    if (!summary) return null;

    const results = hybridSearchSync(db, summary, project, {
      limit: P27_TOP_K,
      globalScope: false,
      substantiveOnly: true,
    });
    if (!results || results.length === 0) return null;

    return applyBudget(results as ArtifactLike[], budgetTokens);
  } catch {
    return null;
  }
}

/**
 * Format the P2.7 Project Knowledge section (async variant).
 *
 * Uses the full hybrid pipeline (FTS5 + Qdrant KNN + recency + graph walk).
 * Prefer this variant when the caller is async (e.g., tests, async hooks).
 *
 * Returns null when ACTIVE.md missing OR summary empty OR no
 * substantive artifacts retrieved. Cache-stable: no clock data.
 *
 * @param db           - Open SQLite database handle.
 * @param project      - Project slug (matches artifacts.project column).
 * @param projectDir   - Absolute path to the project root.
 * @param budgetTokens - Maximum token budget (hard cap 800 per plan).
 */
export async function formatProjectKnowledgeSection(
  db: Database,
  project: string,
  projectDir: string,
  budgetTokens: number,
): Promise<string | null> {
  try {
    const summary = readActiveSummary(projectDir);
    if (!summary) return null;

    const results = await hybridSearchAsync(db, summary, project, {
      limit: P27_TOP_K,
      globalScope: false,
      substantiveOnly: true,
    });
    if (!results || results.length === 0) return null;

    return applyBudget(results as ArtifactLike[], budgetTokens);
  } catch {
    return null;
  }
}

/**
 * Render entries as a `## Project Knowledge` section.
 * Each entry: heading (title), source reference, excerpt.
 * No clock-derived data (CACH-02).
 */
function renderSection(entries: ArtifactLike[]): string {
  const lines: string[] = ['## Project Knowledge'];
  for (const r of entries) {
    const rawTitle = (r.summary ?? r.title ?? 'Untitled');
    const title = rawTitle.slice(0, P27_TITLE_MAX_CHARS);
    const ref = r.artifact_ref ?? `${r.artifact_type ?? r.kind ?? 'artifact'}#${r.id ?? '?'}`;
    const body = r.content ?? r.body ?? '';
    const excerpt = body.split('\n').slice(0, P27_EXCERPT_LINES).join('\n');
    lines.push(`### ${title}`);
    lines.push(`*Source: ${ref}*`);
    if (excerpt.trim()) lines.push(excerpt);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Truncate-and-render the single entry's excerpt to fit within budgetTokens.
 * Returns null if truncation cannot bring it under budget.
 */
function renderSectionTruncated(entries: ArtifactLike[], budgetTokens: number): string | null {
  if (entries.length !== 1) return null;
  const r = entries[0];
  const rawTitle = (r.summary ?? r.title ?? 'Untitled');
  const title = rawTitle.slice(0, P27_TITLE_MAX_CHARS);
  const ref = r.artifact_ref ?? `${r.artifact_type ?? r.kind ?? 'artifact'}#${r.id ?? '?'}`;
  const body = r.content ?? r.body ?? '';
  const headingLine = `## Project Knowledge\n### ${title}\n*Source: ${ref}*`;
  const headingTokens = estimateTokens(headingLine);
  if (headingTokens > budgetTokens) return null;

  // Try to add as many lines of excerpt as fit.
  const allLines = body.split('\n');
  let excerpt = '';
  for (let i = 0; i < Math.min(P27_EXCERPT_LINES, allLines.length); i++) {
    const candidate = excerpt + (excerpt ? '\n' : '') + allLines[i];
    const candidateSection = `${headingLine}\n${candidate}`;
    if (estimateTokens(candidateSection) > budgetTokens) break;
    excerpt = candidate;
  }

  const result = excerpt.trim() ? `${headingLine}\n${excerpt}` : headingLine;
  return estimateTokens(result) <= budgetTokens ? result : null;
}
