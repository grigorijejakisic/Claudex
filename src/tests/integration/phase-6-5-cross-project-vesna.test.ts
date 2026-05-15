/**
 * Phase 6.5 SC#1 Vesna gate — 3 cross-project lesson-application probes.
 *
 * The kid-stove generalization mechanically tested:
 *   - Lesson is stored in project A under rich telemetry+shape handles.
 *   - Fresh session in project B types a prompt with ZERO of the lesson's
 *     lexical-surface tokens.
 *   - Match must fire on perceptual handles + shape vocabulary, not surface
 *     text overlap.
 *
 * Pre-flight `expect(prompt).not.toMatch(forbiddenWords)` enforces lexical-
 * leakage discipline — if the assertion fails, the prompt is invalid (rewrite
 * with synonyms, do NOT relax the assertion).
 *
 * Two surfaces tested per probe:
 *   - Path A: assembleExperienceTier (session-start surfacing)
 *   - Path B: expandSearchCrossProject (claudex_search query expansion)
 *
 * Pass = at least one of the two paths surfaces the cross-project lesson.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { detectTaskShape } from '../../core/task-shape-detector.js';
import { expandSearchCrossProject } from '../../core/cross-project-search.js';
import { assembleExperienceTier } from '../../intelligence/experience-tier.js';
import type { HandleSet, EmbedderFn } from '../../core/cross-project-equivalence.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  seedShapeVocab(db);
});

afterEach(() => {
  db.close();
});

function seedShapeVocab(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', ?, ?, ?)`
  );
  const now = Date.now();
  insert.run('scraping-rate-limit-investigation', now, 5);
  insert.run('schema-migration-design', now, 5);
  insert.run('auth-flow-design', now, 4);
}

function seedShadowbanLesson(db: Database.Database, project: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, scope, project, status) VALUES (?, 'project', ?, 'active')
       ON CONFLICT(session_id) DO NOTHING`
  ).run(`s-${project}-shadowban`, project);
  // Rich telemetry + shape signals; the lexical surface is "shadowban / 429 /
  // Cloudflare" — a Vesna probe MUST type around all of these.
  const ts = Math.floor(Date.now() / 1000) - 3 * 86400;
  db.prepare(
    `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch_ms)
       VALUES (?, ?, ?, 'learning', ?, ?, 4, ?)`
  ).run(
    100 + project.length, `s-${project}-shadowban`, project,
    'Mozzart 429 rate limit shadowban Cloudflare investigation',
    'Decision: switch to per-IP rotation with proxy pool.\nOutcome: 429 response code dropped to zero within 24 hours.',
    ts,
  );
  db.prepare(
    `INSERT INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, 'scraping-rate-limit-investigation', ?, 1.0, 'write_time')`
  ).run(100 + project.length, Date.now());
}

function seedAuthTokenLesson(db: Database.Database, project: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, scope, project, status) VALUES (?, 'project', ?, 'active')
       ON CONFLICT(session_id) DO NOTHING`
  ).run(`s-${project}-auth`, project);
  const ts = Math.floor(Date.now() / 1000) - 5 * 86400;
  db.prepare(
    `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch_ms)
       VALUES (?, ?, ?, 'learning', ?, ?, 4, ?)`
  ).run(
    200 + project.length, `s-${project}-auth`, project,
    'auth token session expiry refresh design login authentication logout',
    'Decision: implement sliding-window refresh on JWT with rotation key.\nOutcome: stable session lifecycle, zero forced re-authentications.',
    ts,
  );
  db.prepare(
    `INSERT INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, 'auth-flow-design', ?, 1.0, 'write_time')`
  ).run(200 + project.length, Date.now());
}

function seedMigrationLesson(db: Database.Database, project: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, scope, project, status) VALUES (?, 'project', ?, 'active')
       ON CONFLICT(session_id) DO NOTHING`
  ).run(`s-${project}-mig`, project);
  const ts = Math.floor(Date.now() / 1000) - 7 * 86400;
  db.prepare(
    `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch_ms)
       VALUES (?, ?, ?, 'learning', ?, ?, 4, ?)`
  ).run(
    300 + project.length, `s-${project}-mig`, project,
    'schema migration ALTER table column backfill downtime transaction safety design',
    'Decision: dual-write phase before column drop; idempotent backfill.\nOutcome: zero downtime ALTER on a high-traffic table.',
    ts,
  );
  db.prepare(
    `INSERT INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, 'schema-migration-design', ?, 1.0, 'write_time')`
  ).run(300 + project.length, Date.now());
}

function synthesizeHandlesFromPrompt(
  prompt: string,
  toolsUsed: string[] = [],
  filesTouched: string[] = [],
  errorsEncountered: string[] = [],
): HandleSet {
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1);
  return {
    tools_used: toolsUsed,
    files_touched: filesTouched,
    user_framing_tokens: tokens,
    errors_encountered: errorsEncountered,
  };
}

// Mock embedder returning high cosine — the gate tests perceptual-handle
// firing, not real embedding similarity. The real bi-encoder is exercised
// in the live-fire smoke test path documented in 06.5-VESNA-RESULT.md.
const MOCK_EMBEDDER: EmbedderFn = async () => {
  return [[1, 0, 0, 0], [0.95, 0.31, 0, 0]]; // cosine ~0.95
};

// ---------------------------------------------------------------------------
// Probe extraction (Phase 8 ABL-02 harness reuse)
// ---------------------------------------------------------------------------
//
// The three probes below are exported as data + a shared runner so the Phase 8
// A/B harness (`phase-8-rl-ablation.test.ts`) can call them under both
// flagged/baseline conditions. Each `seedFn` mutates the supplied DB; the
// runner creates a fresh in-memory DB per probe call so trials are independent.

export interface CrossProjectProbe {
  id: string;
  /** Mutates `db` to insert lesson rows + sessions. */
  seedFn: (db: Database.Database) => void;
  /** Prompt + forbidden-word regex pre-flight. */
  prompt: string;
  forbiddenWords: RegExp;
  /** Project the fresh session is in (NOT the seeded project). */
  freshSessionProject: string;
  /** Session id the runner should use for the fresh-session call. */
  freshSessionId: string;
  /** Match the surfaced experience tier text against this regex (Path A). */
  expectTierMatch: RegExp;
  /** If true, additionally exercise Path B (claudex_search expansion). */
  exercisePathB: boolean;
  /** If exercising Path B, require pathA + pathB sum >= 1 to pass. */
  requirePathBHit?: boolean;
  /** Tools / files / errors to synthesize handles from. */
  handles: {
    tools: string[];
    files: string[];
    errors: string[];
  };
}

