/**
 * PostCompact hook (H4) — after compaction completes.
 * Records compaction event, clears post-compact-pending flag, stores compact summary as journal entry.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';
import { clearPostCompactPending } from '../../core/checkpoint-tracking.js';
import { addJournalEntry } from '../../core/journal.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import * as fs from 'fs';

const main = wrapHook('PostCompact', async (input, ctx) => {
  const trigger = (input.trigger as string) || 'auto';
  const compactSummary = (input.compact_summary as string) || '';

  // Record compaction event
  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'compaction',
    'post-compact',
    trigger,
    compactSummary.slice(0, 500),
  );

  // Clear post-compact-pending flag set by PreCompact
  clearPostCompactPending(ctx.db, input.session_id);

  // Store compact summary as journal entry for cross-session recall
  if (compactSummary) {
    try {
      addJournalEntry(
        ctx.db,
        input.session_id,
        ctx.project,
        'summary',
        compactSummary.slice(0, 2000),
      );
    } catch { /* non-critical */ }
  }

  // B5: Edit integrity verification — check if tracked Claudex file edits survived compaction.
  // Compaction can silently revert tool-applied edits (CC #34674). Compare recorded mtime
  // with current file mtime to detect potential reverts.
  try {
    const trackedEdits = cachedPrepare(ctx.db,
      `SELECT entity, detail FROM session_events
       WHERE session_id = ? AND event_type = 'claudex_file_edit'
       ORDER BY timestamp_epoch DESC LIMIT 20`
    ).all(input.session_id) as Array<{ entity: string; detail: string | null }>;

    for (const edit of trackedEdits) {
      try {
        const filePath = edit.entity;
        if (!fs.existsSync(filePath)) {
          recordEvent(ctx.db, input.session_id, ctx.project,
            'edit_integrity_warning', filePath, 'missing',
            'File no longer exists after compaction',
          );
          continue;
        }
        const currentMtime = fs.statSync(filePath).mtimeMs;
        const recorded = edit.detail ? JSON.parse(edit.detail) : {};
        const recordedMtime = Number(recorded.mtime ?? 0);
        // If file mtime is older than recorded edit time, edit may have been reverted
        if (recordedMtime > 0 && currentMtime < recordedMtime) {
          recordEvent(ctx.db, input.session_id, ctx.project,
            'edit_integrity_warning', filePath, 'mtime_regressed',
            JSON.stringify({ recorded_mtime: recordedMtime, current_mtime: currentMtime }),
          );
        }
      } catch { /* per-file check is non-fatal */ }
    }
  } catch { /* non-critical — integrity check is best-effort */ }

  return {};
});

main();
