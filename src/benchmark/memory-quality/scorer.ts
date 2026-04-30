/**
 * SC#3 mechanical scorer for MEMORY.md content quality.
 *
 * Pure function: (path + options) → MemoryQualityScore.
 * Does NOT call Ollama, the DB, or the network — runs in seconds against any
 * MEMORY.md on disk. Phase 4.1's `phase-4-1-content-quality-scorer.test.ts`
 * test-time scorer is the prior art; this lifts it into production with the
 * 5-dimension × 20-point rubric Phase 11 CONTEXT.md specifies.
 */

import * as fs from 'fs';
import { findUserTailStart } from '../../angel/memory-md-writer.js';
import type {
  MemoryQualityScore,
  ParsingDimension,
  ProjectSpecificDimension,
  TopicsDimension,
  DensityDimension,
  HandoffFreshnessDimension,
  DimensionScore,
} from './types.js';

export interface ScoreOptions {
  /** Project slug (used as the "project-specific" reference for dim 2). */
  project: string;
  /** Optional path to context/handoffs/ACTIVE.md for dim 5 freshness check. */
  activeHandoffPath?: string;
}

/** Top-level entry point — read file, score it, return structured result. */
export function scoreMemoryFile(
  memoryPath: string,
  opts: ScoreOptions,
): MemoryQualityScore {
  const content = fs.readFileSync(memoryPath, 'utf8');
  return scoreMemoryContent(content, memoryPath, opts);
}

/**
 * Pure-string variant — useful for tests that want to feed synthetic content
 * without round-tripping through fs.
 */
export function scoreMemoryContent(
  content: string,
  memoryPath: string,
  opts: ScoreOptions,
): MemoryQualityScore {
  const parsing = scoreParsing(content);
  // If parsing fails, all other dims are 0 (hard fail dimension).
  if (parsing.score === 0) {
    const zero = (max: 20): DimensionScore => ({ score: 0, max });
    const result: MemoryQualityScore = {
      project: opts.project,
      memoryPath,
      total: 0,
      pass: false,
      dimensions: {
        parsing,
        projectSpecific: { ...zero(20), total: 0, specific: 0 },
        topicsNotSessionIds: { ...zero(20), total: 0, topicLabeled: 0 },
        pointerDensity: { ...zero(20), ratio: 0, nonblankLines: 0, pointers: 0 },
        handoffFreshness: { ...zero(20), details: 'skipped: parsing failed' },
      },
    };
    return result;
  }

  const projectSpecific = scoreProjectSpecific(content, opts.project);
  const topicsNotSessionIds = scoreTopicsNotSessionIds(content);
  const pointerDensity = scorePointerDensity(content);
  const handoffFreshness = scoreHandoffFreshness(content, opts.activeHandoffPath);

  const total =
    parsing.score +
    projectSpecific.score +
    topicsNotSessionIds.score +
    pointerDensity.score +
    handoffFreshness.score;

  return {
    project: opts.project,
    memoryPath,
    total,
    pass: total >= 80,
    dimensions: {
      parsing,
      projectSpecific,
      topicsNotSessionIds,
      pointerDensity,
      handoffFreshness,
    },
  };
}

/* ---------- Dimension 1: parsing (20 pts hard-fail) ---------- */

