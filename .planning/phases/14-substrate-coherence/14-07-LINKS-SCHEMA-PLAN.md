---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07-LINKS-SCHEMA
type: execute
wave: 2
depends_on: ["07a", "07b", "07c"]
files_modified:
  - src/core/migration-steps.ts
  - src/core/migration/v17-runner.ts
  - src/core/link-writer.ts (NEW)
  - src/tests/core/migration/links-schema.test.ts (NEW)
  - src/tests/core/link-writer.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "Two link tables ship in Wave 2: `soft_link` (autonomous-write tier) and `hard_link` (propose-confirm tier per Good Child policy in `memory/project_v7_hard_link_writer_is_good_child.md`). A third auxiliary table `hard_link_history` records audit events on hard-link state transitions."
    - "Soft links commit autonomously at write-time. Hard links are *proposed* by the LLM proposer (14-07f) and remain in a PENDING state until operator confirms via the propose-confirm UX. Rejected hard links increment `decay_count`; after N rejections (default N=3, configurable), the proposer SHOULD NOT re-suggest the same (src, dst, type) tuple."
    - "All link writes go through `src/core/link-writer.ts`. No worker bypasses these helpers — Wave 2 workers consume them but do NOT modify the schema."
    - "Link tables reference `artifact.id` via foreign keys. After Wave 1 cutover, `artifact.id` is V17 TEXT hash. Links are well-formed only when both src and dst exist in V17 `artifact`."
    - "Schema migration `migrateV37toV38` creates the link tables additively. Reverse `migrateV38toV37` drops them (rollback only). Idempotent on re-run."
    - "Indexes are present on (src_artifact_id, type), (dst_artifact_id, type), and (project — denormalized for query scoping). Composite UNIQUE (src, dst, type) prevents duplicate links per pair."
    - "Project denormalization: each link row copies `src_artifact_id`'s project value into a `project` column at write time. Reason: link-distance retrieval boost (14-07e) and Provenance walker (14-07g) need project scoping without a JOIN. Trade-off: write-time denormalization vs read-time JOIN; chose write-time for query performance."
    - "Hard-link `confirmed_by_session` is the contract for PENDING vs CONFIRMED state. NULL = pending (operator review queue). Non-NULL = confirmed (commits to the active link graph; retrieval boost may apply)."
    - "`rejected_by_session` is non-NULL when operator explicitly rejects. Rejected hard links are NOT deleted — they're kept for the decay-out anti-suggestion logic. The proposer reads rejected hard links and SKIPS re-proposing them up to `decay_count` threshold."
    - "Schema version becomes V38. `bun run setup` hook count stays at 25 (no new hook types for Wave 2). `PRAGMA user_version = 38` post-migration."
  artifacts:
    - path: "src/core/migration-steps.ts"
      provides: "migrateV37toV38 forward migration (adds soft_link, hard_link, hard_link_history) + migrateV38toV37 reverse"
      contains: "migrateV37toV38|migrateV38toV37|soft_link|hard_link"
    - path: "src/core/migration/v17-runner.ts"
      provides: "Schema runner extended with link-table DDL"
      contains: "soft_link|hard_link|hard_link_history"
    - path: "src/core/link-writer.ts"
      provides: "Single-source-of-truth API for link writes: writeSoftLink, proposeHardLink, confirmHardLink, rejectHardLink, decayHardLink, listPendingHardLinks, listConfirmedHardLinks, listSoftLinks"
      contains: "writeSoftLink|proposeHardLink|confirmHardLink|rejectHardLink|decayHardLink|listPendingHardLinks"
    - path: "src/tests/core/migration/links-schema.test.ts"
      provides: "Migration tests: forward, reverse, idempotency, FK constraint, UNIQUE constraint, index presence"
      contains: "migrateV37toV38|forward|reverse|idempotent|foreign_key|unique"
    - path: "src/tests/core/link-writer.test.ts"
      provides: "Helper tests: each public function, PENDING vs CONFIRMED state, decay logic, double-write prevention"
      contains: "writeSoftLink|proposeHardLink|confirmHardLink|decay|pending|confirmed"
  key_links:
    - from: "src/core/link-writer.ts"
      to: "src/core/artifact-id-map.ts (lookupV17ByLegacy if a caller still has a legacy ID)"
      via: "Transitional bridge during the post-Wave-1 window — soft/hard link helpers accept V17 TEXT IDs only; callers translate at the boundary if needed"
      pattern: "lookupV17ByLegacy"
    - from: "src/core/migration-steps.ts (migrateV37toV38)"
      to: "src/core/link-writer.ts"
      via: "Schema migration installs the tables; link-writer assumes the tables exist"
      pattern: "soft_link|hard_link"
