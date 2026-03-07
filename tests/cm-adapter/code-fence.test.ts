import { describe, it, expect } from 'vitest';
import { linesOutsideCodeFences } from '../../src/cm-adapter/code-fence.js';

function collect(text: string): Array<{ raw: string; trimmed: string }> {
  return [...linesOutsideCodeFences(text)];
}

describe('linesOutsideCodeFences', () => {
  it('yields normal text lines', () => {
    const result = collect('line one\nline two\nline three');
    expect(result).toHaveLength(3);
    expect(result[0]!.trimmed).toBe('line one');
    expect(result[1]!.trimmed).toBe('line two');
    expect(result[2]!.trimmed).toBe('line three');
  });

  it('skips lines inside code fences', () => {
    const text = 'before\n```\ninside fence\n```\nafter';
    const result = collect(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.trimmed).toBe('before');
    expect(result[1]!.trimmed).toBe('after');
  });

  it('skips empty lines', () => {
    const text = 'line one\n\n\nline two';
    const result = collect(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.trimmed).toBe('line one');
    expect(result[1]!.trimmed).toBe('line two');
  });

  it('handles fence toggle: opening then closing', () => {
    const text = 'outside\n```\nfenced1\nfenced2\n```\nalso outside';
    const result = collect(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.trimmed).toBe('outside');
    expect(result[1]!.trimmed).toBe('also outside');
  });

  it('skips content in multiple code fence blocks', () => {
    const text = 'a\n```\nb\n```\nc\n```\nd\n```\ne';
    const result = collect(text);
    expect(result).toHaveLength(3);
    expect(result[0]!.trimmed).toBe('a');
    expect(result[1]!.trimmed).toBe('c');
    expect(result[2]!.trimmed).toBe('e');
  });

  it('yields raw with preserved indentation and trimmed without', () => {
    const text = '  indented line';
    const result = collect(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.raw).toBe('  indented line');
    expect(result[0]!.trimmed).toBe('indented line');
  });

  it('handles simple toggle (not nested) for fences', () => {
    // Nested ``` inside already-open fence closes it
    const text = '```js\ncode here\n```\noutside now';
    const result = collect(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.trimmed).toBe('outside now');
  });

  it('treats fence with language tag (```js) as fence opener', () => {
    const text = 'before\n```typescript\nconst x = 1;\n```\nafter';
    const result = collect(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.trimmed).toBe('before');
    expect(result[1]!.trimmed).toBe('after');
  });

  it('handles fence at start of file', () => {
    const text = '```\nfenced content\n```\noutside';
    const result = collect(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.trimmed).toBe('outside');
  });

  it('returns nothing for empty text', () => {
    expect(collect('')).toHaveLength(0);
  });

  it('returns nothing for text that is only whitespace lines', () => {
    expect(collect('  \n   \n  ')).toHaveLength(0);
  });

  it('handles unclosed fence (all subsequent lines are inside)', () => {
    const text = 'before\n```\nfenced\nstill fenced';
    const result = collect(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.trimmed).toBe('before');
  });

  // ── CRLF handling ─────────────────────────────────────────────────
  it('handles CRLF line endings', () => {
    const text = 'line1\r\n```\r\ncode\r\n```\r\nline2';
    const result = collect(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.trimmed).toBe('line1');
    expect(result[1]!.trimmed).toBe('line2');
  });

  it('handles mixed LF and CRLF line endings', () => {
    const text = 'line1\r\nline2\nline3\r\n```\r\nfenced\n```\nline4';
    const result = collect(text);
    expect(result).toHaveLength(4);
    expect(result[0]!.trimmed).toBe('line1');
    expect(result[1]!.trimmed).toBe('line2');
    expect(result[2]!.trimmed).toBe('line3');
    expect(result[3]!.trimmed).toBe('line4');
  });
});
