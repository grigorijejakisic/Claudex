/**
 * Claudex v3 — Token Gauge Tests (WP-1)
 *
 * 10 tests covering: valid transcript, empty/undefined path, missing usage,
 * threshold boundaries (65%, 75%, 95%), gauge formatting, large transcript,
 * malformed trailing line, CRLF, BOM, zero-length file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readTokenGauge, formatGauge, detectWindowSize, getIncrementalThresholds, readTokenGaugeWithDetection } from '../../src/lib/token-gauge.js';
import type { GaugeReading } from '../../src/lib/token-gauge.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-gauge-test-'));
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Build a JSONL line for an assistant message with usage data. */
function makeAssistantLine(inputTokens: number, outputTokens = 500): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

/** Build a JSONL line for a user message (no usage). */
function makeUserLine(text = 'Hello'): string {
  return JSON.stringify({
    type: 'human',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

/** Build a JSONL line for an assistant message with model name and usage data. */
function makeAssistantLineWithModel(inputTokens: number, model: string, outputTokens = 500): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

function writeTranscript(filename: string, lines: string[]): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

// =============================================================================
// Setup / Teardown
// =============================================================================

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// =============================================================================
// Tests
// =============================================================================

describe('readTokenGauge', () => {
  it('returns correct utilization and threshold for valid transcript', () => {
    const transcriptPath = writeTranscript('valid.jsonl', [
      makeUserLine(),
      makeAssistantLine(162_000),
    ]);

    const result = readTokenGauge(transcriptPath);

    expect(result.status).toBe('ok');
    expect(result.utilization).toBeCloseTo(0.81, 2);
    expect(result.threshold).toBe('checkpoint');
    expect(result.usage.input_tokens).toBe(162_000);
    expect(result.window_size).toBe(200_000);
    expect(result.formatted).toContain('81%');
    expect(result.formatted).toContain('162k/200k');
  });

  it('returns unavailable for empty/undefined transcript_path', () => {
    const resultUndef = readTokenGauge(undefined);
    expect(resultUndef.status).toBe('unavailable');
    expect(resultUndef.threshold).toBe('unavailable');
    expect(resultUndef.utilization).toBe(0);
    expect(resultUndef.formatted).toBe('[Token gauge unavailable]');

    const resultEmpty = readTokenGauge('');
    expect(resultEmpty.status).toBe('unavailable');
    expect(resultEmpty.threshold).toBe('unavailable');
  });

  it('returns unavailable when usage field is missing in assistant message', () => {
    const lines = [
      makeUserLine(),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No usage here' }],
        },
      }),
    ];
    const transcriptPath = writeTranscript('no-usage.jsonl', lines);

    const result = readTokenGauge(transcriptPath);
    expect(result.status).toBe('unavailable');
    expect(result.threshold).toBe('unavailable');
  });

  it('classifies threshold boundaries correctly: 65%, 75%, 95%', () => {
    // Exactly 65% → approaching
    const at65 = writeTranscript('at65.jsonl', [makeAssistantLine(130_000)]);
    expect(readTokenGauge(at65).threshold).toBe('approaching');

    // Exactly 75% → checkpoint
    const at75 = writeTranscript('at75.jsonl', [makeAssistantLine(150_000)]);
    expect(readTokenGauge(at75).threshold).toBe('checkpoint');

    // Exactly 95% → critical
    const at95 = writeTranscript('at95.jsonl', [makeAssistantLine(190_000)]);
    expect(readTokenGauge(at95).threshold).toBe('critical');

    // Just below 65% → normal
    const below65 = writeTranscript('below65.jsonl', [makeAssistantLine(129_999)]);
    expect(readTokenGauge(below65).threshold).toBe('normal');

    // Just below 75% (but ≥ 65%) → approaching
    const at74 = writeTranscript('at74.jsonl', [makeAssistantLine(149_999)]);
    expect(readTokenGauge(at74).threshold).toBe('approaching');

    // Just below 95% (but ≥ 75%) → checkpoint
    const at94 = writeTranscript('at94.jsonl', [makeAssistantLine(189_999)]);
    expect(readTokenGauge(at94).threshold).toBe('checkpoint');
  });

  it('formats gauge bar correctly', () => {
    // 50% utilization
    const bar50 = formatGauge(0.5, 100_000, 200_000);
    expect(bar50).toBe('[█████░░░░░ 50% | 100k/200k]');

    // 0% utilization
    const bar0 = formatGauge(0, 0, 200_000);
    expect(bar0).toBe('[░░░░░░░░░░ 0% | 0/200k]');

    // 100% utilization
    const bar100 = formatGauge(1.0, 200_000, 200_000);
    expect(bar100).toBe('[██████████ 100% | 200k/200k]');

    // Small numbers (< 1000)
    const barSmall = formatGauge(0.005, 500, 100_000);
    expect(barSmall).toContain('500/100k');
  });

  it('sums input + cache_creation + cache_read tokens for utilization', () => {
    // Real Claude Code API returns input_tokens:1 with most tokens in cache
    const lines = [
      makeUserLine(),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 1,
            output_tokens: 291,
            cache_creation_input_tokens: 802,
            cache_read_input_tokens: 88_995,
          },
        },
      }),
    ];
    const transcriptPath = writeTranscript('cached.jsonl', lines);

    const result = readTokenGauge(transcriptPath);
    expect(result.status).toBe('ok');
    // Total: 1 + 802 + 88995 = 89798
    expect(result.utilization).toBeCloseTo(89_798 / 200_000, 4);
    expect(result.threshold).toBe('normal'); // ~45%, below 70%
    expect(result.formatted).toContain('45%');
    expect(result.formatted).toContain('90k/200k');
  });

  it('reads only the last assistant message in large transcript', () => {
    const lines: string[] = [];
    // Add many messages — only the last assistant message matters
    for (let i = 0; i < 50; i++) {
      lines.push(makeUserLine(`Message ${i}`));
      lines.push(makeAssistantLine(10_000 + i * 1000));
    }
    // The last assistant message has 59_000 input tokens
    const transcriptPath = writeTranscript('large.jsonl', lines);

    const result = readTokenGauge(transcriptPath);
    expect(result.status).toBe('ok');
    expect(result.usage.input_tokens).toBe(59_000);
  });

  it('skips malformed trailing JSONL line and reads previous valid line', () => {
    const lines = [
      makeUserLine(),
      makeAssistantLine(170_000),
      '{"type": "assistant", "message": {"content": "partial write', // malformed trailing line
    ];
    const transcriptPath = writeTranscript('malformed.jsonl', lines);

    const result = readTokenGauge(transcriptPath);
    expect(result.status).toBe('ok');
    expect(result.usage.input_tokens).toBe(170_000);
    expect(result.threshold).toBe('checkpoint');
  });

  it('handles CRLF line endings', () => {
    const lines = [
      makeUserLine(),
      makeAssistantLine(140_000),
    ];
    const content = lines.join('\r\n') + '\r\n';
    const filePath = path.join(tmpDir, 'crlf.jsonl');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readTokenGauge(filePath);
    expect(result.status).toBe('ok');
    expect(result.usage.input_tokens).toBe(140_000);
    expect(result.threshold).toBe('approaching');
  });

  it('handles BOM at start of file', () => {
    const lines = [
      makeUserLine(),
      makeAssistantLine(180_000),
    ];
    const content = '\uFEFF' + lines.join('\n');
    const filePath = path.join(tmpDir, 'bom.jsonl');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readTokenGauge(filePath);
    expect(result.status).toBe('ok');
    expect(result.usage.input_tokens).toBe(180_000);
    expect(result.threshold).toBe('checkpoint');
  });

  it('formatGauge handles >100% utilization without crashing (C08)', () => {
    // 150% — should show 150% in text, full bar, no RangeError
    const bar150 = formatGauge(1.5, 300_000, 200_000);
    expect(bar150).toContain('150%');
    expect(bar150).toContain('██████████'); // full bar (clamped to 100%)
    expect(bar150).toContain('300k/200k');
  });

  it('formatGauge handles negative utilization without crashing (C08)', () => {
    // Negative — should clamp to 0%, empty bar
    const barNeg = formatGauge(-0.1, 0, 200_000);
    expect(barNeg).toContain('-10%'); // actual pct shown
    expect(barNeg).toContain('░░░░░░░░░░'); // empty bar (clamped to 0%)
  });

  it('formatGauge at exactly 100% shows full bar', () => {
    const bar = formatGauge(1.0, 200_000, 200_000);
    expect(bar).toBe('[██████████ 100% | 200k/200k]');
  });

  it('formatGauge at 200% shows 200% text with full bar', () => {
    const bar = formatGauge(2.0, 400_000, 200_000);
    expect(bar).toContain('200%');
    expect(bar).toContain('██████████');
  });

  it('returns unavailable for zero-length file', () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const result = readTokenGauge(filePath);
    expect(result.status).toBe('unavailable');
    expect(result.threshold).toBe('unavailable');
    expect(result.utilization).toBe(0);
  });
});

