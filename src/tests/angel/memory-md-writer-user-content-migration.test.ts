/**
 * Phase 4.1 CUR-12 user-content migration tests.
 *
 * First-run migration path: project has hand-curated MEMORY.md (Lacuna,
 * Oracle, Nexus pattern) without Angel sentinel. Migration wraps content
 * under ## User Notes verbatim under a fresh marker, then prepends the
 * managed section.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  curateMemoryMd,
  findUserTailStart,
  wrapLegacyUserContent,
  computeMemoryMdPath,
} from '../../angel/memory-md-writer.js';

function loadFixture(name: string): string {
  const fixturePath = path.join(__dirname, '..', 'fixtures', `${name}-memory-md.txt`);
  const raw = fs.readFileSync(fixturePath, 'utf8');
  // Strip leading `# Source:` / `# Sanitization:` / `# This file is...`
  // headers used by Plan 06 Task 1 fixture format.
  const lines = raw.split('\n');
  let cutoff = 0;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].startsWith('# Source:')
      || lines[i].startsWith('# Sanitization:')
      || lines[i].startsWith('# This file is')
    ) {
      cutoff = i + 1;
    } else if (lines[i].trim().length > 0) {
      break;
    }
  }
  return lines.slice(cutoff).join('\n');
}

describe('memory-md-writer first-run migration (CUR-12)', () => {
  let db: Database.Database;
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migrate-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('wrapLegacyUserContent', () => {
    it('returns null for empty / whitespace-only content', () => {
      expect(wrapLegacyUserContent('')).toBeNull();
      expect(wrapLegacyUserContent('   \n\n\t\n')).toBeNull();
    });

    it('wraps non-empty content under ## User Notes with a marker', () => {
      const wrapped = wrapLegacyUserContent('# My notes\n\n- item 1\n- item 2\n');
      expect(wrapped).not.toBeNull();
      expect(wrapped!).toContain('<!-- USER EDITABLE -->');
      expect(wrapped!).toContain('## User Notes');
      expect(wrapped!).toContain('# My notes');
      expect(wrapped!).toContain('- item 1');
      expect(wrapped!).toContain('- item 2');
    });

    it('does not double-wrap if existing content already has ## User Notes header', () => {
      const wrapped = wrapLegacyUserContent('## User Notes\n\nmy notes\n');
      expect(wrapped).not.toBeNull();
      const occurrences = (wrapped!.match(/## User Notes/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('curateMemoryMd against fixtures', () => {
    function setupProject(name: string, fixtureContent: string): { project: string; memoryMdPath: string } {
      const project = `migrate-${name}`;
      const memoryMdPath = computeMemoryMdPath(project);
      fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
      fs.writeFileSync(memoryMdPath, fixtureContent, 'utf8');
      return { project, memoryMdPath };
    }

    it.each(['lacuna', 'oracle', 'nexus'])(
      'preserves %s fixture content under ## User Notes (every fixture line appears in output)',
      (name) => {
        const fixture = loadFixture(name);
        const { project, memoryMdPath } = setupProject(name, fixture);

        const result = curateMemoryMd(db, project);
        expect(result.written).toBe(true);

        const out = fs.readFileSync(memoryMdPath, 'utf8');

        // Top sentinel exists
        expect(out).toMatch(/^<!-- CLAUDEX-MANAGED:/);
        // Marker exists on its own line
        expect(findUserTailStart(out)).toBeGreaterThanOrEqual(0);
        // ## User Notes header below marker
        const markerIdx = findUserTailStart(out);
        const userTail = out.slice(markerIdx);
        expect(userTail).toContain('## User Notes');
        // Every non-blank fixture line is present somewhere in the output
        const fixtureLines = fixture.split('\n').filter(l => l.trim().length > 0);
        for (const line of fixtureLines) {
          expect(out).toContain(line);
        }
      },
    );

    it('idempotent: re-running curateMemoryMd on a migrated file is a no-op', () => {
      const fixture = loadFixture('lacuna');
      const { project, memoryMdPath } = setupProject('idempotent-lacuna', fixture);

      const result1 = curateMemoryMd(db, project);
      expect(result1.written).toBe(true);
      const after1 = fs.readFileSync(memoryMdPath, 'utf8');

      const result2 = curateMemoryMd(db, project);
      expect(result2.reason).toBe('idempotent_noop');
      const after2 = fs.readFileSync(memoryMdPath, 'utf8');

      expect(after2).toBe(after1);
    });

    it('refuses (sentinel_invalid) when top sentinel exists but marker does not', () => {
      const project = 'corrupt-no-marker';
      const memoryMdPath = computeMemoryMdPath(project);
      fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
      const corrupt = '<!-- CLAUDEX-MANAGED: do not edit above user section. hash='
        + 'a'.repeat(64) + ' -->\n## Some content\n';
      fs.writeFileSync(memoryMdPath, corrupt, 'utf8');

      const result = curateMemoryMd(db, project);
      expect(result.written).toBe(false);
      expect(result.reason).toBe('sentinel_invalid');
    });

    it('handles empty file (cold-start) without invoking migration branch', () => {
      const project = 'cold-start';
      const memoryMdPath = computeMemoryMdPath(project);
      fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
      fs.writeFileSync(memoryMdPath, '', 'utf8');

      const result = curateMemoryMd(db, project);
      expect(result.written).toBe(true);

      const out = fs.readFileSync(memoryMdPath, 'utf8');
      // Default user tail (USER_TAIL_DEFAULT) used; no wrapped legacy content.
      expect(out).toContain('<!-- USER EDITABLE -->\n\n## User Notes\n');
    });
  });
});
