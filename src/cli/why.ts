/**
 * Phase 8.5 — Print retrieval log for a session.
 *
 * Usage:
 *   node dist/cli/why.cjs <session_id> [--no-reconcile]
 *
 * Output:
 *   <one line per retrieval>
 *   <horizontal rule>
 *   <aggregate footer>
 *
 * Empty session: "No retrievals this session."
 * Exit code: always 0 (the slash command never blocks the user).
 *
 * Locked format (CONTEXT.md left to planner; locked here in Plan 05):
 *
 *   [T+0:23] claudex_search("rate limit") → 3 results, 2 used, 487 tokens
 *   [T+1:14] claudex_recall(id:3074)      → 1 result, 1 used, 312 tokens
 *   [T+3:02] pointer_surface(lesson)      → 1 result, 0 used, 89 tokens
 *   ─────────────────────────────────────
 *   3 invocations · hit rate 67% · 888 tokens total
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import {
  listSessionRetrievals,
  aggregateSessionCost,
  reconcileUsedInOutput,
  type RetrievalLogRow,
} from '../intelligence/retrieval-log.js';

export const HRULE = '─'.repeat(37);

export function formatTPlus(invokedAtMs: number, sessionStartMs: number): string {
  const offsetSec = Math.max(0, Math.floor((invokedAtMs - sessionStartMs) / 1000));
  const totalMin = Math.floor(offsetSec / 60);
  if (totalMin >= 100) {
    const hours = Math.floor(totalMin / 60);
    return `T+${String(hours).padStart(2, '0')}h+`;
  }
  const sec = offsetSec % 60;
  return `T+${totalMin}:${String(sec).padStart(2, '0')}`;
}

export function formatQuery(query: string | null): string {
  if (!query) return '(no query)';
  if (query.length > 60) return `${query.slice(0, 57)}...`;
  return query;
}

export function formatSurfaceCall(
  surface: string,
  query: string | null,
  topKRaw: string,
): string {
  const q = formatQuery(query);
  if (surface === 'claudex_search') return `claudex_search("${q}")`;
  if (surface === 'claudex_recall') return `claudex_recall(${q})`;
  if (surface === 'pointer_surface') {
    let source = 'pointer';
    try {
      const arr = JSON.parse(topKRaw) as Array<{ source?: string }>;
      if (arr[0]?.source) source = arr[0].source;
    } catch { /* fall through */ }
    return `pointer_surface(${source})`;
  }
  return `${surface}(${q})`;
}

export function formatLine(row: RetrievalLogRow, sessionStartMs: number): string {
  const tPlus = formatTPlus(row.invoked_at_epoch_ms, sessionStartMs);
  const call = formatSurfaceCall(row.surface, row.query, row.top_k_results);
  let n = 0;
  try { n = (JSON.parse(row.top_k_results) as unknown[]).length; } catch { /* */ }
  const used = row.used_in_output === 1 ? 1 : 0;
  const resultsLabel = `${n} result${n === 1 ? '' : 's'}`;
  return `[${tPlus}] ${call} → ${resultsLabel}, ${used} used, ${row.token_cost} tokens`;
}

export function formatFooter(
  invocations: number,
  usedCount: number,
  totalTokens: number,
): string {
  const hitRatePct = invocations === 0
    ? 0
    : Math.round((usedCount / invocations) * 100);
  return `${HRULE}\n${invocations} invocation${invocations === 1 ? '' : 's'} · hit rate ${hitRatePct}% · ${totalTokens} tokens total`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: why <session_id> [--no-reconcile]');
    process.exit(1);
  }
  const sessionId = args[0];
  const reconcile = !args.includes('--no-reconcile');

  try {
    const db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    if (reconcile) {
      try { reconcileUsedInOutput(db, sessionId); } catch { /* non-fatal */ }
    }
    const rows = listSessionRetrievals(db, sessionId);
    if (rows.length === 0) {
      db.close();
      console.log('No retrievals this session.');
      process.exit(0);
    }
    const sessionStartMs = rows[0].invoked_at_epoch_ms;
    const lines = rows.map(r => formatLine(r, sessionStartMs));
    const agg = aggregateSessionCost(db, sessionId);
    db.close();
    console.log(lines.join('\n'));
    console.log(formatFooter(agg.invocations, agg.usedCount, agg.totalTokens));
    process.exit(0);
  } catch (err) {
    console.error('why failed:', err instanceof Error ? err.message : String(err));
    process.exit(0);
  }
}

if (
  typeof require !== 'undefined' && require.main === module
  || (process.argv[1] && /[/\\]why(\.cjs|\.js)?$/.test(process.argv[1]))
) {
  main();
}