describe('detectWindowSize', () => {
  it('returns 200k regardless of model (conservative default)', () => {
    const tp = writeTranscript('opus.jsonl', [
      makeAssistantLineWithModel(100_000, 'claude-opus-4-6'),
    ]);
    expect(detectWindowSize(tp)).toBe(200_000);
  });

  it('config override takes priority', () => {
    expect(detectWindowSize(undefined, 500_000)).toBe(500_000);
  });

  it('returns 200k for undefined/missing transcript', () => {
    expect(detectWindowSize(undefined)).toBe(200_000);
    expect(detectWindowSize('')).toBe(200_000);
  });
});

describe('getIncrementalThresholds', () => {
  it('returns 2 thresholds for 200k window (light touch)', () => {
    const thresholds = getIncrementalThresholds(200_000);
    expect(thresholds).toHaveLength(2);
    expect(thresholds).toEqual([150_000, 180_000]);
  });

  it('returns 6 thresholds for 1M window (full coverage)', () => {
    const thresholds = getIncrementalThresholds(1_000_000);
    expect(thresholds).toHaveLength(6);
    expect(thresholds).toEqual([150_000, 300_000, 450_000, 600_000, 750_000, 900_000]);
  });

  it('returns 6 thresholds for any window > 200k', () => {
    const thresholds = getIncrementalThresholds(500_000);
    expect(thresholds).toHaveLength(6);
    expect(thresholds[0]).toBe(75_000); // 15% of 500k
  });
});

