/**
 * Phase 4.1 CUR-13 regression tests.
 *
 * The pre-fix `existing.indexOf('<!-- USER EDITABLE -->')` matched the marker
 * as substring inside body content (e.g., when User Notes documented the
 * marker for reference). Result: the writer treated body content as user tail,
 * preserved it, then prepended a fresh managed section + new marker — producing
 * duplicate `<!-- USER EDITABLE -->` lines and duplicated `## How to Query`
 * blocks. Visible regression at production CLAUDEXv3 MEMORY.md line 38.
 *
 * The fix: line-anchored matcher `findUserTailStart` returning the byte offset
 * of a marker line that EQUALS the marker (post-CRLF normalize), not just
 * contains it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  findUserTailStart,
  curateMemoryMd,
  computeMemoryMdPath,
} from '../../angel/memory-md-writer.js';

describe('memory-md-writer findUserTailStart (CUR-13)', () => {
  it('returns -1 for content with no marker', () => {
    expect(findUserTailStart('## Some content\nmore content\n')).toBe(-1);
  });

  it('returns the offset of a clean marker line', () => {
    const content = 'header\n<!-- USER EDITABLE -->\ntail\n';
    const offset = findUserTailStart(content);
    expect(offset).toBe(7); // 'header\n'.length === 7
    expect(content.slice(offset)).toBe('<!-- USER EDITABLE -->\ntail\n');
  });

  it('does NOT match the marker when it appears as substring inside body text', () => {
    // The CUR-13 bug case: the literal string `<!-- USER EDITABLE -->` appears
    // inside a User Notes paragraph describing the marker. indexOf would
    // return offset 12; findUserTailStart returns -1.
    const content = 'header\n\nThe `<!-- USER EDITABLE -->` marker is documented here.\n## More\n';
    expect(findUserTailStart(content)).toBe(-1);
  });

  it('matches a clean line even when prior content mentions the marker as substring', () => {
    // Content mentions the marker in body text AND has a real marker line later.
    // We MUST find the real line, not the substring.
    const content = 'mentions <!-- USER EDITABLE --> in prose.\n<!-- USER EDITABLE -->\nuser tail\n';
    const offset = findUserTailStart(content);
    const tail = content.slice(offset);
    expect(tail.startsWith('<!-- USER EDITABLE -->\n')).toBe(true);
    // The substring match would have returned offset 9 → wrong tail.
    expect(offset).toBeGreaterThan(9);
  });

  it('rejects a marker line with trailing whitespace', () => {
    // Strict equality — no leading/trailing whitespace tolerance. A writer
    // producing trailing-space markers is buggy in its own right.
    const content = 'a\n<!-- USER EDITABLE --> \nb\n';
    expect(findUserTailStart(content)).toBe(-1);
  });

  it('handles CRLF input', () => {
    const content = 'a\r\n<!-- USER EDITABLE -->\r\nb\r\n';
    const offset = findUserTailStart(content);
    // After normalization, 'a\n' is offset 0-1; marker starts at 2.
    expect(offset).toBe(2);
  });
});

describe('memory-md-writer curateMemoryMd against literal corrupted fixture (CUR-13)', () => {
  let db: Database.Database;
  let tempDir: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  const project = 'test-marker-bug-proj';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-marker-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    fs.mkdirSync(path.join(tempDir, '.claude', 'projects', project, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces exactly ONE <!-- USER EDITABLE --> marker when fed the corrupted CLAUDEXv3 fixture', () => {
    // Literal corrupted snapshot — copied from the production file at
    // ~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/MEMORY.md.
    // The corruption: line ~15 contains the marker as substring inside a
    // quoted line ("' marker present, ## User Notes below"); a real marker
    // line appears later. Pre-fix indexOf matched the FIRST occurrence
    // (substring), producing a duplicated How to Query block and two
    // marker lines.
    const corruptedBody = [
      '## Active Projects',
      '- some-project — 1 edit',
      '',
      '## Handoff',
      '',
      'No active handoff.',
      '',
      '## How to Query',
      '',
      '- claudex_search("topic") — decisions, learnings, prior sessions',
      '',
      'See ~/.claude/CLAUDE.md for Claudex tool reference.',
      '',
      "<!-- USER EDITABLE -->` marker present, `## User Notes` below",
      'See: context/handoffs/ACTIVE.md',
      '',
      '## How to Query',
      '',
      '- claudex_search("topic") — decisions, learnings, prior sessions',
      '',
      'See ~/.claude/CLAUDE.md for Claudex tool reference.',
      '',
      '<!-- USER EDITABLE -->',
      '',
      '## User Notes',
      '',
    ].join('\n');

    // Build a valid sentinel for the corrupted body so the file passes the
    // sentinel-presence check. The hash itself is irrelevant for this test —
    // we're not exercising hash mismatch detection. Use a synthetic 64-hex
    // value to satisfy the sentinel-line regex.
    const fakeHash = 'a'.repeat(64);
    const corrupted = `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->\n${corruptedBody}`;

    const memoryMdPath = computeMemoryMdPath(project);
    fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
    fs.writeFileSync(memoryMdPath, corrupted, 'utf8');

    const result = curateMemoryMd(db, project);
    // The writer should write a fresh managed section + preserve the user
    // tail starting at the LINE-ANCHORED marker, NOT the substring inside
    // the quoted prose.
    expect(result.written || result.reason === 'idempotent_noop').toBe(true);

    const out = fs.readFileSync(memoryMdPath, 'utf8');

    // CORE ASSERTION: exactly one marker line (line-anchored).
    const markerLineCount = out.split('\n').filter(l => l === '<!-- USER EDITABLE -->').length;
    expect(markerLineCount).toBe(1);

    // The user tail starts at the real (line-anchored) marker. Anything
    // BELOW it in the original is preserved; anything in the duplicated
    // ## How to Query block ABOVE the real marker is replaced by the
    // freshly-rendered managed section.
    const realMarkerIdx = findUserTailStart(out);
    expect(realMarkerIdx).toBeGreaterThanOrEqual(0);
    const userTail = out.slice(realMarkerIdx);
    expect(userTail).toContain('## User Notes');
  });

  it('refuses (sentinel_missing) when a real line-anchored marker exists with no top sentinel', () => {
    // Pre-fix: this scenario was caught correctly because indexOf finds the
    // marker. The fix preserves this refusal path: when a marker line exists
    // but no sentinel on line 1, refuse rather than guess.
    const noSentinel = [
      '## User-authored Notes',
      'no sentinel here',
      '',
      '<!-- USER EDITABLE -->',
      '',
      '## User Notes',
      'real user content',
    ].join('\n');

    const memoryMdPath = computeMemoryMdPath(project);
    fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
    fs.writeFileSync(memoryMdPath, noSentinel, 'utf8');

    const result = curateMemoryMd(db, project);
    expect(result.written).toBe(false);
    expect(result.reason).toBe('sentinel_missing');
  });

  it('idempotent re-write on a fresh file produces idempotent_noop on second call', () => {
    // Fresh file (no existing MEMORY.md): first call writes a default tail;
    // second call sees byte-identical content via the LF-normalized fast-path.
    const result1 = curateMemoryMd(db, project);
    expect(result1.written).toBe(true);

    const result2 = curateMemoryMd(db, project);
    expect(result2.written).toBe(false);
    expect(result2.reason).toBe('idempotent_noop');
  });
});
