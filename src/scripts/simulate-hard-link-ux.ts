/**
 * Phase 14-07f — operator-runnable UX simulation.
 *
 * Seeds a synthetic fixture (in-memory DB), runs the proposer with a MOCK
 * LLM response (no real LLM call), and prints what the Pending Review
 * section would render. Lets operator preview the propose-confirm-defer
 * UX shape BEFORE enabling the production proposer flag.
 *
 * This script does NOT touch the real DB. No production side effects.
 *
 * Usage:
 *   bun src/scripts/simulate-hard-link-ux.ts
 *   bun src/scripts/simulate-hard-link-ux.ts --proposals 10
 *   bun src/scripts/simulate-hard-link-ux.ts --include-decayed
 *
 * Per 14-07-CONTEXT Risk 3 mitigation: operator MUST review this output
 * before enabling CLAUDEX_HARD_LINK_PROPOSER in production.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../core/migrations.js';
import { createSession } from '../core/sessions.js';
import {
  runHardLinkProposer,
  _setLLMCallableForTest,
  formatPendingReviewLinksSection as formatSection,
} from '../intelligence/hard-link-proposer.js';
import { formatPendingReviewLinksSection } from '../assembly/sections/links.js';
import { rejectHardLink } from '../core/link-writer.js';

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const proposalCount = (() => {
  const idx = args.indexOf('--proposals');
  if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return 4;
})();
const includeDecayed = args.includes('--include-decayed');

// ─── Fixture setup ────────────────────────────────────────────────────────────

const PROJECT = 'simulate-project';
const SESSION_ID = 'simulate-session-001';

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function seedArtifacts(db: Database.Database): string[] {
  createSession(db, {
    session_id: SESSION_ID,
    project: PROJECT,
    cwd: '/simulate',
    source: 'script',
  });

  const now = Date.now();
  const artifacts = [
    {
      id: 'a001aabbccdd00001111222233334444',
      kind: 'observation',
      title: 'BGE reranker fell back to bi-encoder',
      body: 'Observed that the BGE-v2-m3 reranker on port 7439 was unreachable, causing retrieval to degrade to cosine bi-encoder path.',
    },
    {
      id: 'a002aabbccdd00001111222233334444',
      kind: 'decision',
      title: 'Add reranker health line to session-start',
      body: 'Decided to surface reranker health status at session-start to make fallback degradation visible. Unlocks awareness before work starts.',
    },
    {
      id: 'a003aabbccdd00001111222233334444',
      kind: 'lesson',
      title: 'Reranker fallback is not transparent',
      body: 'When BGE reranker falls back to bi-encoder, retrieval quality degrades silently. Surface this in session-start health line.',
    },
    {
      id: 'a004aabbccdd00001111222233334444',
      kind: 'observation',
      title: 'MEMORY.md Lessons index wiped on regeneration',
      body: 'The MEMORY.md auto-regenerator wiped the Lessons index during session 2026-05-14. Eight lesson pointers were lost.',
    },
    {
      id: 'a005aabbccdd00001111222233334444',
      kind: 'decision',
      title: 'Fix regenerator to preserve User Notes',
      body: 'Decided to add a sentinel guard in the regenerator so User Notes are never overwritten. Fix included in 14-07h.',
    },
    {
      id: 'a006aabbccdd00001111222233334444',
      kind: 'checkpoint',
      title: 'Phase 14-07 Wave 2 in progress',
      body: 'Knowledge graph substrate: LINKS-SCHEMA shipped. Workers D/E/F/G executing in parallel.',
    },
  ];

  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];
    db.prepare(`
      INSERT INTO artifact
        (id, kind, title, body, status, created_at_epoch_ms, updated_at_epoch_ms,
         session_id, project, data)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, '{}')
    `).run(
      a.id, a.kind, a.title, a.body,
      now - (artifacts.length - i) * 3600_000, // stagger by 1h each
      now,
      SESSION_ID, PROJECT,
    );
  }

  return artifacts.map(a => a.id);
}

// ─── Mock LLM response ────────────────────────────────────────────────────────

/**
 * simulateProposer returns a MOCK LLM callable that generates synthetic proposals.
 * 4 normal proposals + 1 low-confidence one (to demonstrate filtering).
 * With --proposals 10 it adds more to demonstrate budget truncation.
 */
