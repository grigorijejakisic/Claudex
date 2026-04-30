/**
 * Vesna loader unit tests — schema validation + lexical-leakage pre-flight.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadProbes } from '../../benchmark/vesna/loader.js';
import { LexicalLeakageError, ProbeSchemaError } from '../../benchmark/vesna/types.js';

let tmpDir: string;

function writeProbe(name: string, probe: unknown): void {
  fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(probe, null, 2));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesna-loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadProbes', () => {
  it('throws LexicalLeakageError when prompt contains an exclusion (case-insensitive)', () => {
    writeProbe('leak-case.json', {
      id: 'entity-leak-001',
      category: 'entity-recall',
      source_session_id: 'sess-1',
      source_project: 'claudex-v3',
      scenario: 'test',
      user_prompt: 'How does the bge reranker connect on port 7439?',
      expected_recall: {
        artifact_id_or_pattern: 'decision:bge',
        must_surface_within_turns: 2,
        must_contain_phrase_pattern: ['BGE'],
      },
      lexical_exclusions: ['BGE', '7439'],
      evaluation: 'auto',
    });

    expect(() => loadProbes(tmpDir)).toThrow(LexicalLeakageError);
  });

  it('loads a clean probe without throwing', () => {
    writeProbe('clean.json', {
      id: 'entity-002',
      category: 'entity-recall',
      source_session_id: 'sess-2',
      source_project: 'claudex-v3',
      scenario: 'test',
      user_prompt: 'What is the local cross-encoder service?',
      expected_recall: {
        artifact_id_or_pattern: 'decision:bge',
        must_surface_within_turns: 2,
        must_contain_phrase_pattern: ['BGE'],
      },
      lexical_exclusions: ['BGE-reranker', 'port 7439'],
      evaluation: 'auto',
    });

    const probes = loadProbes(tmpDir);
    expect(probes).toHaveLength(1);
    expect(probes[0].id).toBe('entity-002');
  });

  it('throws ProbeSchemaError when required field missing', () => {
    writeProbe('missing.json', {
      id: 'entity-003',
      category: 'entity-recall',
      source_session_id: 'sess-3',
      // source_project missing
      scenario: 'test',
      user_prompt: 'a prompt',
      expected_recall: {
        artifact_id_or_pattern: 'x',
        must_surface_within_turns: 1,
        must_contain_phrase_pattern: ['x'],
      },
      lexical_exclusions: [],
      evaluation: 'auto',
    });

    expect(() => loadProbes(tmpDir)).toThrow(ProbeSchemaError);
  });

  it('throws ProbeSchemaError for invalid category', () => {
    writeProbe('bad-cat.json', {
      id: 'entity-004',
      category: 'made-up',
      source_session_id: 'sess-4',
      source_project: 'claudex-v3',
      scenario: 'test',
      user_prompt: 'x',
      expected_recall: {
        artifact_id_or_pattern: 'x',
        must_surface_within_turns: 1,
        must_contain_phrase_pattern: ['x'],
      },
      lexical_exclusions: [],
      evaluation: 'auto',
    });

    expect(() => loadProbes(tmpDir)).toThrow(ProbeSchemaError);
  });

  it('throws LexicalLeakageError naming the probe id and leaked tokens', () => {
    writeProbe('leak.json', {
      id: 'entity-005',
      category: 'entity-recall',
      source_session_id: 'sess-5',
      source_project: 'claudex-v3',
      scenario: 'test',
      user_prompt: 'How does Mozzart 429 backoff work?',
      expected_recall: {
        artifact_id_or_pattern: 'decision:mozzart',
        must_surface_within_turns: 2,
        must_contain_phrase_pattern: ['per-IP'],
      },
      lexical_exclusions: ['Mozzart', '429'],
      evaluation: 'auto',
    });

    try {
      loadProbes(tmpDir);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LexicalLeakageError);
      const err = e as LexicalLeakageError;
      expect(err.probe_id).toBe('entity-005');
      // Both exclusions appear in the prompt — both must be reported.
      expect(err.leaked).toContain('Mozzart');
      expect(err.leaked).toContain('429');
    }
  });

  it('skips lexical pre-flight for buffer placeholders', () => {
    writeProbe('buffer.json', {
      id: 'buffer-001',
      category: 'buffer',
      source_session_id: 'phase-10-design',
      source_project: 'claudex-v3',
      scenario: 'unallocated buffer slot',
      user_prompt: '[unallocated]',
      expected_recall: {
        artifact_id_or_pattern: '[unallocated]',
        must_surface_within_turns: 1,
        must_contain_phrase_pattern: [],
      },
      lexical_exclusions: ['unallocated'], // would leak into [unallocated] but exempt
      evaluation: 'auto',
      buffer_placeholder: true,
    });

    const probes = loadProbes(tmpDir);
    expect(probes).toHaveLength(1);
    expect(probes[0].buffer_placeholder).toBe(true);
  });

  it('returns empty array for nonexistent dir', () => {
    expect(loadProbes(path.join(tmpDir, 'does-not-exist'))).toEqual([]);
  });
});