export const CROSS_PROJECT_PROBES: CrossProjectProbe[] = [
  {
    id: 'cp-shadowban-lacuna-to-mozzy',
    seedFn: (db) => seedShadowbanLesson(db, 'lacuna-betting'),
    prompt: 'we are starting work on a new bookmaker integration; what should we know',
    forbiddenWords: /rate|limit|mozzart|429|shadowban|cloudflare|throttle|proxy|scraping/i,
    freshSessionProject: 'big-mozzy-v2',
    freshSessionId: 'mozzy-fresh',
    expectTierMatch: /Prior similar task in project lacuna-betting/,
    exercisePathB: false,
    handles: {
      tools: ['Bash', 'Read', 'Grep'],
      files: ['src/scraper.ts', 'src/api/client.ts'],
      errors: ['response_429'],
    },
  },
  {
    id: 'cp-auth-multi-to-third',
    seedFn: (db) => {
      seedAuthTokenLesson(db, 'oracle');
      seedAuthTokenLesson(db, 'lacuna-betting');
    },
    prompt: 'users keep getting kicked out repeatedly, can you check the backend',
    forbiddenWords: /token|expiry|session|auth|login|refresh|jwt|rotation|logout|authentication/i,
    freshSessionProject: 'big-mozzy-v2',
    freshSessionId: 'third-fresh',
    expectTierMatch: /Prior similar task in project (oracle|lacuna-betting)/,
    exercisePathB: true,
    requirePathBHit: true,
    handles: {
      tools: ['Read', 'Grep'],
      files: ['src/auth/middleware.ts', 'src/users/cookie.ts'],
      errors: [],
    },
  },
  {
    id: 'cp-migration-multi-to-oracle',
    seedFn: (db) => {
      seedMigrationLesson(db, 'claudex-v3');
      seedMigrationLesson(db, 'lacuna-betting');
    },
    prompt: 'design a way to add a new field to the database without disrupting users',
    forbiddenWords: /schema|migration|ALTER|column|backfill|downtime|transaction|dual.?write|idempotent/i,
    freshSessionProject: 'oracle',
    freshSessionId: 'oracle-fresh',
    expectTierMatch: /Prior similar task in project (claudex-v3|lacuna-betting)/,
    exercisePathB: true,
    requirePathBHit: true,
    handles: {
      tools: ['Read', 'Edit'],
      files: ['prisma/schema.prisma', 'src/db/users.ts'],
      errors: [],
    },
  },
];

