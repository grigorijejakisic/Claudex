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
      if (normalizedCwd.startsWith(normalizedProject) && normalizedProject.length > bestLength) {
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

    // Derive from directory name: last segment, lowercased, sanitized
    const baseName = path.basename(cwd);
    return baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Normalizes a path for comparison. Case-insensitive on Windows. */
function normalizePath(p: string): string {
  let normalized = path.normalize(p);
  // Case-insensitive on Windows (QUAL-05, 2nd allowed platform check)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}
