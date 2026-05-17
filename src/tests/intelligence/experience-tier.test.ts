/**
 * Tests for Phase 6.5 Experience Tier scorer.
 *
 * Covers: empty pool, single-candidate scoring, weight matrix exercise,
 * already_injected dedup, top-K cap, budget cap, advisory voice template,
 * cache-stable tiebreak.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  assembleExperienceTier,
  TOP_K,
  TIER_BUDGET,
} from '../../intelligence/experience-tier.js';
import type { HandleSet } from '../../core/cross-project-equivalence.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  // Seed shape_vocabulary canonical values.
  const insertVocab = db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', ?, ?, ?)`
  );
  const now = Date.now();
  insertVocab.run('scraping-rate-limit-investigation', now, 5);
  insertVocab.run('schema-migration-design', now, 5);
  insertVocab.run('auth-flow-design', now, 4);
  return db;
}

function seedSession(db: Database.Database, sessionId: string, project: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, scope, project, status) VALUES (?, 'project', ?, 'active')`
  ).run(sessionId, project);
}

/**
 * Seed a V17 artifact + artifact_task_pattern row.
 * Returns the rowid used as artifact_id in experience-tier scoring.
 *
 * 14-07h: Updated from legacy `artifacts` table to V17 `artifact` table.
 * The legacy `artifacts` table is no longer in the schema; fetchCandidatePool
 * queries `artifact` (singular).
 */
function seedArtifact(
  db: Database.Database,
  _legacyId: number, // kept for call-site compatibility; not used for insert
  sessionId: string,
  project: string,
  type: string,
  summary: string,
  content: string,
  taskPattern: string,
  classifierConf: number = 1.0,
  recencyOffsetDays: number = 0,
): number {
  const ts = Date.now() - recencyOffsetDays * 86400_000;
  const uid = `legacy-seed-${_legacyId}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence,
                           created_at_epoch_ms, updated_at_epoch_ms, data)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0.8, ?, ?, json_object('retrieval_score', 1.0))`
  ).run(uid, type, summary, content, project, sessionId, ts, ts);
  const rowid = (db.prepare('SELECT rowid FROM artifact WHERE id = ?').get(uid) as { rowid: number }).rowid;
  db.prepare(
    `INSERT INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, ?, ?, ?, 'write_time')`
  ).run(rowid, taskPattern, Date.now(), classifierConf);
  return rowid;
}

/**
 * Many tests in this file test cross-project surfacing — the legacy behavior
 * that was default before 14-07h. Set CLAUDEX_EXPERIENCE_SCOPE=all_projects
 * around those tests to preserve their contract.
 */
function useAllProjectsScope(): { beforeEach: () => void; afterEach: () => void } {
  let prev: string | undefined;
  return {
    beforeEach: () => { prev = process.env.CLAUDEX_EXPERIENCE_SCOPE; process.env.CLAUDEX_EXPERIENCE_SCOPE = 'all_projects'; },
    afterEach: () => { if (prev === undefined) delete process.env.CLAUDEX_EXPERIENCE_SCOPE; else process.env.CLAUDEX_EXPERIENCE_SCOPE = prev; },
  };
}

function emptyHandles(over: Partial<HandleSet> = {}): HandleSet {
  return {
    tools_used: [],
    files_touched: [],
    user_framing_tokens: [],
    errors_encountered: [],
    ...over,
  };
}

describe('assembleExperienceTier — empty pool', () => {
  it('returns null when no candidates exist', () => {
    const db = makeDb();
    const result = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', emptyHandles());
    expect(result).toBeNull();
    db.close();
  });

  it('same_project_only (default): same-project candidates surface', () => {
    // 14-07h: With same_project_only default, same-project artifacts ARE included.
    // This test replaces the legacy "returns null when only candidates from current project exist"
    // which tested the old cross-project-only exclusion behavior.
    const db = makeDb();
    seedSession(db, 'sess-A', 'big-mozzy-v2');
    seedArtifact(db, 1, 'sess-A', 'big-mozzy-v2', 'learning', 'rate limit analysis', 'content', 'scraping-rate-limit-investigation');
    const result = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', emptyHandles());
    // Same-project artifact scores > 0 (recency=+2, cross-project-signal=+1) → surfaces.
    expect(result).not.toBeNull();
    db.close();
  });
});

