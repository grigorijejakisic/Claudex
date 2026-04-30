/**
 * Active-projects registry for SC#3 mechanical scoring.
 *
 * The 5+ projects come from Phase 11 CONTEXT.md line 42 (preserved verbatim,
 * including the trailing nexus-e53c6c93 entry — CONTEXT lock: SC#3 measures
 * the named active projects, planner does not prune them).
 *
 * For each project we compute:
 *   - memoryPath:        ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
 *   - activeHandoffPath: <project-cwd>/context/handoffs/ACTIVE.md (if any)
 *
 * The encoded CWD comes from the canonical projects registry at
 * `~/.claudex/projects.json`. If the slug is missing, we fall back to a
 * conventional Windows path heuristic for diagnostic purposes — but the CLI
 * surfaces the project as `missing` rather than failing the gate.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToCcSlug } from '../../shared/cc-slug.js';

export interface ActiveProject {
  slug: string;
  memoryPath: string;
  activeHandoffPath?: string;
  /** Set when the slug couldn't be resolved against the live registry. */
  unresolved?: boolean;
}

/** Per CONTEXT.md line 42 (verbatim, do NOT prune). */
export const ACTIVE_PROJECT_SLUGS = [
  'claudex-v3',
  'lacuna-betting-9f1d552c',
  'oracle-3951898e',
  'big-mozzy-v2',
  'desktop-01dcc792',
  'nexus-e53c6c93',
] as const;

interface ProjectRegistryEntry {
  path: string;
  status?: string;
}

interface ProjectRegistry {
  schema: string;
  version: number;
  projects: Record<string, ProjectRegistryEntry>;
}

function loadRegistry(): ProjectRegistry | null {
  const registryPath = path.join(os.homedir(), '.claudex', 'projects.json');
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as ProjectRegistry;
  } catch {
    return null;
  }
}

export function resolveActiveProjects(): ActiveProject[] {
  const reg = loadRegistry();
  const out: ActiveProject[] = [];
  for (const slug of ACTIVE_PROJECT_SLUGS) {
    const entry = reg?.projects?.[slug];
    if (!entry) {
      out.push({
        slug,
        memoryPath: path.join(os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md'),
        unresolved: true,
      });
      continue;
    }
    const cwdSlug = pathToCcSlug(entry.path);
    const memoryPath = path.join(os.homedir(), '.claude', 'projects', cwdSlug, 'memory', 'MEMORY.md');
    const activeHandoffPath = path.join(entry.path, 'context', 'handoffs', 'ACTIVE.md');
    out.push({ slug, memoryPath, activeHandoffPath });
  }
  return out;
}

export const ACTIVE_PROJECTS: ActiveProject[] = resolveActiveProjects();
