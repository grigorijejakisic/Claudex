---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07d
type: execute
wave: 2
depends_on: ["07-LINKS-SCHEMA"]
files_modified:
  - src/intelligence/soft-link-writers.ts (NEW)
  - src/angel/handoff-writer.ts
  - src/intelligence/learnings-promoter.ts
  - src/angel/highlights-extractor.ts
  - src/intelligence/retrieval-log.ts
  - src/tests/intelligence/soft-link-writers.test.ts (NEW)
  - src/tests/angel/handoff-writer.test.ts
  - src/tests/intelligence/learnings-promoter.test.ts
  - src/tests/angel/highlights-extractor.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "Four soft-link write sites are instrumented in this plan: (1) handoff-writer emits `supersedes` when a new ACTIVE.md is written (links the new handoff to the prior one); (2) learnings-promoter emits `promoted_to` when an observation is promoted to a lesson; (3) highlights-extractor emits `extracted_from` when session frame highlights are extracted; (4) retrieval-log emits `references` when a log entry contains an artifact reference."
    - "All four writes go through `src/intelligence/soft-link-writers.ts` site helpers, which themselves call `writeSoftLink` from `src/core/link-writer.ts` (14-07-LINKS-SCHEMA). No site calls `writeSoftLink` directly."
    - "Instrumentation is ADDITIVE. Existing write contracts (handoff-writer's writeHandoff, learnings-promoter's promote, etc.) keep their signatures + return shapes. Soft-link emission happens after the primary write succeeds; failure to write a soft link is logged but does not roll back the primary write."
    - "Soft links commit at the autonomous tier per the Good Child policy: write-time, no operator confirmation, low-stakes inference (these are factual relationships: 'this handoff replaces that one' is observable from the write event itself, not LLM-inferred)."
    - "The supersedes link is written when the prior ACTIVE.md exists as a V17 artifact AND the new handoff is also a V17 artifact. If either is missing, the soft-link write is skipped silently and a telemetry row is emitted (`soft_link_skipped` event)."
    - "The promoted_to link writes from the observation's V17 ID to the lesson's V17 ID. If learnings-promoter does not currently produce V17 IDs for both sides, this plan adds the V17 ID derivation BUT does not modify the lesson/observation schemas (those are V17 unified post-Wave-1)."
    - "The extracted_from link writes from each extracted highlight's V17 ID to the session frame's V17 ID. session_highlights post-Wave-1 are V17 artifacts; session frames are V17 artifacts."
    - "The references link is denser — retrieval-log entries may reference multiple artifacts. The instrumentation iterates over a log entry's referenced artifacts and writes one link per reference."
  artifacts:
    - path: "src/intelligence/soft-link-writers.ts"
      provides: "Site-specific helpers wrapping link-writer.writeSoftLink with the contextual fields each site provides: recordSupersedes, recordPromotedTo, recordExtractedFrom, recordReferences."
      contains: "recordSupersedes|recordPromotedTo|recordExtractedFrom|recordReferences"
    - path: "src/angel/handoff-writer.ts"
      provides: "Existing handoff writer; instrumented to call soft-link-writers.recordSupersedes after a successful writeHandoff."
      contains: "recordSupersedes"
    - path: "src/intelligence/learnings-promoter.ts"
      provides: "Lesson promotion writer; instrumented to emit promoted_to soft link."
      contains: "recordPromotedTo"
    - path: "src/angel/highlights-extractor.ts"
      provides: "Highlights extractor; instrumented to emit extracted_from soft links per highlight."
      contains: "recordExtractedFrom"
    - path: "src/intelligence/retrieval-log.ts"
      provides: "Retrieval log; instrumented to emit references soft links per logged artifact reference."
      contains: "recordReferences"
  key_links:
    - from: "site helpers in soft-link-writers.ts"
      to: "src/core/link-writer.ts (writeSoftLink)"
      via: "Site helpers wrap writeSoftLink with site-specific defaults and error handling"
      pattern: "writeSoftLink"
---

<objective>
Instrument four existing write sites to emit soft links autonomously.

Each instrumentation:
1. Wraps the existing write path so the soft-link emission happens *after* the primary write succeeds.
2. Uses a site-specific helper (in `soft-link-writers.ts`) that knows what V17 IDs to wire.
3. Failure to emit a soft link is logged via telemetry (`soft_link_write_failed`) but does NOT roll back the primary write.
4. Skipped emissions (e.g., prior artifact missing) emit `soft_link_skipped` telemetry.

After this plan lands:
- New handoffs auto-emit `supersedes` links.
- Lesson promotions auto-emit `promoted_to` links.
- Highlights extractions auto-emit `extracted_from` links.
- Retrieval logs auto-emit `references` links.
- The soft-link graph populates organically as the system runs.

