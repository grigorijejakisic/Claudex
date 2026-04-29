/**
 * Cache-stability scenario fixtures (Phase 5 Plan 02).
 *
 * Each builder returns a self-contained `CacheStabilityFixture` that:
 *   - Provisions a temp project directory + identity directory.
 *   - Initializes an in-memory DB (V18 schema) with seeded fixture rows.
 *   - Pins `nowEpoch` and `sessionId` so cache-stability tests can replay deterministically.
 *   - Exposes `run()` which invokes `assembleFullContext` reading the fixture's LIVE
 *     `nowEpoch`/`sessionId`/`projectDir` fields — Layer 3 mutates these between calls.
 *   - Exposes `cleanupFixture(fx)` for afterEach teardown.
 *
 * NOTE: MEMORY.md and ACTIVE.md are loaded by Claude Code natively, NOT by assembler.
 *       The fixture sets up the file tree to match a realistic surface, but the
 *       sections that surface in the assembler output come from in-DB state and
 *       on-disk files the assembler actually reads (USER.md, CLAUDE.md, etc.).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';
import { upsertLearning } from '../../core/learnings.js';
import { assembleFullContext } from '../../assembly/assembler.js';
import type { ClaudexConfig } from '../../shared/config.js';
import type { InjectPayload } from '../../shared/types.js';
import type { Database as DbType } from 'better-sqlite3';

export interface CacheStabilityFixture {
  name: string;
  projectDir: string;
  identityDir: string;
  sessionId: string;
  /** Pinned wall-clock for STALE_OBS_CUTOFF + lastSessionEpoch fallback. */
  nowEpoch: number;
  db: DbType;
  config: ClaudexConfig;
  /** Re-runs assembleFullContext reading LIVE fixture fields (for Layer 3). */
  run: () => InjectPayload;
  /** Internal: kept for cleanup. */
  _tmpRoot: string;
}

const PINNED_NOW_EPOCH = 1735689600; // 2025-01-01T00:00:00Z — deterministic, far from any real-world clock
const PINNED_SESSION_ID = '00000000-0000-0000-0000-000000000001';

function makeBaseConfig(): ClaudexConfig {
  return {
    schema: 'claudex/config',
    version: 3,
    injection: { budget_tokens: 4000, topic_shift_budget: 800 },
    observations: { enabled: true, retention_days: 90, prune_threshold: 1000, prune_count: 50 },
    checkpoint: { debounce_seconds: 60, compression: false, compaction_instructions: '' },
    learnings: { max_per_project: 50, surface_count: 10 },
    enrichment: { enabled: false, provider: 'auto', ollama_base_url: '', ollama_model: 'auto', timeout_ms: 10000 },
    embeddings: {
      enabled: false, provider: 'ollama', model: 'snowflake-arctic-embed2',
      ollama_base_url: '', topic_shift_threshold: 0.35, topic_shift_window: 3,
      decision_confidence_threshold: 0.15, jaccard_shift_threshold: 0.15,
    },
    observability: { enabled: false, retention_days: 7, retain_error_count: 1000 },
    gsd: { enabled: true },
    context: { advisory_threshold: 0.50, warning_threshold: 0.65, critical_threshold: 0.80, checkpoint_cooldown_seconds: 300 },
    features: { fts5_search: true },
    adapter: 'auto',
  };
}

function provisionTmp(scenarioSlug: string): { tmpRoot: string; projectDir: string; identityDir: string } {
  // Use a fixed, scenario-specific suffix WITHIN a per-test mkdtempSync. The mkdtempSync
  // gives us isolation across parallel test runs; the scenario suffix is deterministic
  // so test logs are readable. Inside the suffix, tree shapes are byte-identical.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `claudex-cs-${scenarioSlug}-`));
  const projectDir = path.join(tmpRoot, 'project');
  const identityDir = path.join(tmpRoot, 'identity');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(identityDir, { recursive: true });
  return { tmpRoot, projectDir, identityDir };
}

