/**
 * PostToolUse hook -> after_tool event.
 * Extracts observations, updates pressure, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES, EDIT_TOOL_NAMES } from '../../shared/constants.js';
import { createSignal } from '../../core/session-signals.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import {
  processToolAndPressure,
  trackAfterTool,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';
import { routeByContent, extractRoutingContent, buildProjectIndex } from '../../shared/content-router.js';
import { withBehavioralBatch, applyFileEditIncrement, applyToolCallPattern, setExperienceFlags, getExperienceFlags } from '../../intelligence/experience-flags.js';
import { buildToolSignature } from '../../intelligence/behavioral-signals.js';
import { matchTriggers } from '../../intelligence/trigger-engine.js';
import { extractEventsFromToolUse, recordEvent, recordEventDeduped } from '../../core/session-events.js';

// ---------------------------------------------------------------------------
// Behavioral signal thresholds (spec-defined)
// ---------------------------------------------------------------------------
const FILE_THRASHING_THRESHOLD = 3; // same file edited 3+ times = thrashing

const main = wrapHook('PostToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const toolOutput = (input.tool_response as Record<string, unknown>) || undefined;

  // Content-aware routing — route to the project the content belongs to
  const routingContent = extractRoutingContent(toolInput, toolOutput);
  const projectIndex = buildProjectIndex();
  const routedProject = routeByContent(routingContent, ctx.project, projectIndex);

  // Each operation isolated — if A fails, B and C still run

  try {
    await processToolAndPressure({
      db: ctx.db,
      sessionId: input.session_id,
      project: routedProject,
      cwd: input.cwd,
      toolName,
      toolInput,
      toolOutput,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/process', e);
  }

  // Note: observation artifact creation and milestone detection happen in
  // lifecycle.ts processToolAndPressure, not here — avoids duplication and
  // ensures both CC hooks and OpenClaw bridge get milestones.

  // Thread tracking
  //
  // DESIGN LIMITATION (ephemeral CC hook process):
  // ThreadTracker.onAfterTool() accumulates pending exchanges in memory, but the
  // CC hook process exits immediately after each invocation. This means in-memory
  // pending exchange data is lost between hook calls. Thread tracking only works
  // fully in the persistent OpenClaw bridge, where the process stays alive across
  // multiple tool calls within a turn. In the CC hooks adapter, only the DB-persisted
  // state (via tracker.persist()) survives between invocations — the pending exchange
  // count and any volatile accumulation are reset on each hook call.
  try {
    trackAfterTool(
      ctx.db,
      input.session_id,
      (input.prompt as string) ?? (input.user_prompt as string) ?? undefined,
      toolName,
      toolInput,
    );
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/track', e);
  }

  // Checkpoint threshold check
  try {
    const gauge = getTokenGauge({
      capabilities: CC_CAPABILITIES,
      transcriptPath: getTranscriptPath(input),
    });

    await checkpointIfThresholdMet({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      cwd: input.cwd,
      scope: ctx.scope ?? undefined,
      config: ctx.config,
      gauge,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/checkpoint', e);
  }

  // ---------------------------------------------------------------------------
  // Behavioral signal detection (v1: detect + telemetry only; no auto-pattern)
  // Per spec: behavioral signals are detected here but pattern creation from
  // behavioral signals is v2. v1 only logs signals to telemetry.
  //
  // Batch pattern: read counters ONCE, mutate in memory, write ONCE — avoids
  // N×2 DB round-trips from separate incrementFileEditCount + trackToolCallPattern
  // calls on every tool invocation.
  // ---------------------------------------------------------------------------
  try {
    const isEditTool = (EDIT_TOOL_NAMES as readonly string[]).includes(toolName);
    // NotebookEdit sends `notebook_path` — verify against real CC payloads if field name changes.
    const filePath = (toolInput.file_path as string) || (toolInput.path as string) || (toolInput.notebook_path as string) || '';
    const sig = toolName ? buildToolSignature(toolName, toolInput) : '';

    // Stigmergic wip signal: broadcast "I'm editing this file" to other sessions
    if (isEditTool && filePath && routedProject) {
      createSignal(ctx.db, input.session_id, routedProject, 'wip', filePath);
    }

    withBehavioralBatch(ctx.db, input.session_id, (counters) => {
      if (isEditTool && filePath) {
        const editCount = applyFileEditIncrement(counters, filePath);
        if (editCount >= FILE_THRASHING_THRESHOLD) {
          emitTelemetry(ctx.db, input.session_id, 'injection', {
            trigger: 'gauge' as const,
            sections_included: ['behavioral_signal_file_thrashing'],
            sections_skipped: [],
            total_tokens: 0,
            budget_remaining: 0,
          });
        }
      }

      // Loop detection: track tool+input signature, log if loop detected
      if (toolName && sig) {
        const loopDetected = applyToolCallPattern(counters, toolName, sig);
        if (loopDetected) {
          emitTelemetry(ctx.db, input.session_id, 'injection', {
            trigger: 'gauge' as const,
            sections_included: ['behavioral_signal_loop_detected'],
            sections_skipped: [],
            total_tokens: 0,
            budget_remaining: 0,
          });
        }
      }
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/behavioral_signals', e);
  }

  // ---------------------------------------------------------------------------
  // Trigger engine — match tool input against context triggers and
  // predictive experience patterns (file globs, command patterns)
  // ---------------------------------------------------------------------------
  try {
    const triggerMatch = matchTriggers(ctx.db, routedProject, toolName, toolInput);
    if (triggerMatch.patternIds.length > 0 || triggerMatch.domains.length > 0) {
      const flags = getExperienceFlags(ctx.db, input.session_id);
      const mergedPatterns = triggerMatch.patternIds.length > 0
        ? [...new Set([...flags.injected_pattern_ids, ...triggerMatch.patternIds])]
        : flags.injected_pattern_ids;
      const mergedDomains = triggerMatch.domains.length > 0
        ? [...new Set([...flags.pending_trigger_domains, ...triggerMatch.domains])]
        : flags.pending_trigger_domains;
      setExperienceFlags(ctx.db, input.session_id, {
        injected_pattern_ids: mergedPatterns,
        pending_trigger_domains: mergedDomains,
      }, flags);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/trigger_engine', e);
  }

  // ---------------------------------------------------------------------------
  // Workflow phase detection — detect phase transitions from tool sequences
  // and store the detected phase for intent-triggered pattern matching.
  // Aviation checklist pattern: fire rules at phase transitions, not every turn.
  // ---------------------------------------------------------------------------
  try {
    let detectedPhase: string | null = null;

    // Map tool usage to workflow phases
    const toolLower = toolName.toLowerCase();
    const inputStr = JSON.stringify(toolInput).toLowerCase();

    if (toolLower === 'bash' && (inputStr.includes('git commit') || inputStr.includes('git add'))) {
      detectedPhase = 'pre-commit';
    } else if (toolLower === 'bash' && (inputStr.includes('git push') || inputStr.includes('gh pr'))) {
      detectedPhase = 'pre-publish';
    } else if (EDIT_TOOL_NAMES.includes(toolName) && inputStr.includes('refactor')) {
      detectedPhase = 'refactoring';
    } else if (toolLower === 'bash' && (inputStr.includes('vitest') || inputStr.includes('test'))) {
      detectedPhase = 'testing';
    }

    if (detectedPhase) {
      // Store detected phase in experience flags for the assembler to pick up
      const flags = getExperienceFlags(ctx.db, input.session_id);
      setExperienceFlags(ctx.db, input.session_id, {
        pending_trigger_domains: [...new Set([...flags.pending_trigger_domains, detectedPhase])],
      }, flags);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/phase_detection', e);
  }

  // ---------------------------------------------------------------------------
  // Session events — lightweight structured event capture
  // Only for mutative tools (Edit, Write, Bash) — skip reads to avoid DB bloat
  // ---------------------------------------------------------------------------
  try {
    const events = extractEventsFromToolUse(toolName, toolInput, toolOutput);
    for (const ev of events) {
      if (ev.deduped) {
        recordEventDeduped(ctx.db, input.session_id, routedProject, ev.type, ev.entity, ev.action, ev.detail);
      } else {
        recordEvent(ctx.db, input.session_id, routedProject, ev.type, ev.entity, ev.action, ev.detail);
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/session_events', e);
  }

  return {};
});

main();
