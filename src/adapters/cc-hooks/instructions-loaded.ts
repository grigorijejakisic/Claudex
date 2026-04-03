/**
 * InstructionsLoaded hook (H9) — when CLAUDE.md or rules files are loaded/reloaded.
 * Pure event logger — records instructions_loaded event with metadata.
 * B3 awareness: does NOT fire after compaction (#30973). PostCompact handles that case.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('InstructionsLoaded', async (input, ctx) => {
  const filePath = (input.file_path as string) || '';
  const loadReason = (input.load_reason as string) || 'unknown';

  const detail: Record<string, unknown> = {
    memory_type: (input.memory_type as string) || undefined,
  };
  if (input.globs) detail.globs = input.globs;
  if (input.trigger_file_path) detail.trigger_file_path = input.trigger_file_path;
  if (input.parent_file_path) detail.parent_file_path = input.parent_file_path;

  // Strip undefined values
  for (const key of Object.keys(detail)) {
    if (detail[key] === undefined) delete detail[key];
  }

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'instructions_loaded',
    filePath,
    loadReason,
    Object.keys(detail).length > 0 ? JSON.stringify(detail) : undefined,
  );

  return {};
});

main();
