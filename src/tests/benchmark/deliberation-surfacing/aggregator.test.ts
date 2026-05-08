import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendReplication,
  appendPooledSummary,
  bindVerdictToAggregator,
  loadAggregator,
} from '../../../benchmark/deliberation-surfacing/aggregator.js';
import { renderAggregatorMarkdown } from '../../../benchmark/deliberation-surfacing/aggregator-renderer.js';
import type { ReplicationRunResult, ReplicationSummary } from '../../../benchmark/deliberation-surfacing/types.js';

let tmpDir: string;
let jsonPath: string;
let mdPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-agg-'));
  jsonPath = path.join(tmpDir, 'deliberation-surfacing.json');
  mdPath = path.join(tmpDir, 'deliberation-surfacing.md');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeReplication(label: string, summaryPasses = 5, transcriptPasses = 25): ReplicationRunResult {
  return {
    replication_label: label,
    started_at_iso: '2026-05-08T12:00:00.000Z',
    completed_at_iso: '2026-05-08T12:30:00.000Z',
    agent_model: 'deepseek-coder-v2:16b',
    judge_model: 'deepseek-coder-v2:16b',
    probe_count: 30,
    retrieval_baseline: 'cross_encoder',
    outcomes: [],
    summary_pass_count: summaryPasses,
    transcript_pass_count: transcriptPasses,
  };
}

describe('appendReplication', () => {
  it('writes initial entry to .json + .md', () => {
    const r = fakeReplication('r1');
    const entry = appendReplication(r, 'POSITIVE', { lower: 0.4, upper: 0.85, point: 0.667 }, { jsonPath, mdPath, isoDate: '2026-05-08' });
    expect(entry.phase).toBe('9-r1');
    expect(entry.verdict).toBe('GREEN_LIGHT');
    const file = loadAggregator(jsonPath);
    expect(file.bound_experiences).toHaveLength(1);
    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('9-r1');
    expect(md).toContain('GREEN_LIGHT');
  });

  it('preserves prior entries byte-identical on subsequent appends', () => {
    appendReplication(fakeReplication('r1'), 'POSITIVE', { lower: 0.4, upper: 0.85, point: 0.667 }, { jsonPath, mdPath, isoDate: '2026-05-08' });
    const before = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).bound_experiences[0];
    appendReplication(fakeReplication('r2'), 'POSITIVE', { lower: 0.3, upper: 0.8, point: 0.6 }, { jsonPath, mdPath, isoDate: '2026-05-08' });
    const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(after.bound_experiences).toHaveLength(2);
    expect(after.bound_experiences[0]).toEqual(before);
  });
});

describe('loadAggregator', () => {
  it('returns empty schema-1 file when path does not exist', () => {
    const file = loadAggregator(path.join(tmpDir, 'does-not-exist.json'));
    expect(file.schema_version).toBe(1);
    expect(file.bound_experiences).toEqual([]);
  });

  it('throws on schema_version > 1', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({ schema_version: 2, question: 'q', bound_experiences: [] }));
    expect(() => loadAggregator(jsonPath)).toThrow();
  });
});

describe('bindVerdictToAggregator', () => {
  it('maps POSITIVE → GREEN_LIGHT, NEGATIVE → KILL, INCONCLUSIVE → INCONCLUSIVE', () => {
    expect(bindVerdictToAggregator('POSITIVE')).toBe('GREEN_LIGHT');
    expect(bindVerdictToAggregator('NEGATIVE')).toBe('KILL');
    expect(bindVerdictToAggregator('INCONCLUSIVE')).toBe('INCONCLUSIVE');
  });
});

describe('appendPooledSummary', () => {
  it('writes a 9-pooled entry with per_kind in metrics', () => {
    const summary: ReplicationSummary = {
      replications: ['r1', 'r2'],
      total_probes: 60,
      pooled_summary_pass_count: 11,
      pooled_transcript_pass_count: 49,
      pooled_n: 60,
      delta_ci: { point: 0.633, lower: 0.4, upper: 0.85, n: 60 },
      verdict: 'POSITIVE',
      per_kind: [
        { kind: 'a', summary_pass_rate: 0.2, transcript_pass_rate: 0.9, delta: 0.7, descriptive_only: true },
        { kind: 'b', summary_pass_rate: 0.1, transcript_pass_rate: 0.8, delta: 0.7, descriptive_only: true },
        { kind: 'c', summary_pass_rate: 0.3, transcript_pass_rate: 0.7, delta: 0.4, descriptive_only: true },
        { kind: 'd', summary_pass_rate: 0.2, transcript_pass_rate: 0.8, delta: 0.6, descriptive_only: true },
        { kind: 'e', summary_pass_rate: 0.1, transcript_pass_rate: 0.9, delta: 0.8, descriptive_only: true },
      ],
    };
    const entry = appendPooledSummary(summary, { jsonPath, mdPath, isoDate: '2026-05-08' });
    expect(entry.phase).toBe('9-pooled-r1+r2');
    expect(entry.n).toBe(60);
    expect(entry.metrics.per_kind).toBeDefined();
  });
});

describe('renderAggregatorMarkdown', () => {
  it('preserves Interpretive History body verbatim from existing .md', () => {
    const existing = `# Deliberation-surfacing aggregator\n\n## Interpretive History\n\n(Each phase that closes prepends a new dated section.)\n\n## 2026-05-15 — closing note\n\nMARKER_TOKEN_PRESERVED\n`;
    fs.writeFileSync(mdPath, existing);
    const out = renderAggregatorMarkdown({ schema_version: 1, question: 'q', bound_experiences: [] }, mdPath);
    expect(out).toContain('MARKER_TOKEN_PRESERVED');
  });

  it('formats delta_pass_rate to 4 decimals; missing metrics render as —', () => {
    const out = renderAggregatorMarkdown(
      {
        schema_version: 1,
        question: 'q',
        bound_experiences: [
          {
            phase: '9-r1',
            labeler: 'l',
            date: '2026-05-08',
            n: 30,
            verdict: 'GREEN_LIGHT',
            conditions: { retrieval_baseline: 'cross_encoder' },
            metrics: { delta_pass_rate: 0.6667, delta_ci_lower: 0.4, delta_ci_upper: 0.85 },
          },
          {
            phase: 'partial',
            labeler: 'l',
            date: '2026-05-08',
            n: 0,
            verdict: 'INCONCLUSIVE',
            conditions: {},
            metrics: {},
          },
        ],
      },
      undefined,
    );
    expect(out).toContain('0.6667');
    expect(out).toContain('—');
  });
});