export function scoreParsing(content: string): ParsingDimension {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (!/^<!-- CLAUDEX-MANAGED:.* hash=[0-9a-f]{64} -->$/.test(lines[0] ?? '')) {
    return { score: 0, max: 20, details: 'Missing or malformed top sentinel' };
  }
  const markerOffset = findUserTailStart(content);
  if (markerOffset < 0) {
    return { score: 0, max: 20, details: 'Missing line-anchored <!-- USER EDITABLE --> marker' };
  }
  const managedSection = content.slice(0, markerOffset);
  const headers = managedSection.split('\n').filter(l => /^## /.test(l));
  const unique = new Set(headers);
  if (unique.size !== headers.length) {
    return {
      score: 0,
      max: 20,
      details: `Duplicated managed-section headers: ${headers.length - unique.size}`,
    };
  }
  return { score: 20, max: 20, details: 'OK' };
}

/* ---------- Dimension 2: project-specific pointers (20 pts) ---------- */

/**
 * Count lines of shape `- [Title](pointer-target.md) — extra` and decide
 * which pointer targets are "project-specific". A pointer is project-specific if:
 *   (a) the pointer is a Lessons-style filename matching feedback_/project_/process_
 *       — these by convention live in the project's memory dir; OR
 *   (b) the pointer text or the surrounding line contains the project's slug
 *       or a common known-project token.
 *
 * Phase 11 correctness fix (per team-lead 2026-04-30): Phase 4.1 designed
 * `## User Notes` (below the `<!-- USER EDITABLE -->` marker) as
 * human-authority territory and explicitly preserved user-curated pointer
 * indexes from Lacuna/Oracle/Nexus verbatim. Per the user-quoted audit:
 * "the user's manual pointer-indexes are the gold standard; auto-curator
 * helps, never replaces." Therefore user-curated User Notes pointers are
 * lessons-equivalent for SC#3 scoring — just human-authored rather than
 * Angel-synthesized. When the managed `## Lessons` section has fewer than
 * 3 pointer entries, fall back to counting pointer-shaped lines in the
 * User Notes tail. This is a CORRECTNESS fix, not a threshold change.
 *
 * Returns 0 if there are no pointers at all (no signal); otherwise scales
 * linearly against the 80% bar — 80%+ project-specific = full 20pts.
 */
export function scoreProjectSpecific(
  content: string,
  project: string,
): ProjectSpecificDimension {
  const managedSection = sliceManaged(content);
  const managedPointers = managedSection
    .split('\n')
    .filter(l => /^- \[/.test(l));

  // Phase 4.1 honor-user-curation correctness fix: when managed Lessons is
  // sparse (<3 entries), count User Notes pointer-shaped lines.
  let pointerLines = managedPointers;
  let source: 'managed' | 'user-notes' = 'managed';
  if (managedPointers.length < 3) {
    const userNotes = sliceUserNotes(content);
    if (userNotes) {
      const userPointers = userNotes
        .split('\n')
        .filter(l => /^- \[/.test(l));
      if (userPointers.length >= managedPointers.length) {
        pointerLines = userPointers;
        source = 'user-notes';
      }
    }
  }

  if (pointerLines.length === 0) {
    return { score: 0, max: 20, total: 0, specific: 0 };
  }
  const slugTokens = projectSlugTokens(project);
  const lessonRe = /\((feedback|project|process|self|user)_[a-z0-9_-]+\.md\)/i;
  let specific = 0;
  for (const ln of pointerLines) {
    const isLesson = lessonRe.test(ln);
    const hasSlug = slugTokens.some(t => ln.toLowerCase().includes(t));
    // User-curated pointers in User Notes are gold-standard project-specific
    // by definition — the user wrote them, in this project's MEMORY.md, by
    // hand. Phase 4.1's design intent says this should count.
    if (isLesson || hasSlug || source === 'user-notes') specific += 1;
  }
  const ratio = specific / pointerLines.length;
  let score: number;
  if (ratio >= 0.8) score = 20;
  else score = Math.round(ratio * 20);
  return { score, max: 20, total: pointerLines.length, specific };
}

/* ---------- Dimension 3: topics not session-IDs (20 pts) ---------- */

/**
 * For pointer/list lines, count how many look like "topics" (≥1 alphabetic word
 * of length ≥3) vs how many look like raw session-IDs (UUID-shaped or
 * `session-XXXXXXXX`). Session-ID-only labels are penalized.
 *
 * Empty list → no penalty (returns full 20 — there is no garbage to flag).
 */
export function scoreTopicsNotSessionIds(content: string): TopicsDimension {
  const managedSection = sliceManaged(content);
  const pointerLines = managedSection
    .split('\n')
    .filter(l => /^- /.test(l));
  if (pointerLines.length === 0) {
    return { score: 20, max: 20, total: 0, topicLabeled: 0 };
  }
  const sessionRe = /session-[a-f0-9]{8}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const topicRe = /[A-Za-z]{3,}/;
  let topicLabeled = 0;
  for (const ln of pointerLines) {
    if (sessionRe.test(ln)) continue;
    if (topicRe.test(ln)) topicLabeled += 1;
  }
  const ratio = topicLabeled / pointerLines.length;
  const score = Math.min(20, Math.round(20 * ratio));
  return { score, max: 20, total: pointerLines.length, topicLabeled };
}

/* ---------- Dimension 4: pointer density (20 pts) ---------- */

/**
 * pointer count / nonblank line count.
 *   ≥0.10 → 20pts (full)
 *   linear 0.05 → 10pts up to 0.10 → 20pts
 *   <0.05 → 0pts
 */
export function scorePointerDensity(content: string): DensityDimension {
  const managedSection = sliceManaged(content);
  const allLines = managedSection.split('\n');
  const nonblank = allLines.filter(l => l.trim().length > 0);
  const pointers = nonblank.filter(l => /^- /.test(l));
  if (nonblank.length === 0) {
    return { score: 0, max: 20, ratio: 0, nonblankLines: 0, pointers: 0 };
  }
  const ratio = pointers.length / nonblank.length;
  let score: number;
  if (ratio >= 0.1) score = 20;
  else if (ratio >= 0.05) score = Math.round(10 + (ratio - 0.05) * (20 - 10) / (0.1 - 0.05));
  else score = 0;
  return {
    score,
    max: 20,
    ratio: Number(ratio.toFixed(3)),
    nonblankLines: nonblank.length,
    pointers: pointers.length,
  };
}

/* ---------- Dimension 5: handoff freshness (20 pts) ---------- */

/**
 * Compare MEMORY.md ## Handoff against context/handoffs/ACTIVE.md status:
 *   - MEMORY.md "No active handoff" + ACTIVE.md missing OR archived → 20 (consistent)
 *   - MEMORY.md links a handoff + ACTIVE.md status:active → 20 (consistent)
 *   - MEMORY.md "No active handoff" + ACTIVE.md status:active → 0 (drift)
 *   - any other combo → 10 (warn)
 */
export function scoreHandoffFreshness(
  content: string,
  activeHandoffPath?: string,
): HandoffFreshnessDimension {
  const managedSection = sliceManaged(content);
  const handoffMatch = managedSection.match(/## Handoff\n([\s\S]*?)(?=\n##|$)/);
  const memoryHasHandoff = handoffMatch
    ? !/no active handoff/i.test(handoffMatch[1] || '')
    && (handoffMatch[1] || '').trim().length > 0
    : false;

  let activeStatus: 'active' | 'archived' | 'paused' | 'missing' | 'unknown' = 'missing';
  if (activeHandoffPath) {
    try {
      if (fs.existsSync(activeHandoffPath)) {
        const raw = fs.readFileSync(activeHandoffPath, 'utf8');
        const fmMatch = raw.match(/^---[\s\S]*?status:\s*(\S+)[\s\S]*?---/m);
        if (fmMatch) {
          const s = fmMatch[1].toLowerCase().replace(/[",]/g, '');
          if (s === 'active' || s === 'archived' || s === 'paused') activeStatus = s;
          else activeStatus = 'unknown';
        } else {
          // No frontmatter → presence implies active by convention.
          activeStatus = 'active';
        }
      } else {
        activeStatus = 'missing';
      }
    } catch {
      activeStatus = 'unknown';
    }
  }

  let score: number;
  let details: string;
  if (!memoryHasHandoff && (activeStatus === 'missing' || activeStatus === 'archived')) {
    score = 20;
    details = `Consistent: MEMORY.md says no handoff; ACTIVE.md ${activeStatus}`;
  } else if (memoryHasHandoff && activeStatus === 'active') {
    score = 20;
    details = 'Consistent: MEMORY.md links handoff; ACTIVE.md status:active';
  } else if (!memoryHasHandoff && activeStatus === 'active') {
    score = 0;
    details = 'Drift: MEMORY.md says no handoff but ACTIVE.md is active';
  } else {
    score = 10;
    details = `Warn: memoryHasHandoff=${memoryHasHandoff}, activeStatus=${activeStatus}`;
  }
  return { score, max: 20, details };
}

/* ---------- helpers ---------- */

function sliceManaged(content: string): string {
  const offset = findUserTailStart(content);
  if (offset < 0) return content;
  return content.slice(0, offset);
}

/**
 * Return the human-authored tail content (everything after the
 * `<!-- USER EDITABLE -->` marker), or null if the marker is absent.
 * Used by the project-specific dimension to honor Phase 4.1's design
 * intent that user-curated pointers in `## User Notes` are gold-standard.
 */
function sliceUserNotes(content: string): string | null {
  const offset = findUserTailStart(content);
  if (offset < 0) return null;
  return content.slice(offset);
}

function projectSlugTokens(project: string): string[] {
  // The project slug in projects.json is e.g. "lacuna-betting-9f1d552c".
  // Split on '-' and keep alphabetic tokens of length ≥3 — these are the
  // "project-specific" tokens that should appear in pointers / line content
  // when the entry truly references this project.
  const lower = project.toLowerCase();
  const parts = lower
    .split(/[-_]/)
    .filter(p => p.length >= 3 && /^[a-z]/.test(p))
    // Drop obviously generic tokens that match too freely.
    .filter(p => !['main', 'master', 'project', 'repo', 'dev', 'src'].includes(p));
  if (parts.length === 0) return [lower];
  // Also include the full slug for an exact match opportunity.
  return Array.from(new Set([lower, ...parts]));
}