function mockLLMResponse(artifactIds: string[], count: number): string {
  const [a1, a2, a3, a4, a5, a6] = artifactIds;

  const base = [
    {
      src_artifact_id: a1,
      dst_artifact_id: a2,
      type: 'triggered_by',
      confidence: 0.91,
      rationale: 'The reranker degradation observation triggered the decision to add health surfacing.',
    },
    {
      src_artifact_id: a1,
      dst_artifact_id: a3,
      type: 'evidence_for',
      confidence: 0.85,
      rationale: 'The specific reranker fallback observation is direct evidence for the lesson about non-transparent degradation.',
    },
    {
      src_artifact_id: a4,
      dst_artifact_id: a5,
      type: 'triggered_by',
      confidence: 0.88,
      rationale: 'The MEMORY.md wipe observation triggered the decision to fix the regenerator sentinel guard.',
    },
    {
      src_artifact_id: a6,
      dst_artifact_id: a2,
      type: 'evidence_for',
      confidence: 0.72,
      rationale: 'The Phase 14-07 checkpoint references the reranker health decision as a Wave 2 dependency.',
    },
  ];

  const extras = count > 4
    ? Array.from({ length: count - 4 }, (_, i) => ({
        src_artifact_id: artifactIds[i % artifactIds.length],
        dst_artifact_id: artifactIds[(i + 1) % artifactIds.length],
        type: 'references' as string,  // deliberately invalid type — skipped_invalid demo
        confidence: 0.55 + i * 0.03,
        rationale: `Synthetic extra proposal ${i + 5} for budget-truncation demonstration.`,
      }))
    : [];

  return JSON.stringify({ proposals: [...base, ...extras] });
}

// ─── Decayed tuple seed ───────────────────────────────────────────────────────

/**
 * Seeds a decayed anti-link tuple to demonstrate the decay-skip behavior.
 * Proposes the link, then rejects it DECAY_THRESHOLD times so the proposer skips it.
 */