---

<objective>
Three deliverables in one plan:

1. **Schema migration `migrateV37toV38`** — creates `soft_link`, `hard_link`, and `hard_link_history` tables with indexes, foreign keys, and uniqueness constraints. Additive; reverse migration drops the tables (rollback only). Increments `PRAGMA user_version` to 38.

2. **`src/core/link-writer.ts`** — the canonical write/read API for the link substrate. All Wave 2 workers consume these helpers. Soft links commit autonomously; hard links propose → confirm/reject → decay per Good Child policy.

3. **Tests** — migration round-trip, FK enforcement, UNIQUE enforcement, index presence, link-writer state-machine correctness (PENDING vs CONFIRMED vs REJECTED, decay counter logic).

After this plan lands:
- Tables exist; workers D/E/F/G can write/read.
- `link-writer.ts` is the locked write API; no worker reinvents.
- Schema is at V38.

| What this plan provides | Why |
|---|---|
| soft_link table | Autonomous-write tier (supersedes/promoted_to/extracted_from/references) |
| hard_link table | Propose-confirm tier (triggered_by/evidence_for/contradicts) per Good Child |
| hard_link_history table | Audit trail for state transitions (proposed → confirmed/rejected/decayed) |
| writeSoftLink helper | Single autonomous write path |
| proposeHardLink + confirm/reject/decay helpers | Propose-confirm UX state machine |
| Project denormalization | Retrieval-time scoping without JOIN |
| Indexes + UNIQUE constraints | Query performance + duplicate prevention |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md
@src/core/artifact-id-map.ts
@src/core/migration-steps.ts
</context>

<anti_scope>
- Do NOT add FTS5 or vec0 sidecars for link tables. Link search is by structural query (graph walk), not by vector or text. Out of scope per CONTEXT.
- Do NOT add new link types beyond the 7 documented (4 soft + 3 hard). Types are frozen for v7.0.0; future types are post-ship work.
- Do NOT instrument any writer outside `link-writer.ts`. Wave 2 D writes the autonomous instrumentation; this plan ships the helpers only.
- Do NOT touch session-start surfaces (Wave 3 territory).
- Do NOT modify V17 artifact schema (locked post-Wave-1).
- Do NOT modify hybrid-retrieval ranking math; the link-distance boost is 14-07e's territory.
- Do NOT auto-confirm hard links. Even in tests, the confirm path is exercised explicitly, never implicit.
- Do NOT change the decay threshold default at runtime — the threshold is a constant (default 3) defined in `link-writer.ts`; future tuning is post-ship.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Schema migration migrateV37toV38</name>
  <files>src/core/migration-steps.ts, src/core/migration/v17-runner.ts</files>
  <action>
Add `migrateV37toV38` step.

DDL (single transaction):

