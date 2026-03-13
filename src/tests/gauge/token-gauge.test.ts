import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import type { RuntimeCapabilities, TokenUsage } from '../../shared/types.js';

const CC_CAPS: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: true,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,
  hasLocalEmbeddings: false,
  supportsTurnEndEvent: true,
};

const OC_CAPS: RuntimeCapabilities = {
  hasFullMessageHistory: true,
  hasNativeContextUsage: true,
  hasTranscriptAccess: false,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,
  hasLocalEmbeddings: false,
  supportsTurnEndEvent: true,
};

const NO_CAPS: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: false,
  supportsSystemInjection: false,
  supportsAsyncEnrichment: false,
  hasLocalEmbeddings: false,
  supportsTurnEndEvent: false,
};

let tmpDir: string;

function writeTranscript(name: string, lines: string[]): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-gauge-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getTokenGauge — native path', () => {
  it('returns nativeUsage directly when hasNativeContextUsage is true', () => {
    const native: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 1000,
      contextWindowTokens: 200_000,
      utilization: 0.025,
    };
    const result = getTokenGauge({ capabilities: OC_CAPS, nativeUsage: native });
    expect(result).toBe(native);
  });

  it('ignores transcriptPath when nativeUsage is available', () => {
    const native: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 1000,
      contextWindowTokens: 200_000,
      utilization: 0.025,
    };
    const tp = writeTranscript('ignored.jsonl', [
      JSON.stringify({ message: { usage: { input_tokens: 99999 } } }),
    ]);
    const result = getTokenGauge({
      capabilities: { ...OC_CAPS, hasTranscriptAccess: true },
      nativeUsage: native,
      transcriptPath: tp,
    });
    expect(result).toBe(native);
  });

  it('returns null when hasNativeContextUsage but no nativeUsage provided', () => {
    const result = getTokenGauge({ capabilities: OC_CAPS });
    expect(result).toBeNull();
  });
});

describe('getTokenGauge — transcript path', () => {
  it('parses token usage from transcript JSONL tail', () => {
    const tp = writeTranscript('basic.jsonl', [
      JSON.stringify({ type: 'user', content: 'hello' }),
      JSON.stringify({ message: { usage: { input_tokens: 50000, output_tokens: 2000 } } }),
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(50000);
    expect(result!.outputTokens).toBe(2000);
    expect(result!.contextWindowTokens).toBe(200_000);
    expect(result!.utilization).toBe(50000 / 200_000);
  });

  it('finds most recent usage entry (last in file)', () => {
    const tp = writeTranscript('multi.jsonl', [
      JSON.stringify({ message: { usage: { input_tokens: 10000, output_tokens: 500 } } }),
      JSON.stringify({ type: 'user', content: 'more' }),
      JSON.stringify({ message: { usage: { input_tokens: 80000, output_tokens: 3000 } } }),
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result!.inputTokens).toBe(80000);
    expect(result!.outputTokens).toBe(3000);
  });

  it('auto-detects window size from model', () => {
    const tp = writeTranscript('bigwindow.jsonl', [
      JSON.stringify({ message: { usage: { input_tokens: 196_000, output_tokens: 5000 } } }),
    ]);
    const result = getTokenGauge({
      capabilities: CC_CAPS,
      transcriptPath: tp,
      model: 'claude-opus-4',
    });
    expect(result!.contextWindowTokens).toBe(1_000_000);
    expect(result!.utilization).toBe(196_000 / 1_000_000);
  });

  it('returns null when transcript file does not exist', () => {
    const result = getTokenGauge({
      capabilities: CC_CAPS,
      transcriptPath: '/nonexistent/path.jsonl',
    });
    expect(result).toBeNull();
  });

  it('returns null when transcript has no usage data', () => {
    const tp = writeTranscript('nousage.jsonl', [
      JSON.stringify({ type: 'user', content: 'hello' }),
      JSON.stringify({ type: 'assistant', content: 'hi' }),
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result).toBeNull();
  });

  it('handles large transcript files efficiently (tail read)', () => {
    // Write >8KB of padding then usage at the end
    const padding = JSON.stringify({ type: 'user', content: 'x'.repeat(500) });
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(padding); // ~15KB of padding
    lines.push(JSON.stringify({ message: { usage: { input_tokens: 42000, output_tokens: 1500 } } }));
    const tp = writeTranscript('large.jsonl', lines);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result!.inputTokens).toBe(42000);
  });

  it('returns null when no capabilities match', () => {
    const result = getTokenGauge({ capabilities: NO_CAPS, transcriptPath: '/any/path' });
    expect(result).toBeNull();
  });

  it('is non-throwing on malformed JSONL', () => {
    const tp = writeTranscript('malformed.jsonl', [
      'not json at all',
      '{ broken json',
      '{"valid": true}',
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result).toBeNull(); // No usage fields in any parseable line
  });

  it('handles root-level usage field', () => {
    const tp = writeTranscript('rootusage.jsonl', [
      JSON.stringify({ usage: { input_tokens: 30000, output_tokens: 1000 } }),
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(30000);
    expect(result!.outputTokens).toBe(1000);
  });
});

describe('getTokenGauge — transcript path validation', () => {
  it('rejects transcript path not ending with .jsonl', () => {
    // Write a file with valid content but wrong extension
    const filePath = path.join(tmpDir, 'sneaky.txt');
    fs.writeFileSync(filePath, JSON.stringify({ message: { usage: { input_tokens: 50000, output_tokens: 2000 } } }) + '\n', 'utf8');
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: filePath });
    expect(result).toBeNull();
  });

  it('rejects transcript path with .jsonl in middle but wrong extension', () => {
    const filePath = path.join(tmpDir, 'fake.jsonl.exe');
    fs.writeFileSync(filePath, JSON.stringify({ message: { usage: { input_tokens: 50000, output_tokens: 2000 } } }) + '\n', 'utf8');
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: filePath });
    expect(result).toBeNull();
  });

  it('accepts valid .jsonl transcript path', () => {
    const tp = writeTranscript('valid-path.jsonl', [
      JSON.stringify({ message: { usage: { input_tokens: 25000, output_tokens: 800 } } }),
    ]);
    const result = getTokenGauge({ capabilities: CC_CAPS, transcriptPath: tp });
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(25000);
  });
});
