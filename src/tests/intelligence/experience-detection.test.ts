/**
 * Tests for correction detection, behavioral detection, and pattern extraction.
 * Functions under test live in src/intelligence/correction-detection.ts
 * (extracted from hook files for testability).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectCorrectionSignal,
  extractPatternFromAssistantText,
  extractLessonFromUserCorrection,
} from '../../intelligence/correction-detection.js';
import { buildToolSignature } from '../../intelligence/behavioral-signals.js';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import {
  withBehavioralBatch,
  applyFileEditIncrement,
  applyToolCallPattern,
  getBehavioralCounters,
} from '../../intelligence/experience-flags.js';

// ---------------------------------------------------------------------------
// Correction signal detection (linguistic)
// ---------------------------------------------------------------------------

describe('correction detection', () => {
  describe('positive cases — should detect as corrections', () => {
    it('detects "I told you before"', () => {
      expect(detectCorrectionSignal('I told you before not to do that')).toBe(true);
    });

    it('detects "same mistake again"', () => {
      expect(detectCorrectionSignal('This is the same mistake again wrong approach')).toBe(true);
    });

    it('detects "we already did this"', () => {
      expect(detectCorrectionSignal('we already did this last session')).toBe(true);
    });

    it('detects "we already" variant', () => {
      expect(detectCorrectionSignal('we already discussed this approach')).toBe(true);
    });

    it('detects "that\'s not right"', () => {
      expect(detectCorrectionSignal("that's not right, you need to check the config")).toBe(true);
    });

    it('detects "that\'s wrong"', () => {
      expect(detectCorrectionSignal("that's wrong, use the correct path")).toBe(true);
    });

    it('detects "you keep doing"', () => {
      expect(detectCorrectionSignal('you keep doing this every time')).toBe(true);
    });

    it('detects "should be remembered"', () => {
      expect(detectCorrectionSignal('this should be remembered for next time')).toBe(true);
    });

    it('detects "remember when"', () => {
      expect(detectCorrectionSignal('remember when we had this exact same issue?')).toBe(true);
    });

    it('detects "remember last time"', () => {
      expect(detectCorrectionSignal('remember last time this broke everything')).toBe(true);
    });

    it('detects "how many times"', () => {
      expect(detectCorrectionSignal('how many times do I have to say this?')).toBe(true);
    });

    it('detects "learn from experience"', () => {
      expect(detectCorrectionSignal('please learn from experience on this one')).toBe(true);
    });

    it('detects "learn from this"', () => {
      expect(detectCorrectionSignal('learn from this mistake so it does not happen again')).toBe(true);
    });

    it('detects "stop doing"', () => {
      expect(detectCorrectionSignal('stop doing that with the imports')).toBe(true);
    });

    it("detects \"don't do that\"", () => {
      expect(detectCorrectionSignal("don't do that with the file paths")).toBe(true);
    });

    it("detects \"don't repeat\"", () => {
      expect(detectCorrectionSignal("don't repeat the same error in the config")).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectCorrectionSignal('I TOLD YOU before')).toBe(true);
      expect(detectCorrectionSignal('YOU KEEP making this mistake')).toBe(true);
    });

    // Contraction-agnostic and expanded coverage
    it('detects "this is wrong"', () => {
      expect(detectCorrectionSignal('this is wrong, fix it please')).toBe(true);
    });

    it('detects "that is wrong"', () => {
      expect(detectCorrectionSignal('that is wrong, it should be X')).toBe(true);
    });

    it('detects "this is not what I wanted"', () => {
      expect(detectCorrectionSignal('this is not what I wanted at all')).toBe(true);
    });

    it('detects "this is incorrect"', () => {
      expect(detectCorrectionSignal('this is incorrect, check the config')).toBe(true);
    });

    it('detects "that is incorrect"', () => {
      expect(detectCorrectionSignal('that is incorrect, use the shared module')).toBe(true);
    });

    it('detects "no, do X instead"', () => {
      expect(detectCorrectionSignal('no, do it differently this time')).toBe(true);
    });

    it('detects "no, use Y"', () => {
      expect(detectCorrectionSignal('no, use the other approach')).toBe(true);
    });

    it('detects "actually, use X"', () => {
      expect(detectCorrectionSignal('actually, use the shared config')).toBe(true);
    });

    it('detects "actually, try Y"', () => {
      expect(detectCorrectionSignal('actually, try the alternative method')).toBe(true);
    });

    it('detects "that is not what I asked"', () => {
      expect(detectCorrectionSignal('that is not what I asked for')).toBe(true);
    });

    it('detects standalone "wrong" at end of input', () => {
      expect(detectCorrectionSignal('wrong')).toBe(true);
    });

    it('detects standalone "incorrect" at end of input', () => {
      expect(detectCorrectionSignal('incorrect')).toBe(true);
    });
  });

  describe('negative cases — should NOT detect as corrections', () => {
    it('does NOT detect normal questions', () => {
      expect(detectCorrectionSignal('How do I configure the database connection?')).toBe(false);
    });

    it('does NOT detect "can you" as correction', () => {
      expect(detectCorrectionSignal('can you help me implement OAuth?')).toBe(false);
    });

    it('does NOT detect "again" alone without error context', () => {
      expect(detectCorrectionSignal('run the tests again please')).toBe(false);
    });

    it('does NOT detect regular task instructions', () => {
      expect(detectCorrectionSignal('please add a new endpoint for user authentication')).toBe(false);
    });

    it('does NOT detect code review feedback without correction phrases', () => {
      expect(detectCorrectionSignal('this function could be simpler')).toBe(false);
    });

    it('does NOT detect empty string', () => {
      expect(detectCorrectionSignal('')).toBe(false);
    });

    it('does NOT detect unrelated "no" usage', () => {
      expect(detectCorrectionSignal('no new features needed right now')).toBe(false);
    });

    it('does NOT detect "actually" without action verb', () => {
      expect(detectCorrectionSignal('actually, I was wondering about the API')).toBe(false);
    });

    it('does NOT detect "wrong" mid-sentence as a question', () => {
      expect(detectCorrectionSignal('is this the wrong file to edit?')).toBe(false);
    });

    it('does NOT detect "no" without action verb following', () => {
      expect(detectCorrectionSignal("no, I don't think we need that feature")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Behavioral detection — file thrashing and loop detection
// ---------------------------------------------------------------------------

describe('behavioral detection', () => {
  let db: TestDatabase;
  let sessionId: string;

  beforeEach(() => {
    const result = createTestDbWithSession('test-session', 'test-project');
    db = result.db;
    sessionId = result.sessionId;
  });

  afterEach(() => { db.close(); });

  describe('file thrashing detection', () => {
    it('detects file thrashing after 3+ edits to same file', () => {
      const filePath = 'src/foo.ts';
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, filePath)); // 1
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, filePath)); // 2
      const finalCounters = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, filePath)); // 3
      expect(finalCounters.file_edit_counts[filePath]).toBeGreaterThanOrEqual(3);
    });

    it('does not false-positive on different files', () => {
      const cA = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/a.ts'));
      const cB = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/b.ts'));
      const cC = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/c.ts'));
      expect(cA.file_edit_counts['src/a.ts']).toBe(1);
      expect(cB.file_edit_counts['src/b.ts']).toBe(1);
      expect(cC.file_edit_counts['src/c.ts']).toBe(1);
    });

    it('tracks each file independently', () => {
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/foo.ts'));
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/foo.ts'));
      const afterFoo = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/foo.ts'));
      const afterBar = withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/bar.ts'));

      expect(afterFoo.file_edit_counts['src/foo.ts']).toBe(3);
      expect(afterBar.file_edit_counts['src/bar.ts']).toBe(1);
    });

    it('persists counts across reads', () => {
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/main.ts'));
      withBehavioralBatch(db, sessionId, c => applyFileEditIncrement(c, 'src/main.ts'));

      const counters = getBehavioralCounters(db, sessionId);
      expect(counters.file_edit_counts['src/main.ts']).toBe(2);
    });
  });

  describe('loop detection', () => {
    it('detects loop when 3+ identical consecutive tool patterns appear', () => {
      const tool = 'Edit';
      const sig = 'src/foo.ts:const x = 1;';

      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, tool, sig)); // 1
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, tool, sig)); // 2
      let loopDetected = false;
      withBehavioralBatch(db, sessionId, c => { loopDetected = applyToolCallPattern(c, tool, sig); }); // 3
      expect(loopDetected).toBe(true);
    });

    it('does not false-positive on different tool signatures', () => {
      const tool = 'Edit';
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, tool, 'src/a.ts:content-a'));
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, tool, 'src/b.ts:content-b'));
      let loopDetected = false;
      withBehavioralBatch(db, sessionId, c => { loopDetected = applyToolCallPattern(c, tool, 'src/c.ts:content-c'); });
      expect(loopDetected).toBe(false);
    });

    it('does not false-positive on 2 identical patterns (needs 3)', () => {
      const tool = 'Bash';
      const sig = 'npm:test';
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, tool, sig));
      let loopDetected = false;
      withBehavioralBatch(db, sessionId, c => { loopDetected = applyToolCallPattern(c, tool, sig); });
      expect(loopDetected).toBe(false);
    });

    it('does not false-positive when same sig appears non-consecutively', () => {
      // A B A B A — not 3 consecutive identical
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Edit', 'src/foo.ts:a'));
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Edit', 'src/bar.ts:b'));
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Edit', 'src/foo.ts:a'));
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Edit', 'src/bar.ts:b'));
      let loopDetected = false;
      withBehavioralBatch(db, sessionId, c => { loopDetected = applyToolCallPattern(c, 'Edit', 'src/foo.ts:a'); });
      expect(loopDetected).toBe(false);
    });

    it('does not false-positive on different tool names with same sig', () => {
      const sig = 'src/foo.ts:';
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Edit', sig));
      withBehavioralBatch(db, sessionId, c => applyToolCallPattern(c, 'Write', sig));
      let loopDetected = false;
      withBehavioralBatch(db, sessionId, c => { loopDetected = applyToolCallPattern(c, 'Edit', sig); });
      expect(loopDetected).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Pattern extraction from assistant text
// ---------------------------------------------------------------------------

describe('pattern extraction', () => {
  describe('lesson extraction', () => {
    it('extracts lesson from "the fix is..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'I apologize for the confusion. The fix is to always check the OAuth token path before migration.',
        'You told me before about the OAuth token issue',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('check the OAuth token path');
    });

    it('extracts lesson from "correct approach is..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'You are right. The correct approach is to copy credentials from ~/.claude/ before any migration.',
        'same mistake with the credentials again wrong',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toBeTruthy();
    });

    it('extracts lesson from "I should..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'I should have checked the environment variables before deploying to production.',
        'We already did this and you forgot the env vars',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('environment variables');
    });

    it('extracts lesson from "going forward..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'Going forward, I will always verify the token is present before starting the migration.',
        'remember when this broke the server',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toBeTruthy();
    });

    it('extracts lesson from "next time, I should..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'Next time, I should verify the database connection string before running migrations.',
        'You keep doing this with migrations',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toBeTruthy();
    });
  });

  describe('anti_pattern extraction', () => {
    it('extracts anti_pattern from "the problem was..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'The fix is to always copy the token file. The problem was that I assumed the old token would work.',
        'same mistake again wrong with the token',
      );
      expect(result).not.toBeNull();
      expect(result!.anti_pattern).toContain('assumed the old token');
    });

    it('extracts anti_pattern from "I assumed..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'The correct approach is to check env vars. I assumed the defaults would carry over.',
        'you keep making this environment mistake',
      );
      expect(result).not.toBeNull();
      expect(result!.anti_pattern).toBeTruthy();
    });

    it('extracts anti_pattern from "instead of..." pattern', () => {
      const result = extractPatternFromAssistantText(
        'Going forward, I will check the config. Instead of relying on cached values from the old host.',
        'we already discussed this caching problem',
      );
      expect(result).not.toBeNull();
      expect(result!.anti_pattern).toBeTruthy();
    });
  });

  describe('trigger_context extraction', () => {
    it('derives trigger_context from user prompt (first 120 chars)', () => {
      const userPrompt = 'We already discussed the OAuth token transfer when migrating servers';
      const result = extractPatternFromAssistantText(
        'The fix is to always copy the OAuth credentials before migration.',
        userPrompt,
      );
      expect(result).not.toBeNull();
      expect(result!.trigger_context.length).toBeLessThanOrEqual(120);
      expect(result!.trigger_context).toContain('OAuth token transfer');
    });

    it('strips correction boilerplate from trigger_context', () => {
      const result = extractPatternFromAssistantText(
        'The fix is to always verify the SSH key before connecting.',
        'I told you before about SSH key verification on the server',
      );
      expect(result).not.toBeNull();
      // "I told you before" should be stripped from trigger_context
      expect(result!.trigger_context).not.toMatch(/I\s+told\s+you/i);
    });

    it('returns pattern_type as "correction"', () => {
      const result = extractPatternFromAssistantText(
        'The fix is to run migrations inside a transaction.',
        'same mistake again wrong with migrations',
      );
      expect(result).not.toBeNull();
      expect(result!.pattern_type).toBe('correction');
    });
  });

  describe('null return cases', () => {
    it('returns null when assistant text has no extractable lesson', () => {
      const result = extractPatternFromAssistantText(
        'I understand. Let me try a different approach here.',
        'same mistake again with the config',
      );
      expect(result).toBeNull();
    });

    it('returns null when assistant text is too short (< 20 chars)', () => {
      const result = extractPatternFromAssistantText(
        'Got it.',
        'same mistake again wrong approach',
      );
      expect(result).toBeNull();
    });

    it('returns null when assistant text is empty', () => {
      const result = extractPatternFromAssistantText(
        '',
        'I told you before',
      );
      expect(result).toBeNull();
    });

    it('returns null when user prompt is too short for trigger_context (< 5 chars)', () => {
      const result = extractPatternFromAssistantText(
        'The fix is to always use async/await properly in the component lifecycle.',
        'fix', // too short
      );
      expect(result).toBeNull();
    });

    it('handles malformed assistant text gracefully (non-throwing)', () => {
      expect(() => extractPatternFromAssistantText(
        null as unknown as string,
        'I told you before',
      )).not.toThrow();

      expect(() => extractPatternFromAssistantText(
        'The fix is something.',
        undefined as unknown as string,
      )).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// extractLessonFromUserCorrection (PRIMARY extraction path)
// ---------------------------------------------------------------------------

describe('extractLessonFromUserCorrection', () => {
  describe('lesson extraction', () => {
    it('extracts "always use X" pattern', () => {
      const result = extractLessonFromUserCorrection(
        'I told you we always use oauth for authentication, never API keys!',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('oauth');
      expect(result!.pattern_type).toBe('correction');
    });

    it('extracts "just use X" pattern', () => {
      const result = extractLessonFromUserCorrection(
        'no, just use the existing database connection pool',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('database connection pool');
    });

    it('extracts "use X instead" pattern', () => {
      const result = extractLessonFromUserCorrection(
        "that's wrong, use parameterized queries instead of string concatenation",
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('parameterized queries');
    });

    it('extracts "we use X" declarative policy', () => {
      const result = extractLessonFromUserCorrection(
        "that's not right, we only use TypeScript strict mode in this project",
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('TypeScript strict mode');
    });

    it('extracts "it should be X" pattern', () => {
      const result = extractLessonFromUserCorrection(
        'same mistake again, it should always be camelCase not snake_case',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toContain('camelCase');
    });
  });

  describe('anti-pattern extraction', () => {
    it('extracts "never X" anti-pattern', () => {
      const result = extractLessonFromUserCorrection(
        'I told you never use API keys for authentication, always use oauth!',
      );
      expect(result).not.toBeNull();
      expect(result!.anti_pattern).toBeTruthy();
      expect(result!.anti_pattern).toContain('API keys');
    });

    it('extracts "stop doing X" anti-pattern', () => {
      const result = extractLessonFromUserCorrection(
        "you keep doing this! stop suggesting quick fixes, we always do proper fixes",
      );
      expect(result).not.toBeNull();
      expect(result!.anti_pattern).toContain('quick fixes');
    });
  });

  describe('combined lesson + anti-pattern', () => {
    it('extracts both lesson and anti-pattern from one prompt', () => {
      const result = extractLessonFromUserCorrection(
        'I told you: always use oauth for server auth! never use API key credentials!',
      );
      expect(result).not.toBeNull();
      expect(result!.lesson).toBeTruthy();
      expect(result!.anti_pattern).toBeTruthy();
    });

    it('derives lesson from anti-pattern when no explicit lesson', () => {
      const result = extractLessonFromUserCorrection(
        "that's wrong, never use mocks for integration tests",
      );
      expect(result).not.toBeNull();
      // Should derive "avoid mocks for integration tests"
      expect(result!.lesson).toMatch(/avoid/i);
    });
  });

  describe('severity escalation', () => {
    it('marks as critical when user indicates repeated correction', () => {
      const result = extractLessonFromUserCorrection(
        'I told you this before! we always use oauth!',
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('critical');
    });

    it('marks as critical for "how many times"', () => {
      const result = extractLessonFromUserCorrection(
        'how many times do I have to say this? just use the standard config!',
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('critical');
    });

    it('marks as important (non-escalated) for first correction', () => {
      const result = extractLessonFromUserCorrection(
        "no, actually we use a different approach. just use the shared helper function",
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('important');
    });
  });

  describe('trigger_context', () => {
    it('strips correction signal phrases from trigger_context', () => {
      const result = extractLessonFromUserCorrection(
        'I told you about SSH key verification always use the standard approach',
      );
      expect(result).not.toBeNull();
      expect(result!.trigger_context).not.toMatch(/I\s+told\s+you/i);
      expect(result!.trigger_context).toContain('SSH key verification');
    });

    it('caps trigger_context at 120 chars', () => {
      const longPrompt = 'same mistake again ' + 'a'.repeat(200) + ' always use the correct approach';
      const result = extractLessonFromUserCorrection(longPrompt);
      if (result) {
        expect(result.trigger_context.length).toBeLessThanOrEqual(120);
      }
    });
  });

  describe('null return cases', () => {
    it('returns null for normal questions (no lesson or anti-pattern)', () => {
      expect(extractLessonFromUserCorrection(
        'How do I configure the database connection?',
      )).toBeNull();
    });

    it('returns null for input shorter than 10 chars', () => {
      expect(extractLessonFromUserCorrection('fix it')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(extractLessonFromUserCorrection('')).toBeNull();
    });

    it('handles null/undefined gracefully (non-throwing)', () => {
      expect(() => extractLessonFromUserCorrection(null as unknown as string)).not.toThrow();
      expect(() => extractLessonFromUserCorrection(undefined as unknown as string)).not.toThrow();
    });

    it('returns null when trigger_context would be too short', () => {
      // Very short prompt — after stripping correction phrases, < 5 chars remain
      expect(extractLessonFromUserCorrection('we already ok')).toBeNull();
    });
  });

  describe('input capping', () => {
    it('caps input at 500 chars to prevent regex backtracking', () => {
      const longInput = 'I told you always use ' + 'x'.repeat(600) + ' important';
      // Should not hang or throw — the regex operates on capped input
      expect(() => extractLessonFromUserCorrection(longInput)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// buildToolSignature
// ---------------------------------------------------------------------------

describe('buildToolSignature', () => {
  it('builds signature from tool name, path and content (content is hashed)', () => {
    const sig = buildToolSignature('Edit', { path: 'src/foo.ts', content: 'const x = 1;' });
    // Format: toolName:path:hash(12 hex chars) — raw content never stored
    expect(sig).toMatch(/^Edit:src\/foo\.ts:[0-9a-f]{12}$/);
    expect(sig).not.toContain('const x = 1;');
  });

  it('uses file_path when path is not present', () => {
    const sig = buildToolSignature('Read', { file_path: 'src/bar.ts', content: 'hello' });
    expect(sig).toContain('src/bar.ts');
    expect(sig).toContain('Read');
    // content should be hashed, not raw
    expect(sig).not.toContain('hello');
  });

  it('produces stable hash for same content (deterministic)', () => {
    const sig1 = buildToolSignature('Write', { path: 'src/foo.ts', content: 'const x = 1;' });
    const sig2 = buildToolSignature('Write', { path: 'src/foo.ts', content: 'const x = 1;' });
    expect(sig1).toBe(sig2);
  });

  it('produces different hash for different content (collision avoidance)', () => {
    const sig1 = buildToolSignature('Write', { path: 'src/foo.ts', content: 'const x = 1;' });
    const sig2 = buildToolSignature('Write', { path: 'src/foo.ts', content: 'const x = 2;' });
    expect(sig1).not.toBe(sig2);
  });

  it('uses tool name + JSON input when no path or content — prevents collision', () => {
    const sig1 = buildToolSignature('Bash', {});
    const sig2 = buildToolSignature('Grep', {});
    // Each must include the tool name so they cannot collide on ':'
    expect(sig1).toContain('Bash');
    expect(sig2).toContain('Grep');
    expect(sig1).not.toBe(sig2);
  });

  it('uses pattern field as path-equivalent', () => {
    const sig = buildToolSignature('Grep', { pattern: '*.ts' });
    expect(sig).toContain('Grep');
    expect(sig).toContain('*.ts');
  });

  it('redacts content for known secret file paths (no raw secret in signature)', () => {
    const sig = buildToolSignature('Read', { file_path: '.env', content: 'API_KEY=supersecret' });
    // Raw secret must never appear in signature
    expect(sig).not.toContain('supersecret');
    expect(sig).not.toContain('API_KEY');
    // Signature is still structured: toolName:path:hash
    expect(sig).toMatch(/^Read:\.env:[0-9a-f]{12}$/);
  });

  it('is non-throwing on bad input', () => {
    expect(() => buildToolSignature('Tool', null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => buildToolSignature('Tool', undefined as unknown as Record<string, unknown>)).not.toThrow();
  });
});
