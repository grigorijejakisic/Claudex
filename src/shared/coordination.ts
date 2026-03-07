/**
 * Claudex v2 — Coordination Config Reader
 *
 * Reads ~/.echo/coordination.json to coordinate with the Context Manager
 * when both systems are active. Returns standalone defaults if file is missing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ECHO_HOME } from '../cm-adapter/constants.js';

export interface CoordinationConfig {
  version: number;
  checkpoint_primary: 'claudex' | 'context_manager';
  injection_budget: {
    claudex: number;
    context_manager: number;
    total: number;
  };
  post_compact_restore: 'claudex' | 'context_manager';
  tool_tracking: 'claudex' | 'context_manager' | 'both';
  thread_tracking: 'claudex' | 'context_manager';
  learnings: 'claudex' | 'context_manager';
  gauge_display: 'claudex' | 'context_manager';
}

/** Standalone defaults — Claudex owns everything with full budget */
const STANDALONE_DEFAULTS: CoordinationConfig = {
  version: 1,
  checkpoint_primary: 'claudex',
  injection_budget: {
    claudex: 4000,
    context_manager: 0,
    total: 4000,
  },
  /** @reserved Not yet consumed by runtime — placeholder for future CM integration */
  post_compact_restore: 'claudex',
  tool_tracking: 'claudex',
  thread_tracking: 'claudex',
  learnings: 'claudex',
  /** @reserved Not yet consumed by runtime — placeholder for future CM integration */
  gauge_display: 'claudex',
};

const COORDINATION_PATH = path.join(ECHO_HOME, 'coordination.json');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_OWNERS = new Set<'claudex' | 'context_manager'>(['claudex', 'context_manager']);
const VALID_TOOL_TRACKING = new Set<'claudex' | 'context_manager' | 'both'>(['claudex', 'context_manager', 'both']);

function validateEnum<T extends string>(value: unknown, valid: Set<T>, fallback: T): T {
  return typeof value === 'string' && valid.has(value as T) ? value as T : fallback;
}

function validatePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validateVersion(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1
    ? value : fallback;
}

const MIN_BUDGET = 256;
const MAX_BUDGET = 8000;

function clampBudget(value: number): number {
  if (value === 0) return 0; // 0 means disabled
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, value));
}

let cachedConfig: CoordinationConfig | null = null;
let cachedMtime: number = 0;

/** @internal Exposed for testing only */
export function _resetCoordinationCache(): void {
  cachedConfig = null;
  cachedMtime = 0;
}

/**
 * Read coordination config from ~/.echo/coordination.json.
 * Deep-validates every field against STANDALONE_DEFAULTS — tampered or
 * missing fields fall back to safe defaults.
 * Uses mtime-based caching to avoid repeated file I/O on hot paths.
 */
export function readCoordinationConfig(): CoordinationConfig {
  try {
    if (!fs.existsSync(COORDINATION_PATH)) {
      cachedConfig = null;
      cachedMtime = 0;
      return structuredClone(STANDALONE_DEFAULTS);
    }

    // Reject symlinks for safety
    try {
      const lstat = fs.lstatSync(COORDINATION_PATH);
      if (lstat.isSymbolicLink()) {
        return structuredClone(STANDALONE_DEFAULTS);
      }
    } catch { /* stat failed — proceed with caution */ }

    const stat = fs.statSync(COORDINATION_PATH);
    const mtime = stat.mtimeMs;

    if (cachedConfig && mtime === cachedMtime) {
      return cachedConfig;
    }

    const raw = fs.readFileSync(COORDINATION_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    const result: CoordinationConfig = {
      version: validateVersion(parsed.version, STANDALONE_DEFAULTS.version),
      checkpoint_primary: validateEnum(parsed.checkpoint_primary, VALID_OWNERS, STANDALONE_DEFAULTS.checkpoint_primary),
      injection_budget: {
        claudex: validatePositiveNumber(parsed.injection_budget?.claudex, STANDALONE_DEFAULTS.injection_budget.claudex),
        context_manager: validatePositiveNumber(parsed.injection_budget?.context_manager, STANDALONE_DEFAULTS.injection_budget.context_manager),
        total: validatePositiveNumber(parsed.injection_budget?.total, STANDALONE_DEFAULTS.injection_budget.total),
      },
      post_compact_restore: validateEnum(parsed.post_compact_restore, VALID_OWNERS, STANDALONE_DEFAULTS.post_compact_restore),
      tool_tracking: validateEnum(parsed.tool_tracking, VALID_TOOL_TRACKING, STANDALONE_DEFAULTS.tool_tracking),
      thread_tracking: validateEnum(parsed.thread_tracking, VALID_OWNERS, STANDALONE_DEFAULTS.thread_tracking),
      learnings: validateEnum(parsed.learnings, VALID_OWNERS, STANDALONE_DEFAULTS.learnings),
      gauge_display: validateEnum(parsed.gauge_display, VALID_OWNERS, STANDALONE_DEFAULTS.gauge_display),
    };

    // Clamp budgets to safe range
    result.injection_budget.claudex = clampBudget(result.injection_budget.claudex);
    result.injection_budget.context_manager = clampBudget(result.injection_budget.context_manager);

    cachedConfig = result;
    cachedMtime = mtime;
    return result;
  } catch {
    cachedConfig = null;
    cachedMtime = 0;
    return structuredClone(STANDALONE_DEFAULTS);
  }
}

/** Check if a coordination field is owned by Claudex */
export function isOwnedByClaudex(
  config: CoordinationConfig,
  field: 'thread_tracking' | 'tool_tracking' | 'checkpoint_primary' | 'learnings',
): boolean {
  return config[field] === 'claudex';
}
