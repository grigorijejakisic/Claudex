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
      if (
        (normalizedCwd === normalizedProject || normalizedCwd.startsWith(normalizedProject + path.sep)) &&
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
export function getProjectId(cwd: string, preDetectedScope?: string | null): string {
  try {
    const detected = preDetectedScope !== undefined ? preDetectedScope : detectProjectScope(cwd);
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

/** Normalizes a path for comparison. Case-insensitive on Windows. R32: strips trailing separators. */
function normalizePath(p: string): string {
  let normalized = path.normalize(p);
  // Case-insensitive on Windows (QUAL-05, 2nd allowed platform check)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  // R32: Strip trailing separators to prevent prefix-match edge cases
  normalized = normalized.replace(/[/\\]+$/, '');
  return normalized;
}