describe('readTokenGaugeWithDetection', () => {
  it('returns 200k window for opus model below 195k tokens', () => {
    const tp = writeTranscript('opus-low.jsonl', [
      makeAssistantLineWithModel(100_000, 'claude-opus-4-6'),
    ]);
    const result = readTokenGaugeWithDetection(tp);
    expect(result.status).toBe('ok');
    expect(result.window_size).toBe(200_000);
  });

  it('upgrades to 1M when opus model exceeds 195k tokens', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 1,
          output_tokens: 500,
          cache_creation_input_tokens: 50_000,
          cache_read_input_tokens: 150_000,
        },
      },
    });
    const tp = writeTranscript('opus-high.jsonl', [line]);
    const result = readTokenGaugeWithDetection(tp);
    expect(result.status).toBe('ok');
    expect(result.window_size).toBe(1_000_000);
    // 200001 tokens / 1M = ~20% utilization
    expect(result.utilization).toBeCloseTo(0.2, 1);
  });

  it('stays 200k for haiku even above 195k (not 1M capable)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5-20251001',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 1,
          output_tokens: 500,
          cache_creation_input_tokens: 100_000,
          cache_read_input_tokens: 100_000,
        },
      },
    });
    const tp = writeTranscript('haiku-high.jsonl', [line]);
    const result = readTokenGaugeWithDetection(tp);
    expect(result.window_size).toBe(200_000);
  });

  it('config override takes priority over everything', () => {
    const tp = writeTranscript('override.jsonl', [
      makeAssistantLineWithModel(100_000, 'claude-opus-4-6'),
    ]);
    const result = readTokenGaugeWithDetection(tp, 500_000);
    expect(result.window_size).toBe(500_000);
  });

  it('returns unavailable for missing transcript', () => {
    const result = readTokenGaugeWithDetection(undefined);
    expect(result.status).toBe('unavailable');
  });
});
