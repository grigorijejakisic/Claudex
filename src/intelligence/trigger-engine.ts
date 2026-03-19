/**
 * Trigger Engine — matches tool input against stored triggers to surface
 * relevant knowledge proactively.
 *
 * Two trigger sources:
 * 1. context_triggers table: file glob → knowledge domain
 * 2. experience_patterns: trigger_glob + trigger_command columns
 *
 * Fires in PostToolUse. Matched context persisted to thread_state
 * for injection at next UserPromptSubmit.
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { ExperiencePattern } from './experience-patterns.js';

/** Hard cap on predictive patterns evaluated per hook invocation. */
const MAX_PREDICTIVE_PATTERNS = 50;

export interface TriggerMatch {
  /** Knowledge domains matched by context_triggers */
  domains: string[];
  /** Experience pattern IDs matched by trigger_glob/trigger_command */
  patternIds: string[];
}

/**
 * Matches tool input against context triggers and predictive experience patterns.
 * Returns matched domains and pattern IDs.
 * Non-throwing — returns empty matches on any error.
 */
export function matchTriggers(
  db: Database,
  project: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): TriggerMatch {
  const result: TriggerMatch = { domains: [], patternIds: [] };

  try {
    const filePath = String(toolInput?.file_path ?? toolInput?.path ?? '');
    const command = toolName === 'Bash' ? String(toolInput?.command ?? '') : '';

    // 1. Match context_triggers by glob pattern (app-level matching)
    if (filePath || command) {
      try {
        const triggers = cachedPrepare(db,
          `SELECT glob_pattern, command_pattern, knowledge_domain FROM context_triggers
           WHERE project = ? OR project = '__global__'`
        ).all(project) as Array<{ glob_pattern: string | null; command_pattern: string | null; knowledge_domain: string }>;

        for (const t of triggers) {
          if (t.glob_pattern && filePath && matchGlob(filePath, t.glob_pattern)) {
            result.domains.push(t.knowledge_domain);
          }
          if (t.command_pattern && command && command.includes(t.command_pattern)) {
            result.domains.push(t.knowledge_domain);
          }
        }
      } catch { /* non-throwing */ }
    }

    // 2. Match experience_patterns by trigger_glob and trigger_command
    if (filePath || command) {
      try {
        const patterns = cachedPrepare(db,
          `SELECT id, trigger_glob, trigger_command FROM experience_patterns
           WHERE score >= 2
             AND (source_project = ? OR source_project = '__global__')
             AND (trigger_glob IS NOT NULL OR trigger_command IS NOT NULL)
           LIMIT ?`
        ).all(project, MAX_PREDICTIVE_PATTERNS) as Array<{
          id: string; trigger_glob: string | null; trigger_command: string | null;
        }>;

        for (const p of patterns) {
          if (p.trigger_glob && filePath && matchGlob(filePath, p.trigger_glob)) {
            result.patternIds.push(p.id);
          }
          if (p.trigger_command && command && command.includes(p.trigger_command)) {
            result.patternIds.push(p.id);
          }
        }
      } catch { /* non-throwing */ }
    }

    // Deduplicate
    result.domains = [...new Set(result.domains)];
    result.patternIds = [...new Set(result.patternIds)];
  } catch {
    // Non-throwing
  }

  return result;
}

/**
 * Simple glob matching for file paths.
 * Supports: * (any chars except /), ** (any chars including /), ? (single char).
 * Non-throwing — returns false on error.
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  try {
    // Normalize separators
    const normPath = filePath.replace(/\\/g, '/').toLowerCase();
    const normPattern = pattern.replace(/\\/g, '/').toLowerCase();

    // Convert glob to regex
    let regex = normPattern
      .replace(/[.+^${}()|[\]]/g, '\\$&')  // Escape special regex chars (not * or ?)
      .replace(/\*\*/g, '§§')                // Temp placeholder for **
      .replace(/\*/g, '[^/]*')               // * = any except separator
      .replace(/§§/g, '.*')                  // ** = any including separator
      .replace(/\?/g, '[^/]');               // ? = single char

    // Anchor the pattern
    if (!regex.startsWith('.*')) regex = '(?:^|/)' + regex;
    regex = regex + '$';

    return new RegExp(regex).test(normPath);
  } catch {
    return false;
  }
}

/**
 * Loads full experience patterns by their IDs.
 * Used to render matched predictive patterns for injection.
 */
export function loadPatternsByIds(db: Database, ids: string[]): ExperiencePattern[] {
  if (!ids || ids.length === 0) return [];
  try {
    const placeholders = ids.map(() => '?').join(',');
    return cachedPrepare(db,
      `SELECT * FROM experience_patterns WHERE id IN (${placeholders})`
    ).all(...ids) as ExperiencePattern[];
  } catch {
    return [];
  }
}