| What this plan provides | Why |
|---|---|
| Autonomous supersedes links | Handoff history becomes a traversable chain |
| Autonomous promoted_to links | Observation→lesson lineage discoverable |
| Autonomous extracted_from links | Highlight provenance back to session frame |
| Autonomous references links | Cross-artifact reference graph |
| Site helpers, not direct calls | Consistency + error handling at one layer |
| Telemetry on skip/fail | Silent failure becomes observable |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07-LINKS-SCHEMA-PLAN.md
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md
@src/core/link-writer.ts
@src/angel/handoff-writer.ts
@src/intelligence/learnings-promoter.ts
@src/angel/highlights-extractor.ts
@src/intelligence/retrieval-log.ts
</context>

<anti_scope>
- Do NOT propose or write hard links — that's 14-07f territory.
- Do NOT add new soft link types beyond the four documented in LINKS-SCHEMA.
- Do NOT modify the primary write paths (handoff writeHandoff, lesson promote, highlight extraction, retrieval log) beyond adding the post-write soft-link call.
- Do NOT roll back the primary write if the soft-link emission fails.
- Do NOT touch session-start surfaces (Wave 3 territory).
- Do NOT modify link-writer.ts (LINKS-SCHEMA owns the link write API; this plan consumes it).
- Do NOT touch artifact schema (V17 unified shape locked post-Wave-1).
- Do NOT auto-confirm or auto-emit hard links — Good Child policy.
- Do NOT introduce new write sites; only instrument the four documented.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: soft-link-writers.ts site helpers</name>
  <files>src/intelligence/soft-link-writers.ts</files>
  <action>
Create new file with four site-specific helpers.

```typescript
import type { Database } from 'better-sqlite3';
import { writeSoftLink } from '../core/link-writer.js';
import { emitTelemetry } from '../observability/telemetry.js';

/**
 * Phase 14-07d — site helpers for autonomous soft-link emission.
 *
 * Each helper wraps writeSoftLink with site-specific defaults and
 * the standardized try/catch + telemetry pattern. Per the Good
 * Child policy, soft links commit at write-time; failures are
 * logged but do not block the primary write path.
 */

export interface SoftLinkContext {
  db: Database;
  session_id: string;
}

export interface RecordSupersedesParams extends SoftLinkContext {
  new_handoff_artifact_id: string;       // V17 ID of just-written handoff
  prior_handoff_artifact_id: string | null;  // V17 ID of prior; null = first handoff for project
}

/**
 * Record a supersedes link from new handoff → prior handoff.
 * If prior is null, emits `soft_link_skipped` telemetry and returns.
 */
export function recordSupersedes(p: RecordSupersedesParams): number | null;

export interface RecordPromotedToParams extends SoftLinkContext {
  observation_artifact_id: string;
  lesson_artifact_id: string;
  promotion_confidence?: number;   // default 1.0
}

/**
 * Record a promoted_to link from observation → lesson.
 */
export function recordPromotedTo(p: RecordPromotedToParams): number | null;

export interface RecordExtractedFromParams extends SoftLinkContext {
  highlight_artifact_id: string;
  session_frame_artifact_id: string;
}

/**
 * Record an extracted_from link from highlight → session frame.
 */
export function recordExtractedFrom(p: RecordExtractedFromParams): number | null;

export interface RecordReferencesParams extends SoftLinkContext {
  src_artifact_id: string;
  referenced_artifact_ids: string[];   // emits N links
}

/**
 * Record N references links from src → each referenced artifact.
 * Returns count of links written (excludes skipped/failed).
 */
export function recordReferences(p: RecordReferencesParams): number;
```

Implementation pattern (per helper):

```typescript
export function recordSupersedes(p: RecordSupersedesParams): number | null {
  if (!p.prior_handoff_artifact_id) {
    emitTelemetry(p.db, {
      event_kind: 'soft_link_skipped',
      session_id: p.session_id,
      detail: { reason: 'no_prior', site: 'recordSupersedes', new_id: p.new_handoff_artifact_id },
    });
    return null;
  }
  try {
    return writeSoftLink(p.db, {
      src_artifact_id: p.new_handoff_artifact_id,
      dst_artifact_id: p.prior_handoff_artifact_id,
      type: 'supersedes',
      created_by_session: p.session_id,
    });
  } catch (err) {
    emitTelemetry(p.db, {
      event_kind: 'soft_link_write_failed',
      session_id: p.session_id,
      detail: { site: 'recordSupersedes', error: String(err) },
    });
    return null;
  }
}
```

Apply the same pattern to the other three helpers.
  </action>
  <verification>
- All 4 helpers present with documented signatures.
- Successful write returns the soft_link row id.
- Skipped emission (no_prior or missing dst) emits soft_link_skipped telemetry; returns null.
- Failed emission emits soft_link_write_failed telemetry; returns null; does NOT throw.
- recordReferences returns count of successful writes.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Instrument handoff-writer.ts for supersedes</name>
  <files>src/angel/handoff-writer.ts</files>
  <action>
