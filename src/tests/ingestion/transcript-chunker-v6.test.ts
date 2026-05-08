/**
 * Tests for chunkTranscript (v6 transcript chunker).
 *
 * Pure-function tests: no DB, no I/O. Covers turn-boundary chunking,
 * sentence-boundary sub-chunking on long turns (>1500 tokens via the
 * 0.75-tokens-per-word proxy), parseWrappers redaction at the source-of-
 * truth ingestion point (TRX-04), and idempotency / determinism.
 */

import { describe, it, expect } from 'vitest';
import {
  chunkTranscript,
  SOFT_TOKEN_LIMIT,
  type JsonlTurn,
} from '../../ingestion/transcript-chunker-v6.js';
import { KNOWN_WRAPPER_TAGS } from '../../extraction/wrapper-parser.js';

function makeTurn(partial: Partial<JsonlTurn>): JsonlTurn {
  return {
    session_id: partial.session_id ?? 'sess-1',
    project_id: partial.project_id ?? 'proj-1',
    turn_index: partial.turn_index ?? 0,
    role: partial.role ?? 'user',
    body: partial.body ?? '',
    created_at_epoch_ms: partial.created_at_epoch_ms ?? 1700000000000,
    provenance: partial.provenance ?? 'organic',
  };
}

/** Build a body that exceeds SOFT_TOKEN_LIMIT tokens via repeated sentences. */
function makeLongBody(approxTokens: number): string {
  const sentence = 'This sentence has roughly ten words and ends with a period. ';
  // sentence ≈ 12 words → 12/0.75 = 16 tokens
  const sentencesNeeded = Math.ceil(approxTokens / 16);
  return sentence.repeat(sentencesNeeded).trim();
}

describe('chunkTranscript — pure function', () => {
  it('empty turns array returns empty chunks', () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  it('one short user turn produces exactly one chunk with sub_index=0 and wrapper_redacted=false', () => {
    const chunks = chunkTranscript([
      makeTurn({ body: 'Hello, this is a short turn.' }),
    ]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].sub_index).toBe(0);
    expect(chunks[0].wrapper_redacted).toBe(false);
    expect(chunks[0].body).toBe('Hello, this is a short turn.');
  });

  it('a short turn containing a <system-reminder> block sets wrapper_redacted=true and strips the wrapper', () => {
    const body = 'Pre. <system-reminder>injected text</system-reminder> Post.';
    const chunks = chunkTranscript([makeTurn({ body })]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].wrapper_redacted).toBe(true);
    expect(chunks[0].body).not.toContain('<system-reminder>');
    expect(chunks[0].body).not.toContain('injected text');
    expect(chunks[0].body).toContain('Pre.');
    expect(chunks[0].body).toContain('Post.');
  });

  it('a 5000-token assistant turn splits into multiple sub-chunks ≤ SOFT_TOKEN_LIMIT, ascending sub_index, sentence boundaries preserved', () => {
    const body = makeLongBody(5000);
    const chunks = chunkTranscript([makeTurn({ role: 'assistant', body })]);
    expect(chunks.length).toBeGreaterThan(1);
    // All same (session_id, turn_index, role)
    for (const c of chunks) {
      expect(c.session_id).toBe('sess-1');
      expect(c.turn_index).toBe(0);
      expect(c.role).toBe('assistant');
    }
    // Ascending sub_index 0..N-1
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].sub_index).toBe(i);
    }
    // Every sub-chunk respects SOFT_TOKEN_LIMIT (approximately — give a
    // small slack for the last sentence packing edge case).
    for (const c of chunks) {
      const wordCount = c.body.split(/\s+/).filter(Boolean).length;
      expect(Math.ceil(wordCount / 0.75)).toBeLessThanOrEqual(SOFT_TOKEN_LIMIT + 16);
    }
    // Sentence integrity — each sub-chunk ends on .!?
    for (const c of chunks) {
      expect(c.body.trim()).toMatch(/[.!?]$/);
    }
  });

  it('mixed-modality turn with <command-message> + <file-content> strips both wrapper types', () => {
    const body = [
      'Outer organic content begins.',
      '<command-message>cmd payload</command-message>',
      'Some middle organic content.',
      '<file-content>file payload</file-content>',
      'Final organic content.',
    ].join('\n\n');
    const chunks = chunkTranscript([makeTurn({ body })]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].wrapper_redacted).toBe(true);
    expect(chunks[0].body).not.toContain('<command-message>');
    expect(chunks[0].body).not.toContain('cmd payload');
    expect(chunks[0].body).not.toContain('<file-content>');
    expect(chunks[0].body).not.toContain('file payload');
    // Organic content survives.
    expect(chunks[0].body).toContain('Outer organic content begins.');
    expect(chunks[0].body).toContain('Some middle organic content.');
    expect(chunks[0].body).toContain('Final organic content.');
  });

  it('every KNOWN_WRAPPER_TAGS variant is stripped', () => {
    const blocks = KNOWN_WRAPPER_TAGS.map(
      tag => `<${tag}>secret-${tag}</${tag}>`,
    );
    const body = ['Outer.', ...blocks, 'Closer.'].join('\n');
    const chunks = chunkTranscript([makeTurn({ body })]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].wrapper_redacted).toBe(true);
    for (const tag of KNOWN_WRAPPER_TAGS) {
      expect(chunks[0].body).not.toContain(`<${tag}>`);
      expect(chunks[0].body).not.toContain(`</${tag}>`);
      expect(chunks[0].body).not.toContain(`secret-${tag}`);
    }
  });

  it('provenance values pass through unchanged from input turn', () => {
    const provenances: Array<JsonlTurn['provenance']> = [
      'organic', 'injected', 'tool_result', 'environmental',
    ];
    for (const p of provenances) {
      const chunks = chunkTranscript([
        makeTurn({ body: 'A turn body.', provenance: p }),
      ]);
      expect(chunks[0].provenance).toBe(p);
    }
  });

  it('chunkTranscript is deterministic: same input → same output', () => {
    const turns = [
      makeTurn({ turn_index: 0, role: 'user', body: 'Hello.' }),
      makeTurn({ turn_index: 1, role: 'assistant', body: makeLongBody(3000) }),
      makeTurn({ turn_index: 2, role: 'user', body: 'Follow-up.' }),
    ];
    const a = chunkTranscript(turns);
    const b = chunkTranscript(turns);
    expect(a).toEqual(b);
  });

  it('preserves session_id, project_id, turn_index, created_at_epoch_ms across all sub-chunks', () => {
    const ts = 1799999999999;
    const chunks = chunkTranscript([
      makeTurn({
        session_id: 'sess-X',
        project_id: 'proj-Y',
        turn_index: 7,
        role: 'assistant',
        body: makeLongBody(3000),
        created_at_epoch_ms: ts,
      }),
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.session_id).toBe('sess-X');
      expect(c.project_id).toBe('proj-Y');
      expect(c.turn_index).toBe(7);
      expect(c.created_at_epoch_ms).toBe(ts);
    }
  });

  it('an empty body (after wrapper stripping leaves nothing) still emits a single chunk for predictability', () => {
    const body = '<system-reminder>only injected</system-reminder>';
    const chunks = chunkTranscript([makeTurn({ body })]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].wrapper_redacted).toBe(true);
    expect(chunks[0].body).toBe('');
  });

  it('a turn with no whitespace between wrappers strips cleanly', () => {
    const body = '<system-reminder>a</system-reminder><file-content>b</file-content>';
    const chunks = chunkTranscript([makeTurn({ body })]);
    expect(chunks[0].wrapper_redacted).toBe(true);
    expect(chunks[0].body).toBe('');
  });
});