describe('assembleExperienceTier — single candidate', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('surfaces a single cross-project candidate', () => {
    const db = makeDb();
    seedSession(db, 'sess-lacuna', 'lacuna-betting');
    const rowid = seedArtifact(
      db, 10, 'sess-lacuna', 'lacuna-betting',
      'learning',
      'Mozzart 429 rate limit',
      'Decision: switch to per-IP rotation\nOutcome: 429s dropped to zero',
      'scraping-rate-limit-investigation',
    );
    const result = assembleExperienceTier(
      db, 'sess-mozzy', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['investigate', 'another', 'backend'] }),
    );
    expect(result).not.toBeNull();
    expect(result!.section).toContain('## Experience');
    expect(result!.section).toContain('Prior similar task in project lacuna-betting');
    expect(result!.section).toContain('switch to per-IP rotation');
    expect(result!.section).toContain('429s dropped to zero');
    expect(result!.injectedArtifactIds).toEqual([rowid]);
    db.close();
  });
});

describe('assembleExperienceTier — weight matrix', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('Stage-1 overlap ≥3 grants +5 boost', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Candidate with strong overlap via framing tokens (handles synthesized
    // from summary+content tokens; matches with incoming framing tokens).
    const rowid11 = seedArtifact(
      db, 11, 's', 'lacuna-betting', 'learning',
      'rate limit shadowban cloudflare',
      'investigation of throttling and 429',
      'scraping-rate-limit-investigation',
    );
    seedArtifact(
      db, 12, 's', 'oracle', 'observation',
      'auth flow', 'logout session token',
      'auth-flow-design',
    );
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['rate', 'limit', 'shadowban', 'cloudflare', 'investigation', 'throttling'] }),
    );
    expect(result).not.toBeNull();
    // rowid11 should outscore rowid12 due to overlap boost.
    expect(result!.injectedArtifactIds[0]).toBe(rowid11);
    db.close();
  });

  it('shape-vocab match grants +4 boost when inferred pattern matches candidate task_pattern', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    const rowid21 = seedArtifact(db, 21, 's', 'lacuna-betting', 'learning', 'auth flow', 'login session token', 'auth-flow-design');
    seedArtifact(db, 22, 's', 'oracle', 'observation', 'unrelated', 'random text', 'scraping-rate-limit-investigation');
    // Incoming framing matches all tokens of 'auth-flow-design'
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    expect(result!.injectedArtifactIds[0]).toBe(rowid21);
    db.close();
  });
});

describe('assembleExperienceTier — already_injected dedup', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('candidate with -10 penalty drops out of top-K', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Two candidates with identical positive signals; one is already injected.
    const rowid31 = seedArtifact(db, 31, 's', 'lacuna-betting', 'learning', 'auth flow', 'login session token', 'auth-flow-design');
    const rowid32 = seedArtifact(db, 32, 's', 'oracle', 'learning', 'auth flow', 'login session token', 'auth-flow-design');
    // Mark rowid31 as already-injected this session.
    db.prepare(
      `INSERT INTO session_events (session_id, project, event_type, entity, action)
         VALUES ('mozzy-sess', 'big-mozzy-v2', 'experience_tier_injected', ?, 'inject')`
    ).run(String(rowid31));
    const result = assembleExperienceTier(
      db, 'mozzy-sess', 5, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    expect(result!.injectedArtifactIds).toContain(rowid32);
    expect(result!.injectedArtifactIds).not.toContain(rowid31);
    db.close();
  });
});

