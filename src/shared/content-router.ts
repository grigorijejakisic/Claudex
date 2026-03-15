/**
 * Content-aware project routing.
 * Routes observations/decisions to the correct project based on content,
 * not just the working directory. Provides intellectual independence —
 * discussing Paperclip while sitting in CLAUDEXv3 routes to paperclip.
 *
 * Two sources of project knowledge:
 * 1. projects.json — registered projects with IDs, paths, descriptions
 * 2. ~/Desktop/Projects/ scan — unregistered project directories
 *
 * Matching priority:
 * 1. File path match (strongest — content contains a project's full path)
 * 2. Project name/alias match (word-boundary, scored by length * frequency)
 * 3. CWD project fallback (no reroute when signal is weak)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readJsonFile } from './fs-helpers.js';
import { getProjectsJsonPath } from './paths.js';
import { deriveProjectId } from './scope-detector.js';

export interface ProjectSignature {
  id: string;
  dirName: string;
  fullPath: string;
  /** Normalized forward-slash path for content matching. */
  pathFwd: string;
  /** MSYS-style path (/c/Users/...) for git-bash content matching. */
  msysPath: string;
  aliases: string[];
  /** Precompiled regex patterns for alias matching. */
  aliasPatterns: { pattern: RegExp; length: number }[];
}

/** Max content length to scan for routing — performance guard. */
const MAX_CONTENT_SCAN = 5000;

/** Minimum alias length to avoid false positives from short matches. */
const MIN_ALIAS_LENGTH = 3;

/**
 * Minimum score for name-only routing (no path match).
 * Prevents single mentions of short project names ("codex", "grove") from
 * triggering false reroutes. Score = sum(matchCount * aliasLength).
 * 20 ≈ 2 mentions of a 10-char name, or 3 mentions of a 7-char name.
 */
const MIN_NAME_SCORE = 20;

/**
 * Build project signatures from projects.json + Projects directory scan.
 * Returns all known projects with aliases for content matching.
 * Precompiles regex patterns and normalized paths for routing performance.
 * Never throws.
 */
export function buildProjectIndex(): ProjectSignature[] {
  const signatures: ProjectSignature[] = [];
  const seenDirs = new Set<string>();

  // 1. Registered projects from projects.json
  try {
    const registry = readJsonFile<Record<string, unknown>>(getProjectsJsonPath());
    const projects = (registry as { projects?: Record<string, unknown> })?.projects;
    if (projects && typeof projects === 'object') {
      for (const [key, entry] of Object.entries(projects)) {
        let projId: string;
        let projPath: string | undefined;

        if (typeof entry === 'string') {
          // Legacy format: key is path, value is project ID
          // Matches scope-detector.ts interpretation
          projPath = key;
          projId = entry;
        } else {
          // Standard format: key is project ID, value has path
          projId = key;
          projPath = (entry as { path?: string })?.path;
        }

        if (!projPath || typeof projPath !== 'string') continue;
        const dirName = path.basename(projPath);
        const aliases = buildAliases(projId, dirName);
        const pathFwd = projPath.toLowerCase().replace(/\\/g, '/');
        signatures.push({
          id: projId,
          dirName,
          fullPath: projPath,
          pathFwd,
          msysPath: pathFwd.replace(/^([a-z]):/, '/$1'),
          aliases,
          aliasPatterns: compileAliasPatterns(aliases),
        });
        seenDirs.add(dirName.toLowerCase());
      }
    }
  } catch { /* non-throwing */ }

  // 2. Unregistered project directories
  const baseDir = path.join(os.homedir(), 'Desktop', 'Projects');
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seenDirs.has(entry.name.toLowerCase())) continue;
      const dirName = entry.name;
      const fullPath = path.join(baseDir, dirName);
      // Use same ID derivation as getProjectId fallback — prevents ID fragmentation
      const id = deriveProjectId(fullPath);
      const aliases = buildAliases(id, dirName);
      const pathFwd = fullPath.toLowerCase().replace(/\\/g, '/');
      signatures.push({
        id,
        dirName,
        fullPath,
        pathFwd,
        msysPath: pathFwd.replace(/^([a-z]):/, '/$1'),
        aliases,
        aliasPatterns: compileAliasPatterns(aliases),
      });
    }
  } catch { /* non-throwing */ }

  // Sort by path length descending — longest path matches first (prevents prefix collisions)
  signatures.sort((a, b) => b.pathFwd.length - a.pathFwd.length);

  return signatures;
}

/**
 * Build matching aliases for a project.
 * Returns lowercase strings for word-boundary matching.
 */
