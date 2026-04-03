/**
 * TaskCreated hook (H13a) — when a task is created.
 * Pure event logger — records task_created event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('TaskCreated', async (input, ctx) => {
  const taskId = (input.task_id as string) || '';
  const taskSubject = ((input.task_subject as string) || '').slice(0, 80);

  const detail = JSON.stringify({
    description: ((input.task_description as string) || '').slice(0, 200),
    teammate_name: (input.teammate_name as string) || undefined,
    team_name: (input.team_name as string) || undefined,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'task_created',
    taskId,
    taskSubject,
    detail,
  );

  return {};
});

main();
