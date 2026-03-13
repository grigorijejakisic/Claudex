/**
 * SessionStart hook -> session_init event.
 * Creates session, recovers checkpoints, prunes telemetry, assembles full context.
 * @see Architecture Section 3.2
 */

import { wrapHook } from './infrastructure.js';
import { createSession } from '../../core/sessions.js';
import { recoverFromDb } from '../../checkpoint/loader.js';
import { emitInjectionTelemetry, pruneTelemetry } from '../../observability/telemetry.js';
import { assembleFullContext } from '../../assembly/assembler.js';
import { getIdentityDir } from '../../shared/paths.js';

const main = wrapHook('SessionStart', async (input, ctx) => {
  createSession(ctx.db, {
    session_id: input.session_id,
    project: ctx.project,
    scope: ctx.scope ?? undefined,
    cwd: input.cwd,
    source: 'cc-hooks',
    adapter: 'cc-hooks',
  });

  await recoverFromDb(ctx.db);

  if (ctx.config.observability.enabled) {
    pruneTelemetry(ctx.db, {
      retentionDays: ctx.config.observability.retention_days,
      retainErrorCount: ctx.config.observability.retain_error_count,
    });
  }

  const payload = assembleFullContext({
    db: ctx.db,
    project: ctx.project,
    projectDir: input.cwd,
    config: ctx.config,
    identityDir: getIdentityDir(),
    sessionId: input.session_id,
  });

  if (ctx.config.observability.enabled) {
    emitInjectionTelemetry(ctx.db, input.session_id, {
      trigger: 'session_start',
      sectionsIncluded: payload.sources,
      totalTokens: payload.tokenEstimate,
      budgetTokens: ctx.config.injection.budget_tokens,
    });
  }

  if (payload.content) {
    return { additionalContext: payload.content };
  }
  return {};
});

main();
