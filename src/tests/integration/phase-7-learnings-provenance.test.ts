/**
 * Phase 7 plan 03 — VAL-02 extension regression guard.
 *
 * Asserts the write-path filter in captureInsightsAsLearnings strips
 * wrapper-tagged content (parseWrappers / KNOWN_WRAPPER_TAGS) before
 * insight extraction, so no non-'organic' learnings.provenance row ever
 * materializes. Substrate-level mirror of Vesna probe
 * learnings-injected-guard-001 (Plan 07-04).
 *
 * Cases:
 *   (a) Assistant text is 100% wrapper blocks → zero learnings inserted
 *   (b) Mixed text (organic + wrapper blocks) → only organic-derived
 *       insights become learnings; the phantom phrases inside the wrapper
 *       blocks do NOT appear in any inserted row's content
 *   (c) Non-organic provenance never appears in the learnings table from
 *       the production codepath
 *   (d) Schema invariant: V30 column exists with closed-enum CHECK
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDbWithSession } from '../helpers/test-db.js';
import { captureInsightsAsLearnings } from '../../adapters/shared/lifecycle.js';

function countLearnings(db: Database.Database, project: string): number {
  return (db.prepare(
    `SELECT COUNT(*) as c FROM learnings WHERE project = ?`
  ).get(project) as { c: number }).c;
}

function countNonOrganic(db: Database.Database, project: string): number {
  return (db.prepare(
    `SELECT COUNT(*) as c FROM learnings WHERE project = ? AND provenance != 'organic'`
  ).get(project) as { c: number }).c;
}

describe('Phase 7 — learnings provenance write-path filter', () => {
  let db: Database.Database;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const t = createTestDbWithSession();
    db = t.db;
    sessionId = t.sessionId;
    project = t.project;
  });

  afterEach(() => {
    db.close();
  });

  // (a) 100% wrapper-tagged input → zero learnings inserted
  it('(a) captureInsightsAsLearnings on pure wrapper-block text inserts zero learnings', async () => {
    const before = countLearnings(db, project);
    const phantomText = `<system-reminder>The root cause is that always_phantom_X must be true. The fix is to never_phantom_Y.</system-reminder><experience-data>The architecture is phantom_lesson_applies broadly.</experience-data>`;
    await captureInsightsAsLearnings(db, sessionId, project, phantomText);
    const after = countLearnings(db, project);
    expect(after).toBe(before);
  });

  // (b) Mixed input: organic regex-extractable insight + injected phantom
  //     content. Only the organic insight becomes a learning. Phantom
  //     phrases must NOT appear in any inserted row's content.
  it('(b) mixed organic + wrapper text only inserts organic-derived insights', async () => {
    const mixedText = `The root cause is that the cache eviction was off by one. <system-reminder>The fix is to invoke phantom_lesson_helper.</system-reminder>`;
    await captureInsightsAsLearnings(db, sessionId, project, mixedText);
    const rows = db.prepare(
      `SELECT content, provenance FROM learnings WHERE project = ?`
    ).all(project) as Array<{ content: string; provenance: string }>;

    // The organic "root cause" sentence may have been extracted (regex floor
    // matches "root cause"). The phantom_lesson_helper string must NEVER
    // appear in any inserted content.
    for (const row of rows) {
      expect(row.content).not.toContain('phantom_lesson_helper');
      expect(row.provenance).toBe('organic');
    }
  });

  // (c) Production-codepath invariant: zero non-organic provenance rows
  //     appear from captureInsightsAsLearnings, regardless of input shape.
  it('(c) captureInsightsAsLearnings never inserts a non-organic provenance row', async () => {
    const inputs = [
      `<system-reminder>injected only</system-reminder>`,
      `Organic prose with no wrappers and no insight markers.`,
      `The root cause is that we got off by one. <file-content>const x = 5;</file-content>`,
      `The architecture is event-driven. The fix is to add backpressure.`,
    ];
    for (const text of inputs) {
      await captureInsightsAsLearnings(db, sessionId, project, text);
    }
    expect(countNonOrganic(db, project)).toBe(0);
  });

  // (d) Schema invariant: V30 column exists, default is 'organic', CHECK
  //     enforces the closed enum.
  it('(d) learnings.provenance column exists with closed-enum CHECK', () => {
    const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    const provenance = cols.find(c => c.name === 'provenance');
    expect(provenance).toBeDefined();
    expect(provenance?.notnull).toBe(1);
    expect(provenance?.dflt_value).toContain('organic');
    // Out-of-enum INSERT must throw
    expect(() =>
      db.prepare(
        `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
      ).run('p', 'default', 'fp-bad-prov', 'c', 'bogus')
    ).toThrow(/CHECK constraint failed/);
  });
});
