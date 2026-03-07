import { describe, it, expect } from 'vitest';
import {
  extractDecisionFromResponse,
  isConfirmationMessage,
} from '../../src/cm-adapter/decision-extractor.js';

describe('extractDecisionFromResponse', () => {
  // ── Tier 1: Explicit decision markers ──────────────────────────────
  it('extracts lines starting with "Decision:"', () => {
    const result = extractDecisionFromResponse('Decision: use SQLite for storage');
    expect(result).toBe('Decision: use SQLite for storage');
  });

  it('extracts lines starting with "Plan:"', () => {
    const result = extractDecisionFromResponse('Plan: deploy to staging first');
    expect(result).toBe('Plan: deploy to staging first');
  });

  it('extracts lines starting with "Choosing"', () => {
    // "Choosing" is Tier 1 but must also pass quality gate (needs action verb or structural marker)
    const result = extractDecisionFromResponse('Choosing to use the adapter pattern');
    expect(result).toBe('Choosing to use the adapter pattern');
  });

  it('extracts lines starting with "Going with"', () => {
    const result = extractDecisionFromResponse('Going with option B to keep it simple');
    expect(result).toBe('Going with option B to keep it simple');
  });

  it('extracts lines starting with "Chose"', () => {
    const result = extractDecisionFromResponse('Chose the simpler implementation path');
    expect(result).toBe('Chose the simpler implementation path');
  });

  // ── Tier 2: Action intent ──────────────────────────────────────────
  it('extracts lines starting with "I\'ll"', () => {
    const result = extractDecisionFromResponse("I'll implement the fix in state-files.ts");
    expect(result).toBe("I'll implement the fix in state-files.ts");
  });

  it('extracts lines starting with "We\'ll"', () => {
    const result = extractDecisionFromResponse("We'll use vitest for testing");
    expect(result).toBe("We'll use vitest for testing");
  });

  it('extracts lines starting with "Let\'s"', () => {
    const result = extractDecisionFromResponse("Let's add the dedup logic here");
    expect(result).toBe("Let's add the dedup logic here");
  });

  it('extracts lines starting with "The approach is"', () => {
    const result = extractDecisionFromResponse('The approach is to merge before writing');
    expect(result).toBe('The approach is to merge before writing');
  });

  it('extracts lines starting with "The plan is"', () => {
    const result = extractDecisionFromResponse('The plan is to split the module');
    expect(result).toBe('The plan is to split the module');
  });

  // ── Tier 3: Structured formats ─────────────────────────────────────
  it('extracts bold-prefixed bullets', () => {
    const result = extractDecisionFromResponse('- **SQLite** use it for the storage layer');
    expect(result).toBe('- **SQLite** use it for the storage layer');
  });

  it('extracts bold headings with action verbs', () => {
    const result = extractDecisionFromResponse('**Fix the dedup** by adding stemming');
    expect(result).toBe('**Fix the dedup** by adding stemming');
  });

  // ── Tier 4: Action-verb bullets ────────────────────────────────────
  it('extracts plain bullet with action verb', () => {
    const result = extractDecisionFromResponse('- use the adapter pattern for this');
    expect(result).toBe('- use the adapter pattern for this');
  });

  it('extracts numbered item with action verb', () => {
    const result = extractDecisionFromResponse('1. add error handling to the parser');
    expect(result).toBe('1. add error handling to the parser');
  });

  // ── Tier priority ──────────────────────────────────────────────────
  it('picks highest tier (lowest number) when multiple tiers present', () => {
    const text = [
      "- use the adapter pattern",         // Tier 4
      "I'll implement the fix first",      // Tier 2
      "Decision: go with option A",        // Tier 1
    ].join('\n');
    const result = extractDecisionFromResponse(text);
    expect(result).toBe('Decision: go with option A');
  });

  it('prefers tier 2 over tier 4 when both pass quality gate', () => {
    const text = [
      "- add the new module",
      "I'll implement the fix in dedup: refactor logic",
    ].join('\n');
    const result = extractDecisionFromResponse(text);
    // Tier 2 ("I'll") beats Tier 4 ("- add")
    expect(result).toBe("I'll implement the fix in dedup: refactor logic");
  });

  // ── Code fences skipped ────────────────────────────────────────────
  it('does NOT extract decision-like text inside code fences', () => {
    const text = [
      '```',
      'Decision: use SQLite',
      '```',
    ].join('\n');
    const result = extractDecisionFromResponse(text);
    expect(result).toBeNull();
  });

  it('extracts text before code fence but not inside', () => {
    const text = [
      "I'll fix the parser",
      '```js',
      'Decision: some code comment',
      '```',
    ].join('\n');
    const result = extractDecisionFromResponse(text);
    expect(result).toBe("I'll fix the parser");
  });

  // ── Quality gate: filler rejection ─────────────────────────────────
  it('rejects filler lines starting with "you\'re right"', () => {
    const result = extractDecisionFromResponse("you're right, let me use that approach");
    expect(result).toBeNull();
  });

  it('rejects filler lines starting with "hmm"', () => {
    const result = extractDecisionFromResponse("hmm let me add something here");
    expect(result).toBeNull();
  });

  it('rejects filler lines starting with "well,"', () => {
    const result = extractDecisionFromResponse("well, we should use SQLite");
    expect(result).toBeNull();
  });

  // ── Quality gate: question rejection ───────────────────────────────
  it('rejects lines ending with ?', () => {
    const result = extractDecisionFromResponse('Decision: should we use SQLite?');
    expect(result).toBeNull();
  });

  // ── Edge cases ─────────────────────────────────────────────────────
  it('returns null for empty text', () => {
    expect(extractDecisionFromResponse('')).toBeNull();
  });

  it('returns null for text with no decision-like content', () => {
    const result = extractDecisionFromResponse('This is just a regular paragraph with no decisions.');
    expect(result).toBeNull();
  });

  it('truncates long lines to 200 chars', () => {
    const longDecision = 'Decision: ' + 'x'.repeat(250);
    const result = extractDecisionFromResponse(longDecision);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(200);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('does not truncate lines at or under 200 chars', () => {
    const decision = 'Decision: ' + 'x'.repeat(180);
    const result = extractDecisionFromResponse(decision);
    expect(result).toBe(decision);
    expect(result!.length).toBeLessThanOrEqual(200);
  });

  // ── Tier 1 untested prefixes ──────────────────────────────────────
  it('should extract Approach: prefix', () => {
    expect(extractDecisionFromResponse('Approach: use dependency injection for services')).toBeTruthy();
  });

  // ── Tier 2 untested prefixes ──────────────────────────────────────
  it.each([
    'I will split the module into smaller functions',
    'We will deploy to staging first',
    "I'm going to change the database schema",
    "We're going to implement caching at the API layer",
    'The fix is to add null checks before dereferencing',
    'The solution is to use a connection pool',
  ])('should extract Tier 2 intent: %s', (input) => {
    expect(extractDecisionFromResponse(input)).toBeTruthy();
  });
});

describe('isConfirmationMessage', () => {
  // ── Positive cases ─────────────────────────────────────────────────
  it('returns true for "yes"', () => {
    expect(isConfirmationMessage('yes')).toBe(true);
  });

  it('returns true for "go ahead"', () => {
    expect(isConfirmationMessage('go ahead')).toBe(true);
  });

  it('returns true for "sounds good"', () => {
    expect(isConfirmationMessage('sounds good')).toBe(true);
  });

  it('returns true for "ok"', () => {
    expect(isConfirmationMessage('ok')).toBe(true);
  });

  it('returns true for "sure"', () => {
    expect(isConfirmationMessage('sure')).toBe(true);
  });

  it('returns true for "do it"', () => {
    expect(isConfirmationMessage('do it')).toBe(true);
  });

  it('returns true for "proceed"', () => {
    expect(isConfirmationMessage('proceed')).toBe(true);
  });

  // ── International confirmations ────────────────────────────────────
  it('returns true for "da" (Serbian yes)', () => {
    expect(isConfirmationMessage('da')).toBe(true);
  });

  it('returns true for "ja" (German yes)', () => {
    expect(isConfirmationMessage('ja')).toBe(true);
  });

  it('returns true for "oui" (French yes)', () => {
    expect(isConfirmationMessage('oui')).toBe(true);
  });

  // ── Negative cases ─────────────────────────────────────────────────
  it('returns false for empty string', () => {
    expect(isConfirmationMessage('')).toBe(false);
  });

  it('returns false for "no"', () => {
    expect(isConfirmationMessage('no')).toBe(false);
  });

  it('returns false for "don\'t do that"', () => {
    expect(isConfirmationMessage("don't do that")).toBe(false);
  });

  it('returns false for "stop"', () => {
    expect(isConfirmationMessage('stop')).toBe(false);
  });

  it('returns false for "wait"', () => {
    expect(isConfirmationMessage('wait')).toBe(false);
  });

  it('returns false for "cancel"', () => {
    expect(isConfirmationMessage('cancel')).toBe(false);
  });

  it('returns false for text ending with ?', () => {
    expect(isConfirmationMessage('sounds good?')).toBe(false);
  });

  it('returns false for long text (>= 50 chars) without keyword', () => {
    const longText = 'This is a rather long message that goes on and on without any confirmation keyword present at all';
    expect(longText.length).toBeGreaterThanOrEqual(50);
    expect(isConfirmationMessage(longText)).toBe(false);
  });

  it('returns false for long text (>= 50 chars) even with keyword', () => {
    const longText = 'I think we should proceed with this approach because it makes sense and is well thought out here';
    expect(longText.length).toBeGreaterThanOrEqual(50);
    expect(isConfirmationMessage(longText)).toBe(false);
  });

  it('returns true for text with keyword under 50 chars', () => {
    expect(isConfirmationMessage('yes, go ahead and implement it')).toBe(true);
  });

  // ── Negative: short non-keyword text should NOT confirm ──────────
  it('returns false for "later" (short, no keyword)', () => {
    expect(isConfirmationMessage('later')).toBe(false);
  });

  it('returns false for "maybe" (short, no keyword)', () => {
    expect(isConfirmationMessage('maybe')).toBe(false);
  });

  it('returns false for "hmm" (short, no keyword)', () => {
    expect(isConfirmationMessage('hmm')).toBe(false);
  });

  it('returns false for "k" (short, no keyword)', () => {
    expect(isConfirmationMessage('k')).toBe(false);
  });

  it('returns false for "what" (short, no keyword)', () => {
    expect(isConfirmationMessage('what')).toBe(false);
  });

  it('returns false for "yep" (short, no keyword)', () => {
    expect(isConfirmationMessage('yep')).toBe(false);
  });
});
