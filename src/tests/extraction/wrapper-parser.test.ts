/**
 * Phase 1 Plan 01-02 — wrapper-parser unit tests.
 *
 * Covers the contract for parseWrappers: splitting a UserPromptSubmit prompt
 * into its organic span + the document-ordered list of injected wrapper
 * blocks. KNOWN_WRAPPER_TAGS is the locked v5.0 set; the parser is the
 * single source of truth used by both the hook (correction-signal detection)
 * and episodic-events.ts (provenance split).
 *
 * EPI-04.
 */

import { describe, it, expect } from 'vitest';
import { parseWrappers, KNOWN_WRAPPER_TAGS } from '../../extraction/wrapper-parser.js';

describe('parseWrappers (EPI-04)', () => {
  it('returns organic=trimmed-input and empty injected when no wrappers are present', () => {
    const r = parseWrappers('  hello world  ');
    expect(r.organic).toBe('hello world');
    expect(r.injected).toEqual([]);
  });

  it('handles empty input', () => {
    const r = parseWrappers('');
    expect(r.organic).toBe('');
    expect(r.injected).toEqual([]);
  });

  it('extracts a single <system-reminder> block and strips it from organic', () => {
    const r = parseWrappers('what is X?\n<system-reminder>RULE</system-reminder>');
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0].tag).toBe('system-reminder');
    expect(r.injected[0].content).toBe('RULE');
    expect(r.organic).not.toMatch(/RULE/);
    expect(r.organic).toMatch(/^what is X\?$/);
  });

  it('extracts three different wrappers in document order', () => {
    const input = '<system-reminder>SR</system-reminder>middle<experience-data>EXP</experience-data>tail<file-content>FC</file-content>';
    const r = parseWrappers(input);
    expect(r.injected.map(b => b.tag)).toEqual(['system-reminder', 'experience-data', 'file-content']);
    expect(r.injected.map(b => b.content)).toEqual(['SR', 'EXP', 'FC']);
    // Organic preserves the interleaving text minus the wrapper blocks.
    expect(r.organic).toContain('middle');
    expect(r.organic).toContain('tail');
    expect(r.organic).not.toContain('SR');
    expect(r.organic).not.toContain('EXP');
    expect(r.organic).not.toContain('FC');
  });

  it('extracts the same tag twice as two distinct blocks', () => {
    const r = parseWrappers('<system-reminder>A</system-reminder> sep <system-reminder>B</system-reminder>');
    expect(r.injected).toHaveLength(2);
    expect(r.injected[0].content).toBe('A');
    expect(r.injected[1].content).toBe('B');
  });

  it('captures attribute strings on tags that carry them', () => {
    const r = parseWrappers('<file-content path="x.ts">body</file-content>');
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0].tag).toBe('file-content');
    expect(r.injected[0].content).toBe('body');
    expect(r.injected[0].attributes).toBe('path="x.ts"');
  });

  it('returns content="" for empty wrapper bodies', () => {
    const r = parseWrappers('<system-reminder></system-reminder>');
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0].content).toBe('');
  });

  it('handles mixed organic/wrapper interleaving', () => {
    const r = parseWrappers('pre <system-reminder>1</system-reminder> mid <experience-data>2</experience-data> post');
    expect(r.injected.map(b => b.content)).toEqual(['1', '2']);
    expect(r.organic).toContain('pre');
    expect(r.organic).toContain('mid');
    expect(r.organic).toContain('post');
    expect(r.organic).not.toContain('1');
    expect(r.organic).not.toContain('2');
  });

  it('is idempotent: running parseWrappers on .organic returns same organic + empty injected', () => {
    const first = parseWrappers('q? <experience-data>RECALL</experience-data>');
    const second = parseWrappers(first.organic);
    expect(second.organic).toBe(first.organic);
    expect(second.injected).toEqual([]);
  });

  it('matches all nine known wrapper tags case-insensitively', () => {
    for (const tag of KNOWN_WRAPPER_TAGS) {
      const r = parseWrappers(`pre <${tag}>X</${tag}> post`);
      expect(r.injected, `tag=${tag}`).toHaveLength(1);
      expect(r.injected[0].tag).toBe(tag);
    }
  });

  it('matches uppercase tag spellings (case-insensitive flag)', () => {
    const r = parseWrappers('<SYSTEM-REMINDER>x</SYSTEM-REMINDER>');
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0].tag).toBe('system-reminder');
    expect(r.injected[0].content).toBe('x');
  });

  it('concatenated wrappers with no separator -> organic is empty (regression)', () => {
    const r = parseWrappers('<system-reminder>SR</system-reminder><experience-data>EXP</experience-data>');
    expect(r.injected).toHaveLength(2);
    expect(r.injected.map(b => b.content)).toEqual(['SR', 'EXP']);
    expect(r.organic).toBe('');
  });
});
