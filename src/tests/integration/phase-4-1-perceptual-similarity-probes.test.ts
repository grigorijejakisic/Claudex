/**
 * Phase 4.1 substrate-validation probe set.
 *
 * Per CONTEXT.md "Author the 6.5 perceptual-similarity probe set (the
 * canonical shadowban example and N variants) as part of substrate work;
 * run as unit tests on the substrate: do telemetry+shape handles encode
 * such that 6.5's matcher *would* find the right lesson?"
 *
 * **These probes test substrate adequacy. The actual recall benchmark
 * (≥80% probe-set surfaces correct lesson) is Phase 6.5's gate. This
 * file is checked in as the canonical probe set for Phase 6.5 to consume.**
 *
 * Substrate adequacy claim: variants of the same underlying experience
 * (different surface phrasing, different files-touched, different tools)
 * MUST share enough handles that a perceptual matcher would group them.
 *
 * The probes assert (without invoking a real matcher):
 *   - Jaccard overlap on user_framing_tokens ≥ 0.4
 *   - At least one shared session_arc segment
 *   - Shape handles either match across variants OR are abstained on both
 *     sides (mixed-non-null is the failure case)
 *   - Duration variation does not break framing-token adequacy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeLesson } from '../../angel/lesson-writer.js';
import { listLessonsForProject } from '../../angel/lesson-reader.js';

const project = 'probe-set-shadowban';

function jaccard(a: string[], b: string[]): number {
  const sA = new Set(a);
  const sB = new Set(b);
  const intersection = new Set([...sA].filter(t => sB.has(t)));
  const union = new Set([...sA, ...sB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

const CANONICAL = {
  type: 'project' as const,
  slug: 'backendx-shadowban',
  frontmatter: {
    created_at_epoch: Date.now(),
    telemetry: {
      tools_used: ['Bash', 'Read'],
      files_touched: ['src/scraper.ts'],
      errors_encountered: ['429-rate-limit'],
      user_framing_tokens: ['shadowban', 'rate-limit', 'polls', 'window', '15min', 'IP', 'ban'],
      session_arc: ['investigation', 'rate-limit-discovery'],
      duration_min: 25,
      correction_count: 0,
    },
    shape: {
      task_shape: 'scraping-rate-limit-investigation',
      failure_mode: 'silent-rate-limit',
    },
  },
  body: '# 60-poll shadowban — backend X\n\n60 polls per 60-min window triggers 15-min IP ban. Backoff to 30 polls/window prevents.',
};

describe('Phase 4.1 substrate-validation probe set (Phase 6.5 hand-off)', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-4-1-probes-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('canonical + 5 variants share ≥0.4 Jaccard on user_framing_tokens', () => {
    writeLesson({ project, ...CANONICAL });

    // Variant 1: terser body, identical handles
    writeLesson({
      project,
      type: 'project',
      slug: 'shadowban-terse',
      frontmatter: { ...CANONICAL.frontmatter, created_at_epoch: Date.now() + 1 },
      body: '# Backend X bans at 60 polls\n\n15-min IP ban triggered.',
    });

    // Variant 2: different files touched, same framing tokens
    writeLesson({
      project,
      type: 'project',
      slug: 'shadowban-diff-file',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 2,
        telemetry: { ...CANONICAL.frontmatter.telemetry, files_touched: ['src/poller.ts'] },
      },
      body: '# Same shadowban — different file path\n\nSame symptoms.',
    });

    // Variant 3: subset of framing tokens (still ≥0.4 overlap)
    writeLesson({
      project,
      type: 'project',
      slug: 'shadowban-subset',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 3,
        telemetry: {
          ...CANONICAL.frontmatter.telemetry,
          user_framing_tokens: ['shadowban', 'rate-limit', 'polls', '15min'],
        },
      },
      body: '# Subset variant\n\nFewer terms.',
    });

    // Variant 4: shape abstained
    writeLesson({
      project,
      type: 'project',
      slug: 'shadowban-abstain',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 4,
        shape: undefined,
      },
      body: '# Shape-abstained variant\n\nSame substrate.',
    });

    // Variant 5: same telemetry, different sess_id (no semantic difference)
    writeLesson({
      project,
      type: 'project',
      slug: 'shadowban-other-sess',
      frontmatter: { ...CANONICAL.frontmatter, created_at_epoch: Date.now() + 5 },
      body: '# Other-session variant\n\nIdentical substrate.',
    });

    const lessons = listLessonsForProject(project);
    expect(lessons.length).toBe(6);

    const canonLesson = lessons.find(l => l.filename === 'project_backendx-shadowban.md')!;
    const canonTokens = canonLesson.frontmatter.telemetry.user_framing_tokens;

    for (const variant of lessons.filter(l => l.filename !== canonLesson.filename)) {
      const varTokens = variant.frontmatter.telemetry.user_framing_tokens;
      const overlap = jaccard(canonTokens, varTokens);
      expect(overlap).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('variants share at least one session_arc segment with canonical', () => {
    writeLesson({ project, ...CANONICAL });
    writeLesson({
      project,
      type: 'project',
      slug: 'arc-shared',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 1,
        telemetry: {
          ...CANONICAL.frontmatter.telemetry,
          session_arc: ['investigation', 'follow-up'], // shares 'investigation' with canonical
        },
      },
      body: '# Variant\n\nbody',
    });

    const lessons = listLessonsForProject(project);
    const canonical = lessons.find(l => l.filename === 'project_backendx-shadowban.md')!;
    const variant = lessons.find(l => l.filename === 'project_arc-shared.md')!;
    const canonArc = new Set(canonical.frontmatter.telemetry.session_arc);
    const overlap = variant.frontmatter.telemetry.session_arc.some(s => canonArc.has(s));
    expect(overlap).toBe(true);
  });

  it('shape handles match across variants OR are abstained on either side', () => {
    writeLesson({ project, ...CANONICAL });
    // Variant with same shape
    writeLesson({
      project,
      type: 'project',
      slug: 'shape-match',
      frontmatter: { ...CANONICAL.frontmatter, created_at_epoch: Date.now() + 1 },
      body: '# Same shape\n\nbody',
    });
    // Variant with abstained shape
    writeLesson({
      project,
      type: 'project',
      slug: 'shape-abstain',
      frontmatter: { ...CANONICAL.frontmatter, created_at_epoch: Date.now() + 2, shape: undefined },
      body: '# Abstained\n\nbody',
    });

    const lessons = listLessonsForProject(project);
    const canonical = lessons.find(l => l.filename === 'project_backendx-shadowban.md')!;
    const canonShape = canonical.frontmatter.shape?.task_shape;

    for (const variant of lessons.filter(l => l.filename !== canonical.filename)) {
      const varShape = variant.frontmatter.shape?.task_shape;
      // Either both match, OR variant abstained, OR canonical abstained — all pass.
      // Mixed non-null shapes that disagree would be the failure case.
      const ok = varShape == null || canonShape == null || varShape === canonShape;
      expect(ok).toBe(true);
    }
  });

  it('varying duration_min does not break framing-token adequacy', () => {
    writeLesson({ project, ...CANONICAL });
    writeLesson({
      project,
      type: 'project',
      slug: 'duration-low',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 1,
        telemetry: { ...CANONICAL.frontmatter.telemetry, duration_min: 5 },
      },
      body: '# Short\n\nbody',
    });
    writeLesson({
      project,
      type: 'project',
      slug: 'duration-high',
      frontmatter: {
        ...CANONICAL.frontmatter,
        created_at_epoch: Date.now() + 2,
        telemetry: { ...CANONICAL.frontmatter.telemetry, duration_min: 120 },
      },
      body: '# Long\n\nbody',
    });

    const lessons = listLessonsForProject(project);
    const canon = lessons.find(l => l.filename === 'project_backendx-shadowban.md')!;
    for (const variant of lessons.filter(l => l.filename !== canon.filename)) {
      const overlap = jaccard(
        canon.frontmatter.telemetry.user_framing_tokens,
        variant.frontmatter.telemetry.user_framing_tokens,
      );
      expect(overlap).toBeGreaterThanOrEqual(0.4);
    }
  });
});
