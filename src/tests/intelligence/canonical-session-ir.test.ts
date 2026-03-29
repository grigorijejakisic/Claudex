import { describe, it, expect } from 'vitest';
import { fromClaudeCode, fromCodex, fromAider, autoDetectAndParse, toSummary } from '../../intelligence/canonical-session-ir.js';

describe('canonical-session-ir', () => {
  it('parses Claude Code JSONL transcript', () => {
    const jsonl = [
      JSON.stringify({ message: { role: 'user', content: 'Fix the auth bug' }, timestamp: '2026-03-28T10:00:00Z' }),
      JSON.stringify({ message: { role: 'assistant', content: 'I found the issue in auth.ts' }, timestamp: '2026-03-28T10:01:00Z' }),
    ].join('\n');

    const session = fromClaudeCode(jsonl, 'test-session');
    expect(session).not.toBeNull();
    expect(session!.provider).toBe('claude-code');
    expect(session!.messages.length).toBe(2);
    expect(session!.messages[0].role).toBe('user');
    expect(session!.messages[0].content).toContain('auth bug');
  });

  it('parses Claude Code with array content blocks', () => {
    const jsonl = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the fix' }, { type: 'tool_use', id: 'x' }] },
    });

    const session = fromClaudeCode(jsonl);
    expect(session).not.toBeNull();
    expect(session!.messages[0].content).toBe('Here is the fix');
  });

  it('parses Codex JSONL', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', content: 'Review this code' }),
      JSON.stringify({ role: 'assistant', content: 'Looks good with one issue' }),
    ].join('\n');

    const session = fromCodex(jsonl);
    expect(session).not.toBeNull();
    expect(session!.provider).toBe('codex');
    expect(session!.messages.length).toBe(2);
  });

  it('parses Aider markdown history', () => {
    const md = `#### user
Fix the login page CSS

#### assistant
I'll update the styles in login.css to fix the alignment issue.

#### user
Also add dark mode support
`;

    const session = fromAider(md);
    expect(session).not.toBeNull();
    expect(session!.provider).toBe('aider');
    expect(session!.messages.length).toBeGreaterThan(0);
  });

  it('auto-detects Claude Code JSONL', () => {
    const jsonl = [
      JSON.stringify({ message: { role: 'user', content: 'hello' }, slug: 'test-session' }),
      JSON.stringify({ message: { role: 'assistant', content: 'hi there' } }),
    ].join('\n');

    const session = autoDetectAndParse(jsonl);
    expect(session).not.toBeNull();
    expect(session!.provider).toBe('claude-code');
  });

  it('auto-detects Aider markdown by filename', () => {
    const md = '#### user\nFix the login page bug that causes crash on submit\n#### assistant\nI found the issue in the form validation handler and fixed it';
    const session = autoDetectAndParse(md, '.aider.chat.history.md');
    expect(session).not.toBeNull();
    expect(session!.provider).toBe('aider');
  });

  it('returns null for empty content', () => {
    expect(fromClaudeCode('')).toBeNull();
    expect(fromCodex('')).toBeNull();
    expect(fromAider('')).toBeNull();
  });

  it('generates a budget-aware summary', () => {
    const jsonl = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} with enough content to be meaningful and test budget` } })
    ).join('\n');

    const session = fromClaudeCode(jsonl)!;
    const summary = toSummary(session, 100); // Very tight budget
    expect(summary.length).toBeLessThan(500); // Budget respected
    expect(summary).toContain('claude-code');
  });
});