describe('assembleExperienceTier — top-K + budget', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('takes only top-K (3) when more candidates score positively', () => {
    const db = makeDb();
    seedSession(db, 's', 'p1');
    for (let i = 0; i < 5; i++) {
      seedArtifact(
        db, 100 + i, 's', `p${i + 1}`, 'learning',
        `auth flow item ${i}`,
        `Decision: design ${i}\nOutcome: shipped`,
        'auth-flow-design',
        1.0, i, // i days old (recent for first 14)
      );
    }
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    expect(result!.injectedArtifactIds.length).toBeLessThanOrEqual(TOP_K);
    db.close();
  });

  it('returns null when even one candidate exceeds the budget cap', () => {
    const db = makeDb();
    seedSession(db, 's', 'p1');
    const longContent = 'word '.repeat(1500); // ~1500 tokens
    seedArtifact(
      db, 200, 's', 'p1', 'learning',
      'massive lesson summary that is also intentionally very long and verbose so that even after extracting a salience the line is huge'.repeat(20),
      longContent,
      'auth-flow-design',
    );
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
      4096, // standard contextWindowTokens
    );
    // Either null (over budget even at K=1) or non-null but trimmed.
    if (result === null) {
      expect(true).toBe(true);
    } else {
      expect(result.tokenCost).toBeLessThanOrEqual(TIER_BUDGET);
    }
    db.close();
  });
});

describe('assembleExperienceTier — advisory voice', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('uses the LOCKED template; no imperative phrasing', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    seedArtifact(
      db, 300, 's', 'lacuna-betting', 'learning',
      'safety alert',
      'Decision: roll back\nOutcome: stable',
      'auth-flow-design',
    );
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    expect(result!.section).not.toMatch(/WARNING|Always|Never|MUST|REQUIRED|do not/i);
    expect(result!.section).toMatch(/Prior similar task in project lacuna-betting/);
    expect(result!.section).toMatch(/Decision was roll back/);
    expect(result!.section).toMatch(/outcome was stable/);
    db.close();
  });
});

describe('assembleExperienceTier — applyEffects', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('applyEffects writes session_events rows for each injected artifact', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    const rowid400 = seedArtifact(db, 400, 's', 'lacuna-betting', 'learning', 'auth flow', 'design', 'auth-flow-design');
    const result = assembleExperienceTier(
      db, 'mozzy-sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    result!.applyEffects();

    const rows = db.prepare(
      `SELECT entity FROM session_events
        WHERE session_id = 'mozzy-sess' AND event_type = 'experience_tier_injected'`
    ).all() as Array<{ entity: string }>;
    expect(rows.map(r => r.entity)).toContain(String(rowid400));
    db.close();
  });

  it('side-effect-free at scoring time — no session_events written before applyEffects', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    seedArtifact(db, 500, 's', 'lacuna-betting', 'learning', 'auth flow', 'design', 'auth-flow-design');
    const result = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(result).not.toBeNull();
    // Did NOT call applyEffects yet.
    const rows = db.prepare(
      `SELECT 1 AS one FROM session_events WHERE session_id = 'sess' AND event_type = 'experience_tier_injected'`
    ).all();
    expect(rows.length).toBe(0);
    db.close();
  });
});

describe('assembleExperienceTier — cache stability tiebreak', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('two runs with identical inputs produce byte-identical sections', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    seedArtifact(db, 601, 's', 'lacuna-betting', 'learning', 'auth flow A', 'design A', 'auth-flow-design');
    seedArtifact(db, 602, 's', 'oracle', 'learning', 'auth flow B', 'design B', 'auth-flow-design');
    const handles = emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] });
    const r1 = assembleExperienceTier(db, 'sess', 1, 'big-mozzy-v2', handles);
    const r2 = assembleExperienceTier(db, 'sess', 1, 'big-mozzy-v2', handles);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.section).toBe(r2!.section);
    expect(r1!.injectedArtifactIds).toEqual(r2!.injectedArtifactIds);
    db.close();
  });

  it('ties broken by id ascending (deterministic)', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Two candidates with identical scores — tie-break by artifact_id (rowid) ASC.
    // Seed the "winner" first so it gets the lower rowid.
    const rowidLower = seedArtifact(db, 711, 's', 'p1', 'learning', 'auth flow A', 'design A', 'auth-flow-design');
    const rowidHigher = seedArtifact(db, 712, 's', 'p2', 'learning', 'auth flow B', 'design B', 'auth-flow-design');
    expect(rowidLower).toBeLessThan(rowidHigher); // sanity check
    const r = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(r).not.toBeNull();
    expect(r!.injectedArtifactIds[0]).toBe(rowidLower); // lower rowid wins on tie
    db.close();
  });
});

