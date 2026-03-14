/**
 * Project scope detection from ~/.claudex/projects.json.
 * Defensive non-throwing (QUAL-01). Case-insensitive path matching on Windows (QUAL-05).
 * @see Architecture Section 15.6
 */

import * as path from 'path';
import { getProjectsJsonPath } from './paths.js';
import { readJsonFile, writeJsonFile } from './fs-helpers.js';

interface ProjectsFile {
  projects: Record<string, string>;
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

    for (const [projectPath, projectId] of Object.entries(data.projects)) {
      const normalizedProject = normalizePath(projectPath);
      // Skip empty/falsy project paths (REC-22)
      if (!normalizedProject) continue;
      // When project path is a filesystem root (ends with separator),
      // don't append an extra separator for prefix matching (REC-22)
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
    return null;
  }
}

/**
 * Registers a project in projects.json. Adds/updates the cwd → projectId mapping.
 * Returns true on success. Never throws.
 */
export async function registerProject(cwd: string, projectId: string): Promise<boolean> {
  try {
    const filePath = getProjectsJsonPath();
    const existing = readJsonFile<ProjectsFile>(filePath) ?? { projects: {} };
    existing.projects[cwd] = projectId;
    return await writeJsonFile(filePath, existing);
  } catch {
    return false;
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

    // Derive from directory name: last segment, lowercased, sanitized + short hash of full path for uniqueness
    const baseName = path.basename(cwd);
    const sanitized = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    const hash = simpleHash(normalizePath(path.resolve(cwd)));
    return `${sanitized}-${hash}`;
  } catch {
    return 'unknown';
  }
}

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
    // Guard: don't collapse "C:\" to "C:" or "/" to "" (REC-22)
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
  // Case-insensitive on Windows (QUAL-05, 2nd allowed platform check)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  // R32: Strip trailing separators to prevent prefix-match edge cases
  normalized = normalized.replace(/[/\\]+$/, '');
  // REC-22: Protect filesystem roots from being corrupted to empty/incomplete strings
  if (normalized === '' || /^[a-zA-Z]:$/.test(normalized)) {
    normalized = normalized + path.sep;
  }
  return normalized;
}
