/**
 * UPS per-turn payload budget test (Phase 5 Plan 06 — INJ-05).
 *
 * Asserts assembleRegularPrompt total content ≤1024 bytes (~256 cl100k_base tokens)
 * across realistic per-turn fixtures. Hard cap. If a fixture overruns, the cause is
 * one of:
 *   - Critical reminder too verbose → fix formatter
 *   - Proven principle text too long → already 500-token capped at section level;
 *     cascade gating may need re-tuning
 *   - Codebase index returning too many lines → already capped at 200 tokens
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { encode } from 'gpt-tokenizer';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';
import { upsertLearning } from '../../core/learnings.js';
import { assembleRegularPrompt } from '../../assembly/assembler.js';
import type { ClaudexConfig } from '../../shared/config.js';

const BUDGET_BYTES = 1024;
const BUDGET_TOKENS_APPROX = 256;

interface UpsScenario {
  name: string;
  prompt: string;
  preset?: 'with-critical-reminder' | 'empty';
}

const SCENARIOS: UpsScenario[] = [
  { name: 'no-prompt', prompt: '' },
  { name: 'short-prompt', prompt: 'fix the cache test' },
  { name: 'long-prompt-with-tech-terms',
    prompt: 'why does the assembler skip the materialization layer when isPostCompaction is true and the predicted context fixture is empty' },
  { name: 'critical-reminder-active', prompt: 'continue debugging', preset: 'with-critical-reminder' },
];

function makeConfig(): ClaudexConfig {
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

interface UpsFixture {
  tmpDir: string;
  db: Database.Database;
  params: Parameters<typeof assembleRegularPrompt>[0];
}

function makeUpsFixture(sc: UpsScenario): UpsFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `claudex-ups-${sc.name}-`));
  const db = new Database(':memory:');
  initializeSchema(db);

  const sessionId = '00000000-0000-0000-0000-000000000099';
  createSession(db, { session_id: sessionId, project: 'ups-fixture', cwd: '/test', source: 'test' });

  // Seed a couple of learnings so proven_principles cooldown gate has data
  upsertLearning(db, { project: 'ups-fixture', fingerprint: 'ups-1', content: 'UPS fixture learning A.' });
  upsertLearning(db, { project: 'ups-fixture', fingerprint: 'ups-2', content: 'UPS fixture learning B.' });

  const params = {
    isPostCompaction: false,
    prompt: sc.prompt,
    gauge: null,
    topicShift: null,
    db,
    project: 'ups-fixture',
    projectDir: tmpDir,
    config: makeConfig(),
    sessionId,
  };

  return { tmpDir, db, params };
}

function cleanup(fx: UpsFixture | null): void {
  if (!fx) return;
  try { fx.db.close(); } catch { /* */ }
  try { fs.rmSync(fx.tmpDir, { recursive: true, force: true }); } catch { /* */ }
}

for (const sc of SCENARIOS) {
  describe(`UPS budget: ${sc.name}`, () => {
    let fx: UpsFixture | null = null;
    afterEach(() => { cleanup(fx); fx = null; });

    test('per-turn payload ≤ 1024 bytes', () => {
      fx = makeUpsFixture(sc);
      const out = assembleRegularPrompt(fx.params);
      const bytes = Buffer.byteLength(out.content ?? '', 'utf8');
      const tokens = (out.content ?? '').length > 0 ? encode(out.content!).length : 0;

      // eslint-disable-next-line no-console
      console.log(`[ups-budget:${sc.name}] bytes=${bytes} tokens=${tokens} sources=[${out.sources.join(',')}]`);

      if (tokens > BUDGET_TOKENS_APPROX) {
        // eslint-disable-next-line no-console
        console.warn(`[ups-budget:${sc.name}] tokens=${tokens} > approx-budget ${BUDGET_TOKENS_APPROX} (still passes if bytes ≤ 1024)`);
      }
      expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES);
    });
  });
}