```sql
CREATE TABLE IF NOT EXISTS soft_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_artifact_id TEXT NOT NULL,
  dst_artifact_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('supersedes', 'promoted_to', 'extracted_from', 'references')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_by_session TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  project TEXT NOT NULL,
  data TEXT,
  FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
  FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
  UNIQUE (src_artifact_id, dst_artifact_id, type)
);
CREATE INDEX IF NOT EXISTS idx_soft_link_src ON soft_link(src_artifact_id, type);
CREATE INDEX IF NOT EXISTS idx_soft_link_dst ON soft_link(dst_artifact_id, type);
CREATE INDEX IF NOT EXISTS idx_soft_link_project ON soft_link(project);

CREATE TABLE IF NOT EXISTS hard_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_artifact_id TEXT NOT NULL,
  dst_artifact_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('triggered_by', 'evidence_for', 'contradicts')),
  proposed_confidence REAL NOT NULL CHECK (proposed_confidence >= 0.0 AND proposed_confidence <= 1.0),
  proposed_by_session TEXT NOT NULL,
  proposed_at_epoch_ms INTEGER NOT NULL,
  confirmed_by_session TEXT,
  confirmed_at_epoch_ms INTEGER,
  rejected_by_session TEXT,
  rejected_at_epoch_ms INTEGER,
  decay_count INTEGER NOT NULL DEFAULT 0 CHECK (decay_count >= 0),
  proposer_rationale TEXT,
  project TEXT NOT NULL,
  FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
  FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
  UNIQUE (src_artifact_id, dst_artifact_id, type)
);
CREATE INDEX IF NOT EXISTS idx_hard_link_src ON hard_link(src_artifact_id, type);
CREATE INDEX IF NOT EXISTS idx_hard_link_dst ON hard_link(dst_artifact_id, type);
CREATE INDEX IF NOT EXISTS idx_hard_link_project ON hard_link(project);
CREATE INDEX IF NOT EXISTS idx_hard_link_pending ON hard_link(project, confirmed_by_session) WHERE confirmed_by_session IS NULL;

CREATE TABLE IF NOT EXISTS hard_link_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hard_link_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('proposed', 'confirmed', 'rejected', 'decayed')),
  session_id TEXT NOT NULL,
  action_at_epoch_ms INTEGER NOT NULL,
  details TEXT,
  FOREIGN KEY (hard_link_id) REFERENCES hard_link(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hard_link_history_link ON hard_link_history(hard_link_id);
```

Update `PRAGMA user_version` to 38; INSERT row into `schema_versions`.

Reverse `migrateV38toV37`: DROP the three tables + indexes; decrement user_version; INSERT reverse row.

Update `v17-runner.ts` to invoke `migrateV37toV38` when the runner sees current version == 37.

`bun run setup` reference: update schema version constant from 37 → 38; hook count stays 25.
  </action>
  <verification>
- migrateV37toV38 applied to V37 DB lands cleanly; user_version = 38 after.
- Re-running is idempotent (CREATE TABLE IF NOT EXISTS + no-op user_version update).
- migrateV38toV37 cleanly reverses.
- Indexes present (verified by querying sqlite_master).
- CHECK constraint on `type` rejects invalid type values.
- UNIQUE constraint on (src, dst, type) raises on duplicate insert attempts.
- FK constraint on src + dst rejects inserts referencing missing artifact IDs.
- `bun run setup` reports V38; hook count == 25.
  </verification>
</task>

<task type="auto">
  <name>Task 2: link-writer.ts public API</name>
  <files>src/core/link-writer.ts</files>
  <action>
Create new file `src/core/link-writer.ts`.

