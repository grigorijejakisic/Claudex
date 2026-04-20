#!/usr/bin/env node
/**
 * Apply team-lead's labeling-review decisions to gold-labels.jsonl in-place.
 *
 * Ran once at the 03-03 labeling-review checkpoint. Kept under .planning/
 * rather than src/ because it's a one-shot audit record, not a reusable
 * CLI. Decisions source: team-lead message 2026-04-20, 14 flagged
 * candidates. See the Decisions object below.
 *
 * Behavior:
 *   - accept: set human_verified=true, no label change
 *   - override: set human_verified=true, set reviewer_override={ fields... },
 *               AND also overwrite the label with the override (so
 *               precision-harness gold-comparisons don't need to know about
 *               the override column — they just read `label`).
 *
 * Idempotent: re-running against an already-reviewed file is a no-op for
 * accepts and overwrites override fields for overrides.
 */

const fs = require('node:fs');
const path = require('node:path');

const LABELS_PATH = path.join(
  __dirname,
  'fixtures',
  'gold-labels.jsonl',
);

// Shorthand prefix → full session_id. We only need enough characters to
// disambiguate among the 14 flagged rows.
const SID = {
  be1e3376: 'be1e3376-62a4-493b-b914-9ab3132afeca',
  '4a20a39d': '4a20a39d-3c85-4697-98ce-22d09383ce53',
  ba9eeaf8: 'ba9eeaf8-b666-41f9-8ce7-1a320e683a61',
  '8fac41a9': '8fac41a9-022f-4c16-83a5-f4120e8dc096',
  '3c4196f4': '3c4196f4-2c7f-4c72-a9c8-2541455d9c74',
  d8c2005c: 'd8c2005c-5929-4918-ad38-088ceea77dc9',
  d4e1d7e0: 'd4e1d7e0-48c3-4449-abaf-eb04f05eeeb6',
};

function cid(prefix, turnIdx) {
  return `${SID[prefix]}:${turnIdx}`;
}

const DECISIONS = [
  // Accepts — verify only
  { cid: cid('be1e3376', 11), action: 'accept' },                                                    // #1
  { cid: cid('ba9eeaf8', 38), action: 'accept' },                                                    // #3
  { cid: cid('be1e3376', 6),  action: 'accept' },                                                    // #6
  { cid: cid('be1e3376', 18), action: 'accept' },                                                    // #7
  { cid: cid('be1e3376', 54), action: 'accept' },                                                    // #8
  { cid: cid('be1e3376', 64), action: 'accept' },                                                    // #9
  { cid: cid('8fac41a9', 73), action: 'accept' },                                                    // #10
  { cid: cid('3c4196f4', 8),  action: 'accept' },                                                    // #11
  { cid: cid('d4e1d7e0', 1),  action: 'accept' },                                                    // #14

  // Overrides
  { cid: cid('4a20a39d', 13), action: 'override',                                                     // #2
    override: { is_directive: false, scope: null, polarity: null, self_confidence: 1.0,
                reasoning: 'REVIEWER: task-specific concern, "but that is about it" signals casualness; not a standing rule' } },
  { cid: cid('ba9eeaf8', 51), action: 'override',                                                     // #4
    override: { is_directive: false, scope: null, polarity: null, self_confidence: 1.0,
                reasoning: 'REVIEWER: questions/exploratory ideas ("Can we have this?"), no always/never rule' } },
  { cid: cid('ba9eeaf8', 56), action: 'override',                                                     // #5 — scope project→universal
    override: { is_directive: true, scope: 'universal', polarity: 'prohibitive', self_confidence: 1.0,
                reasoning: 'REVIEWER: mirrors global CLAUDE.md "no quick fixes" rule; applies across every project, not just this one' } },
  { cid: cid('3c4196f4', 25), action: 'override',                                                     // #12
    override: { is_directive: false, scope: null, polarity: null, self_confidence: 1.0,
                reasoning: 'REVIEWER: directive text is inside <system-reminder>, not user-authored; user message is just "how are we looking?"' } },
  { cid: cid('d8c2005c', 9),  action: 'override',                                                     // #13
    override: { is_directive: false, scope: null, polarity: null, self_confidence: 1.0,
                reasoning: 'REVIEWER: one-off task request disguised as imperative; not a persistent rule' } },
];

function main() {
  const raw = fs.readFileSync(LABELS_PATH, 'utf8');
  const rows = raw.split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l));
  const byCid = new Map(rows.map(r => [r.candidate_id, r]));

  let accepted = 0, overridden = 0, missing = 0;
  for (const d of DECISIONS) {
    const row = byCid.get(d.cid);
    if (!row) {
      console.error(`MISSING: ${d.cid}`);
      missing++;
      continue;
    }
    row.human_verified = true;
    if (d.action === 'override') {
      row.reviewer_override = d.override;
      // Also apply the override onto `label` so downstream consumers (the
      // precision harness) compute against the human-verified truth without
      // needing to know about the override column.
      row.label = { ...row.label, ...d.override };
      overridden++;
    } else {
      accepted++;
    }
  }

  fs.writeFileSync(LABELS_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`applied: accepted=${accepted}, overridden=${overridden}, missing=${missing}`);
  const totalVerified = rows.filter(r => r.human_verified).length;
  console.log(`total human_verified rows: ${totalVerified} / ${rows.length}`);
}

main();
