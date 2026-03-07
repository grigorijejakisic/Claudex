/**
 * Claudex v2 — Coordination Config Reader
 *
 * Reads ~/.echo/coordination.json to coordinate with the Context Manager
 * when both systems are active. Returns standalone defaults if file is missing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
  post_compact_restore: 'claudex',
  tool_tracking: 'claudex',
  thread_tracking: 'claudex',
  learnings: 'claudex',
  gauge_display: 'claudex',
};

const COORDINATION_PATH = path.join(os.homedir(), '.echo', 'coordination.json');

/**
 * Read coordination config from ~/.echo/coordination.json.
 * Returns standalone defaults if file is missing or corrupt.
 */
export function readCoordinationConfig(): CoordinationConfig {
  try {
    if (!fs.existsSync(COORDINATION_PATH)) {
      return structuredClone(STANDALONE_DEFAULTS);
    }
    const raw = fs.readFileSync(COORDINATION_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CoordinationConfig;
    if (typeof parsed.injection_budget?.claudex !== 'number' || !Number.isFinite(parsed.injection_budget.claudex)) {
      return structuredClone(STANDALONE_DEFAULTS);
    }
    return parsed;
  } catch {
    return structuredClone(STANDALONE_DEFAULTS);
  }
}