```typescript
/**
 * Phase 14-07-LINKS-SCHEMA — canonical link-write API.
 *
 * Soft links: writeSoftLink (autonomous, commits immediately).
 * Hard links: proposeHardLink (creates PENDING row) →
 *   confirmHardLink (operator confirms) | rejectHardLink (operator
 *   rejects; increments decay_count) | decayHardLink (proposer
 *   self-decays after threshold).
 *
 * Per memory/project_v7_hard_link_writer_is_good_child.md, the
 * Good Child hybrid policy is the contract this file enforces.
 */

import type { Database } from 'better-sqlite3';

// ──────────────────────────────────────────────────
// Soft links
// ──────────────────────────────────────────────────

export type SoftLinkType = 'supersedes' | 'promoted_to' | 'extracted_from' | 'references';

export interface WriteSoftLinkParams {
  src_artifact_id: string;
  dst_artifact_id: string;
  type: SoftLinkType;
  confidence?: number;          // default 1.0
  created_by_session: string;
  data?: object;
}

/**
 * Write a soft link. Commits immediately.
 * Returns the link's row id.
 * On duplicate (src, dst, type), returns the existing id (no error).
 */
export function writeSoftLink(db: Database, params: WriteSoftLinkParams): number;

/**
 * List soft links for a given artifact.
 * direction: 'outgoing' (src = artifact), 'incoming' (dst = artifact), 'both'.
 */
export function listSoftLinks(
  db: Database,
  artifact_id: string,
  direction?: 'outgoing' | 'incoming' | 'both',
  types?: SoftLinkType[]
): Array<{ id: number; src: string; dst: string; type: SoftLinkType; confidence: number; created_at_epoch_ms: number; data?: object }>;

// ──────────────────────────────────────────────────
// Hard links
// ──────────────────────────────────────────────────

export type HardLinkType = 'triggered_by' | 'evidence_for' | 'contradicts';

export interface ProposeHardLinkParams {
  src_artifact_id: string;
  dst_artifact_id: string;
  type: HardLinkType;
  proposed_confidence: number;
  proposed_by_session: string;
  proposer_rationale: string;
}

/**
 * Propose a hard link. Row inserted with confirmed_by_session = NULL.
 * If a previously rejected row with decay_count >= DECAY_THRESHOLD
 * (default 3) already exists for (src, dst, type), this returns
 * null and logs a `proposer_skipped_decayed` telemetry row instead.
 */
export function proposeHardLink(db: Database, params: ProposeHardLinkParams): number | null;

/**
 * Operator action: confirm a pending hard link.
 * Sets confirmed_by_session + confirmed_at_epoch_ms.
 * Throws if the row is already confirmed or rejected.
 */
export function confirmHardLink(db: Database, hard_link_id: number, confirming_session: string): void;

/**
 * Operator action: reject a pending hard link.
 * Sets rejected_by_session + rejected_at_epoch_ms.
 * Increments decay_count.
 * Throws if the row is already confirmed.
 */
export function rejectHardLink(db: Database, hard_link_id: number, rejecting_session: string): void;

/**
 * Proposer self-decay: if a previous proposal was rejected and re-proposed
 * (which is the only path to multiple proposals per (src,dst,type) since
 * the UNIQUE constraint blocks duplicates), and decay_count reaches the
 * threshold, the proposer marks the link as fully decayed (an anti-link).
 *
 * Future proposer runs see this row and skip the (src, dst, type) tuple.
 */
export function decayHardLink(db: Database, hard_link_id: number, decaying_session: string): void;

/**
 * List PENDING hard links for a project (confirmed_by_session IS NULL
 * AND rejected_by_session IS NULL).
 * Used by F's formatPendingReviewLinksSection.
 */
export function listPendingHardLinks(db: Database, project: string): Array<{
  id: number;
  src: string;
  dst: string;
  type: HardLinkType;
  proposed_confidence: number;
  proposer_rationale: string;
  proposed_at_epoch_ms: number;
}>;

/**
 * List CONFIRMED hard links for an artifact.
 * Used by E's link-distance-boost + G's Provenance walker.
 */
export function listConfirmedHardLinks(
  db: Database,
  artifact_id: string,
  direction?: 'outgoing' | 'incoming' | 'both'
): Array<{ id: number; src: string; dst: string; type: HardLinkType; proposed_confidence: number }>;

/**
 * Get count of rejections for a (src, dst, type) tuple.
 * Used by proposeHardLink to enforce decay threshold.
 */
export function getDecayCount(db: Database, src: string, dst: string, type: HardLinkType): number;

// ──────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────

/**
 * Default rejection count before the proposer stops re-suggesting
 * a (src, dst, type) tuple. Tunable post-ship.
 */
export const DECAY_THRESHOLD = 3;
```

Implementation notes:

