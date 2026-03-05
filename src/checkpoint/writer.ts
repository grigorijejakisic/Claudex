/**
 * Claudex v3 -- Checkpoint Writer (WP-4)
 *
 * Bundles incremental state (decisions, questions, files touched, thread)
 * + token gauge reading + GSD state into a structured checkpoint YAML file.
 *
 * Called by UserPromptSubmit when context hits 80% utilization.
 * The checkpoint is what gets reloaded after compaction — ~600 tokens
 * of structured data instead of ~40,000 tokens of lossy prose.
 *
 * NEVER throws — returns null on failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { ensureEpochMs } from '../shared/epoch.js';
import {
  readDecisions,
  readQuestions,
  readFilesTouched,
  readThread,
  archiveStateFiles,
  ensureDir,
} from './state-files.js';
import type { GaugeReading } from '../lib/token-gauge.js';
import type { GsdState } from '../gsd/types.js';
import type Database from 'better-sqlite3';
import type {
  Checkpoint,
  CheckpointMeta,
  GsdCheckpointState,
  WorkingState,
} from './types.js';
import { CHECKPOINT_SCHEMA, CHECKPOINT_VERSION } from './types.js';
import { getHotFiles, getWarmFiles } from '../db/pressure.js';
import { getRecentObservations } from '../db/observations.js';
import { getCheckpointState } from '../db/checkpoint.js';
import { numericCheckpointSort } from './sort.js';

const log = createLogger('checkpoint-writer');

// =============================================================================
// Constants
// =============================================================================

const WRITER_VERSION = '3.0.0';

// =============================================================================
// Public Types
// =============================================================================

interface WriteCheckpointInput {
  projectDir: string;
  sessionId: string;
  scope: string;                        // "global" | "project:{name}"
  trigger: CheckpointMeta['trigger'];
  gaugeReading: GaugeReading;           // From token-gauge (may have status: 'unavailable')
  gsdState?: GsdState;
  workingTask?: string;
  nextAction?: string;
  branch?: string;
  db?: Database.Database;               // Optional DB handle for enrichment (pressure, observations, boost)
}

interface WriteCheckpointResult {
  path: string;
  checkpointId: string;
  checkpoint: Checkpoint;
  tokenEstimate: number;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Get the checkpoints directory for a project */
function checkpointsDir(projectDir: string): string {
  return path.join(projectDir, 'context', 'checkpoints');
}

/**
 * Generate the next checkpoint ID for today.
 * Format: YYYY-MM-DD_cpN where N is sequential within the day.
 * Scans existing files to determine the next number.
 */
function generateCheckpointId(cpDir: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const prefix = `${dateStr}_cp`;

  let maxN = 0;

  try {
    if (fs.existsSync(cpDir)) {
      const entries = fs.readdirSync(cpDir);
      for (const entry of entries) {
        if (entry.startsWith(prefix) && entry.endsWith('.yaml')) {
          const nStr = entry.slice(prefix.length, -5); // strip prefix and .yaml
          const n = parseInt(nStr, 10);
          if (!isNaN(n) && n > maxN) {
            maxN = n;
          }
        }
      }
    }
  } catch (e) {
    log.warn('Failed to scan checkpoints dir for numbering', e);
  }

  return `${prefix}${maxN + 1}`;
}

/**
 * Find the most recent checkpoint file (basename only) in the checkpoints dir.
 * Returns null if no prior checkpoint exists.
 */
function findPreviousCheckpoint(cpDir: string, currentId: string): string | null {
  try {
    if (!fs.existsSync(cpDir)) return null;

    const entries = fs.readdirSync(cpDir)
      .filter(f => f.endsWith('.yaml') && f !== 'latest.yaml' && f !== `${currentId}.yaml`)
      .sort(numericCheckpointSort);

    if (entries.length === 0) return null;

    // Return the most recent (last sorted — numeric sort handles cp10 > cp9)
    return entries[entries.length - 1]!;
  } catch (e) {
    log.warn('Failed to find previous checkpoint', e);
    return null;
  }
}

/**
 * Convert GsdState to the checkpoint-compatible GsdCheckpointState.
 * Returns null if GSD is inactive or not provided.
 */
function buildGsdCheckpointState(gsdState?: GsdState): GsdCheckpointState | null {
  if (!gsdState || !gsdState.active) return null;

  const pos = gsdState.position;
  const currentPhase = pos
    ? gsdState.phases.find(p => p.number === pos.phase)
    : null;

  return {
    active: true,
    milestone: null, // No milestone field in GsdState — null for now
    phase: pos?.phase ?? 0,
    phase_name: pos?.phaseName ?? null,
    phase_goal: currentPhase?.goal ?? null,
    plan_status: pos?.status ?? null,
    plan_number: pos?.plan ?? null,
    completion_pct: gsdState
      ? Math.round(gsdState.phases.filter(p => p.roadmapComplete).length / Math.max(gsdState.phases.length, 1) * 100)
      : 0,
    requirements: currentPhase
      ? currentPhase.requirements.map(reqId => ({
          id: reqId,
          status: 'unknown',
          description: reqId,
        }))
      : [],
  };
}

/**
 * Estimate token count for selective-load sections.
 * Uses character count × 0.25 (4 chars/token average).
 */
