/**
 * Prompt-asset tests (Plan 03-02).
 *
 * Pins the shape of the swappable prompt fixture files so future edits don't
 * silently break the loader or drop scope-balance across examples.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPromptAssets, __resetPromptAssetsCache } from '../../intelligence/directive-detector.js';

const PROMPTS_DIR = path.join(
  process.cwd(),
  'src',
  'intelligence',
  'directive-detector-prompts',
);

interface ConfirmationExample {
  candidate_text: string;
  context: Array<{ role: string; turn_offset: number; text: string }>;
  expected_output: {
    is_directive: boolean;
    confidence: number;
    polarity: 'prescriptive' | 'prohibitive' | null;
    scope: 'session' | 'project' | 'universal' | null;
    suggested_title: string | null;
    normalized_text: string | null;
    reasoning: string;
  };
}

interface ScopeRubricExample {
  text: string;
  expected_scope: 'session' | 'project' | 'universal';
  rationale: string;
}

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8')) as T;
}

function readMd(filename: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
}

// ---------------------------------------------------------------------------

describe('directive-detector-prompts — JSON fixtures', () => {
  it('confirmation-few-shot.json parses and has exactly 12 examples', () => {
    const data = readJson<{ examples: ConfirmationExample[] }>('confirmation-few-shot.json');
    expect(Array.isArray(data.examples)).toBe(true);
    expect(data.examples.length).toBe(12);
  });

  it('confirmation-few-shot has 3:3:3 positive examples across session/project/universal', () => {
    const data = readJson<{ examples: ConfirmationExample[] }>('confirmation-few-shot.json');
    const positives = data.examples.filter(e => e.expected_output.is_directive);
    expect(positives.length).toBe(9);

    const byScope = new Map<string, number>();
    for (const p of positives) {
      const s = p.expected_output.scope ?? 'none';
      byScope.set(s, (byScope.get(s) ?? 0) + 1);
    }
    expect(byScope.get('session')).toBe(3);
    expect(byScope.get('project')).toBe(3);
    expect(byScope.get('universal')).toBe(3);
  });

  it('confirmation-few-shot has exactly 3 negative examples', () => {
    const data = readJson<{ examples: ConfirmationExample[] }>('confirmation-few-shot.json');
    const negatives = data.examples.filter(e => !e.expected_output.is_directive);
    expect(negatives.length).toBe(3);
    // Negatives must null out structured fields
    for (const n of negatives) {
      expect(n.expected_output.polarity).toBeNull();
      expect(n.expected_output.scope).toBeNull();
      expect(n.expected_output.suggested_title).toBeNull();
      expect(n.expected_output.normalized_text).toBeNull();
    }
  });

  it('every confirmation example has context with a turn_offset=0 target', () => {
    const data = readJson<{ examples: ConfirmationExample[] }>('confirmation-few-shot.json');
    for (const ex of data.examples) {
      expect(Array.isArray(ex.context)).toBe(true);
      const offsets = ex.context.map(c => c.turn_offset);
      expect(offsets).toContain(0);
    }
  });

  it('scope-rubric-few-shot.json parses and has exactly 9 examples, 3:3:3 balance', () => {
    const data = readJson<{ examples: ScopeRubricExample[] }>('scope-rubric-few-shot.json');
    expect(Array.isArray(data.examples)).toBe(true);
    expect(data.examples.length).toBe(9);

    const byScope = new Map<string, number>();
    for (const ex of data.examples) {
      byScope.set(ex.expected_scope, (byScope.get(ex.expected_scope) ?? 0) + 1);
      expect(typeof ex.rationale).toBe('string');
      expect(ex.rationale.length).toBeGreaterThan(0);
      expect(ex.rationale.length).toBeLessThanOrEqual(200);
    }
    expect(byScope.get('session')).toBe(3);
    expect(byScope.get('project')).toBe(3);
    expect(byScope.get('universal')).toBe(3);
  });
});

describe('directive-detector-prompts — Markdown system prompts', () => {
  it('confirmation-system-prompt.md contains exactly one {{FEW_SHOT}} placeholder', () => {
    const md = readMd('confirmation-system-prompt.md');
    const matches = md.match(/\{\{FEW_SHOT\}\}/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('scope-rubric-system-prompt.md contains exactly one {{FEW_SHOT}} placeholder', () => {
    const md = readMd('scope-rubric-system-prompt.md');
    const matches = md.match(/\{\{FEW_SHOT\}\}/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('loadPromptAssets', () => {
  beforeEach(() => {
    __resetPromptAssetsCache();
  });

  it('returns a confirmationSystem string with the placeholder filled', () => {
    const assets = loadPromptAssets();
    expect(typeof assets.confirmationSystem).toBe('string');
    expect(assets.confirmationSystem).not.toContain('{{FEW_SHOT}}');
    // A representative few-shot candidate should now be inlined
    expect(assets.confirmationSystem).toContain('always use Bun');
  });

  it('returns a scopeRubricSystem string with the placeholder filled', () => {
    const assets = loadPromptAssets();
    expect(typeof assets.scopeRubricSystem).toBe('string');
    expect(assets.scopeRubricSystem).not.toContain('{{FEW_SHOT}}');
  });

  it('returns the inline dedup-relation prompt (no fixture, no placeholder)', () => {
    const assets = loadPromptAssets();
    expect(assets.dedupRelationSystem).toContain('restatement');
    expect(assets.dedupRelationSystem).toContain('opposite_polarity');
    expect(assets.dedupRelationSystem).not.toContain('{{FEW_SHOT}}');
  });

  it('caches the result — second call returns the same reference', () => {
    const a = loadPromptAssets();
    const b = loadPromptAssets();
    expect(a).toBe(b);
  });

  it('reload=true bypasses the cache and returns a fresh object', () => {
    const a = loadPromptAssets();
    const b = loadPromptAssets(true);
    // Different identity — the inner cache was rebuilt.
    expect(a).not.toBe(b);
    // Content equivalent though
    expect(b.confirmationSystem).toBe(a.confirmationSystem);
  });
});