function writeFile(base: string, rel: string, content: string): void {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function buildBaseFixture(name: string, scenarioSlug: string, dbSeed: (db: DbType) => void): CacheStabilityFixture {
  const { tmpRoot, projectDir, identityDir } = provisionTmp(scenarioSlug);
  writeFile(identityDir, 'USER.md', 'CACH-FIX user identity (deterministic).');
  const db = new Database(':memory:');
  initializeSchema(db);
  dbSeed(db);

  const fx: CacheStabilityFixture = {
    name,
    projectDir,
    identityDir,
    sessionId: PINNED_SESSION_ID,
    nowEpoch: PINNED_NOW_EPOCH,
    db,
    config: makeBaseConfig(),
    _tmpRoot: tmpRoot,
    run: () => {
      // Read LIVE fields so Layer 3 mutations are observed
      return assembleFullContext({
        db: fx.db,
        project: 'cache-stability-fixture',
        projectDir: fx.projectDir,
        config: fx.config,
        identityDir: fx.identityDir,
        sessionId: fx.sessionId,
        nowEpoch: fx.nowEpoch,
      });
    },
  };
  return fx;
}

/**
 * Cold start — fresh project, no MEMORY.md, no handoff, no GSD .planning/, empty DB.
 * Surfaces: identity + claudex_ready + project (CLAUDE.md fallback) only.
 */
export function makeColdStart(): CacheStabilityFixture {
  return buildBaseFixture('cold-start', 'cold', (_db) => {
    /* empty DB — no fixtures */
  });
}

/**
 * Warm start — one prior session in DB, one learning, no handoff/GSD.
 * Surfaces add: session continuity (latest log if file present) + learnings.
 */
export function makeWarmStart(): CacheStabilityFixture {
  return buildBaseFixture('warm-start-with-memory-md', 'warm', (db) => {
    createSession(db, {
      session_id: 'warm-prior-session',
      project: 'cache-stability-fixture',
      cwd: '/test',
      source: 'test',
    });
    upsertLearning(db, {
      project: 'cache-stability-fixture',
      fingerprint: 'cs-warm-1',
      content: 'Cache-stable warm-start fixture learning entry.',
    });
  });
}

/**
 * Handoff start — ACTIVE.md handoff present (status:active, phase:5).
 * Surfaces add: session continuity (handoff content).
 */
export function makeHandoffStart(): CacheStabilityFixture {
  const fx = buildBaseFixture('handoff-start', 'handoff', (db) => {
    upsertLearning(db, {
      project: 'cache-stability-fixture',
      fingerprint: 'cs-handoff-1',
      content: 'Handoff-start scenario learning.',
    });
  });
  // Write ACTIVE.md and a sessions log dir so renderSessionContinuity has something to load.
  writeFile(fx.projectDir, 'context/handoffs/ACTIVE.md',
    '---\nstatus: active\nphase: "5"\nsummary: "Resume Phase 5 wave 2."\n---\n\n# Phase 5 handoff\n\nResume Phase 5 wave 2.\n');
  return fx;
}

/**
 * GSD-active start — `.planning/STATE.md` + `.planning/ROADMAP.md` populated.
 * Surfaces add: GSD state.
 */
export function makeGsdActiveStart(): CacheStabilityFixture {
  const fx = buildBaseFixture('gsd-active-start', 'gsd', (db) => {
    upsertLearning(db, {
      project: 'cache-stability-fixture',
      fingerprint: 'cs-gsd-1',
      content: 'GSD-active scenario learning.',
    });
  });
  writeFile(fx.projectDir, '.planning/STATE.md',
    '**Current Phase:** 5\n**Current Phase Name:** P4 — Kill legacy injection\n**Current Plan:** 2\nStatus: executing\n');
  writeFile(fx.projectDir, '.planning/ROADMAP.md',
    `### Phase 5: P4 — Kill legacy injection\n**Goal**: delete legacy injection sections\n**Success Criteria** (what must be TRUE):\n  1. Token budget ≤500\n  2. Cache stable across mutations\n`);
  // Empty phases dir so checkbox-counter has something to scan.
  writeFile(fx.projectDir, '.planning/phases/05-p4/plan.md', '- [x] Done\n- [ ] Pending\n');
  return fx;
}

export function cleanupFixture(fx: CacheStabilityFixture): void {
  try { fx.db.close(); } catch { /* */ }
  try { fs.rmSync(fx._tmpRoot, { recursive: true, force: true }); } catch { /* */ }
}