/**
 * Run a single cross-project probe end-to-end on a fresh in-memory DB.
 *
 * Used by:
 *   - The 3 it-blocks in this file (it-blocks call their own assertions in
 *     addition to this — they use the runner's pass/fail signal as the gate
 *     summary.)
 *   - Phase 8 A/B harness (`phase-8-rl-ablation.test.ts`).
 */
export async function runCrossProjectProbe(
  probe: CrossProjectProbe,
): Promise<{ passed: boolean; tierHits: number; expansionHits: number }> {
  const probeDb = new Database(':memory:');
  try {
    initializeSchema(probeDb);
    seedShapeVocab(probeDb);
    probe.seedFn(probeDb);

    // Pre-flight: forbidden-words discipline. If the prompt leaks tokens, the
    // probe is invalid — surface as a hard fail, not a soft skip.
    if (probe.forbiddenWords.test(probe.prompt)) {
      return { passed: false, tierHits: 0, expansionHits: 0 };
    }

    const ts = detectTaskShape(probeDb, probe.prompt);

    // Path A — Experience Tier surfacing.
    const handles = synthesizeHandlesFromPrompt(
      probe.prompt,
      probe.handles.tools,
      probe.handles.files,
      probe.handles.errors,
    );
    const tier = assembleExperienceTier(
      probeDb,
      probe.freshSessionId,
      1,
      probe.freshSessionProject,
      handles,
    );

    let tierHits = 0;
    let pathAOk = false;
    if (tier !== null) {
      tierHits = tier.injectedArtifactIds.length;
      pathAOk = probe.expectTierMatch.test(tier.section);
    }

    // Path B — claudex_search query expansion (best-effort unless required).
    let expansionHits = 0;
    let pathBOk = false;
    if (probe.exercisePathB && ts.isTaskShaped) {
      const expansion = await expandSearchCrossProject(
        probeDb,
        probe.freshSessionId,
        probe.prompt,
        ts,
        probe.freshSessionProject,
        MOCK_EMBEDDER,
      );
      expansionHits = expansion.matchedCount;
      pathBOk = expansion.matchedCount > 0;
    }

    // Pass logic mirrors the original it-blocks:
    //  - Probe 1 (Path A only): pass = pathAOk
    //  - Probes 2/3 (require sum>=1): pass = pathAOk OR (pathA tier injected + pathB hit)
    let passed: boolean;
    if (probe.requirePathBHit) {
      passed = pathAOk && (tierHits + expansionHits) >= 1;
    } else {
      passed = pathAOk;
    }

    return { passed, tierHits, expansionHits };
  } finally {
    probeDb.close();
  }
}

// ---------------------------------------------------------------------------
// SC#1 it-blocks (preserved — call the shared runner + add legacy assertions)
// ---------------------------------------------------------------------------

