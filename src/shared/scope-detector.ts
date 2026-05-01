/**
 * Project scope detection from ~/.claudex/projects.json.
 * Defensive non-throwing. Case-insensitive path matching on Windows.
 */

import * as path from 'path';
import * as fs from 'fs';
import { getProjectsJsonPath } from './paths.js';
import { getProjectsDir } from './projects-dir.js';
import { readJsonFile, writeJsonFile } from './fs-helpers.js';

interface ProjectEntry {
  path: string;
  [key: string]: unknown;
}

interface ProjectsFile {
  projects: Record<string, string | ProjectEntry>;
}

/**
 * Detects project scope by finding the longest matching path prefix in projects.json.
 * Case-insensitive path comparison on Windows. Returns project ID or null.
 * Never throws.
 */
export function detectProjectScope(cwd: string): string | null {
  try {
    const data = readJsonFile<ProjectsFile>(getProjectsJsonPath());
    if (!data?.projects) return null;

    const normalizedCwd = normalizePath(cwd);
    let bestMatch: string | null = null;
    let bestLength = 0;

    for (const [key, value] of Object.entries(data.projects)) {
      // Support both formats:
      //   { "path": "projectId" }          — Record<path, string>
      //   { "projectId": { path: "..." } } — Record<id, ProjectEntry>
      let projectPath: string;
      let projectId: string;
      if (typeof value === 'string') {
        projectPath = key;
        projectId = value;
      } else if (value && typeof value === 'object' && typeof (value as ProjectEntry).path === 'string') {
        projectPath = (value as ProjectEntry).path;
        projectId = key;
      } else {
        continue;
      }

      const normalizedProject = normalizePath(projectPath);
      // Skip empty/falsy project paths
      if (!normalizedProject) continue;
      // When project path is a filesystem root (ends with separator),
      // don't append an extra separator for prefix matching
      const prefix = normalizedProject.endsWith(path.sep)
        ? normalizedProject
        : normalizedProject + path.sep;
      if (
        (normalizedCwd === normalizedProject || normalizedCwd.startsWith(prefix)) &&
        normalizedProject.length > bestLength
      ) {
        bestMatch = projectId;
        bestLength = normalizedProject.length;
      }
    }

    return bestMatch;
  } catch {
    // Non-throwing: no DB access — caller handles null (no project scope detected)
    return null;
  }
}

/**
 * Derives a project ID from a directory path without consulting projects.json.
 * Uses directory name + FNV-1a hash for uniqueness. Exported for reuse by content-router.
 * Always returns a string. Never throws.
 */
export function deriveProjectId(cwd: string): string {
  try {
    const baseName = path.basename(cwd);
    const sanitized = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    const hash = simpleHash(normalizePath(path.resolve(cwd)));
    return `${sanitized}-${hash}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Convenience: detects project scope, or derives a project ID from the directory name.
 * Always returns a string. Never throws.
 */
export function getProjectId(cwd: string): string {
  try {
    const detected = detectProjectScope(cwd);
    if (detected) return detected;
    return deriveProjectId(cwd);
  } catch {
    // Non-throwing: no DB access — caller always gets a valid project ID string
    return 'unknown';
  }
}

/**
 * Resolves a project ID to its directory path.
 * Checks projects.json first, then scans the configured projects directory
 * (CLAUDEX_PROJECTS_DIR, default ~/Projects/) for derived matches.
 * Returns null if no path can be determined. Never throws.
 */
export function resolveProjectPath(projectId: string): string | null {
  try {
    // 1. Check registered projects in projects.json
    const data = readJsonFile<ProjectsFile>(getProjectsJsonPath());
    if (data?.projects) {
      for (const [key, value] of Object.entries(data.projects)) {
        let projId: string;
        let projPath: string | undefined;
        if (typeof value === 'string') {
          projPath = key;
          projId = value;
        } else if (value && typeof value === 'object' && typeof (value as ProjectEntry).path === 'string') {
          projPath = (value as ProjectEntry).path;
          projId = key;
        } else {
          continue;
        }
        if (projId === projectId && projPath) return projPath;
      }
    }

    // 2. Scan the configured projects directory (CLAUDEX_PROJECTS_DIR, default
    //    ~/Projects/) for unregistered directories whose derived ID matches.
    const baseDir = getProjectsDir();
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(baseDir, entry.name);
      if (deriveProjectId(fullPath) === projectId) return fullPath;
    }
  } catch { /* non-throwing */ }

  return null;
}

/**
 * Auto-registers a project in projects.json.
 * Idempotent — skips if project ID already exists.
 * Returns true on success. Never throws.
 */
export function registerProject(id: string, dirPath: string, description?: string): boolean {
  try {
    const jsonPath = getProjectsJsonPath();
    const data = readJsonFile<Record<string, unknown>>(jsonPath) ?? {
      schema: 'claudex/project-registry',
      version: 1,
      projects: {},
    };

    const projects = (data as { projects?: Record<string, unknown> }).projects;
    if (!projects || typeof projects !== 'object') return false;

    // Idempotent — don't overwrite existing registrations
    if (projects[id]) return true;

    projects[id] = {
      path: dirPath,
      created: new Date().toISOString().split('T')[0],
      last_session: new Date().toISOString().split('T')[0],
      description: description ?? `Auto-registered from ${path.basename(dirPath)}`,
      status: 'active',
    };

    return writeJsonFile(jsonPath, data);
  } catch {
    return false;
  }
}

// TODO: FNV-1a 32-bit hash is collision-prone for scope boundaries.
// Changing requires DB migration to re-hash existing project IDs.
/** Deterministic simple string hash. Returns 8-char hex string. Not cryptographic — for uniqueness only. */
function simpleHash(str: string): string {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV-1a prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Normalizes a path for comparison. Case-insensitive on Windows. Preserves filesystem roots. */
function normalizePath(p: string): string {
  if (!p) return p;
  let normalized = path.normalize(p);
  // Strip trailing separator (path.normalize keeps it for roots)
  // but guard against collapsing filesystem roots to empty/invalid forms
  if (normalized.endsWith(path.sep) && normalized.length > 1) {
    const stripped = normalized.slice(0, -1);
    // Guard: don't collapse "C:\" to "C:" or "/" to ""
    if (stripped.length === 0) {
      // Unix root "/" stripped to "" — restore
      normalized = path.sep;
    } else if (/^[A-Za-z]:$/.test(stripped)) {
      // Windows drive root "C:\" stripped to "C:" — restore separator
      normalized = stripped + path.sep;
    } else {
      normalized = stripped;
    }
  }
  // Case-insensitive on Windows
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  // Strip trailing separators to prevent prefix-match edge cases
  normalized = normalized.replace(/[/\\]+$/, '');
  // Protect filesystem roots from being corrupted to empty/incomplete strings
  if (normalized === '' || /^[a-zA-Z]:$/.test(normalized)) {
    normalized = normalized + path.sep;
  }
  return normalized;
}
