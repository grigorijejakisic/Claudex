/**
 * PreCompact hook -> before_compact event.
 * Writes checkpoint, promotes learnings, marks post-compact-pending.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { readGsdState } from '../../gsd/state-reader.js';
import { runCompactionSequence } from '../shared/lifecycle.js';
import { detectEnrichmentProvider } from '../../intelligence/enrichment.js';

const main = wrapHook('PreCompact', async (input, ctx) => {
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });
  const gsd = readGsdState(input.cwd);

  // Detect enrichment provider (Ollama) — optional, non-blocking
  let enrichmentProvider: Awaited<ReturnType<typeof detectEnrichmentProvider>> = null;
  try {
    enrichmentProvider = await detectEnrichmentProvider(
      {
        baseUrl: ctx.config.enrichment.ollama_base_url,
        model: ctx.config.enrichment.ollama_model,
        enabled: ctx.config.enrichment.enabled,
      },
      CC_CAPABILITIES,
    );
  } catch {
    // Non-fatal — enrichment is optional
  }

  // Isolated — compaction failure must not prevent returning custom instructions
  try {
    await runCompactionSequence({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      cwd: input.cwd,
      scope: ctx.scope ?? undefined,
      gauge: gauge ?? undefined,
      gsd: gsd ?? undefined,
      enrichmentProvider: enrichmentProvider ?? undefined,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'pre_compact/sequence', e);
  }

  // Return custom compaction instructions if configured
  const instructions = ctx.config.checkpoint.compaction_instructions;
  if (instructions) {
    return { customInstructions: instructions };
  }

  return {};
});

main();
