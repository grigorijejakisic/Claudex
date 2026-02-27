/**
 * Claudex v2 -- GSD Phase Transition Handlers
 *
 * Composes existing modules into lifecycle handlers for:
 * - phase start
 * - phase end
 * - plan complete
 *
 * Never throws -- returns { success, message }.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { accumulatePressureScore, getPressureScores, upsertPressureScore } from '../db/pressure.js';
import { archivePhaseSummary, writePhaseSummary } from './summary-writer.js';
import { getPhaseRelevanceSet, applyPhaseBoost } from './phase-relevance.js';
import { readGsdState } from './state-reader.js';
import type { GsdPhase } from './types.js';
import { writeCheckpoint } from '../checkpoint/writer.js';
import { writeCrossPhaseSummary } from './cross-phase-writer.js';
import type { ScoredFile } from '../shared/types.js';

const log = createLogger('gsd-phase-transition');

export interface PhaseTransitionArgs {
  db: Database.Database;
  projectDir: string;
  projectName: string;
  phaseNumber: number;
}

export interface PlanCompleteArgs extends PhaseTransitionArgs {
  planNumber: number;
  sessionId: string;
}

export interface PhaseTransitionResult {
  success: boolean;
  message: string;
}

const SEED_INCREMENT = 0.3;
const DEFAULT_DECAY_RATE = 0.05;
const PHASE_FILE_PATTERN = /\| `([^`]+)` \| [\d.]+ \| \w+ \|/g;

function phaseSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findPreviousPhase(phases: GsdPhase[], currentPhase: number): GsdPhase | null {
  const previous = phases
    .filter(p => p.number < currentPhase)
    .sort((a, b) => a.number - b.number);

  return previous.length > 0 ? previous[previous.length - 1]! : null;
}

function findArchiveFile(projectDir: string, phaseNumber: number): string | null {
  try {
    const archiveDir = path.join(projectDir, '.planning', 'context', 'archive');
    if (!fs.existsSync(archiveDir)) return null;

    const prefix = `${String(phaseNumber).padStart(2, '0')}-`;
    const candidates = fs.readdirSync(archiveDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.md'));
    if (candidates.length === 0) return null;

    const withMtime = candidates.map(file => {
      const fullPath = path.join(archiveDir, file);
      const mtimeMs = fs.statSync(fullPath).mtimeMs;
      return { fullPath, mtimeMs };
    });
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return withMtime[0]!.fullPath;
  } catch {
    return null;
  }
}

function extractSeedFiles(archiveContent: string): string[] {
  const normalized = archiveContent.replace(/\r\n/g, '\n');
  const files = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = PHASE_FILE_PATTERN.exec(normalized)) !== null) {
    files.add(match[1]!);
  }

  return Array.from(files);
}

function resolvePhaseStartEpoch(
  db: Database.Database,
  projectDir: string,
  projectName: string,
  phaseNumber: number,
  phases: GsdPhase[],
): number {
  const previous = findPreviousPhase(phases, phaseNumber);
  if (previous) {
    const prevArchive = findArchiveFile(projectDir, previous.number);
    if (prevArchive) {
      try {
        return Math.floor(fs.statSync(prevArchive).mtimeMs);
      } catch {
        // fall through to DB fallback
      }
    }
  }

  const row = db.prepare(`
    SELECT MIN(timestamp_epoch) AS min_epoch
    FROM observations
    WHERE project = ? AND deleted_at_epoch IS NULL
  `).get(projectName) as { min_epoch: number | null } | undefined;

  if (typeof row?.min_epoch === 'number') {
    return row.min_epoch;
  }

  return Date.now();
}

export function handlePhaseStart(args: PhaseTransitionArgs): PhaseTransitionResult {
  try {
    const nowIso = new Date().toISOString();
    const nowEpoch = Date.now();

    const decayResult = args.db.prepare(`
      UPDATE pressure_scores
      SET raw_pressure = raw_pressure * 0.1,
          temperature = CASE
            WHEN raw_pressure * 0.1 >= 0.7 THEN 'HOT'
            WHEN raw_pressure * 0.1 >= 0.3 THEN 'WARM'
            ELSE 'COLD'
          END,
          updated_at = ?,
          updated_at_epoch = ?
      WHERE project = ?
    `).run(nowIso, nowEpoch, args.projectName);

    let seededCount = 0;
    const gsdState = readGsdState(args.projectDir);
    const previous = findPreviousPhase(gsdState.phases, args.phaseNumber);

    if (previous) {
      archivePhaseSummary(args.projectDir, previous.number, phaseSlug(previous.name));

      const previousArchive = findArchiveFile(args.projectDir, previous.number);
      if (previousArchive) {
        const archiveContent = fs.readFileSync(previousArchive, 'utf-8');
        const files = extractSeedFiles(archiveContent);
        for (const filePath of files) {
          accumulatePressureScore(args.db, filePath, args.projectName, SEED_INCREMENT);
          seededCount++;
        }
      }
    }

    return {
      success: true,
      message: `Phase start: decayed ${decayResult.changes} scores, seeded ${seededCount} files`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('handlePhaseStart failed', error);
    return { success: false, message };
  }
}

export function handlePhaseEnd(args: PhaseTransitionArgs): PhaseTransitionResult {
  try {
    const summaryPath = path.join(args.projectDir, '.planning', 'context', 'SUMMARY.md');
    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Missing summary is fine.
    }

    const gsdState = readGsdState(args.projectDir);
    const wrote = writePhaseSummary(args.projectDir, args.projectName, args.db, gsdState);

    const current = gsdState.phases.find(p => p.number === args.phaseNumber);
    const slug = current ? phaseSlug(current.name) : `phase-${args.phaseNumber}`;
    const archived = archivePhaseSummary(args.projectDir, args.phaseNumber, slug);

    const startEpoch = resolvePhaseStartEpoch(
      args.db,
      args.projectDir,
      args.projectName,
      args.phaseNumber,
      gsdState.phases,
    );
    const nowEpoch = Date.now();

    const softDeleteResult = args.db.prepare(`
      UPDATE observations
      SET deleted_at_epoch = ?
      WHERE project = ?
        AND timestamp_epoch >= ?
        AND timestamp_epoch <= ?
        AND deleted_at_epoch IS NULL
    `).run(nowEpoch, args.projectName, startEpoch, nowEpoch);

    return {
      success: true,
      message: `Phase end: summary=${wrote}, archived=${archived}, observations archived=${softDeleteResult.changes}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('handlePhaseEnd failed', error);
    return { success: false, message };
  }
}

export function handlePlanComplete(args: PlanCompleteArgs): PhaseTransitionResult {
  try {
    const initialGsd = readGsdState(args.projectDir);
    const checkpoint = writeCheckpoint({
      projectDir: args.projectDir,
      sessionId: args.sessionId,
      scope: `project:${args.projectName}`,
      trigger: 'plan-complete',
      gaugeReading: {
        status: 'unavailable',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        window_size: 0,
        utilization: 0,
        formatted: '[unavailable]',
        threshold: 'unavailable',
      },
      gsdState: initialGsd,
      db: args.db,
    });

    if (!checkpoint) {
      return {
        success: false,
        message: 'Failed to write checkpoint for plan completion',
      };
    }

    const nextPlan = args.planNumber + 1;
    const phasesDir = path.join(args.projectDir, '.planning', 'phases');
    const relevanceSet = getPhaseRelevanceSet(phasesDir, args.phaseNumber, nextPlan);
    const currentScores = getPressureScores(args.db, args.projectName).map((score): ScoredFile => ({
      path: score.file_path,
      raw_pressure: score.raw_pressure,
      temperature: score.temperature,
      system_bucket: 0,
      pressure_bucket: 0,
    }));
    const boosted = applyPhaseBoost(currentScores, relevanceSet);

    let boostedCount = 0;
    for (const file of boosted) {
      if (file.phase_boosted === true) {
        upsertPressureScore(args.db, {
          file_path: file.path,
          project: args.projectName,
          raw_pressure: file.raw_pressure,
          temperature: file.temperature,
          decay_rate: DEFAULT_DECAY_RATE,
        });
        boostedCount++;
      }
    }

    const summaryPath = path.join(args.projectDir, '.planning', 'context', 'SUMMARY.md');
    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Missing summary is fine.
    }
    writePhaseSummary(args.projectDir, args.projectName, args.db, readGsdState(args.projectDir));

    const claudexDir = path.join(args.projectDir, 'Claudex');
    const crossPhase = writeCrossPhaseSummary(args.projectDir, claudexDir);

    return {
      success: true,
      message: `Plan complete: checkpoint=${checkpoint.checkpointId}, boosted=${boostedCount}, crossPhase=${crossPhase}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('handlePlanComplete failed', error);
    return { success: false, message };
  }
}

