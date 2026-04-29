/**
 * Phase 5.5 — Curation feedback sweeps.
 *
 * Two heartbeat-driven operations:
 *   - sweepArchivePointers: demote lesson pointers with 0 retrievals in 90d
 *     AND no helpful_yn=1 row. Action: set tier='background' on lesson
 *     frontmatter. The MEMORY.md renderLessons filters foreground only,
 *     so this immediately removes the pointer from the foreground index
 *     on the next MEMORY.md rebuild.
 *
 *   - sweepPromotePointers: promote lesson pointers with ≥3 retrievals
 *     AND ≥1 helpful_yn=1. Action: bump last_fired_at_epoch on lesson
 *     frontmatter to now. renderLessons sorts foreground by
 *     last_fired_at_epoch DESC, so the bump puts the pointer at the top
 *     of `## Lessons`.
 *
 * Both sweeps:
 *   - Operate only on source='lesson' pointers (user_note auto-archive
 *     is deferred — see RESEARCH §8 + CONTEXT.md byte-preservation contract).
 *   - Are project-aware via lesson_pointer.project (the encoded form
 *     used on disk).
 *   - Take an explicit nowEpochMs parameter (no internal Date.now())
 *     for time-mocked tests.
 *   - Are idempotent under repeated invocation.
 */

import type { Database } from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import { cachedPrepare } from '../core/stmt-cache.js';
import { parseLessonFile } from './lesson-reader.js';
import { updateLessonFrontmatter } from './lesson-writer.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const PROMOTE_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // skip if last_fired bumped <24h ago
const ARCHIVE_GATE_MS = 24 * 60 * 60 * 1000;       // run archive sweep at most every 24h
const PROMOTE_GATE_MS = 7 * 24 * 60 * 60 * 1000;   // run promote sweep at most every 7d

// Module-scoped time gates (mirrors shouldConsolidate / markConsolidationRan
// pattern in heartbeat.ts).
let lastArchiveSweepAt = 0;
let lastPromoteSweepAt = 0;

export function shouldRunArchiveSweep(nowEpochMs: number): boolean {
  return nowEpochMs - lastArchiveSweepAt >= ARCHIVE_GATE_MS;
}
export function markArchiveSweepRan(nowEpochMs: number): void {
  lastArchiveSweepAt = nowEpochMs;
}
export function shouldRunPromoteSweep(nowEpochMs: number): boolean {
  return nowEpochMs - lastPromoteSweepAt >= PROMOTE_GATE_MS;
}
export function markPromoteSweepRan(nowEpochMs: number): void {
  lastPromoteSweepAt = nowEpochMs;
}

/**
 * Reconstruct the on-disk path for a lesson pointer. The `project` value
 * stored in lesson_pointer is the encoded form (e.g.,
 * 'C--Users-Grigorije-Desktop-Projects-CLAUDEXv3') already produced by
 * lesson-writer when files were created. So the path is mechanical:
 *
 *   <basedir>/projects/<project>/memory/<filename>
 *
 * `basedir` defaults to ~/.claude. Tests inject a tmpdir via the optional
 * argument so the sweep operates on fixture files instead of real lessons.
 */
function resolveLessonPath(project: string, filename: string, basedir?: string): string {
  const root = basedir ?? path.join(os.homedir(), '.claude');
  return path.join(root, 'projects', project, 'memory', filename);
}

export interface ArchiveSweepOpts {
  ageMs?: number;
  basedir?: string;
}

/**
 * Archive sweep: demote unused lesson pointers to tier='background'.
 *
 * Returns the number of lessons demoted (excludes already-background lessons
 * and lessons whose files were missing on disk).
 */
export function sweepArchivePointers(
  db: Database,
  nowEpochMs: number,
  opts?: ArchiveSweepOpts,
): number {
  const cutoff = nowEpochMs - (opts?.ageMs ?? NINETY_DAYS_MS);

  const candidates = cachedPrepare(db,
    `SELECT lp.id, lp.project, lp.filename
       FROM lesson_pointer lp
      WHERE lp.source = 'lesson'
        AND NOT EXISTS (
          SELECT 1 FROM pointer_recall_log prl
           WHERE prl.pointer_id = lp.id
             AND prl.retrieved_at_epoch_ms > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM pointer_recall_log prl
           WHERE prl.pointer_id = lp.id AND prl.helpful_yn = 1
        )`
  ).all(cutoff) as Array<{ id: number; project: string; filename: string }>;

  let archived = 0;
  for (const c of candidates) {
    const filePath = resolveLessonPath(c.project, c.filename, opts?.basedir);
    let parsed;
    try { parsed = parseLessonFile(filePath); } catch { continue; }
    if (!parsed) continue;
    if (parsed.frontmatter.tier === 'background') continue;  // idempotent

    try {
      updateLessonFrontmatter(filePath, { tier: 'background' });
      archived++;
    } catch {
      // File may have been deleted between SELECT and write — skip.
    }
  }
  return archived;
}

export interface PromoteSweepOpts {
  minRecalls?: number;
  basedir?: string;
}

/**
 * Promote sweep: bump last_fired_at_epoch on lesson pointers that have
 * earned their place by use.
 *
 * Returns the number of lessons promoted (excludes lessons whose
 * last_fired was bumped within the cooldown window).
 *
 * Re-promotion implicitly un-archives a pointer (tier flips from
 * 'background' back to 'foreground'). CONTEXT.md "natural rehabilitation
 * path" — a previously-archived lesson that re-earns ≥3 recalls + helpful=1
 * climbs out of background.
 */
export function sweepPromotePointers(
  db: Database,
  nowEpochMs: number,
  opts?: PromoteSweepOpts,
): number {
  const minRecalls = opts?.minRecalls ?? 3;

  const candidates = cachedPrepare(db,
    `SELECT lp.id, lp.project, lp.filename, COUNT(*) AS recall_count
       FROM lesson_pointer lp
       JOIN pointer_recall_log prl ON prl.pointer_id = lp.id
      WHERE lp.source = 'lesson'
      GROUP BY lp.id
     HAVING COUNT(*) >= ?
        AND SUM(CASE WHEN prl.helpful_yn = 1 THEN 1 ELSE 0 END) >= 1`
  ).all(minRecalls) as Array<{ id: number; project: string; filename: string; recall_count: number }>;

  let promoted = 0;
  const cooldownCutoff = nowEpochMs - PROMOTE_COOLDOWN_MS;

  for (const c of candidates) {
    const filePath = resolveLessonPath(c.project, c.filename, opts?.basedir);
    let parsed;
    try { parsed = parseLessonFile(filePath); } catch { continue; }
    if (!parsed) continue;

    const lastFired = parsed.frontmatter.last_fired_at_epoch ?? 0;
    if (lastFired >= cooldownCutoff) continue;  // already promoted recently

    try {
      const partial: Partial<typeof parsed.frontmatter> = {
        last_fired_at_epoch: nowEpochMs,
      };
      if (parsed.frontmatter.tier === 'background') partial.tier = 'foreground';
      updateLessonFrontmatter(filePath, partial);
      promoted++;
    } catch {
      // File missing — skip.
    }
  }
  return promoted;
}

/**
 * Test seam: reset module-level gate state. Used by curation-sweep tests
 * to start each case from a known initial state.
 */
export function __resetGatesForTests(): void {
  lastArchiveSweepAt = 0;
  lastPromoteSweepAt = 0;
}
