/**
 * Phase 4.1 multi-project marker sweep.
 *
 * For every system-promoted critical_rule, count distinct projects whose
 * system-promoted rules normalize to the same rule_text. Persist the count
 * in the `critical_rules_multi_project` sidecar table, keyed by
 * (project, normalized_rule_text).
 *
 * The flat +2 scoring boost in assembleCriticalReminders consumes this
 * sidecar via a LEFT JOIN on the same key.
 *
 * Sidecar rationale (per CONTEXT.md "Claude's Discretion" + Plan 07 Task 2
 * pre-authorized fallback): the V17 critical_rules view does not expose
 * `data` for direct UPDATE through INSTEAD OF triggers. The sidecar table
 * works equally well in pre-V17 (legacy critical_rules table) and post-V17
 * (view) environments.
 *
 * Cadence: heartbeat. Cross-project query runs in O(N) where N = total
 * system-promoted rules; for typical N < 100 this is sub-millisecond.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { normalizeRuleText } from './feedback-promoter.js';

/**
 * Update critical_rules_multi_project sidecar for all system-promoted rules.
 *
 * Returns the number of rows upserted. Idempotent — repeated calls produce
 * the same field values.
 *
 * Reads from the critical_rules view (works pre-V17 as legacy table; post-V17
 * as view-over-artifact). Source-discriminated to system-promoted only.
 */
export function updateMultiProjectMarkers(db: Database): number {
  // Pull all system-promoted rules with their project + rule_text.
  const all = cachedPrepare(db,
    `SELECT project, rule_text FROM critical_rules WHERE source = 'system-promoted'`,
  ).all() as Array<{ project: string; rule_text: string }>;

  if (all.length === 0) return 0;

  // Group by normalized text → set of distinct projects.
  const byNorm = new Map<string, Set<string>>();
  for (const row of all) {
    const norm = normalizeRuleText(row.rule_text);
    if (norm.length === 0) continue;
    const set = byNorm.get(norm) ?? new Set();
    set.add(row.project);
    byNorm.set(norm, set);
  }

  // Per-row upsert into sidecar.
  let updated = 0;
  const now = Date.now();
  for (const row of all) {
    const norm = normalizeRuleText(row.rule_text);
    if (norm.length === 0) continue;
    const count = byNorm.get(norm)?.size ?? 1;
    try {
      cachedPrepare(db,
        `INSERT INTO critical_rules_multi_project (project, normalized_rule_text, multi_project_count, updated_at_epoch)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project, normalized_rule_text) DO UPDATE SET
           multi_project_count = excluded.multi_project_count,
           updated_at_epoch = excluded.updated_at_epoch`,
      ).run(row.project, norm, count, now);
      updated++;
    } catch {
      // Non-fatal: continue.
    }
  }

  return updated;
}
