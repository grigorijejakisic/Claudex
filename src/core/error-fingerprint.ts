/**
 * Pure error-fingerprint module — Phase 2 IDX-01.
 *
 * Token-shingle + outer-exception-class fingerprinter over stack traces.
 * Pure CPU; no DB, no network, no clock, no random — `computeErrorFingerprint`
 * is referentially transparent so two independent processes always agree on
 * the fingerprint of the same input.
 *
 * Used by:
 *   - `src/core/episodic-events.ts` (writeToolResult): ingest-time, attaches
 *     the fingerprint to `episodic_events.metadata_json.error_fingerprint`
 *     when content matches stack-trace shape.
 *   - `src/benchmark/episodic-density/backfill.ts`: one-time pass that
 *     populates the V26 sidecar from accumulated tool_result rows + v4
 *     artifact observations.
 *   - `src/benchmark/episodic-density/pair-labeling.ts` (frame extraction
 *     reused), `density.ts` (Jaccard over `shingles`), `retrieval.ts`
 *     (variant B fingerprint-only retrieval).
 *
 * CONTEXT.md item 6 specifies the storage shape (sidecar table); this module
 * specifies the compute that fills it. The decision rule (CONTEXT item 5)
 * binds to the harness's measurements over the same fingerprint; algorithm
 * details below should not be tuned post-hoc to chase a verdict.
 */

import { createHash } from 'crypto';

export const FINGERPRINT_ALGORITHM_VERSION = 1 as const;
export const SHINGLE_WIDTH = 5 as const;

export interface ErrorFingerprint {
  /** Sorted unique 16-hex-char shingle hashes; deterministic. */
  shingles: string[];
  /** Outer exception class, e.g. 'TypeError', 'sqlite3.OperationalError'; null if no header detected. */
  outer_exception: string | null;
  /** Number of stack frames detected. */
  frame_count: number;
  /** = SHINGLE_WIDTH (snapshotted into the fingerprint for forward compat). */
  shingle_width: number;
  /** = FINGERPRINT_ALGORITHM_VERSION (bump invalidates prior fingerprints). */
  algorithm_version: number;
}

const NODE_AT_LINE = /^\s+at\s+\S+/;
const PYTHON_FILE_LINE = /^\s+File\s+".+?",\s+line\s+\d+/;
const TRACEBACK_HEADER = /Traceback \(most recent call last\):/;
const FILE_LINE_TOKEN = /\S+:\d+(?::\d+)?/;
const FUNCTION_TOKEN = /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/;
const OUTER_EXCEPTION = /^([\w.]*(?:Error|Exception|Failed|Failure)):\s/m;

const NODE_AT_FRAME = /^\s+at\s+(.+?)\s*\(?(\S+):(\d+)(?::\d+)?\)?$/;
const PYTHON_FRAME = /^\s+File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/;
const GENERIC_FRAME = /^(\S+):(\d+)(?::\d+)?\s*[\s\(](\S+)/;

/**
 * Conservative heuristic: does this string LOOK like a stack trace? Returns
 * true if any of:
 *   - 2+ consecutive Node-style `^  at ...` lines
 *   - 2+ Python-style `^  File "...", line N` lines
 *   - one `Traceback (most recent call last):` header
 *   - 2+ lines containing both a `path:line` token AND a function-like token
 *   - one outer-exception header (`TypeError: foo`, `sqlite3.OperationalError: ...`)
 *
 * Total function — never throws; deterministic on any string input.
 */
export function looksLikeStackTrace(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const lines = content.split(/\r?\n/);

  let nodeAtCount = 0;
  let pyFileCount = 0;
  let mixedFrameCount = 0;
  for (const line of lines) {
    if (NODE_AT_LINE.test(line)) nodeAtCount++;
    if (PYTHON_FILE_LINE.test(line)) pyFileCount++;
    if (FILE_LINE_TOKEN.test(line) && FUNCTION_TOKEN.test(line)) mixedFrameCount++;
  }

  if (nodeAtCount >= 2) return true;
  if (pyFileCount >= 2) return true;
  if (mixedFrameCount >= 2) return true;
  if (TRACEBACK_HEADER.test(content)) return true;
  if (OUTER_EXCEPTION.test(content)) return true;
  return false;
}

/**
 * Extract the outer exception class from a stack-trace string.
 * Match `^<dotted.path><Error|Exception|Failed|Failure>:\s` somewhere in the
 * string (multiline) — typical headers from Node, Python, sqlite3, etc.
 * Returns null if no match.
 */
function extractOuterException(content: string): string | null {
  const m = content.match(OUTER_EXCEPTION);
  return m ? m[1] : null;
}

/**
 * Extract `<file>:<line>:<func>` frames from a string. The `func` slot may be
 * the empty string when only file:line is recoverable. Frames missing both
 * file and line are skipped.
 *
 * Exposed for reuse by `src/benchmark/episodic-density/pair-labeling.ts`,
 * which needs the same frame definition the auto-pair-labeler in CONTEXT
 * item 2 specifies (`file:line + function name`).
 */
export function extractFrames(content: string): Array<{ file: string; line: string; func: string }> {
  const frames: Array<{ file: string; line: string; func: string }> = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    let m: RegExpMatchArray | null = raw.match(NODE_AT_FRAME);
    if (m) {
      frames.push({ file: m[2], line: m[3], func: m[1].trim() });
      continue;
    }
    m = raw.match(PYTHON_FRAME);
    if (m) {
      frames.push({ file: m[1], line: m[2], func: (m[3] ?? '').trim() });
      continue;
    }
    m = raw.match(GENERIC_FRAME);
    if (m) {
      frames.push({ file: m[1], line: m[2], func: m[3].trim() });
      continue;
    }
  }
  return frames;
}

/**
 * Token-shingle the content with width=SHINGLE_WIDTH; sha256 the shingle and
 * keep the first 16 hex chars; deduplicate and sort lexicographically for
 * byte-stable output across processes.
 */
function computeShingles(content: string): string[] {
  const tokens = content.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length < SHINGLE_WIDTH) return [];
  const set = new Set<string>();
  for (let i = 0; i + SHINGLE_WIDTH <= tokens.length; i++) {
    const ngram = tokens.slice(i, i + SHINGLE_WIDTH).join(' ');
    const hash = createHash('sha256').update(ngram).digest('hex').slice(0, 16);
    set.add(hash);
  }
  return Array.from(set).sort();
}

/**
 * Compute the fingerprint of a candidate error/stack-trace string.
 * Returns null if `looksLikeStackTrace(content)` is false (omit, don't
 * fabricate). Total function — never throws on any string input.
 *
 * Determinism: pure compute (sha256 + lexical sort + Set dedup); independent
 * processes that pass the same string get the byte-equal output.
 */
export function computeErrorFingerprint(content: string): ErrorFingerprint | null {
  if (!looksLikeStackTrace(content)) return null;
  const outer = extractOuterException(content);
  const frames = extractFrames(content);
  const shingles = computeShingles(content);
  return {
    shingles,
    outer_exception: outer,
    frame_count: frames.length,
    shingle_width: SHINGLE_WIDTH,
    algorithm_version: FINGERPRINT_ALGORITHM_VERSION,
  };
}