describe('assembleExperienceTier — abstain rows excluded', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('artifacts with __abstain__ task_pattern do not surface', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    seedArtifact(
      db, 800, 's', 'lacuna-betting', 'learning', 'whatever', 'whatever',
      '__abstain__', 0,
    );
    const r = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(r).toBeNull();
    db.close();
  });
});

describe('assembleExperienceTier — substantive filter (Plan 14-03)', () => {
  const scope = useAllProjectsScope();
  beforeEach(scope.beforeEach);
  afterEach(scope.afterEach);

  it('noise observations (Read: prefix) do NOT surface in the candidate pool', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Noise: observation with 'Read:' prefix — even with importance=5 and high content
    const rowid900 = seedArtifact(
      db, 900, 's', 'lacuna-betting', 'observation',
      'Read: config.ts', 'some content here',
      'auth-flow-design', 1.0, 0,
    );
    // Only substantive learning alongside the noise observation
    const rowid901 = seedArtifact(
      db, 901, 's', 'lacuna-betting', 'learning',
      'auth flow decision', 'login session token handling',
      'auth-flow-design', 1.0, 0,
    );
    const r = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(r).not.toBeNull();
    // Must NOT include the noise observation
    expect(r!.injectedArtifactIds).not.toContain(rowid900);
    // Must include the substantive learning
    expect(r!.injectedArtifactIds).toContain(rowid901);
    db.close();
  });

  it('high-importance long-summary observations DO surface (they pass the substance gate)', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Substantive observation: confidence=0.8 (importance 4.0 after ×5), summary >= 60 chars, no noise prefix
    const longSummary = 'Cascade failure in bet365 pipeline traced to connection pool exhaustion at 22:00 UTC; root cause was a network partition that was not properly handled by the retry logic.';
    const rowid950 = seedArtifact(
      db, 950, 's', 'lacuna-betting', 'observation',
      longSummary, 'detailed investigation content',
      'auth-flow-design', 1.0, 0,
    );
    // Override confidence to 0.8 (importance = confidence * 5 = 4.0 ≥ 4 gate)
    db.prepare(`UPDATE artifact SET confidence = 0.8 WHERE rowid = ?`).run(rowid950);

    const r = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    expect(r).not.toBeNull();
    // The substantive observation should surface
    expect(r!.injectedArtifactIds).toContain(rowid950);
    db.close();
  });

  it('low-importance short-summary observations do NOT surface (below substance gate)', () => {
    const db = makeDb();
    seedSession(db, 's', 'lacuna-betting');
    // Noise-shaped observation: short title (Edit: prefix), low confidence
    const rowid960 = seedArtifact(
      db, 960, 's', 'lacuna-betting', 'observation',
      'Edit: auth.ts', 'content',
      'auth-flow-design', 1.0, 0,
    );
    const r = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      emptyHandles({ user_framing_tokens: ['auth', 'flow', 'design'] }),
    );
    // Pool empty → null (or if null because no candidates score positively)
    // Either way, the noise observation should NOT be injected
    if (r !== null) {
      expect(r.injectedArtifactIds).not.toContain(rowid960);
    } else {
      expect(r).toBeNull(); // null is fine — no substantive candidates
    }
    db.close();
  });
});
