/**
 * Phase 13 Plan 01: session-writer.ts fixture tests.
 *
 * Proves the per-turn fsync write guarantee in the fixture sense:
 * - deterministic path derivation (getSessionFilePath)
 * - file reuse across calls in the same session
 * - multi-turn append ordering
 * - wrapper preservation at write-time (redaction is extraction-time)
 * - crash-simulation: writes completed before abort are durable on disk
 * - non-throwing error return (Error object, not exception)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendTurnToSessionFile,
  getSessionFilePath,
  nowIso,
} from '../../../adapters/cc-hooks/session-writer.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-sessions-test-'));
}

describe('getSessionFilePath', () => {
  it('returns deterministic path based on session-id suffix', () => {
    const cwd = makeTmpDir();
    const sid = 'test-session-abc123';
    const p1 = getSessionFilePath(cwd, sid);
    const p2 = getSessionFilePath(cwd, sid);
    expect(p1).toBe(p2);
    expect(p1).toMatch(/_test-session-abc123\.md$/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reuses existing file path when Sessions/ already has a file for this session', () => {
    const cwd = makeTmpDir();
    const sid = 'reuse-test-session';
    const sessDir = path.join(cwd, 'Sessions');
    fs.mkdirSync(sessDir);
    const existingFile = path.join(sessDir, `2026-01-01_${sid}.md`);
    fs.writeFileSync(existingFile, '', 'utf8');
    const resolved = getSessionFilePath(cwd, sid);
    expect(resolved).toBe(existingFile);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a new path with today\'s local-date prefix when no file exists', () => {
    const cwd = makeTmpDir();
    const sid = 'brand-new-session';
    const p = getSessionFilePath(cwd, sid);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(path.basename(p)).toBe(`${today}_${sid}.md`);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('produces 10 deterministic paths for 10 synthetic session-id + date combinations', () => {
    const cwd = makeTmpDir();
    const sessDir = path.join(cwd, 'Sessions');
    fs.mkdirSync(sessDir);
    const sids = Array.from({ length: 10 }, (_, i) => `synth-${i.toString().padStart(3, '0')}-abcdef`);
    // Pre-create existing files for half with date prefix
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(sessDir, `2025-12-31_${sids[i]}.md`), '', 'utf8');
    }
    for (const sid of sids) {
      const p1 = getSessionFilePath(cwd, sid);
      const p2 = getSessionFilePath(cwd, sid);
      expect(p1).toBe(p2);
      expect(p1.endsWith(`_${sid}.md`)).toBe(true);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('appendTurnToSessionFile — clean session', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('creates Sessions/ dir and writes first turn', () => {
    const sid = 'clean-session-1';
    const err = appendTurnToSessionFile({
      cwd, sessionId: sid, role: 'user',
      body: 'Hello from user', timestampIso: '2026-05-14T10:00:00+02:00',
    });
    expect(err).toBeNull();
    const filePath = getSessionFilePath(cwd, sid);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('## User');
    expect(content).toContain('Hello from user');
    expect(content).toContain('2026-05-14T10:00:00+02:00');
  });

  it('appends 3 user+assistant turn pairs in correct order', () => {
    const sid = 'clean-session-2';
    const turns: Array<{ role: 'user' | 'assistant'; body: string }> = [
      { role: 'user', body: 'Turn 1 user' },
      { role: 'assistant', body: 'Turn 1 assistant' },
      { role: 'user', body: 'Turn 2 user' },
      { role: 'assistant', body: 'Turn 2 assistant' },
      { role: 'user', body: 'Turn 3 user' },
      { role: 'assistant', body: 'Turn 3 assistant' },
    ];
    for (const t of turns) {
      appendTurnToSessionFile({ cwd, sessionId: sid, role: t.role, body: t.body, timestampIso: nowIso() });
    }
    const filePath = getSessionFilePath(cwd, sid);
    const content = fs.readFileSync(filePath, 'utf8');
    for (const t of turns) {
      expect(content).toContain(t.body);
    }
    expect(content.indexOf('Turn 1 user')).toBeLessThan(content.indexOf('Turn 1 assistant'));
    expect(content.indexOf('Turn 1 assistant')).toBeLessThan(content.indexOf('Turn 2 user'));
    expect(content.indexOf('Turn 2 user')).toBeLessThan(content.indexOf('Turn 2 assistant'));
    // 3 user headers + 3 assistant headers
    expect((content.match(/^## User$/gm) ?? []).length).toBe(3);
    expect((content.match(/^## Assistant$/gm) ?? []).length).toBe(3);
  });

  it('preserves system-reminder wrapper content verbatim (no redaction at write-time)', () => {
    const sid = 'wrapper-preservation';
    const bodyWithWrapper = 'User message\n<system-reminder>Critical rule: always do X</system-reminder>';
    appendTurnToSessionFile({ cwd, sessionId: sid, role: 'user', body: bodyWithWrapper, timestampIso: nowIso() });
    const filePath = getSessionFilePath(cwd, sid);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('<system-reminder>Critical rule: always do X</system-reminder>');
  });

  it('tool_result turn uses correct header with toolName', () => {
    const sid = 'tool-result-turn';
    appendTurnToSessionFile({
      cwd, sessionId: sid, role: 'tool_result',
      body: 'tool output here', timestampIso: nowIso(), toolName: 'Bash',
    });
    const filePath = getSessionFilePath(cwd, sid);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('## ToolResult: Bash');
    expect(content).toContain('tool output here');
  });
});

describe('appendTurnToSessionFile — crash resilience', () => {
  it('file on disk contains all writes completed before a simulated abort', () => {
    const cwd = makeTmpDir();
    try {
      const sid = 'crash-sim-session';
      appendTurnToSessionFile({ cwd, sessionId: sid, role: 'user', body: 'Pre-crash turn 1', timestampIso: nowIso() });
      appendTurnToSessionFile({ cwd, sessionId: sid, role: 'assistant', body: 'Pre-crash turn 2', timestampIso: nowIso() });
      appendTurnToSessionFile({ cwd, sessionId: sid, role: 'user', body: 'Pre-crash turn 3', timestampIso: nowIso() });
      // Simulate mid-turn abort — 4th write never happens
      const filePath = getSessionFilePath(cwd, sid);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('Pre-crash turn 1');
      expect(content).toContain('Pre-crash turn 2');
      expect(content).toContain('Pre-crash turn 3');
      const userHeaders = (content.match(/^## User$/gm) ?? []).length;
      const assistantHeaders = (content.match(/^## Assistant$/gm) ?? []).length;
      expect(userHeaders).toBe(2);
      expect(assistantHeaders).toBe(1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null (no error) on success and a non-null Error on write failure', () => {
    const cwd1 = makeTmpDir();
    try {
      const sid = 'error-return-test';
      const ok = appendTurnToSessionFile({ cwd: cwd1, sessionId: sid, role: 'user', body: 'ok', timestampIso: nowIso() });
      expect(ok).toBeNull();
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
    }

    // Force write failure: make Sessions a file (not a dir) so mkdir+open fail.
    const cwd2 = makeTmpDir();
    try {
      fs.writeFileSync(path.join(cwd2, 'Sessions'), 'I am a file not a dir');
      const err = appendTurnToSessionFile({
        cwd: cwd2, sessionId: 'fail-session', role: 'user', body: 'fail', timestampIso: nowIso(),
      });
      expect(err).toBeInstanceOf(Error);
    } finally {
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });
});

describe('nowIso', () => {
  it('returns an ISO 8601 string with timezone offset (not Z)', () => {
    const ts = nowIso();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(ts.endsWith('Z')).toBe(false);
  });
});