function buildAliases(id: string, dirName: string): string[] {
  const aliases = new Set<string>();

  aliases.add(id.toLowerCase());
  aliases.add(dirName.toLowerCase());

  // Strip common suffixes from BOTH id and dirName.
  // id stripping catches "claudex-v3" → "claudex" (separator before v3).
  // dirName stripping catches "openclaw-main" → "openclaw".
  for (const base of [id.toLowerCase(), dirName.toLowerCase()]) {
    const stripped = base
      .replace(/[-_\s](main|fix|master|dev)$/i, '')
      .replace(/[-_\s]v\d+$/i, '');
    if (stripped && stripped.length >= MIN_ALIAS_LENGTH) {
      aliases.add(stripped);
    }
  }

  // Collapsed form (no separators): "openclaw-main" → "openclawmain"
  const collapsed = dirName.toLowerCase().replace(/[-_\s]/g, '');
  if (collapsed && collapsed.length >= MIN_ALIAS_LENGTH) {
    aliases.add(collapsed);
  }

  return [...aliases].filter(a => a.length >= MIN_ALIAS_LENGTH);
}

/** Escape special regex characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Precompile alias regex patterns at index build time. */
function compileAliasPatterns(aliases: string[]): { pattern: RegExp; length: number }[] {
  const patterns: { pattern: RegExp; length: number }[] = [];
  for (const alias of aliases) {
    try {
      patterns.push({
        pattern: new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi'),
        length: alias.length,
      });
    } catch { /* skip invalid regex */ }
  }
  return patterns;
}

/**
 * Check if a path match has proper segment boundaries.
 * Prevents `/Projects/app` from matching `/Projects/app-old`.
 * The character after the match must be `/` or end-of-string.
 */
function isPathBoundaryMatch(content: string, matchPath: string): boolean {
  const idx = content.indexOf(matchPath);
  if (idx < 0) return false;
  const afterIdx = idx + matchPath.length;
  // Must be followed by path separator, whitespace, or end-of-string
  // NOT alphanumeric or hyphen (prevents /app matching /app-old or /app2)
  if (afterIdx >= content.length) return true;
  const ch = content[afterIdx];
  return ch === '/' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '"' || ch === '\'' || ch === ')';
}

/**
 * Route content to the best matching project.
 *
 * Returns cwdProject when no strong match is found.
 * Never throws — routing failure must not break the hook pipeline.
 */
export function routeByContent(
  content: string,
  cwdProject: string,
  projectIndex: ProjectSignature[],
): string {
  if (!content || projectIndex.length === 0) return cwdProject;

  try {
    // Cap content length for performance
    const contentLower = content.substring(0, MAX_CONTENT_SCAN).toLowerCase();

    // 1. File path match — strongest signal
    // Normalize content slashes once for all path comparisons
    const contentFwd = contentLower.replace(/\\/g, '/');

    // Index is sorted by path length descending — longest match wins
    for (const proj of projectIndex) {
      if (proj.id === cwdProject) continue;

      if (isPathBoundaryMatch(contentFwd, proj.pathFwd)) {
        return proj.id;
      }

      if (isPathBoundaryMatch(contentFwd, proj.msysPath)) {
        return proj.id;
      }
    }

    // 2. Project name mentions (word-boundary, scored)
    // Score ALL projects including CWD — only reroute when another project
    // scores strictly higher than CWD. Prevents false positives when CWD
    // project's alias is a substring of its own name.
    let cwdScore = 0;
    let bestMatch: { id: string; score: number } | null = null;

    for (const proj of projectIndex) {
      let score = 0;
      for (const { pattern, length } of proj.aliasPatterns) {
        pattern.lastIndex = 0; // Reset stateful regex
        const matches = contentLower.match(pattern);
        if (matches) {
          score += matches.length * length;
        }
      }

      if (proj.id === cwdProject) {
        cwdScore = score;
      } else if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { id: proj.id, score };
      }
    }

    // Only reroute when another project scores strictly higher than CWD
    // AND meets minimum threshold to avoid false positives from short names
    if (bestMatch && bestMatch.score > cwdScore && bestMatch.score >= MIN_NAME_SCORE) {
      return bestMatch.id;
    }

    return cwdProject;
  } catch {
    return cwdProject;
  }
}

/**
 * Extract a routing-relevant string from tool input/output.
 * Bounded extraction — walks only string fields, never serializes full objects.
 */
export function extractRoutingContent(
  toolInput: Record<string, unknown>,
  toolOutput?: Record<string, unknown>,
): string {
  const parts: string[] = [];
  let totalLen = 0;

  // Extract string fields from tool input (file paths are the main signal)
  for (const val of Object.values(toolInput)) {
    if (typeof val === 'string' && val.length > 0) {
      const chunk = val.substring(0, 500);
      parts.push(chunk);
      totalLen += chunk.length;
      if (totalLen >= MAX_CONTENT_SCAN) break;
    }
  }

  // Extract string fields from tool output (capped)
  if (toolOutput && totalLen < MAX_CONTENT_SCAN) {
    for (const val of Object.values(toolOutput)) {
      if (typeof val === 'string' && val.length > 0) {
        const chunk = val.substring(0, 200);
        parts.push(chunk);
        totalLen += chunk.length;
        if (totalLen >= MAX_CONTENT_SCAN) break;
      }
    }
  }

  return parts.join(' ').substring(0, MAX_CONTENT_SCAN);
}