After `writeHandoff` successfully completes (writes ACTIVE.md to disk + emits the artifact row), look up the prior handoff for the project:

1. Query V17 `artifact` for the most recent `kind='handoff'` row for the project that is NOT the just-written handoff. Order by `created_at_epoch_ms DESC`, LIMIT 1.
2. If found, call `recordSupersedes` with new and prior V17 IDs.
3. If not found (first handoff for the project), `recordSupersedes` handles the skip path internally.

This is post-write instrumentation. The existing writeHandoff contract is unchanged.

Add a `// 14-07d: emit supersedes soft link` comment marker so reviewers can grep.
  </action>
  <verification>
- writeHandoff still returns the same shape.
- After a writeHandoff, the soft_link table has a new `supersedes` row pointing from the new handoff to the prior one (when a prior exists).
- First-handoff-for-project case skips emission (verified via soft_link_skipped telemetry).
- writeHandoff fails-safe: a soft-link emission failure does NOT cause writeHandoff to return error.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Instrument learnings-promoter.ts for promoted_to</name>
  <files>src/intelligence/learnings-promoter.ts</files>
  <action>
After a lesson promotion writes the new lesson artifact AND the originating observation is identifiable:

1. Look up the observation's V17 artifact ID (it should already exist as a V17 artifact post-Wave-1).
2. Call `recordPromotedTo` with observation and lesson IDs.

If the observation cannot be linked (e.g., promotion from an aggregate of multiple observations rather than a single one), emit `soft_link_skipped` with reason='multi_source_aggregate' and continue without a link.

Add `// 14-07d: emit promoted_to soft link` comment marker.
  </action>
  <verification>
- A lesson promotion creates a promoted_to soft_link row.
- Multi-source promotion (no single observation) skips emission cleanly.
- learnings-promoter contract unchanged.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Instrument highlights-extractor.ts for extracted_from</name>
  <files>src/angel/highlights-extractor.ts</files>
  <action>
After session_highlights extraction writes the per-highlight artifact rows, for each highlight:

1. Identify the session frame artifact ID (the session row in V17 form, post-Wave-1).
2. Call `recordExtractedFrom` with highlight V17 ID and session frame V17 ID.

If the highlight extraction returned no rows (degraded=1 from a failed Opus call), no links are emitted (nothing to link from).

Add `// 14-07d: emit extracted_from soft link` comment marker per emission.
  </action>
  <verification>
- Each successful highlight extraction emits one extracted_from soft_link per highlight.
- Degraded / failed extractions do not emit links.
- highlights-extractor contract unchanged.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Instrument retrieval-log.ts for references</name>
  <files>src/intelligence/retrieval-log.ts</files>
  <action>
After a retrieval log entry is written AND it contains referenced artifact IDs (typically the retrieved candidate set):

1. Call `recordReferences` with the log entry's V17 artifact ID as src and the list of referenced artifact V17 IDs as dst.

`recordReferences` emits N soft_link rows (one per reference). The UNIQUE constraint on (src, dst, type) prevents duplicate references for the same retrieval log entry referencing the same artifact twice.

Add `// 14-07d: emit references soft links` comment marker.
  </action>
  <verification>
