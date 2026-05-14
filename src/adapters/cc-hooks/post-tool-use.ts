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
import { mapToolToDomain } from '../../intelligence/critical-reminders.js';
import { writeToolResult } from '../../core/episodic-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Behavioral signal thresholds (spec-defined)
// ---------------------------------------------------------------------------
const FILE_THRASHING_THRESHOLD = 3; // same file edited 3+ times = thrashing

const main = wrapHook('PostToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const toolOutput = (input.tool_response as Record<string, unknown>) || undefined;

  // Phase 6 EBD-02: heartbeat tick. Best-effort; never fails the hook.
  try {
    const now = Math.floor(Date.now() / 1000);
    cachedPrepare(ctx.db,
      `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?`
    ).run(now, input.session_id);
  } catch { /* swallow */ }

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
  // Critical reminders: activity gate + first-encounter tracking
  // Flags phase-transition moments and tracks new rule domains for injection.
  // ---------------------------------------------------------------------------
  try {
    const crFlags = getExperienceFlags(ctx.db, input.session_id);
    let gateTriggered = false;
    const newDomains: string[] = [...crFlags.seen_rule_domains];

    // Activity gate: multi-file edits
    const behavioral = withBehavioralBatch(ctx.db, input.session_id, () => {});
    const editFiles = Object.keys(behavioral.file_edit_counts);
    if (editFiles.length >= 2) gateTriggered = true;

    // Activity gate: git operations
    const crToolLower = toolName.toLowerCase();
    const crInputStr = JSON.stringify(toolInput).toLowerCase();
    if (crToolLower === 'bash' && (crInputStr.includes('git commit') || crInputStr.includes('git push'))) {
      gateTriggered = true;
    }

    // Activity gate: agent spawning
    if (crToolLower === 'task' || crToolLower === 'agent' || crToolLower === 'subagent') {
      gateTriggered = true;
    }

    // First-encounter: track tool domain
    const toolDomain = mapToolToDomain(toolName);
    if (toolDomain && !newDomains.includes(toolDomain)) {
      newDomains.push(toolDomain);
    }

    if (gateTriggered || newDomains.length !== crFlags.seen_rule_domains.length) {
      setExperienceFlags(ctx.db, input.session_id, {
        critical_activity_gate: gateTriggered || crFlags.critical_activity_gate,
        seen_rule_domains: newDomains,
      }, crFlags);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/critical_gate', e);
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

  // ---------------------------------------------------------------------------
  // B5: Edit integrity tracking — track Edit/Write on Claudex-relevant files.
  // Tracked paths: src/, CLAUDE.md, .claude/rules/, context/
  // Records claudex_file_edit events so PostCompact can verify edits survived.
  // ---------------------------------------------------------------------------
  try {
    const isEditTool = (EDIT_TOOL_NAMES as readonly string[]).includes(toolName);
    if (isEditTool) {
      const filePath = (toolInput.file_path as string) || (toolInput.path as string) || (toolInput.notebook_path as string) || '';
      if (filePath) {
        // Normalize to forward slashes for consistent matching
        const normalized = filePath.replace(/\\/g, '/');
        const cwdNormalized = input.cwd.replace(/\\/g, '/');
        const relative = normalized.startsWith(cwdNormalized)
          ? normalized.slice(cwdNormalized.length).replace(/^\//, '')
          : normalized;

        const isClaudexRelevant =
          relative.startsWith('src/') ||
          relative === 'CLAUDE.md' ||
          relative.startsWith('.claude/rules/') ||
          relative.startsWith('context/');

        if (isClaudexRelevant) {
          let mtime: number;
          try {
            mtime = fs.statSync(filePath).mtimeMs;
          } catch {
            mtime = Date.now(); // fallback for newly created files
          }
          recordEvent(ctx.db, input.session_id, routedProject,
            'claudex_file_edit', filePath, toolName,
            JSON.stringify({ mtime }),
          );
        }
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/edit_integrity', e);
  }

  // ---------------------------------------------------------------------------
  // V5 Plan 01-03 (EPI-03, EPI-05): episodic substrate write for the tool result.
  // Each PostToolUse fires exactly one writeToolResult — provenance='tool_result',
  // source=<toolName>, content=stringified tool_response, metadata_json carries
  // the tool_input so Phase 2 indexes can filter by args without parsing.
  // turn_number = current MAX(turn_number) for this session, or NULL when no
  // user prompt has fired yet. parent_event_id stays NULL in Phase 1 (Phase 4
  // links tool_result rows back to assistant_message when retrieval needs it).
  // Non-fatal: telemetry-on-rollback inside writeToolResult records any failure;
  // we never let the new write break the existing PostToolUse flow.
  // ---------------------------------------------------------------------------
  try {
    const toolResultText = toolOutput !== undefined ? JSON.stringify(toolOutput) : '';
    const lastTurn = cachedPrepare(ctx.db,
      `SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?`
    ).get(input.session_id) as { max_turn: number | null } | undefined;
    const turnNumber = lastTurn?.max_turn ?? undefined;
    writeToolResult({
      db: ctx.db,
      sessionId: input.session_id,
      project: routedProject,
      toolName: toolName || 'unknown',
      toolInput,
      toolResult: toolResultText,
      ...(turnNumber !== undefined && turnNumber !== null ? { turnNumber } : {}),
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/episodic_tool_result', e);
  }

  // ---------------------------------------------------------------------------
  // 12-06: Mid-flight commit visibility — write last commit to sidecar file
  // ---------------------------------------------------------------------------
  if (toolName === 'Bash') {
    const command = (toolInput as { command?: string })?.command ?? '';
    if (command.trimStart().startsWith('git commit')) {
      try {
        const { execSync } = await import('node:child_process');
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const claudexDir = join(homedir(), '.claudex');
        mkdirSync(claudexDir, { recursive: true });
        const lastCommit = execSync('git log -1 --format="%H %s"', {
          encoding: 'utf8',
          timeout: 5_000,
          cwd: input.cwd,
        }).trim();
        writeFileSync(join(claudexDir, '.last-commit.txt'), lastCommit + '\n', 'utf8');
      } catch {
        // Non-blocking; never fails the hook
      }
    }
  }

  return {};
});

main();
