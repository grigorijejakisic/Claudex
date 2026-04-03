/**
 * ConfigChange hook (H8) — when settings or config files change.
 * Pure event logger — records config_change event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('ConfigChange', async (input, ctx) => {
  const source = (input.source as string) || 'unknown';
  const filePath = (input.file_path as string) || 'unknown';

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'config_change',
    source,
    filePath,
  );

  return {};
});

main();
