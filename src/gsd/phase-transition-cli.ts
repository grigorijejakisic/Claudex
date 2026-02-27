#!/usr/bin/env node
/**
 * Claudex v2 -- Phase Transition CLI
 *
 * Standalone script invoked by GSD's gsd-tools.cjs during phase lifecycle events.
 * NOT a Claude Code hook -- not registered in settings.json.
 *
 * Usage:
 *   node dist/phase-transition-cli.mjs --event=phase-start --phase=6 --project-dir=/path
 *   node dist/phase-transition-cli.mjs --event=phase-end --phase=6 --project-dir=/path
 *   node dist/phase-transition-cli.mjs --event=plan-complete --phase=6 --plan=2 --project-dir=/path --session-id=abc
 *
 * Required: --event, --phase, --project-dir
 * Optional: --project-name (defaults to basename of project-dir)
 * plan-complete also requires: --plan, --session-id
 *
 * Exit codes: 0 = success, 1 = failure
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../db/connection.js';
import {
  handlePhaseStart,
  handlePhaseEnd,
  handlePlanComplete,
  type PhaseTransitionResult,
} from './phase-transition.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gsd-phase-transition-cli');
const VALID_EVENTS = ['phase-start', 'phase-end', 'plan-complete'] as const;

type PhaseTransitionEvent = (typeof VALID_EVENTS)[number];

interface BaseParsedArgs {
  event: PhaseTransitionEvent;
  phaseNumber: number;
  projectDir: string;
  projectName: string;
}

interface ParsedPlanCompleteArgs extends BaseParsedArgs {
  event: 'plan-complete';
  planNumber: number;
  sessionId: string;
}

interface ParsedPhaseArgs extends BaseParsedArgs {
  event: 'phase-start' | 'phase-end';
}

export type ParsedCliArgs = ParsedPhaseArgs | ParsedPlanCompleteArgs;
export type ParsedCliArgsResult = ParsedCliArgs | { error: string };

const USAGE = [
  'Usage:',
  '  node dist/phase-transition-cli.mjs --event=phase-start --phase=6 --project-dir=/path',
  '  node dist/phase-transition-cli.mjs --event=phase-end --phase=6 --project-dir=/path',
  '  node dist/phase-transition-cli.mjs --event=plan-complete --phase=6 --plan=2 --project-dir=/path --session-id=abc',
  '',
  'Required: --event, --phase, --project-dir',
  'Optional: --project-name',
].join('\n');

function parseKeyValueArgs(argv: string[]): Map<string, string> | { error: string } {
  const args = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      return { error: `Invalid argument format: ${arg}` };
    }

    const separator = arg.indexOf('=');
    if (separator <= 2) {
      return { error: `Invalid argument format: ${arg}. Expected --key=value` };
    }

    const key = arg.slice(2, separator).trim();
    const value = arg.slice(separator + 1).trim();

    if (!key) {
      return { error: `Invalid argument key in: ${arg}` };
    }
    if (!value) {
      return { error: `Missing value for --${key}` };
    }

    args.set(key, value);
  }

  return args;
}

function resolveDefaultProjectName(projectDir: string): string {
  const normalized = path.normalize(projectDir);
  const trimmed = normalized.endsWith(path.sep)
    ? normalized.slice(0, -path.sep.length)
    : normalized;
  const base = path.basename(trimmed);
  return base || path.basename(path.resolve(projectDir));
}

function parseRequiredNumber(
  value: string | undefined,
  flagName: string,
): number | { error: string } {
  if (!value) {
    return { error: `Missing required argument: --${flagName}` };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `Invalid --${flagName} value: ${value}` };
  }

  return parsed;
}

export function parseCliArgs(argv: string[]): ParsedCliArgsResult {
  const parsedMap = parseKeyValueArgs(argv);
  if ('error' in parsedMap) {
    return parsedMap;
  }

  const rawEvent = parsedMap.get('event');
  if (!rawEvent) {
    return { error: 'Missing required argument: --event' };
  }
  if (!VALID_EVENTS.includes(rawEvent as PhaseTransitionEvent)) {
    return { error: `Invalid --event value: ${rawEvent}` };
  }
  const event = rawEvent as PhaseTransitionEvent;

  const phaseNumber = parseRequiredNumber(parsedMap.get('phase'), 'phase');
  if (typeof phaseNumber !== 'number') {
    return phaseNumber;
  }

  const projectDir = parsedMap.get('project-dir');
  if (!projectDir) {
    return { error: 'Missing required argument: --project-dir' };
  }

  const projectName = parsedMap.get('project-name') ?? resolveDefaultProjectName(projectDir);
  if (!projectName) {
    return { error: 'Unable to resolve project name from --project-dir' };
  }

  if (event === 'plan-complete') {
    const planNumber = parseRequiredNumber(parsedMap.get('plan'), 'plan');
    if (typeof planNumber !== 'number') {
      return planNumber;
    }

    const sessionId = parsedMap.get('session-id');
    if (!sessionId) {
      return { error: 'Missing required argument: --session-id' };
    }

    return {
      event,
      phaseNumber,
      projectDir,
      projectName,
      planNumber,
      sessionId,
    };
  }

  if (event !== 'phase-start' && event !== 'phase-end') {
    return { error: `Invalid --event value: ${event}` };
  }

  return {
    event,
    phaseNumber,
    projectDir,
    projectName,
  };
}

function printUsage(): void {
  console.error(USAGE);
}

function run(): void {
  let db: ReturnType<typeof getDatabase> = null;

  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if ('error' in parsed) {
      console.error(`[phase-transition] ${parsed.error}`);
      printUsage();
      process.exit(1);
    }

    db = getDatabase();
    if (!db) {
      console.error('[phase-transition] Failed to open database');
      process.exit(1);
    }

    let result: PhaseTransitionResult;
    switch (parsed.event) {
      case 'phase-start':
        result = handlePhaseStart({
          db,
          projectDir: parsed.projectDir,
          projectName: parsed.projectName,
          phaseNumber: parsed.phaseNumber,
        });
        break;
      case 'phase-end':
        result = handlePhaseEnd({
          db,
          projectDir: parsed.projectDir,
          projectName: parsed.projectName,
          phaseNumber: parsed.phaseNumber,
        });
        break;
      case 'plan-complete':
        result = handlePlanComplete({
          db,
          projectDir: parsed.projectDir,
          projectName: parsed.projectName,
          phaseNumber: parsed.phaseNumber,
          planNumber: parsed.planNumber,
          sessionId: parsed.sessionId,
        });
        break;
    }

    if (result.success) {
      console.log(`[phase-transition] ${parsed.event}: ${result.message}`);
      process.exit(0);
    }

    console.error(`[phase-transition] ${parsed.event} FAILED: ${result.message}`);
    process.exit(1);
  } catch (error) {
    log.error('Unexpected CLI error', error);
    console.error('[phase-transition] Unexpected error:', error);
    process.exit(1);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (closeError) {
        log.warn('Failed to close database handle', closeError);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
