/**
 * TaskCompleted hook (H13b) — when a task is completed.
 * Pure event logger — records task_completed event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('TaskCompleted', async (input, ctx) => {
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
    'task_completed',
    taskId,
    taskSubject,
    detail,
  );

  return {};
});

main();
