/**
 * Phase 8.5 — Print per-session memory cost block at /endsession.
 *
 * Usage:
 *   node dist/cli/session-token-cost.cjs <session_id> [--no-reconcile]
 *
 * Output format (locked in CONTEXT.md):
 *
 *   Memory cost this session:
 *     session-start: <N> tokens
 *     UPS turns: <M> tokens (avg <P>/turn × <Q> turns)
 *     explicit retrieval: <R> tokens (<X> invocations)
 *     total: <T> tokens
 *
 * If a line's data is missing, prints "(unavailable)" for the value
 * and excludes it from total (qualifier "(+ some unavailable)" added).
 *
 * Exits 0 on bad/missing session_id (the /endsession skill never blocks
 * on this step).
 *
 * session-events token-cost source map (verified at Plan 08.5-04 time):
 *   session-start line:  telemetry.event_kind='injection' with
 *                        detail.trigger='session_start' and
 *                        detail.total_tokens=<int>. Source:
 *                        adapters/cc-hooks/session-start.ts:336-342.
 *   UPS turns line:      telemetry.event_kind='injection' with
 *                        detail.trigger in {'gauge','topic_shift','post_compaction'}
 *                        and detail.total_tokens=<int>. Source:
 *                        adapters/cc-hooks/user-prompt-submit.ts:484-490.
 *   explicit retrieval:  retrieval_log table (always available post-Plan 03).
 *
 * Phase 5 emits these as estimateTokens (chars/4) — for Phase 8.5 we
 * surface them as-is (acknowledged drift; the EXPLICIT retrieval line
 * uses real cl100k_base, the others reflect Phase 5's existing budget
 * proxy).
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import {
  aggregateSessionCost,
  reconcileUsedInOutput,
} from '../intelligence/retrieval-log.js';

export interface CostLine {
  label: string;
  tokens: number | null;
  detail?: string;
}

interface InjectionDetail {
  trigger?: string;
  total_tokens?: number;
}

export function readSessionStartCost(
  db: Database.Database,
  sessionId: string,
): CostLine {
  try {
    const row = db.prepare(
      `SELECT detail FROM telemetry
        WHERE session_id = ?
          AND event_kind = 'injection'
          AND json_extract(detail, '$.trigger') = 'session_start'
        ORDER BY timestamp_epoch ASC LIMIT 1`,
    ).get(sessionId) as { detail: string } | undefined;
    if (!row) return { label: 'session-start', tokens: null };
    const d = JSON.parse(row.detail) as InjectionDetail;
    if (typeof d.total_tokens !== 'number') {
      return { label: 'session-start', tokens: null };
    }
    return { label: 'session-start', tokens: d.total_tokens };
  } catch {
    return { label: 'session-start', tokens: null };
  }
}

export function readUpsTurnsCost(
  db: Database.Database,
  sessionId: string,
): CostLine {
  try {
    const rows = db.prepare(
      `SELECT detail FROM telemetry
        WHERE session_id = ?
          AND event_kind = 'injection'
          AND json_extract(detail, '$.trigger') IN ('gauge', 'topic_shift', 'post_compaction')`
    ).all(sessionId) as Array<{ detail: string }>;
    if (rows.length === 0) return { label: 'UPS turns', tokens: null };
    let total = 0;
    let count = 0;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.detail) as InjectionDetail;
        if (typeof d.total_tokens === 'number') {
          total += d.total_tokens;
          count++;
        }
      } catch { /* skip malformed row */ }
    }
    if (count === 0) return { label: 'UPS turns', tokens: null };
    const avg = Math.round(total / count);
    return {
      label: 'UPS turns',
      tokens: total,
      detail: `avg ${avg}/turn × ${count} turns`,
    };
  } catch {
    return { label: 'UPS turns', tokens: null };
  }
}

export function readExplicitRetrievalCost(
  db: Database.Database,
  sessionId: string,
): CostLine {
  const agg = aggregateSessionCost(db, sessionId);
  return {
    label: 'explicit retrieval',
    tokens: agg.totalTokens,
    detail: `${agg.invocations} invocation${agg.invocations === 1 ? '' : 's'}`,
  };
}

export function formatBlock(lines: CostLine[]): string {
  const out: string[] = ['Memory cost this session:'];
  let total = 0;
  let anyUnavailable = false;
  for (const ln of lines) {
    if (ln.tokens == null) {
      out.push(`  ${ln.label}: (unavailable)`);
      anyUnavailable = true;
    } else {
      total += ln.tokens;
      const tail = ln.detail ? ` (${ln.detail})` : '';
      out.push(`  ${ln.label}: ${ln.tokens} tokens${tail}`);
    }
  }
  out.push(
    `  total: ${total} tokens${anyUnavailable ? ' (+ some unavailable)' : ''}`,
  );
  return out.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: session-token-cost <session_id> [--no-reconcile]');
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
    const lines = [
      readSessionStartCost(db, sessionId),
      readUpsTurnsCost(db, sessionId),
      readExplicitRetrievalCost(db, sessionId),
    ];
    db.close();
    console.log(formatBlock(lines));
    process.exit(0);
  } catch (err) {
    console.error(
      'session-token-cost failed:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(0); // /endsession skill never blocks on this step
  }
}

// Run only when invoked as a script (CLI), not when imported by tests.
// In CJS bundle, `require.main === module` is the canonical guard.
// `process.argv[1]` ending in 'session-token-cost' covers vitest's
// dynamic import case where require.main is unset.
if (
  typeof require !== 'undefined' && require.main === module
  || (process.argv[1] && process.argv[1].includes('session-token-cost'))
) {
  main();
}