- A retrieval log entry with 3 references emits 3 references soft_link rows.
- A log entry with 0 references emits 0 rows; no error.
- Re-running on a log entry that already linked does not throw (UNIQUE constraint handled by recordReferences via writeSoftLink's duplicate-returns-existing-id behavior).
  </verification>
</task>

<task type="auto">
  <name>Task 6: Tests for soft-link-writers.ts</name>
  <files>src/tests/intelligence/soft-link-writers.test.ts</files>
  <action>
New test file. Tests:

1. `recordSupersedes: successful write returns row id`
2. `recordSupersedes: null prior → soft_link_skipped telemetry, returns null`
3. `recordSupersedes: missing dst artifact (FK violation) → soft_link_write_failed telemetry, returns null`
4. `recordPromotedTo: successful write returns row id`
5. `recordPromotedTo: confidence default 1.0`
6. `recordPromotedTo: custom confidence accepted`
7. `recordExtractedFrom: successful write returns row id`
8. `recordReferences: 3 refs → 3 soft_links written; returns 3`
9. `recordReferences: 0 refs → 0 written; returns 0`
10. `recordReferences: duplicate refs in same call → UNIQUE constraint dedupes; returns count of new+existing`
11. `All helpers: telemetry write failure doesn't cascade into throw`
12. `All helpers: primary write success path does not throw`
  </action>
  <verification>
- 12 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 7: Site-instrumentation tests</name>
  <files>src/tests/angel/handoff-writer.test.ts, src/tests/intelligence/learnings-promoter.test.ts, src/tests/angel/highlights-extractor.test.ts</files>
  <action>
Add new describe blocks to each existing test file:

**handoff-writer.test.ts** — `describe('Phase 14-07d supersedes emission', ...)`:
- `writeHandoff with prior handoff present: supersedes soft_link emitted`
- `writeHandoff first-for-project: no soft_link emitted; soft_link_skipped telemetry present`
- `writeHandoff: soft-link emission failure does NOT cause writeHandoff to fail`

**learnings-promoter.test.ts** — `describe('Phase 14-07d promoted_to emission', ...)`:
- `single-source promotion: promoted_to soft_link emitted`
- `multi-source aggregate promotion: no link, soft_link_skipped telemetry`

**highlights-extractor.test.ts** — `describe('Phase 14-07d extracted_from emission', ...)`:
- `successful extraction with N highlights: N extracted_from soft_links emitted`
- `degraded extraction: no soft_links emitted`

Preserve all existing tests.
  </action>
  <verification>
- New describe blocks added in 3 test files; all new tests pass.
- All pre-existing tests in these files still pass.
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/intelligence/soft-link-writers.test.ts` — 12 tests pass.
- `npx vitest run src/tests/angel/handoff-writer.test.ts src/tests/intelligence/learnings-promoter.test.ts src/tests/angel/highlights-extractor.test.ts` — new + existing tests pass.
- `npx vitest run` — full suite green.
  </action>
  <verification>
- Build green.
- 12 + ~8 (instrumentation tests) = ~20 new tests pass.
- Full suite green.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `src/intelligence/soft-link-writers.ts` exports 4 site helpers with the documented contract.
- AC-2: Each helper wraps writeSoftLink with try/catch + telemetry on failure/skip.
- AC-3: handoff-writer instrumented; supersedes soft_link emitted after successful writeHandoff.
- AC-4: learnings-promoter instrumented; promoted_to soft_link emitted after successful promotion.
- AC-5: highlights-extractor instrumented; extracted_from soft_links emitted per highlight.
- AC-6: retrieval-log instrumented; references soft_links emitted per log entry.
- AC-7: All primary write contracts unchanged — same signatures, same returns.
- AC-8: Soft-link emission failure does NOT roll back the primary write.
- AC-9: Skipped emissions (no prior, multi-source, etc.) emit soft_link_skipped telemetry.
- AC-10: All ~20 new tests pass.
- AC-11: No regression in v6.6.0 + Wave 1 + LINKS-SCHEMA test baseline.
</acceptance_criteria>

<risks>
- **Risk 1: Prior-handoff lookup query is slow.** For projects with many handoffs, the "find most recent prior" query scans the artifact table. Mitigation: V17 artifact has an index on (project, kind, created_at_epoch_ms); the query uses it. Performance acceptable for project sizes seen in practice.
- **Risk 2: V17 ID lookup for observation in learnings-promoter requires schema alignment.** If learnings-promoter receives an in-memory observation object (not a DB ID), V17 ID resolution may need an extra query. Mitigation: learnings-promoter post-Wave-1 already operates on V17 IDs (per 14-07b's caller migration); this plan does not change that flow.
- **Risk 3: Highlight extraction emits many links.** With ~10 highlights per session frame, the bulk extracted_from emission adds 10 writes per extraction. Mitigation: per-write overhead is small (single INSERT + UNIQUE check); acceptable at production scale.
- **Risk 4: Telemetry write failure cascades.** If the telemetry helper itself errors, the link emission could throw despite the wrap. Mitigation: telemetry calls wrapped in try/catch INSIDE the helper; telemetry failure logs to console only.
- **Risk 5: Operator notices soft_link_skipped telemetry as noise.** First-handoff-for-project emits a skip telemetry. Over many projects this accumulates. Mitigation: skipped events are low-severity; telemetry sweep can prune; documentation notes this is expected.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Site helper error handling — does any path throw when it shouldn't?
- (b) Primary write isolation — is the soft-link emission truly post-write (no race with the primary write's transaction)?
- (c) FK constraint handling — does the FK violation surface correctly via telemetry?
- (d) Cascade behavior — would a failure in soft-link emission ever block production traffic?

NO-SIGNOFF triggers PM escalation.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (~20 new tests across helper + site-instrumentation files).
3. Live-wiring smoke: an actual writeHandoff invocation against a test DB confirms supersedes emission.
4. No "MVP" shortcuts — non-blocking soft-link emission with explicit telemetry on every skip/fail is the production-quality pattern.
5. Negative results valid: if any site's link emission reveals an unexpected coupling problem, surface to PM.
6. Cross-family external review.
7. No time estimates.
</methodology_gates>