async function seedDecayedTuple(db: Database.Database, artifactIds: string[]): Promise<void> {
  const { proposeHardLink, DECAY_THRESHOLD } = await import('../core/link-writer.js');

  // Propose the a3 → a5 link.
  const id = proposeHardLink(db, {
    src_artifact_id: artifactIds[2],
    dst_artifact_id: artifactIds[4],
    type: 'contradicts',
    proposed_confidence: 0.6,
    proposed_by_session: SESSION_ID,
    proposer_rationale: 'This link was previously proposed and rejected by the operator.',
  });

  if (id === null) return;

  // Reject it DECAY_THRESHOLD times to reach the anti-link threshold.
  for (let i = 0; i < DECAY_THRESHOLD; i++) {
    rejectHardLink(db, id, `reject-session-${i}`);
    // Re-propose to get a new row for next rejection cycle.
    if (i < DECAY_THRESHOLD - 1) {
      try {
        proposeHardLink(db, {
          src_artifact_id: artifactIds[2],
          dst_artifact_id: artifactIds[4],
          type: 'contradicts',
          proposed_confidence: 0.6,
          proposed_by_session: SESSION_ID,
          proposer_rationale: 'Re-proposed after rejection (decay simulation).',
        });
      } catch { /* may fail if row exists in non-rejected state — fine */ }
    }
  }
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function simulateProposer(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  14-07f Hard-Link UX Simulation (in-memory DB, mock LLM)   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Options: --proposals ${proposalCount}${includeDecayed ? ' --include-decayed' : ''}`);
  console.log('');

  // 1. Set up in-memory DB.
  const db = createInMemoryDb();
  const artifactIds = seedArtifacts(db);

  console.log(`Seeded ${artifactIds.length} synthetic artifacts (observation/decision/lesson/checkpoint).`);
  console.log('');

  // 2. Seed a decayed anti-link (demonstrates skip behavior).
  await seedDecayedTuple(db, artifactIds);
  console.log('Seeded 1 decayed anti-link tuple (a3→a5 contradicts, rejected 3× by operator).');
  console.log('');

  // 3. Install mock LLM.
  const mockResponse = mockLLMResponse(artifactIds, proposalCount);
  _setLLMCallableForTest(async (_prompt: string) => mockResponse);

  // 4. Run proposer against in-memory DB.
  console.log('Running proposer with MOCK LLM response...');
  const result = await runHardLinkProposer({
    db,
    session_id: SESSION_ID,
    project: PROJECT,
    max_proposals_per_run: 10,
  });

  // Restore.
  _setLLMCallableForTest(null);

  console.log('');
  console.log('── Proposer result ──────────────────────────────────────────');
  console.log(`  Proposed:         ${result.proposed}`);
  console.log(`  Skipped (decayed): ${result.skipped_decayed}`);
  console.log(`  Skipped (invalid): ${result.skipped_invalid}`);
  console.log(`  LLM error:        ${result.llm_error}`);
  console.log('');

  // 5. Render Pending Review section.
  console.log('── formatPendingReviewLinksSection output (budget: 600 tokens) ──');
  console.log('');

  const section = formatPendingReviewLinksSection({
    db,
    project: PROJECT,
    budget_tokens: 600,
  });

  if (section) {
    console.log(section);
  } else {
    console.log('(section returned null — no pending rows after filtering)');
  }

  // 6. Show decayed-exclusion toggle if --include-decayed.
  if (includeDecayed) {
    console.log('');
    console.log('── --include-decayed: what the section renders WITHOUT decay filter ──');
    console.log('(This shows proposals operators previously rejected — not shown in production)');
    console.log('');
    // Temporarily show the raw pending rows without decay filter.
    const raw = db.prepare(`
      SELECT id, src_artifact_id, dst_artifact_id, type, proposed_confidence,
             proposer_rationale, decay_count, proposed_at_epoch_ms
      FROM hard_link
      WHERE project = ?
      ORDER BY proposed_at_epoch_ms DESC
    `).all(PROJECT) as Array<{
      id: number;
      src_artifact_id: string;
      dst_artifact_id: string;
      type: string;
      proposed_confidence: number;
      proposer_rationale: string;
      decay_count: number;
      proposed_at_epoch_ms: number;
    }>;

    for (const row of raw) {
      const status = row.decay_count >= 3 ? '[DECAYED — hidden from operator]' : '[PENDING — shown to operator]';
      console.log(`  ${status}`);
      console.log(`    ID: ${row.id} | type: ${row.type} | confidence: ${Math.round(row.proposed_confidence * 100)}%`);
      console.log(`    src: ${row.src_artifact_id.slice(0, 16)}... → dst: ${row.dst_artifact_id.slice(0, 16)}...`);
      console.log(`    decay_count: ${row.decay_count} / 3 threshold`);
      console.log(`    rationale: ${row.proposer_rationale}`);
      console.log('');
    }
  }

  // 7. Summary.
  console.log('── Simulation summary ────────────────────────────────────────');
  console.log('  No production DB was touched. All data is in-memory only.');
  console.log('');
  console.log('  To confirm or reject (post-ship MCP tool):');
  console.log('    confirmHardLink(db, id, session_id)');
  console.log('    rejectHardLink(db, id, session_id)');
  console.log('');
  console.log('  To enable the production proposer:');
  console.log('    export CLAUDEX_HARD_LINK_PROPOSER=1');
  console.log('  (Only after operator has reviewed this simulation output)');
  console.log('');
  console.log('  Flag is OFF by default — no proposer runs without explicit opt-in.');

  db.close();
}

// Render section preview (alias used by tests).
export async function renderSectionPreview(
  db: Database.Database,
  project: string,
  budget = 600,
): Promise<string | null> {
  return formatPendingReviewLinksSection({ db, project, budget_tokens: budget });
}

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('simulate-hard-link-ux.ts')) {
  simulateProposer().catch(err => {
    console.error('Simulation failed:', err);
    process.exit(1);
  });
}
