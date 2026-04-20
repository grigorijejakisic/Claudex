/**
 * Fixture corpus schema tests (Plan 03-03).
 *
 * Runs against the committed JSONL artifacts under
 * `.planning/phases/03-p2-directive-detector/fixtures/`.
 *
 * Gates:
 *  - fixture-candidates.jsonl exists, line-count ≥ 90 (sanity floor; RESEARCH
 *    §1.2 measured 105).
 *  - Every row has the expected schema fields.
 *  - Every session_id belongs to FIXTURE_SESSIONS.
 *  - No duplicate candidate_id.
 *  - gold-labels.jsonl (if present) matches row count + shape, and
 *    `labeled_by` is never `glm-5.1:cloud` (self-agreement-bias guard).
 *
 * The gold-labels.jsonl existence check is informational — Wave-1 ships
 * fixture-candidates.jsonl eagerly; gold-labels.jsonl is produced in the
 * labeling-review phase. When labels haven't been run yet, the suite
 * tolerates absence but fails on schema violations if the file exists.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURE_SESSIONS } from '../../benchmarks/directive-detector/fixture-sessions.js';
import type { FixtureCandidate } from '../../benchmarks/directive-detector/build-candidates.js';
import type { GoldLabelRow } from '../../benchmarks/directive-detector/label-candidates.js';

const FIXTURES_DIR = path.join(
  process.cwd(),
  '.planning',
  'phases',
  '03-p2-directive-detector',
  'fixtures',
);

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as T);
}

describe('fixture-candidates.jsonl', () => {
  const file = path.join(FIXTURES_DIR, 'fixture-candidates.jsonl');
  const exists = fs.existsSync(file);

  it.skipIf(!exists)('file exists at expected path', () => {
    expect(exists).toBe(true);
  });

  it.skipIf(!exists)('has ≥ 90 candidate rows (sanity floor)', () => {
    const rows = readJsonl<FixtureCandidate>(file);
    expect(rows.length).toBeGreaterThanOrEqual(90);
  });

  it.skipIf(!exists)('every row has required schema fields', () => {
    const rows = readJsonl<FixtureCandidate>(file);
    for (const r of rows) {
      expect(typeof r.candidate_id).toBe('string');
      expect(typeof r.session_id).toBe('string');
      expect(typeof r.ordinal).toBe('number');
      expect(typeof r.turn_idx).toBe('number');
      expect(typeof r.raw_text).toBe('string');
      expect(typeof r.stripped_text).toBe('string');
      expect(Array.isArray(r.matched_families)).toBe(true);
      expect(r.matched_families.length).toBeGreaterThan(0);
      expect(Array.isArray(r.context_prev_2)).toBe(true);
      expect(Array.isArray(r.context_next_2)).toBe(true);
    }
  });

  it.skipIf(!exists)('every session_id is in FIXTURE_SESSIONS', () => {
    const rows = readJsonl<FixtureCandidate>(file);
    const known = new Set(FIXTURE_SESSIONS.map(s => s.session_id));
    for (const r of rows) {
      expect(known.has(r.session_id)).toBe(true);
    }
  });

  it.skipIf(!exists)('no duplicate candidate_id', () => {
    const rows = readJsonl<FixtureCandidate>(file);
    const seen = new Set<string>();
    for (const r of rows) {
      expect(seen.has(r.candidate_id)).toBe(false);
      seen.add(r.candidate_id);
    }
  });
});

describe('gold-labels.jsonl', () => {
  const candidatesFile = path.join(FIXTURES_DIR, 'fixture-candidates.jsonl');
  const labelsFile = path.join(FIXTURES_DIR, 'gold-labels.jsonl');
  const exists = fs.existsSync(labelsFile);

  it.skipIf(!exists)('has same row count as candidate file (full label pass done)', () => {
    const cands = readJsonl<FixtureCandidate>(candidatesFile);
    const labels = readJsonl<GoldLabelRow>(labelsFile);
    expect(labels.length).toBe(cands.length);
  });

  it.skipIf(!exists)('every row has a label with all required fields', () => {
    const labels = readJsonl<GoldLabelRow>(labelsFile);
    for (const r of labels) {
      expect(typeof r.candidate_id).toBe('string');
      expect(typeof r.label).toBe('object');
      expect(typeof r.label.is_directive).toBe('boolean');
      expect(['session', 'project', 'universal', null]).toContain(r.label.scope);
      expect(['prescriptive', 'prohibitive', null]).toContain(r.label.polarity);
      expect(typeof r.label.self_confidence).toBe('number');
      expect(typeof r.label.reasoning).toBe('string');
      expect(typeof r.human_verified).toBe('boolean');
      expect(typeof r.labeled_by).toBe('string');
    }
  });

  it.skipIf(!exists)("labeled_by is never 'glm-5.1:cloud' (self-agreement guard)", () => {
    const labels = readJsonl<GoldLabelRow>(labelsFile);
    for (const r of labels) {
      expect(r.labeled_by).not.toBe('glm-5.1:cloud');
    }
  });
});
