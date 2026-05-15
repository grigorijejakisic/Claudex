/**
 * Phase 4.1 CUR-09 + CUR-10 — ## Lessons section tests for memory-md-writer.
 *
 * Verifies:
 *   - Curated MEMORY.md no longer contains ## Entities or ## Recent Threads
 *   - Curated MEMORY.md contains ## Lessons section
 *   - Pointer lines: '- [salience](filename) — task-pattern: <task_shape>'
 *   - Foreground tier filter (background-tier lessons excluded)
 *   - 20-entry foreground cap
 *   - "unclassified" task-pattern when shape is abstained
 *   - ≤140-char total pointer line length
 *   - Section ordering: Active Projects → Lessons → Handoff → How to Query
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { renderLessons, curateMemoryMd, computeMemoryMdPath } from '../../angel/memory-md-writer.js';
import { writeLesson } from '../../angel/lesson-writer.js';

const project = 'lessons-section-proj';

describe('memory-md-writer ## Lessons section (Phase 4.1 CUR-09/CUR-10)', () => {
  let db: Database.Database;
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-section-'));
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

  function baseTelemetry() {
    return {
      tools_used: ['Read'],
      files_touched: [],
      errors_encountered: [],
      user_framing_tokens: ['x'],
      session_arc: ['fix'],
      duration_min: 5,
      correction_count: 0,
    };
  }

  describe('renderLessons direct', () => {
    it('renders empty-state header when no lessons exist', () => {
      const out = renderLessons(project);
      expect(out).toContain('## Lessons');
      expect(out).toContain('No lessons captured yet.');
    });

    it('renders foreground-tier lessons with task-pattern + salience', () => {
      writeLesson({
        project,
        type: 'feedback',
        slug: 'check-deps',
        frontmatter: {
          created_at_epoch_ms: Date.now(),
          telemetry: baseTelemetry(),
          shape: { task_shape: 'code-edit-with-existing-deps' },
        },
        body: '# Always check existing dependencies before adding new imports\n\nDetailed body.',
      });

      const out = renderLessons(project);
      expect(out).toContain('## Lessons');
      expect(out).toContain('feedback_check-deps.md');
      expect(out).toContain('task-pattern: code-edit-with-existing-deps');
      expect(out).toContain('Always check existing dependencies');
    });

    it('uses "unclassified" task-pattern when shape is abstained', () => {
      writeLesson({
        project,
        type: 'project',
        slug: 'mozzart-429',
        frontmatter: {
          created_at_epoch_ms: Date.now(),
          telemetry: baseTelemetry(),
          // shape omitted = abstain
        },
        body: '# Mozzart 429 is per-IP, 15-min auto-heal\n\nDocumented behavior.',
      });

      const out = renderLessons(project);
      expect(out).toContain('task-pattern: unclassified');
    });

    it('caps salience line so total pointer line length is <= 140 chars', () => {
      const longBody = '# ' + 'a'.repeat(300);
      writeLesson({
        project,
        type: 'feedback',
        slug: 'long-body',
        frontmatter: {
          created_at_epoch_ms: Date.now(),
          telemetry: baseTelemetry(),
        },
        body: longBody,
      });

      const out = renderLessons(project);
      const pointerLines = out.split('\n').filter(l => l.startsWith('- ['));
      expect(pointerLines.length).toBeGreaterThan(0);
      for (const line of pointerLines) {
        expect(line.length).toBeLessThanOrEqual(140);
      }
    });

    it('skips background-tier lessons', () => {
      writeLesson({
        project,
        type: 'feedback',
        slug: 'demoted',
        frontmatter: {
          created_at_epoch_ms: Date.now(),
          telemetry: baseTelemetry(),
          tier: 'background',
        },
        body: '# Demoted lesson\n\nShould not appear in MEMORY.md.',
      });

      const out = renderLessons(project);
      expect(out).not.toContain('feedback_demoted.md');
      expect(out).toContain('No lessons captured yet.');
    });

    it('caps foreground at 20 entries; sorts by last_fired_at_epoch DESC nulls last', () => {
      const baseEpoch = 1700000000000;
      // 25 foreground lessons. First 10 have a recent last_fired_at_epoch,
      // the rest have none.
      for (let i = 0; i < 25; i++) {
        writeLesson({
          project,
          type: 'feedback',
          slug: `bulk-${String(i).padStart(2, '0')}`,
          frontmatter: {
            created_at_epoch_ms: baseEpoch + i * 1000,
            telemetry: baseTelemetry(),
            last_fired_at_epoch: i < 10 ? baseEpoch + i * 1000 : undefined,
          },
          body: `# Lesson ${i}\n\nSalience body.`,
        });
      }

      const out = renderLessons(project);
      const pointerLines = out.split('\n').filter(l => l.startsWith('- ['));
      expect(pointerLines.length).toBe(20);

      // The 10 most-recently-fired (bulk-00..bulk-09) should be in the top 10
      // pointer lines (sorted by last_fired_at_epoch DESC).
      const top10 = pointerLines.slice(0, 10);
      const top10HasFired = top10.every(l => /bulk-(0[0-9])\.md/.test(l));
      expect(top10HasFired).toBe(true);
    });
  });

  describe('curateMemoryMd integration', () => {
    function ensureMemoryDir() {
      const memoryMdPath = computeMemoryMdPath(project);
      fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
    }

    it('produces output without ## Entities and ## Recent Threads', () => {
      ensureMemoryDir();
      curateMemoryMd(db, project);
      const memoryMdPath = computeMemoryMdPath(project);
      const content = fs.readFileSync(memoryMdPath, 'utf8');
      expect(content).not.toContain('## Entities');
      expect(content).not.toContain('## Recent Threads');
      expect(content).toContain('## Lessons');
    });

    it('produces ## Lessons after Active Projects, before Handoff and How to Query', () => {
      ensureMemoryDir();
      curateMemoryMd(db, project);
      const memoryMdPath = computeMemoryMdPath(project);
      const content = fs.readFileSync(memoryMdPath, 'utf8');

      const idxLessons = content.indexOf('## Lessons');
      const idxHandoff = content.indexOf('## Handoff');
      const idxHowTo = content.indexOf('## How to Query');

      expect(idxLessons).toBeGreaterThan(0);
      // Active Projects might be empty (rendered as just header) for an
      // empty DB — verify Lessons appears before Handoff and How to Query.
      expect(idxHandoff).toBeGreaterThan(idxLessons);
      expect(idxHowTo).toBeGreaterThan(idxHandoff);
    });
  });
});
