/**
 * Worker Context Assembly — assembles task-specific knowledge packages for spawned workers.
 *
 * Queries Claudex DB and produces a lean, token-budgeted context string that a PM/main
 * agent can prepend to a worker's spawn prompt. Designed for the /team skill's spawn path.
 *
 * Priority model (hot/warm/cold per spec Section 1):
 *   Hot  — experience warnings + relevant learnings (500 tokens each)
 *   Warm — matched artifact summaries + hot files   (1000 + 500 tokens)
 *   Cold — primer excerpt (conventions + gotchas)   (500 tokens)
 *
 * Non-throwing. Each section is assembled independently; one failure never blocks others.
 * Returns empty package on catastrophic error.
 */

import * as fs from 'fs';
import * as path from 'path';
import { estimateTokens } from '../shared/text-utils.js';
import { tokenizeQuery } from '../shared/search-utils.js';
import { findMatchingPatterns } from '../intelligence/experience-patterns.js';
import { renderExperienceWarnings } from './sections.js';
import { searchArtifacts } from '../core/artifacts.js';
import { getHotFiles } from '../core/pressure.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { Database } from 'better-sqlite3';
import type { LearningRow } from '../core/learnings.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WorkerContextPackage {
  primer: string;
  relevantArtifacts: string;
  experienceWarnings: string;
  hotFiles: string;
  learnings: string;
  tokenBudget: number;
  /** Ready-to-inject string combining all non-empty sections. */
  formatted: string;
}

// Per-section token budgets (from spec)
const BUDGET_EXPERIENCE  = 500;
const BUDGET_LEARNINGS   = 500;
const BUDGET_ARTIFACTS   = 1000;
const BUDGET_HOT_FILES   = 500;
const BUDGET_PRIMER      = 500;
const DEFAULT_MAX_TOKENS = 3000;

/**
 * Reserved token budget for the outer header and section title strings.
 * "## Project Knowledge...\n\n" + up to 5 "### Section\n" + separators ≈ 50 tokens.
 * Deducted from maxTokens before distributing to content sections.
 */
const HEADER_OVERHEAD = 50;

