/**
 * Probe loader — reads JSON files from a probes directory, validates the canonical
 * schema, and asserts the lexical-exclusion pre-flight at LOAD time. Throws
 * LexicalLeakageError or ProbeSchemaError immediately so authoring violations
 * never reach the runner. Phase 6.5's lock mandates load-time enforcement.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import {
  type Probe,
  type ProbeCategory,
  LexicalLeakageError,
  ProbeSchemaError,
} from './types.js';

const REQUIRED_TOP_LEVEL_FIELDS = [
  'id',
  'category',
  'source_session_id',
  'source_project',
  'scenario',
  'user_prompt',
  'expected_recall',
  'lexical_exclusions',
  'evaluation',
] as const;

const VALID_CATEGORIES: ProbeCategory[] = [
  'entity-recall',
  'constraint-recall',
  'handoff-pickup',
  'cross-project',
  'lesson-application',
  'self-instrumented',
  'buffer',
];

const DEFAULT_PROBES_DIR = 'src/benchmark/vesna/probes';

/**
 * Reads, parses, validates every probe JSON in `dir`. Throws on missing fields
 * or lexical leakage so CI authoring errors fail fast.
 *
 * @param dir Directory of probe JSON files. Default: src/benchmark/vesna/probes.
 *            Resolved against CWD if relative.
 */
export function loadProbes(dir: string = DEFAULT_PROBES_DIR): Probe[] {
  const absDir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (!existsSync(absDir)) {
    return [];
  }

  const files = readdirSync(absDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const probes: Probe[] = [];
  for (const file of files) {
    const path = join(absDir, file);
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseAndValidate(path, raw);
    assertLexicalPreflight(parsed);
    probes.push(parsed);
  }
  return probes;
}

function parseAndValidate(path: string, raw: string): Probe {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `ProbeJsonParseError: ${path} is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`ProbeJsonShapeError: ${path} root must be an object`);
  }

  const probe = obj as Record<string, unknown>;
  const probeId = typeof probe.id === 'string' ? probe.id : `<unknown-id:${path}>`;

  // Required-field check (top-level)
  const missing: string[] = [];
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in probe) || probe[field] === undefined || probe[field] === null) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new ProbeSchemaError(probeId, missing);
  }

  // Type checks for the load-bearing fields
  if (!VALID_CATEGORIES.includes(probe.category as ProbeCategory)) {
    throw new ProbeSchemaError(probeId, [`category (got: ${String(probe.category)})`]);
  }
  if (typeof probe.user_prompt !== 'string') {
    throw new ProbeSchemaError(probeId, ['user_prompt (must be string)']);
  }
  if (!Array.isArray(probe.lexical_exclusions)) {
    throw new ProbeSchemaError(probeId, ['lexical_exclusions (must be array)']);
  }
  for (const w of probe.lexical_exclusions) {
    if (typeof w !== 'string') {
      throw new ProbeSchemaError(probeId, ['lexical_exclusions (entries must be strings)']);
    }
  }

  const expected = probe.expected_recall as Record<string, unknown> | undefined;
  if (
    !expected ||
    typeof expected.artifact_id_or_pattern !== 'string' ||
    typeof expected.must_surface_within_turns !== 'number' ||
    !Array.isArray(expected.must_contain_phrase_pattern)
  ) {
    throw new ProbeSchemaError(probeId, [
      'expected_recall (require artifact_id_or_pattern: string, must_surface_within_turns: number, must_contain_phrase_pattern: string[])',
    ]);
  }
  for (const p of expected.must_contain_phrase_pattern) {
    if (typeof p !== 'string') {
      throw new ProbeSchemaError(probeId, ['expected_recall.must_contain_phrase_pattern entries must be strings']);
    }
  }

  if (probe.evaluation !== 'auto' && probe.evaluation !== 'semi-auto') {
    throw new ProbeSchemaError(probeId, [`evaluation (got: ${String(probe.evaluation)})`]);
  }

  if (probe.setup_steps !== undefined && !Array.isArray(probe.setup_steps)) {
    throw new ProbeSchemaError(probeId, ['setup_steps (must be array if present)']);
  }

  return probe as unknown as Probe;
}

/**
 * Asserts none of the lexical_exclusions tokens appear in user_prompt
 * (case-insensitive substring match). Buffer placeholders (which carry the
 * sentinel "[unallocated]" prompt) are exempt.
 */
function assertLexicalPreflight(probe: Probe): void {
  if (probe.buffer_placeholder === true) return;
  const promptLower = probe.user_prompt.toLowerCase();
  const leaked: string[] = [];
  for (const word of probe.lexical_exclusions) {
    if (!word) continue;
    if (promptLower.includes(word.toLowerCase())) {
      leaked.push(word);
    }
  }
  if (leaked.length > 0) {
    throw new LexicalLeakageError(probe.id, leaked);
  }
}
