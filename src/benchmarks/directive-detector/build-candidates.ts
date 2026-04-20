/**
 * build-candidates.ts — fixture-corpus builder for Plan 03-03.
 *
 * Reads `conversation_turns` for every `FIXTURE_SESSIONS` entry, strips
 * fenced + inline code, matches `DIRECTIVE_REGEX_FAMILIES`, and emits one
 * JSONL row per matching turn. The emitted rows are the input to both the
 * labeling harness (Plan 03-03's label-candidates.ts) and the precision
 * harness (Plan 03-05's run-precision.ts).
 *
 * Deterministic output: sorted by (ordinal ASC, turn_idx ASC). Commit-friendly.
 *
 * Usage:
 *   bun run src/benchmarks/directive-detector/build-candidates.ts
 *     [--db=~/.claudex/db/claudex.db]
 *     [--output=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl]
 *
 * Exit code: 0 on success, non-zero if fewer than 90 candidates emit (sanity
 * floor; RESEARCH §1.2 measured 105).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  DIRECTIVE_REGEX_FAMILIES,
  matchFamilies,
  stripCodeBlocks,
} from '../../intelligence/directive-detector-regex.js';
import { FIXTURE_SESSIONS, type FixtureSession } from './fixture-sessions.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  db: string;
  output: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    db: path.join(os.homedir(), '.claudex', 'db', 'claudex.db'),
    output: path.join(
      process.cwd(),
      '.planning',
      'phases',
      '03-p2-directive-detector',
      'fixtures',
      'fixture-candidates.jsonl',
    ),
  };
  for (const arg of argv) {
    const [k, v] = arg.split('=');
    if (k === '--db' && v) out.db = v.replace(/^~/, os.homedir());
    else if (k === '--output' && v) out.output = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture row shape — stable contract consumed by label-candidates.ts
// ---------------------------------------------------------------------------

export interface ContextTurn {
  turn_idx: number;
  user_text: string | null;
  assistant_text: string | null;
}

export interface FixtureCandidate {
  candidate_id: string;
  session_id: string;
  ordinal: number;
  turn_idx: number;
  raw_text: string;
  stripped_text: string;
  matched_families: string[];
  context_prev_2: ContextTurn[];
  context_next_2: ContextTurn[];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface TurnRow {
  turn_number: number;
  user_text: string | null;
  assistant_text: string | null;
}

function fetchTurns(db: Database.Database, sessionId: string): TurnRow[] {
  return db
    .prepare(
      `SELECT turn_number, user_text, assistant_text
         FROM conversation_turns
        WHERE session_id = ?
        ORDER BY turn_number ASC`,
    )
    .all(sessionId) as TurnRow[];
}

function buildRowsForSession(db: Database.Database, sess: FixtureSession): FixtureCandidate[] {
  const turns = fetchTurns(db, sess.session_id);
  const rowsOut: FixtureCandidate[] = [];

  // Index by turn_number for ±2 lookup
  const byTurn = new Map<number, TurnRow>();
  for (const t of turns) byTurn.set(t.turn_number, t);

  for (const t of turns) {
    if (!t.user_text) continue;
    const stripped = stripCodeBlocks(t.user_text);
    const families = matchFamilies(stripped);
    if (families.length === 0) continue;

    const ctxPrev: ContextTurn[] = [];
    const ctxNext: ContextTurn[] = [];
    for (let off = -2; off <= 2; off++) {
      if (off === 0) continue;
      const neighbor = byTurn.get(t.turn_number + off);
      if (!neighbor) continue;
      const ct: ContextTurn = {
        turn_idx: neighbor.turn_number,
        user_text: neighbor.user_text,
        assistant_text: neighbor.assistant_text,
      };
      if (off < 0) ctxPrev.push(ct);
      else ctxNext.push(ct);
    }

    rowsOut.push({
      candidate_id: `${sess.session_id}:${t.turn_number}`,
      session_id: sess.session_id,
      ordinal: sess.ordinal,
      turn_idx: t.turn_number,
      raw_text: t.user_text,
      stripped_text: stripped,
      matched_families: families,
      context_prev_2: ctxPrev,
      context_next_2: ctxNext,
    });
  }
  return rowsOut;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!fs.existsSync(args.db)) {
    console.error(`build-candidates: DB not found at ${args.db}`);
    return 2;
  }

  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const rows: FixtureCandidate[] = [];
    for (const sess of FIXTURE_SESSIONS) {
      rows.push(...buildRowsForSession(db, sess));
    }
    rows.sort((a, b) => (a.ordinal - b.ordinal) || (a.turn_idx - b.turn_idx));

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    const content = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
    fs.writeFileSync(args.output, content, 'utf8');

    const familyHits = new Map<string, number>();
    for (const r of rows) for (const f of r.matched_families) {
      familyHits.set(f, (familyHits.get(f) ?? 0) + 1);
    }
    const byFamily = DIRECTIVE_REGEX_FAMILIES
      .map(f => `  ${f.name.padEnd(24, ' ')} ${familyHits.get(f.name) ?? 0}`)
      .join('\n');

    console.log(`emitted ${rows.length} rows across ${FIXTURE_SESSIONS.length} sessions → ${args.output}`);
    console.log(`per-family hit counts (with overlap):\n${byFamily}`);
    if (rows.length < 90) {
      console.error(`FAIL: ${rows.length} < 90 sanity floor`);
      return 1;
    }
    return 0;
  } finally {
    db.close();
  }
}

export { main, buildRowsForSession };

// Executed when run directly via `node dist/.../build-candidates.cjs`.
// In the esbuild CJS bundle, `require.main === module` identifies the
// top-level script. `typeof require` check keeps this safe under vitest/ESM.
declare const require: { main: unknown } | undefined;
declare const module: unknown;
try {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const code = main(process.argv.slice(2));
    process.exit(code);
  }
} catch { /* noop — direct-run detection failed; module was imported. */ }
