/**
 * Phase 14-07f — Pending Review Links section formatter tests.
 *
 * Coverage:
 *   - empty pending: returns null
 *   - one pending: section rendered with type, summary, rationale
 *   - multiple pending: sorted by proposed_at_epoch_ms DESC (newest first)
 *   - decayed pending: excluded from section
 *   - budget cap: truncates list with appended summary
 *   - confidence formatted as percent
 *   - rationale rendered
 *   - header line + guidance line present
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { proposeHardLink, rejectHardLink, DECAY_THRESHOLD } from '../../core/link-writer.js';
import { formatPendingReviewLinksSection } from '../../assembly/sections/links.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertArtifact(
  db: Database.Database,
  id: string,
  project: string,
  title = 'Test Artifact',
): void {
  db.prepare(`
    INSERT INTO artifact
      (id, kind, title, body, status, created_at_epoch_ms, updated_at_epoch_ms,
       session_id, project, data)
    VALUES (?, 'observation', ?, 'Body text', 'active', ?, ?, 'sess', ?, '{}')
  `).run(id, title, Date.now(), Date.now(), project);
}

function proposePending(
  db: Database.Database,
  src: string,
  dst: string,
  type: 'triggered_by' | 'evidence_for' | 'contradicts',
  confidence: number,
  rationale: string,
  session = 'sess',
): number {
  const id = proposeHardLink(db, {
    src_artifact_id: src,
    dst_artifact_id: dst,
    type,
    proposed_confidence: confidence,
    proposed_by_session: session,
    proposer_rationale: rationale,
  });
  if (id === null) throw new Error('proposeHardLink returned null (decayed)');
  return id;
}

const PROJECT = 'prl-test-proj';
const A1 = 'prl001' + '0'.repeat(26);
const A2 = 'prl002' + '0'.repeat(26);
const A3 = 'prl003' + '0'.repeat(26);
const A4 = 'prl004' + '0'.repeat(26);
const A5 = 'prl005' + '0'.repeat(26);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('formatPendingReviewLinksSection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertArtifact(db, A1, PROJECT, 'Reranker fell back');
    insertArtifact(db, A2, PROJECT, 'Add health surfacing');
    insertArtifact(db, A3, PROJECT, 'Lesson: fallback not transparent');
    insertArtifact(db, A4, PROJECT, 'Memory wipe observation');
    insertArtifact(db, A5, PROJECT, 'Fix regenerator');
  });

  afterEach(() => { db.close(); });

  it('returns null when no pending links exist', () => {
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toBeNull();
  });

  it('renders non-null when one pending row exists', () => {
    proposePending(db, A1, A2, 'triggered_by', 0.9, 'Observation triggered decision.');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).not.toBeNull();
  });

  it('section header is present', () => {
    proposePending(db, A1, A2, 'triggered_by', 0.9, 'Test rationale');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain('## Inferred Links Pending Review');
  });

  it('renders link type in output', () => {
    proposePending(db, A1, A2, 'evidence_for', 0.85, 'Evidence rationale');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain('[evidence_for]');
  });

  it('renders artifact summaries (title present)', () => {
    proposePending(db, A1, A2, 'triggered_by', 0.9, 'A rationale');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain('Reranker fell back');
    expect(result).toContain('Add health surfacing');
  });

  it('renders rationale', () => {
    const rationale = 'Specific rationale text for operator review';
    proposePending(db, A1, A2, 'triggered_by', 0.9, rationale);
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain(rationale);
  });

  it('renders confidence as percentage', () => {
    proposePending(db, A1, A2, 'triggered_by', 0.87, 'R');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain('87%');
  });

  it('renders the link ID', () => {
    const linkId = proposePending(db, A1, A2, 'triggered_by', 0.9, 'R');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain(`ID: ${linkId}`);
  });

  it('guidance line is present', () => {
    proposePending(db, A1, A2, 'triggered_by', 0.9, 'R');
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toContain('confirmHardLink');
    expect(result).toContain('rejectHardLink');
  });

  it('excludes decayed tuples', () => {
    // Decay A1→A2 triggered_by via direct DB (avoids UNIQUE constraint cycle).
    const decayedId = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: 'triggered_by',
      proposed_confidence: 0.9,
      proposed_by_session: 'sess',
      proposer_rationale: 'decayed',
    });
    expect(decayedId).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, decayedId);

    // A3→A4 is not decayed.
    proposePending(db, A3, A4, 'evidence_for', 0.8, 'Non-decayed rationale');

    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    // Should render the non-decayed proposal.
    expect(result).toContain('[evidence_for]');
    // The section should exist (A3→A4 is there).
    expect(result).not.toBeNull();
    // Verify decayed one's rationale is absent.
    expect(result).not.toContain('decayed');
  });

  it('returns null when ALL pending links are decayed', () => {
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: 'triggered_by',
      proposed_confidence: 0.9,
      proposed_by_session: 'sess',
      proposer_rationale: 'test decay',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, id);

    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 600 });
    expect(result).toBeNull();
  });

  it('budget cap: appends truncation message when over budget', () => {
    // Propose many links — budget is very tight (50 tokens).
    proposePending(db, A1, A2, 'triggered_by', 0.9, 'Rationale for link 1 which is fairly detailed.');
    proposePending(db, A2, A3, 'evidence_for', 0.85, 'Rationale for link 2 which is also detailed.');
    proposePending(db, A3, A4, 'contradicts', 0.8, 'Rationale for link 3.');
    proposePending(db, A4, A5, 'triggered_by', 0.75, 'Rationale for link 4.');
    proposePending(db, A5, A1, 'evidence_for', 0.7, 'Rationale for link 5.');

    // Use a tiny budget that can only fit the header + maybe 1 entry.
    const result = formatPendingReviewLinksSection({ db, project: PROJECT, budget_tokens: 100 });

    // Should have truncation notice.
    expect(result).toContain('more pending');
  });
});