function estimateCheckpointTokens(checkpoint: Checkpoint): number {
  // Selective-load sections: working, decisions, files, open_questions, thread, gsd
  const sections: unknown[] = [
    checkpoint.working,
    checkpoint.decisions,
    checkpoint.files,
    checkpoint.open_questions,
    checkpoint.thread,
  ];

  if (checkpoint.gsd) {
    sections.push(checkpoint.gsd);
  }

  try {
    const yamlStr = yaml.dump(sections, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
    });
    return Math.ceil(yamlStr.length * 0.25);
  } catch {
    return 0;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Write a checkpoint bundling all incremental state into a structured YAML file.
 *
 * @returns WriteCheckpointResult on success, null on failure. Never throws.
 */
export function writeCheckpoint(input: WriteCheckpointInput): WriteCheckpointResult | null {
  const t0 = Date.now();

  try {
    const cpDir = checkpointsDir(input.projectDir);
    ensureDir(cpDir);

    // Generate checkpoint ID
    const checkpointId = generateCheckpointId(cpDir);

    // Find previous checkpoint (basename only)
    const previousCheckpoint = findPreviousCheckpoint(cpDir, checkpointId);

    // Read incremental state via WP-3 functions
    const decisions = readDecisions(input.projectDir, input.sessionId);
    const questions = readQuestions(input.projectDir, input.sessionId);
    const files = readFilesTouched(input.projectDir, input.sessionId);
    const thread = readThread(input.projectDir, input.sessionId);

    // Build token_usage from gauge reading
    const gaugeOk = input.gaugeReading.status === 'ok';
    const tokenUsage: CheckpointMeta['token_usage'] = {
      input_tokens: gaugeOk ? input.gaugeReading.usage.input_tokens : 0,
      output_tokens: gaugeOk ? input.gaugeReading.usage.output_tokens : 0,
      window_size: input.gaugeReading.window_size,
      utilization: gaugeOk ? input.gaugeReading.utilization : 0,
    };

    // Build working state
    const working: WorkingState = {
      task: input.workingTask ?? '',
      status: 'in_progress',
      branch: input.branch ?? null,
      next_action: input.nextAction ?? null,
    };

    // Build GSD checkpoint state
    const gsd = buildGsdCheckpointState(input.gsdState);

    // Build enrichment data from DB (if available)
    let pressureSnapshot: { hot: string[]; warm: string[] } = { hot: [], warm: [] };
    let recentObs: Array<{ title: string; category: string; timestamp_epoch: number }> = [];
    let boostState: { files: string[]; turn: number; applied_at: number } | null = null;

    if (input.db) {
      // Derive project name from scope for filtered queries
      const projectFilter = input.scope.startsWith('project:') ? input.scope.slice('project:'.length) : undefined;

      try {
        const hotFiles = getHotFiles(input.db, projectFilter);
        const warmFiles = getWarmFiles(input.db, projectFilter);
        pressureSnapshot = {
          hot: hotFiles.map(f => f.file_path),
          warm: warmFiles.map(f => f.file_path),
        };
      } catch (e) {
        log.warn('Failed to read pressure snapshot', e);
      }

      try {
        const observations = getRecentObservations(input.db, 8, projectFilter);
        recentObs = observations.map(o => ({
          title: o.title,
          category: o.category,
          timestamp_epoch: o.timestamp_epoch,
        }));
      } catch (e) {
        log.warn('Failed to read recent observations', e);
      }

      try {
        const cpState = getCheckpointState(input.db, input.sessionId);
        if (cpState?.boost_applied_at != null && cpState.boost_turn_count != null) {
          boostState = {
            files: cpState.active_files,
            turn: cpState.boost_turn_count,
            applied_at: cpState.boost_applied_at,
          };
        }
      } catch (e) {
        log.warn('Failed to read boost state', e);
      }
    }

    // Build the full checkpoint
    const now = new Date();
    const checkpoint: Checkpoint = {
      schema: CHECKPOINT_SCHEMA,
      version: CHECKPOINT_VERSION,
      meta: {
        checkpoint_id: checkpointId,
        session_id: input.sessionId,
        scope: input.scope,
        created_at: now.toISOString(),
        created_at_epoch_ms: ensureEpochMs(now.getTime()),
        trigger: input.trigger,
        writer_version: WRITER_VERSION,
        token_usage: tokenUsage,
        previous_checkpoint: previousCheckpoint,
        session_log: null,
      },
      working,
      decisions,
      files,
      gsd,
      open_questions: questions,
      learnings: [],
      thread,
      pressure_snapshot: pressureSnapshot,
      recent_observations: recentObs,
      boost_state: boostState,
    };

    // Serialize to YAML
    const yamlContent = yaml.dump(checkpoint, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    // Write checkpoint file (atomic: write to tmp, then rename)
    const cpPath = path.join(cpDir, `${checkpointId}.yaml`);
    const cpTmpPath = cpPath + '.tmp';
    fs.writeFileSync(cpTmpPath, yamlContent, 'utf-8');
    fs.renameSync(cpTmpPath, cpPath);

    // Update latest.yaml (atomic: write to tmp, then rename)
    const latestPath = path.join(cpDir, 'latest.yaml');
    const latestTmpPath = latestPath + '.tmp';
    fs.writeFileSync(latestTmpPath, `ref: ${checkpointId}.yaml\n`, 'utf-8');
    fs.renameSync(latestTmpPath, latestPath);

    // Don't archive state on incremental checkpoints — state accumulates
    // across incrementals so each checkpoint captures the full session state.
    // Only archive on final checkpoints (pre-compact, session-end, auto-75pct).
    if (input.trigger !== 'incremental') {
      archiveStateFiles(input.projectDir, input.sessionId, checkpointId);
    }

    // Estimate token cost
    const tokenEstimate = estimateCheckpointTokens(checkpoint);

    return {
      path: cpPath,
      checkpointId,
      checkpoint,
      tokenEstimate,
    };
  } catch (e) {
    log.error('writeCheckpoint failed', e);
    return null;
  } finally {
    recordMetric('checkpoint_write', Date.now() - t0);
  }
}