const EMPTY_PACKAGE: WorkerContextPackage = {
  primer: '',
  relevantArtifacts: '',
  experienceWarnings: '',
  hotFiles: '',
  learnings: '',
  tokenBudget: 0,
  formatted: '',
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Assembles a task-specific knowledge package for a spawned worker.
 *
 * @param db               - Open Claudex SQLite database
 * @param taskDescription  - The task the worker will perform (used as search query)
 * @param project          - Project scope for all queries
 * @param opts.maxTokens   - Total token cap (default 3000)
 * @param opts.includeExperience - Whether to include experience warnings (default true)
 * @param opts.fileScope   - If provided, filter hot files to this set; else top by pressure
 */
export function assembleWorkerContext(
  db: Database,
  taskDescription: string,
  project: string,
  opts?: {
    maxTokens?: number;
    includeExperience?: boolean;
    fileScope?: string[];
  },
): WorkerContextPackage {
  try {
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const includeExperience = opts?.includeExperience !== false; // default true

    // Reserve budget for outer header + section title strings (~50 tokens).
    // This ensures the final formatted string stays within maxTokens.
    let remaining = Math.max(0, maxTokens - HEADER_OVERHEAD);

    // --- Section 1: Experience warnings (Hot, 500 tokens) ---
    let experienceWarnings = '';
    if (includeExperience) {
      experienceWarnings = assembleExperienceSection(db, taskDescription, project, BUDGET_EXPERIENCE);
    }
    const expCost = estimateTokens(experienceWarnings);
    if (expCost <= remaining) {
      remaining -= expCost;
    } else {
      experienceWarnings = truncateToTokens(experienceWarnings, remaining);
      remaining = 0;
    }

    // --- Section 2: Relevant learnings (Hot, 500 tokens) ---
    let learnings = '';
    if (remaining > 0) {
      learnings = assembleLearningsSection(db, taskDescription, project, Math.min(BUDGET_LEARNINGS, remaining));
      const cost = estimateTokens(learnings);
      remaining = Math.max(0, remaining - cost);
    }

    // --- Section 3: Matched artifacts (Warm, 1000 tokens) ---
    let relevantArtifacts = '';
    if (remaining > 0) {
      relevantArtifacts = assembleArtifactsSection(db, taskDescription, project, Math.min(BUDGET_ARTIFACTS, remaining));
      const cost = estimateTokens(relevantArtifacts);
      remaining = Math.max(0, remaining - cost);
    }

    // --- Section 4: Hot files (Warm, 500 tokens) ---
    let hotFiles = '';
    if (remaining > 0) {
      hotFiles = assembleHotFilesSection(db, project, opts?.fileScope, Math.min(BUDGET_HOT_FILES, remaining));
      const cost = estimateTokens(hotFiles);
      remaining = Math.max(0, remaining - cost);
    }

    // --- Section 5: Primer excerpt (Cold, 500 tokens) ---
    let primer = '';
    if (remaining > 0) {
      primer = assemblePrimerSection(project, Math.min(BUDGET_PRIMER, remaining));
      const cost = estimateTokens(primer);
      remaining = Math.max(0, remaining - cost);
    }

    // --- Format combined output ---
    const formatted = formatWorkerContext({
      experienceWarnings,
      learnings,
      relevantArtifacts,
      hotFiles,
      primer,
    });

    const tokenBudget = estimateTokens(formatted);

    return {
      primer,
      relevantArtifacts,
      experienceWarnings,
      hotFiles,
      learnings,
      tokenBudget,
      formatted,
    };
  } catch {
    return { ...EMPTY_PACKAGE };
  }
}

// ---------------------------------------------------------------------------
// Section assemblers (each is non-throwing, returns '' on any error)
// ---------------------------------------------------------------------------

/**
 * Experience warnings: FTS5 match against task description.
 * Uses existing findMatchingPatterns + renderExperienceWarnings (same path as main assembler).
 */
function assembleExperienceSection(
  db: Database,
  query: string,
  project: string,
  budget: number,
): string {
  try {
    if (!query || query.length < 3) return '';
    const patterns = findMatchingPatterns(db, query, project, 3);
    if (patterns.length === 0) return '';
    const section = renderExperienceWarnings(patterns);
    if (!section) return '';
    return truncateToTokens(section, budget);
  } catch {
    return '';
  }
}

/**
 * Relevant learnings: keyword LIKE search against task description.
 * The learnings table has no FTS5 virtual table, so we use tokenized LIKE queries.
 * Returns bullet-formatted learnings within budget.
 */
function assembleLearningsSection(
  db: Database,
  query: string,
  project: string,
  budget: number,
): string {
  try {
    if (!query || query.length < 3) return '';

    const keywords = tokenizeQuery(query, 5);
    if (keywords.length === 0) return '';

    // Build LIKE conditions for keyword matching on content
    const conditions = keywords.map(() => '(LOWER(content) LIKE ?)').join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    const rows = cachedPrepare(db,
      `SELECT * FROM learnings
       WHERE (project = ? OR project = '__global__')
         AND (${conditions})
       ORDER BY promotion_count DESC
       LIMIT 10`,
    ).all(project, ...likeParams) as LearningRow[];

    if (rows.length === 0) return '';

    const bullets = rows.map(r => `- ${r.content}`);
    const section = bullets.join('\n');
    return truncateToTokens(section, budget);
  } catch {
    return '';
  }
}

/**
 * Matched artifacts: searchArtifacts from artifacts.ts with task description as query.
 * Renders summaries only (not full content) per spec.
 */
function assembleArtifactsSection(
  db: Database,
  query: string,
  project: string,
  budget: number,
): string {
  try {
    if (!query || query.length < 3) return '';

    const artifacts = searchArtifacts(db, project, query, 15);
    if (artifacts.length === 0) return '';

    const lines: string[] = [];
    for (const a of artifacts) {
      lines.push(`- [${a.artifact_type}] ${a.summary}`);
    }
    const section = lines.join('\n');
    return truncateToTokens(section, budget);
  } catch {
    return '';
  }
}

/**
 * Hot files: top files by pressure score, filtered to fileScope if provided.
 * Returns a formatted list with file paths.
 */
function assembleHotFilesSection(
  db: Database,
  project: string,
  fileScope: string[] | undefined,
  budget: number,
): string {
  try {
    const hotRows = getHotFiles(db, project, 20);
    if (hotRows.length === 0) return '';

    let filtered = hotRows;
    if (fileScope && fileScope.length > 0) {
      // Normalize paths for comparison (forward slashes, lowercased)
      const scopeSet = new Set(fileScope.map(f => normalizePath(f)));
      filtered = hotRows.filter(r => scopeSet.has(normalizePath(r.file_path)));
      if (filtered.length === 0) return '';
    }

    const lines = filtered.map(r => `- ${r.file_path}`);
    const section = `Recently active files:\n${lines.join('\n')}`;
    return truncateToTokens(section, budget);
  } catch {
    return '';
  }
}

/**
 * Primer excerpt: reads PROJECT_PRIMER.md and extracts the "Patterns and Conventions"
 * and "Gotchas" sections only (not the full primer).
 * Falls back gracefully if the file doesn't exist or lacks those sections.
 */
function assemblePrimerSection(
  project: string,
  budget: number,
): string {
  try {
    // PROJECT_PRIMER.md lives at the project root. We receive project (name),
    // not projectDir. Use cwd-relative lookup: walk up from cwd looking for
    // PROJECT_PRIMER.md, or skip if not found. This is best-effort — the primer
    // is a Cold section and failure is acceptable.
    const primerContent = readProjectPrimer(project);
    if (!primerContent) return '';

    const extracted = extractPrimerSections(primerContent, [
      'Patterns and Conventions',
      'Gotchas',
    ]);
    if (!extracted) return '';
    return truncateToTokens(extracted, budget);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Primer reading and extraction
// ---------------------------------------------------------------------------

/**
 * Attempts to read PROJECT_PRIMER.md.
 * Tries cwd and common project root locations. Non-throwing, returns null on miss.
 */
function readProjectPrimer(project: string): string | null {
  try {
    // Try cwd-relative (most common case when claudex runs inside project)
    const candidates = [
      path.join(process.cwd(), 'PROJECT_PRIMER.md'),
      // Also try as absolute if project looks like a path
      ...(project.includes('/') || project.includes('\\')
        ? [path.join(project, 'PROJECT_PRIMER.md')]
        : []),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const content = fs.readFileSync(candidate, 'utf-8');
          if (content && content.trim().length > 0) return content;
        }
      } catch { /* try next */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts named sections from markdown primer content.
 * Matches headings (##, ###) containing any of the given section names.
 * Returns extracted content joined, or null if none found.
 */
function extractPrimerSections(content: string, sectionNames: string[]): string | null {
  try {
    const lines = content.split('\n');
    const extracted: string[] = [];

    let inSection = false;
    let currentSectionLines: string[] = [];

    for (const line of lines) {
      // Check if this line is a heading that matches one of our target sections
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headingMatch) {
        const headingText = headingMatch[1].trim();
        const isTargetSection = sectionNames.some(name =>
          headingText.toLowerCase().includes(name.toLowerCase()),
        );

        if (isTargetSection) {
          // Flush previous section if any
          if (currentSectionLines.length > 0) {
            extracted.push(currentSectionLines.join('\n').trim());
            currentSectionLines = [];
          }
          inSection = true;
          currentSectionLines.push(line);
        } else if (inSection && headingMatch[0].startsWith('##') && !headingMatch[0].startsWith('###')) {
          // Top-level heading terminates current section
          if (currentSectionLines.length > 0) {
            extracted.push(currentSectionLines.join('\n').trim());
            currentSectionLines = [];
          }
          inSection = false;
        } else if (!inSection) {
          // Not in a target section, skip
        }
      } else if (inSection) {
        currentSectionLines.push(line);
      }
    }

    // Flush trailing section
    if (inSection && currentSectionLines.length > 0) {
      extracted.push(currentSectionLines.join('\n').trim());
    }

    if (extracted.length === 0) return null;
    return extracted.join('\n\n');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Combines non-empty sections into the final formatted string with headers.
 */
function formatWorkerContext(sections: {
  experienceWarnings: string;
  learnings: string;
  relevantArtifacts: string;
  hotFiles: string;
  primer: string;
}): string {
  const parts: string[] = [];

  if (sections.experienceWarnings) {
    parts.push(`### Warnings from Past Experience\n${sections.experienceWarnings}`);
  }
  if (sections.learnings) {
    parts.push(`### Key Learnings\n${sections.learnings}`);
  }
  if (sections.relevantArtifacts) {
    parts.push(`### Relevant Context\n${sections.relevantArtifacts}`);
  }
  if (sections.hotFiles) {
    parts.push(`### Active Files\n${sections.hotFiles}`);
  }
  if (sections.primer) {
    parts.push(`### Conventions\n${sections.primer}`);
  }

  if (parts.length === 0) return '';

  return `## Project Knowledge (auto-assembled by Claudex)\n\n${parts.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Truncates text to fit within a token budget using chars/4 estimation.
 * Appends "..." when truncated. Returns '' for empty/zero budget inputs.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

/** Normalizes a file path for case/separator-insensitive comparison. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