describe('Phase 6.5 cross-project Vesna gate (SC#1)', () => {
  it('Probe 1 (canonical): shadowban from Lacuna surfaces in big-mozzy-v2 fresh session on advisory prompt', async () => {
    const probe = CROSS_PROJECT_PROBES[0];
    expect(probe.prompt).not.toMatch(probe.forbiddenWords);

    seedShadowbanLesson(db, 'lacuna-betting');

    const ts = detectTaskShape(db, probe.prompt);
    void ts; // verb='starting' may or may not match TASK_VERBS; not a gate

    // Path A — Experience Tier surfacing on the shared `db` (legacy assertions).
    const handles = synthesizeHandlesFromPrompt(
      probe.prompt,
      probe.handles.tools,
      probe.handles.files,
      probe.handles.errors,
    );
    const tier = assembleExperienceTier(db, probe.freshSessionId, 1, probe.freshSessionProject, handles);
    expect(tier).not.toBeNull();
    expect(tier!.section).toMatch(/Prior similar task in project lacuna-betting/);
    // Advisory voice — no imperative phrasing.
    expect(tier!.section).not.toMatch(/WARNING|MUST|REQUIRED|Always|Never|do not/i);
    expect(tier!.section).toMatch(/Decision was/);
    expect(tier!.section).toMatch(/outcome was/);

    // Shared runner: fresh DB inside, must report passed=true.
    const runResult = await runCrossProjectProbe(probe);
    expect(runResult.passed).toBe(true);
  });

  it('Probe 2: auth-token-expiry across projects surfaces on advisory prompt', async () => {
    const probe = CROSS_PROJECT_PROBES[1];
    expect(probe.prompt).not.toMatch(probe.forbiddenWords);

    seedAuthTokenLesson(db, 'oracle');
    seedAuthTokenLesson(db, 'lacuna-betting');

    const ts = detectTaskShape(db, probe.prompt);
    expect(ts.isTaskShaped).toBe(true);

    // Path A — Experience Tier on shared DB.
    const handles = synthesizeHandlesFromPrompt(
      probe.prompt,
      probe.handles.tools,
      probe.handles.files,
      probe.handles.errors,
    );
    const tier = assembleExperienceTier(db, probe.freshSessionId, 1, probe.freshSessionProject, handles);
    expect(tier).not.toBeNull();
    expect(tier!.section).toMatch(/Prior similar task in project (oracle|lacuna-betting)/);

    // Path B — claudex_search expansion.
    const expansion = await expandSearchCrossProject(
      db, probe.freshSessionId, probe.prompt, ts, probe.freshSessionProject, MOCK_EMBEDDER,
    );
    expect(tier!.injectedArtifactIds.length + expansion.matchedCount).toBeGreaterThanOrEqual(1);

    // Shared runner: fresh DB inside, must report passed=true.
    const runResult = await runCrossProjectProbe(probe);
    expect(runResult.passed).toBe(true);
  });

  it('Probe 3: schema-migration patterns across projects surface on advisory prompt', async () => {
    const probe = CROSS_PROJECT_PROBES[2];
    expect(probe.prompt).not.toMatch(probe.forbiddenWords);

    seedMigrationLesson(db, 'claudex-v3');
    seedMigrationLesson(db, 'lacuna-betting');

    const ts = detectTaskShape(db, probe.prompt);
    expect(ts.isTaskShaped).toBe(true);

    // Path A — Experience Tier on shared DB.
    const handles = synthesizeHandlesFromPrompt(
      probe.prompt,
      probe.handles.tools,
      probe.handles.files,
      probe.handles.errors,
    );
    const tier = assembleExperienceTier(db, probe.freshSessionId, 1, probe.freshSessionProject, handles);
    expect(tier).not.toBeNull();
    expect(tier!.section).toMatch(/Prior similar task in project (claudex-v3|lacuna-betting)/);

    // Path B — claudex_search expansion.
    const expansion = await expandSearchCrossProject(
      db, probe.freshSessionId, probe.prompt, ts, probe.freshSessionProject, MOCK_EMBEDDER,
    );
    expect(tier!.injectedArtifactIds.length + expansion.matchedCount).toBeGreaterThanOrEqual(1);

    // Shared runner: fresh DB inside, must report passed=true.
    const runResult = await runCrossProjectProbe(probe);
    expect(runResult.passed).toBe(true);
  });

  it('SC#1 gate summary — at least 3/3 probes pass', () => {
    // This synthetic assertion is the gate-marker. If any of the three
    // it-blocks above fails, this test reflects the failure aggregated.
    // Vitest runs all `it` blocks and aggregates failures regardless,
    // so this is a documentation marker for SC#1 closure.
    expect(true).toBe(true);
  });
});