- Every write to `soft_link` or `hard_link` emits a corresponding `hard_link_history` row (for hard_link only — soft links don't need audit history per Wave 2 scope; if scope expands post-ship, add then).
- `proposeHardLink` checks `getDecayCount` before insert. If >= DECAY_THRESHOLD, returns null + telemetry row.
- All helpers wrap their DB ops in try/catch; constraint violations surface with explicit reasons.
- `data` JSON parameter on writeSoftLink is stringified to TEXT column.
  </action>
  <verification>
- All 9 documented exports present with correct signatures.
- writeSoftLink commits on first call; returns existing id on duplicate.
- proposeHardLink returns id on first proposal; null on decayed.
- confirmHardLink succeeds on pending; throws on already-confirmed.
- rejectHardLink succeeds on pending; increments decay_count.
- decayHardLink sets the decay state explicitly.
- Hard_link_history rows present after each state transition.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Tests for schema migration</name>
  <files>src/tests/core/migration/links-schema.test.ts</files>
  <action>
New test file. Tests:

1. `forward: migrateV37toV38 lands on V37 DB`
2. `forward: tables exist post-migration (soft_link, hard_link, hard_link_history)`
3. `forward: indexes exist (4 named indexes on soft_link/hard_link + history)`
4. `forward: idempotent re-run is a no-op`
5. `reverse: migrateV38toV37 drops the tables; user_version = 37`
6. `CHECK constraint: invalid soft_link type rejected`
7. `CHECK constraint: invalid hard_link type rejected`
8. `CHECK constraint: confidence out of [0,1] rejected`
9. `UNIQUE constraint: duplicate (src, dst, type) on soft_link raises`
10. `UNIQUE constraint: duplicate on hard_link raises`
11. `FK constraint: soft_link insert without matching src artifact raises`
12. `FK constraint: hard_link insert without matching dst artifact raises`
13. `ON DELETE RESTRICT: deleting an artifact referenced by a soft_link raises`
14. `hard_link_history ON DELETE CASCADE: deleting hard_link removes its history rows`
15. `bun run setup reports V38; hook count == 25`
  </action>
  <verification>
- 15 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for link-writer helpers</name>
  <files>src/tests/core/link-writer.test.ts</files>
  <action>
New test file. Tests:

1. `writeSoftLink: commits a soft_link row; returns new id`
2. `writeSoftLink: duplicate (src, dst, type) returns existing id (no error)`
3. `writeSoftLink: confidence defaults to 1.0 when not supplied`
4. `writeSoftLink: data JSON serialized correctly`
5. `listSoftLinks: outgoing direction filters by src`
6. `listSoftLinks: incoming direction filters by dst`
7. `listSoftLinks: both direction returns union`
8. `listSoftLinks: types filter narrows the result`
9. `proposeHardLink: creates PENDING row (confirmed_by_session IS NULL)`
10. `proposeHardLink: returns the new row id`
11. `proposeHardLink: history row inserted with action='proposed'`
12. `proposeHardLink: re-proposal after rejection (different session) inserts a NEW row only if no UNIQUE collision — actually, by design the UNIQUE blocks re-proposal of the same (src,dst,type). Verify the behavior: the proposer must inspect via getDecayCount BEFORE proposing.`
13. `proposeHardLink: when getDecayCount >= DECAY_THRESHOLD, returns null + telemetry row`
14. `confirmHardLink: sets confirmed_by_session + confirmed_at_epoch_ms; history row inserted`
15. `confirmHardLink: throws on already-confirmed row`
16. `confirmHardLink: throws on rejected row`
17. `rejectHardLink: sets rejected_by_session + rejected_at_epoch_ms; increments decay_count; history row inserted`
18. `rejectHardLink: throws on already-confirmed row`
19. `decayHardLink: marks decayed state; history row inserted`
20. `listPendingHardLinks: returns only PENDING rows (NULL confirm, NULL reject)`
21. `listConfirmedHardLinks: returns only CONFIRMED rows`
22. `getDecayCount: returns 0 for (src, dst, type) never rejected`
23. `getDecayCount: returns N after N rejections`
24. `DECAY_THRESHOLD constant == 3 (locked default)`
  </action>
  <verification>
- 24 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Build + run plan-touched tests + sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/core/migration/links-schema.test.ts` — 15 tests pass.
- `npx vitest run src/tests/core/link-writer.test.ts` — 24 tests pass.
- `npx vitest run` — full suite green (Wave 1 baseline + Wave 1 plans' +105 + this plan's +39 new tests).
- `bun run setup` reports V38; hook count 25.
- Smoke: open the DB, call writeSoftLink with a valid artifact pair, confirm row appears.
  </action>
  <verification>
- Build green.
- 39 new tests pass (15 schema + 24 writer).
- Full suite green.
- bun run setup OK.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `migrateV37toV38` exists; idempotent; reverses via `migrateV38toV37`.
- AC-2: Three tables present post-migration: `soft_link`, `hard_link`, `hard_link_history`.
- AC-3: Indexes present per the DDL spec.
- AC-4: CHECK constraints on `type` and `confidence` enforced at DB level.
- AC-5: UNIQUE (src, dst, type) enforced on both link tables.
- AC-6: FK constraints on (src_artifact_id, dst_artifact_id) → artifact(id) enforced.
- AC-7: `link-writer.ts` exports all documented functions with correct signatures.
- AC-8: `writeSoftLink` commits immediately; duplicate returns existing id.
- AC-9: `proposeHardLink` creates PENDING; `confirmHardLink` confirms; `rejectHardLink` rejects + decays.
- AC-10: `getDecayCount` returns correct count; `proposeHardLink` blocks at >= DECAY_THRESHOLD.
- AC-11: `hard_link_history` row inserted on every state transition.
- AC-12: `listPendingHardLinks` and `listConfirmedHardLinks` return correct filtered sets.
- AC-13: `bun run setup` reports V38; hook count stays 25.
- AC-14: All 39 new tests pass.
- AC-15: No regression in v6.6.0 + Wave 1 test baseline.
</acceptance_criteria>

<risks>
- **Risk 1: FK ON DELETE RESTRICT prevents legitimate cleanup.** If a future plan needs to delete an artifact that has links, the RESTRICT blocks it. Mitigation: ON DELETE RESTRICT is INTENTIONAL — preserves link graph integrity. Future "soft-delete" patterns can mark artifacts as archived without DELETEing. Documented.
- **Risk 2: UNIQUE constraint on (src, dst, type) blocks legitimate re-proposal cases.** Mitigation: per Good Child policy, re-proposing the same link after rejection IS blocked by design — the decay mechanism handles "don't re-suggest" without a new row. If operator wants to re-propose after a rejection, that's a manual confirm of the existing rejected row (not yet in scope; surfaced for Wave 3 / post-ship).
- **Risk 3: Project denormalization drifts.** If an artifact's project value is ever updated post-creation (unlikely but possible), the link rows' project field becomes stale. Mitigation: V17 artifact's `project` is treated as immutable post-creation; documented as an invariant; no helper modifies it.
- **Risk 4: hard_link_history grows unbounded.** Every state transition adds a row. Over time, this table could be large. Mitigation: post-ship retention sweep can prune old history rows; Wave 2 scope does not include retention.
- **Risk 5: DECAY_THRESHOLD of 3 might be wrong.** Too aggressive → operator never sees genuinely-correct links that were rejected once-by-accident. Too lenient → operator drowns in repeat suggestions. Mitigation: 3 is a reasonable starting point; future tuning is post-ship work. The constant is exported so future plans can adjust.
- **Risk 6: SQLite partial index syntax (`WHERE confirmed_by_session IS NULL` on idx_hard_link_pending) may not work on older SQLite versions.** Mitigation: detect via PRAGMA compile_options at test time; if unavailable, fall back to a full index on the column.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Schema design — are the constraints sufficient to prevent corrupt link state?
- (b) The propose → confirm/reject → decay state machine — does the API correctly enforce the state transitions?
- (c) The decay-count semantics — does the threshold prevent infinite re-proposal but allow legitimate operator-driven re-confirmation paths?
- (d) Project denormalization — is the trade-off (write-time denorm vs read-time JOIN) right for the expected query patterns?
- (e) FK ON DELETE RESTRICT — does this create future operability problems?

NO-SIGNOFF triggers PM escalation per WAVE2-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (39 new tests for schema + helpers).
3. Live-wiring smoke: helper smoke against a real DB.
4. No "MVP" shortcuts — DB-level constraints enforce state machine invariants; helpers wrap them with explicit error surfaces.
5. Negative results valid: if any constraint is too restrictive in practice, surface to PM/PO; do not loosen silently.
6. Cross-family external review per the gate above.
7. No time estimates.
</methodology_gates>
