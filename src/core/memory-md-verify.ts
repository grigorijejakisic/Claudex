/**
 * Read-only MEMORY.md invariant verifier (CUR-03 SC-5).
 *
 * Called once at session-start (after file-artifact ingestion). Checks the
 * Angel-managed MEMORY.md at `~/.claude/projects/<slug>/memory/MEMORY.md`
 * against size/line/sentinel invariants. On violation, records a
 * `memory_md_invalid` session event. Never mutates the file.
 *
 * Writer (`src/angel/memory-md-writer.ts`) owns all mutations; this module
 * is the observability half.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { recordEvent } from './session-events.js';
import { pathToCcSlug } from '../shared/cc-slug.js';

export type VerifyReason =
  | 'ok'
  | 'file_missing'
  | 'not_angel_managed'
  | 'size_exceeded'
  | 'lines_exceeded'
  | 'sentinel_missing'
  | 'sentinel_invalid';

export interface VerifyResult {
  path: string;
  reason: VerifyReason;
  bytes: number;
  lines: number;
  hash: string | null;
}

const MAX_BYTES = 25_000;
const MAX_LINES = 200;
const USER_EDITABLE_MARKER = '<!-- USER EDITABLE -->';
// Allow any-length hex to distinguish sentinel_missing from sentinel_invalid.
// Writer's canonical sentinel uses 64 hex chars (sha256); anything else flags.
const SENTINEL_ANY_HEX_REGEX =
  /^<!-- CLAUDEX-MANAGED: do not edit above user section\. hash=([0-9a-f]+) -->$/;

export function verifyMemoryMd(
  db: Database,
  project: string,
  sessionId: string,
  opts: { scope?: string; cwd?: string } = {},
): VerifyResult {
  try {
    const slug = resolveSlug(opts.scope, opts.cwd, project);
    const memoryMdPath = path.join(
      os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md',
    );

    if (!fs.existsSync(memoryMdPath)) {
      return { path: memoryMdPath, reason: 'file_missing', bytes: 0, lines: 0, hash: null };
    }

    const content = fs.readFileSync(memoryMdPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const lines = content.split('\n').length;
    const firstLine = content.split('\n', 1)[0] ?? '';
    const sentinelMatch = firstLine.match(SENTINEL_ANY_HEX_REGEX);
    const hasMarker = content.includes(USER_EDITABLE_MARKER);

    // Non-Angel-managed file — never curated; not our problem.
    if (!hasMarker && !sentinelMatch) {
      return { path: memoryMdPath, reason: 'not_angel_managed', bytes, lines, hash: null };
    }

    // Size / line invariants — flag regardless of sentinel state so Angel sees
    // the problem even on files that lost their marker via user tampering.
    if (bytes > MAX_BYTES) {
      return flag(db, project, sessionId, memoryMdPath, 'size_exceeded', bytes, lines, null);
    }
    if (lines > MAX_LINES) {
      return flag(db, project, sessionId, memoryMdPath, 'lines_exceeded', bytes, lines, null);
    }

    // Sentinel presence check only when marker is present (CUR-03 semantics).
    if (hasMarker && !sentinelMatch) {
      return flag(db, project, sessionId, memoryMdPath, 'sentinel_missing', bytes, lines, null);
    }
    if (hasMarker && sentinelMatch && sentinelMatch[1].length !== 64) {
      return flag(db, project, sessionId, memoryMdPath, 'sentinel_invalid', bytes, lines, sentinelMatch[1]);
    }

    return {
      path: memoryMdPath,
      reason: 'ok',
      bytes,
      lines,
      hash: sentinelMatch ? sentinelMatch[1] : null,
    };
  } catch {
    // IO errors (missing HOME, permission denied, etc.) are swallowed here.
    // Session-start telemetry wraps this call in its own try/catch for logging.
    return { path: '', reason: 'ok', bytes: 0, lines: 0, hash: null };
  }
}

function resolveSlug(scope: string | undefined, cwd: string | undefined, project: string): string {
  if (scope) return scope;
  if (cwd) return pathToCcSlug(cwd);
  // Fallback: project may already be a slug or may be a path — pathToCcSlug is
  // idempotent for already-encoded strings (no separators to replace).
  return /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
}

function flag(
  db: Database,
  project: string,
  sessionId: string,
  p: string,
  reason: VerifyReason,
  bytes: number,
  lines: number,
  hash: string | null,
): VerifyResult {
  try {
    recordEvent(
      db,
      sessionId,
      project,
      'memory_md_invalid',
      p,
      'verify',
      JSON.stringify({ reason, bytes, lines }),
    );
  } catch { /* telemetry failure is non-fatal */ }
  return { path: p, reason, bytes, lines, hash };
}
