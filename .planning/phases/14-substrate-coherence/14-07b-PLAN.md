---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07b
type: execute
wave: 1
depends_on: ["07a"]
files_modified:
  # Retrieval cluster (W1)
  - src/core/hybrid-retrieval.ts            # 8 sites — L3 retrieval centerpiece
  - src/intelligence/retrieval-feedback.ts  # 5 sites — activation_score lifecycle
  - src/intelligence/experience-tier.ts     # 1 site — candidate pool query
  # Ingestion / embedding cluster (W2)
  - src/core/file-ingester.ts               # 2 sites — INSERT memory_file/session_log/handoff/entity_summary
  - src/embeddings/embed-pipeline.ts        # 2 sites — UPDATE embedding (storage shape change)
  - src/embeddings/sqlite-vec-backend.ts    # 1 site — JOIN to vec sidecar
  # Query-surface cluster (W3)
  - src/mcp/recall-server.ts                # 2 sites — exposed via claudex_recall
  - src/core/cross-project-search.ts        # 1 site — claudex_search expansion
  - src/core/observations.ts                # 1 site — SELECT artifact_ref
  # Angel writers cluster (W4)
  - src/angel/consolidator.ts               # 1 site — UPDATE consolidated_into
  - src/angel/retention-sweep.ts            # 1 site — DELETE / UPDATE (TTL enforcement)
  - src/angel/entity-summarizer.ts          # 1 site — INSERT entity_summary
  - src/intelligence/intent-predictor.ts    # 1 site — per-turn prediction
  - src/intelligence/batch-reflection.ts    # 1 site — SELECT id (dedup) for learning promotion
  # CLI + tests cluster (W5)
  - src/cli/health.ts                       # 1 site — INSERT (test fixture)
  - src/tests/helpers/v7-unified-schema.ts (NEW)
  - src/tests/** (general sweep — fixture seeds + caller adjacent tests)
  # NOTE: Excluded from W1-W5 — migration-aware (handled by 14-07a)
  # - src/core/migration-steps.ts (4 sites — already migration-aware)
  # NOT in W1-W5 — these files are V17 callers (per RCA-3), not legacy callers:
  # - src/intelligence/directive-detector.ts (kind='directive_rule' against V17)
  # - src/intelligence/retrieval-log.ts (kind='transcript_chunk' against V17)
  # - src/angel/transcript-chunker.ts (INSERT against V17)
  # - src/angel/memory-md-writer.ts (V17 guard SELECT only — 1 site)
autonomous: true
parallel_workers: ["W1", "W2", "W3", "W4", "W5"]
requirements: []

must_haves:
  truths:
    - "All ~22 caller sites against the legacy `artifacts` API are migrated to the V17 unified API. Read paths use `lookupV17ByLegacy` from 14-07a's `src/core/artifact-id-map.ts` as the transitional bridge when a caller still receives a legacy INTEGER ID externally; write paths go DIRECTLY to V17 with TEXT IDs."
    - "No worker introduces net-new caller sites or net-new code paths. If a worker discovers an unmigrated site missing from the inventory below, the site is added to the worker's slice and migrated. The worker does NOT add new code paths, new query types, or new candidate sources."
    - "No worker changes hybrid-retrieval ranking math, BGE-v2-m3 reranker config, arctic-embed2 model, vector dimensions, candidate-pool composition, or query expansion logic. Per CONTEXT out-of-scope. If a worker is tempted to optimize during migration, STOP and surface to PM."
    - "Workers commit on dedicated feature branches: B1 → `phase-14-07/b1-retrieval`, B2 → `phase-14-07/b2-ingest`, B3 → `phase-14-07/b3-writer-tests`. Each branch is merged independently after AC-green per worker."
    - "memory-md-writer.ts is owned by B3 only. If B1 or B2 discover a memory-md-writer site during their caller sweep, they STOP, file the site to B3 via integration-branch comment, and wait for B3 to handle it."
    - "B3 owns the shared test-fixture helper `src/tests/helpers/v7-unified-schema.ts` (NEW). B1 and B2 consume it for their test fixtures; only B3 modifies it."
    - "Each worker's existing tests stay green; new tests cover the V17 path explicitly. Test counts go up, not down."
    - "Migrated read paths return data of identical SHAPE as before the migration (same fields, same types). Internal representation changes from legacy INTEGER ID + sidecar tables to V17 TEXT ID + unified shape; external callers see no shape diff."
    - "Site inventory below is the working list. Exact site counts may shift +/-2 during execution as workers discover variations. The total stays under 26 sites; if it exceeds 26, surface to PM (likely an inventory miss)."
  artifacts:
    - path: "src/core/hybrid-retrieval.ts"
      provides: "Hybrid retrieval calling V17 unified artifact API (8 sites migrated). Behavior unchanged externally."
      contains: "V17|artifact_id_map|lookupV17ByLegacy"
    - path: "src/intelligence/retrieval-feedback.ts"
      provides: "Retrieval feedback writing to V17 unified artifact (5 sites migrated)."
      contains: "V17|artifact_id_map"
    - path: "src/core/file-ingester.ts"
      provides: "File ingester writing artifacts to V17 unified shape (2 sites migrated)."
      contains: "V17"
    - path: "src/intelligence/directive-detector.ts"
      provides: "Directive detector reading from V17 unified shape."
      contains: "V17"
    - path: "src/intelligence/retrieval-log.ts"
      provides: "Retrieval log writing to V17 (no legacy writes after 14-07b lands)."
      contains: "V17"
    - path: "src/angel/transcript-chunker.ts"
      provides: "Transcript chunker writing chunks under V17 artifact references."
      contains: "V17"
    - path: "src/angel/memory-md-writer.ts"
      provides: "MEMORY.md writer reading from V17 unified shape (B3 owns)."
      contains: "V17"
    - path: "src/tests/helpers/v7-unified-schema.ts"
      provides: "Shared fixture helper for post-Wave-1 unified schema. Other workers consume; B3 owns."
      contains: "seedV7Artifact|seedV7ArtifactWithEmbedding|migrateFixtureV36toV37"
  key_links:
    - from: "every migrated read site"
      to: "src/core/artifact-id-map.ts (lookupV17ByLegacy, lookupLegacyByV17)"
      via: "Transitional bridge for legacy IDs received from external boundaries during the transition window"
      pattern: "lookupV17ByLegacy"
    - from: "every migrated write site"
      to: "V17 unified artifact insert/upsert"
      via: "Direct write to V17 artifact + vec_artifact_v17 + artifact_fts_v17"
      pattern: "INSERT INTO artifact"
---

<objective>
Caller migration sweep across ~22 sites. Three workers fan out in parallel (B1: retrieval cluster, B2: ingestion cluster, B3: writer + tests cluster) per `14-07-WAVE1-COORDINATION.md`'s file-ownership table.

**Migration shape per site:**
- Read paths: replace legacy `artifacts` SELECT with V17 unified SELECT; use `lookupV17ByLegacy` only when an external boundary delivers a legacy INTEGER ID.
- Write paths: INSERT/UPSERT into V17 `artifact` + `artifact_fts_v17` + `vec_artifact_v17` (via existing v17-triggers).
- Test fixtures: migrated to seed V7 unified schema via `src/tests/helpers/v7-unified-schema.ts`.

After this plan lands:
- All ~22 caller sites read/write the unified shape.
- Legacy `artifacts` table is still alive but receives no new writes from production code.
- Test suite passes against the V37 schema.
- Wave 1c (cutover + benchmarks) can dispatch.

| What this plan provides | Why |
|---|---|
| All retrieval-side reads on V17 | Hybrid retrieval, retrieval feedback, directive detector |
| All ingestion-side writes on V17 | File ingester, transcript chunker, retrieval log |
| MEMORY.md writer on V17 | Closes the writer side of the unified shape |
| Shared test-fixture helper | Workers don't reinvent V7-unified seeding |
| No regression in test suite | Behavioral equivalence post-migration |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE1-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07a-PLAN.md
@context/measurements/2026-05-15-substrate-rcas.md
@src/core/artifact-id-map.ts
@src/core/hybrid-retrieval.ts
@src/intelligence/retrieval-feedback.ts
@src/core/file-ingester.ts
</context>

<anti_scope>
- Do NOT change hybrid-retrieval ranking math, scoring weights, candidate-pool composition, BGE reranker config, query expansion logic, or arctic-embed2 model.
- Do NOT introduce new candidate sources or new query types.
- Do NOT touch link tables (Wave 2 / `14-07-LINKS-SCHEMA-PLAN.md` territory). If a site "wants" linking semantics, leave a TODO comment and move on.
- Do NOT touch session-start assembler sections (`src/assembly/sections.ts`) — Wave 3 territory.
- Do NOT touch experience-tier project-scope filter — Wave 3 / 14-07h territory.
- Do NOT touch session-start codebase-context formatter — Wave 3 / 14-07i territory.
- Do NOT refactor adjacent code "for cleanup." Per `memory/feedback_same_family_teammates_blind_spots.md`, same-family blind spots cause silent scope creep. Operator surfaces if cleanup needed.
- Do NOT modify schema-version constants or schema migration steps. 14-07a owns those.
- B1 and B2 do NOT touch `src/angel/memory-md-writer.ts` — B3-only territory.
- B1 and B2 do NOT modify `src/tests/helpers/v7-unified-schema.ts` — B3-only territory.
- Do NOT add cutover logic, read-only flag flip, or benchmark code — 14-07c territory.
- Do NOT auto-drop or auto-truncate the legacy `artifacts` table.
</anti_scope>

<tasks>

<task type="auto" worker="B1">
  <name>Task B1.1: Migrate hybrid-retrieval.ts (8 sites)</name>
  <files>src/core/hybrid-retrieval.ts</files>
  <action>
Enumerate 8 call sites against legacy `artifacts` and migrate each to V17 unified `artifact` table. Each site preserves the EXTERNAL CONTRACT of the calling function (same return shape, same parameters) and only switches the internal data source.

Per-site shape:
- SELECT … FROM artifacts WHERE … → SELECT … FROM artifact WHERE …
- FTS5: `artifact_fts MATCH …` → `artifact_fts_v17 MATCH …`
- vec0: `vec_artifacts.distance` → `vec_artifact_v17.distance`
- Where a function receives a legacy INTEGER ID from an external boundary (e.g., older test fixtures), bridge via `lookupV17ByLegacy(db, legacy_id)` before the V17 query.
- WHERE clause project scoping: V17 column is also `project` (post-14-02 from v6.6.0), so no rename needed.

For each migrated site:
- Add an inline comment `// 14-07b: migrated from legacy artifacts` so reviewers can grep.
- Verify the function's return shape is unchanged via the existing test (pre-migration baseline).
  </action>
  <verification>
- 8 sites migrated; `grep -n 'FROM artifacts\b' src/core/hybrid-retrieval.ts` returns 0 matches.
- `grep -n 'artifact_fts\b' src/core/hybrid-retrieval.ts` returns 0 matches (only `artifact_fts_v17`).
- Each migrated site has the `// 14-07b: migrated from legacy artifacts` marker.
- Existing tests pass without modification (behavioral equivalence).
  </verification>
</task>

<task type="auto" worker="B1">
  <name>Task B1.2: Migrate retrieval-feedback.ts (5 sites)</name>
  <files>src/intelligence/retrieval-feedback.ts</files>
  <action>
Same migration shape as B1.1, applied to retrieval-feedback's 5 sites. Read AND write paths in this file — the feedback writer that records retrieval signals into the artifact substrate must write to V17 directly.

Write-path specifics: when feedback writes a new artifact row (e.g., a "retrieval_signal" kind), INSERT INTO `artifact` with V17 TEXT id generated via `generateV17IdFromLegacy({ legacy_id: -1, ... })` or by hashing the signal payload. **Position-unless-flagged:** I lean on hashing the payload (`sha256(signal_kind + project + content + timestamp).slice(0,32)`) rather than calling generateV17IdFromLegacy with a synthetic legacy_id, because the latter is overloading a transition helper for a non-transitional case. If PM flags this, the alternative is a small `generateV17IdFromPayload` helper in `src/core/artifact-id-map.ts` (additive, would be a B1 → 14-07a callback).
  </action>
  <verification>
- 5 sites migrated.
- New artifact rows written by retrieval-feedback are visible in V17 `artifact` table.
- Existing tests pass.
- Feedback signals retrievable via V17 hybrid retrieval.
  </verification>
</task>

<task type="auto" worker="B2">
  <name>Task B2.1: Migrate file-ingester.ts (2 sites)</name>
  <files>src/core/file-ingester.ts</files>
  <action>
Two write-path sites. The file ingester reads file content from the operator's workspace, extracts substantive artifacts (per the post-14-03 isSubstantive predicate), and writes them. After migration, writes go DIRECTLY to V17 `artifact` with TEXT IDs.

Per-site shape:
- INSERT INTO artifacts (...) VALUES (...) → INSERT INTO artifact (id, kind, project, summary, body, created_at_epoch_ms, data) VALUES (...).
- `id` derived via `sha256(file_path + content_hash + project).slice(0, 32)` — deterministic per content.
- `kind` = the existing legacy `artifact_type` value preserved (no enum changes).

No change to isSubstantive filter behavior; just the write target.
  </action>
  <verification>
- 2 sites migrated.
- Ingestion writes appear in V17 `artifact` (not legacy `artifacts`).
- Existing file-ingester tests pass.
  </verification>
</task>

<task type="auto" worker="B2">
  <name>Task B2.2: Migrate directive-detector.ts</name>
  <files>src/intelligence/directive-detector.ts</files>
  <action>
Read-path sites. Directive detector currently queries legacy artifacts for prior directives. Switch to V17 unified queries.

Enumerate exact sites during execution (estimate: 1-3 sites). Each site:
- SELECT FROM artifacts → SELECT FROM artifact
- Project scoping unchanged (column name is `project`).

If the detector currently joins against `artifact_fts`, switch to `artifact_fts_v17`.
  </action>
  <verification>
- All directive-detector legacy `artifacts` references migrated to V17.
- Existing directive-detector tests pass.
  </verification>
</task>

<task type="auto" worker="B2">
  <name>Task B2.3: Migrate retrieval-log.ts</name>
  <files>src/intelligence/retrieval-log.ts</files>
  <action>
Write-path: retrieval log writes to V17 `artifact` for any artifact-shaped logging events. Read-path: log queries for prior retrieval-log entries hit V17.

Per-site shape per B1.1.
  </action>
  <verification>
- All retrieval-log legacy `artifacts` references migrated.
- Existing retrieval-log tests pass.
  </verification>
</task>

<task type="auto" worker="B2">
  <name>Task B2.4: Migrate transcript-chunker.ts</name>
  <files>src/angel/transcript-chunker.ts</files>
  <action>
Write-path: transcript chunker writes chunks. Post-14-02 (v6.6.0), `transcript_chunk_v6` already uses V17 conventions. The remaining legacy `artifacts` references in this file are for cross-referencing parent artifacts — switch those to V17.
  </action>
  <verification>
- transcript-chunker legacy `artifacts` references migrated.
- Existing transcript-chunker tests pass.
  </verification>
</task>

<task type="auto" worker="B3">
  <name>Task B3.1: Create shared fixture helper</name>
  <files>src/tests/helpers/v7-unified-schema.ts</files>
  <action>
New file. Exports test helpers that seed V7-unified-schema rows. Used by B1, B2, and B3's test files.

```typescript
import type { Database } from 'better-sqlite3';
import { generateV17IdFromLegacy, populateAllMappings } from '../../core/artifact-id-map.js';

/**
 * Seed a V17 artifact row directly (no legacy bridge).
 * Returns the V17 TEXT id.
 */
export function seedV7Artifact(db: Database, fields: {
  kind: string;
  project: string;
  summary: string;
  body: string;
  created_at_epoch_ms?: number;
  data?: object;
}): string;

/**
 * Seed a V17 artifact AND populate vec_artifact_v17 with a fixture vector.
 * Used by tests that exercise hybrid retrieval.
 */
export function seedV7ArtifactWithEmbedding(db: Database, fields: {
  kind: string;
  project: string;
  summary: string;
  body: string;
  vector: Float32Array;
  created_at_epoch_ms?: number;
}): string;

/**
 * Test-side helper: migrate a fixture-shaped V36 DB to V37 in place.
 * Runs migrateV36toV37 + populateAllMappings.
 * Used by tests that start from a legacy-shaped fixture.
 */
export function migrateFixtureV36toV37(db: Database): void;
```
  </action>
  <verification>
- File exists with the three exports.
- All three exports have at least one consumer in B1/B2/B3 tests.
- Helper tests cover the happy path.
  </verification>
</task>

<task type="auto" worker="B3">
  <name>Task B3.2: Migrate memory-md-writer.ts</name>
  <files>src/angel/memory-md-writer.ts</files>
  <action>
Read-path sites. memory-md-writer reads from the artifact substrate to populate MEMORY.md. Switch all legacy `artifacts` references to V17 `artifact`.

Estimate: 1-2 sites (per RCA-3). Project-scope filtering unchanged.

If B1 or B2 filed any memory-md-writer sites during their sweep, address them here.
  </action>
  <verification>
- memory-md-writer legacy `artifacts` references migrated.
- MEMORY.md output for claudex-v3 fixture is byte-equivalent pre/post migration (behavioral equivalence).
- Existing memory-md-writer tests pass.
  </verification>
</task>

<task type="auto" worker="B3">
  <name>Task B3.3: Test-fixture sweep across src/tests/**</name>
  <files>src/tests/**/*.test.ts, src/tests/**/*.ts</files>
  <action>
Sweep through `src/tests/` for tests that:
- Seed legacy `artifacts` rows directly via raw SQL → migrate to `seedV7Artifact` helper.
- Reference `artifact_fts` / `vec_artifacts` directly → migrate to `_v17` variants.
- Hand-roll schema setup that should use `migrateFixtureV36toV37` instead.

This is a sweep — workers B1 and B2 only migrate test files in their own caller's adjacent tests. B3 migrates everything else, plus any global fixture references in `src/tests/helpers/*` (besides v7-unified-schema.ts which B3 just created).

Be surgical: do not modify test ASSERTIONS, only test SETUP / SEEDING.
  </action>
  <verification>
- `grep -rn 'FROM artifacts\b' src/tests/` returns 0 matches in test source files (only in fixture data that doesn't reach the DB).
- `grep -rn 'CREATE TABLE artifacts\b' src/tests/` returns 0 matches (test setup uses migrateFixtureV36toV37).
- Full test suite passes.
  </verification>
</task>

<task type="auto" worker="ALL">
  <name>Task Final: Integration merge + build + full test suite</name>
  <files></files>
  <action>
After all 3 workers signal AC-green on their branches, PM merges in order B1 → B2 → B3 to integration branch `phase-14-07/wave1-integration`. Then:

- `bun run build` — must succeed.
- `npx vitest run` — full suite. Expected: same green count as v6.6.0 baseline, plus the +35 from 14-07a, plus new tests added per worker (B1: at least 2 V17-path tests, B2: at least 3, B3: at least 3 + shared fixture tests). Net new tests: ~+45 from 14-07b.
- `grep -rn 'FROM artifacts\b' src/` returns 0 matches in production code (excluding `src/core/migration/`).
- `bun run vesna` — SC#1 PASS 18/18 (this is a smoke; 14-07c is the formal gate).
  </action>
  <verification>
- Build green.
- Full test suite green (no new regressions outside known llama-* baseline).
- Production-code grep clean.
- vesna smoke passes.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: All 8 `hybrid-retrieval.ts` sites migrated; grep returns 0 legacy `artifacts` references in this file.
- AC-2: All 5 `retrieval-feedback.ts` sites migrated.
- AC-3: All `file-ingester.ts`, `directive-detector.ts`, `retrieval-log.ts`, `transcript-chunker.ts` legacy references migrated.
- AC-4: All `memory-md-writer.ts` legacy references migrated.
- AC-5: `src/tests/helpers/v7-unified-schema.ts` exists, exports the three documented helpers, is consumed by tests across B1/B2/B3 clusters.
- AC-6: Test-fixture sweep complete — grep returns 0 legacy `FROM artifacts` or `artifact_fts` (without _v17) references in production code and in test setup logic.
- AC-7: Full test suite passes with the same green count as v6.6.0 baseline plus the +35 (14-07a) + ~+45 (14-07b) = ~+80 new tests.
- AC-8: `bun run vesna` SC#1 passes 18/18 as a Wave 1 smoke (formal gate at 14-07c).
- AC-9: No worker changed hybrid-retrieval ranking math, candidate-pool composition, or query logic. Codex + Gemini review confirms behavioral-equivalence claim.
- AC-10: No worker introduced net-new code paths or new candidate sources.
- AC-11: Read-paths use `lookupV17ByLegacy` only at external boundary sites (where a legacy INTEGER ID is delivered from outside). Internal queries go straight to V17.
- AC-12: Write-paths INSERT directly into V17 `artifact` with TEXT IDs. No legacy `artifacts` INSERT or UPDATE remains in production code (outside `src/core/migration/`).
</acceptance_criteria>

<risks>
- **Risk 1: A worker discovers a site missed by RCA-3's inventory.** Mitigation: the worker migrates it, files it to PM via WAVE1 integration branch comment. If the total site count exceeds 26, PM escalates (likely an inventory miss; may need PO review of scope).
- **Risk 2: Two workers touch the same file accidentally.** Mitigation: file-ownership table in WAVE1-COORDINATION is strict; PM resolves boundary disputes. If a file isn't listed, normal git merge applies.
- **Risk 3: A migrated read site returns subtly different data shape.** Mitigation: behavioral-equivalence test in each worker — pre-migration baseline of return shape captured; post-migration shape compared byte-by-byte (for primitive types) or structurally (for objects). Any drift surfaces as a test failure.
- **Risk 4: Test-fixture migration breaks tests for reasons orthogonal to V17.** Mitigation: B3's sweep is surgical (setup-only, not assertions). If a test fails after fixture migration AND it's not due to V17 shape, surface as a real bug discovered by the migration.
- **Risk 5: Worker B1's retrieval-feedback write path introduces V17 ID derivation pattern (`sha256(payload)`) that differs from 14-07a's transition helper.** Documented as a position-unless-flagged in Task B1.2. If PM flags, alternative is to extend `src/core/artifact-id-map.ts` with `generateV17IdFromPayload` (additive; coordinated callback to 14-07a's owner).
- **Risk 6: Behavioral equivalence is hard to prove for tests that were already failing before migration.** Mitigation: baseline the test failures pre-migration in `14-07-WAVE1-STATUS.md`; only NEW failures (not pre-existing) count as regressions.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Behavioral equivalence — does any migrated site change observable behavior?
- (b) lookupV17ByLegacy usage — used only at external boundaries, never as internal shortcut?
- (c) No new ranking-side changes — confirm via diff inspection that hybrid-retrieval scoring is byte-equivalent.
- (d) Test-fixture sweep correctness — fixtures use the shared helper, no hand-rolled legacy seeds remain.
- (e) Site count completeness — does the total of 22+/-2 sites match the diff?

NO-SIGNOFF triggers PM escalation per WAVE1-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above before any code (this plan satisfies).
2. Tests written alongside code — new V17-path tests in each worker's slice, ~+45 net new tests.
3. Live-wiring smoke: `bun run vesna` SC#1 PASS as Wave 1 smoke; full formal gate at 14-07c.
4. No "MVP" shortcuts — behavioral-equivalence is the production-quality guarantee.
5. Negative results valid: if a discovered site reveals an architectural problem (e.g., a caller that "needs" link semantics), surface to PM and operator. Do NOT silently extend scope.
6. Cross-family external review per the gate above.
7. No time estimates anywhere. Relative sizing only.
</methodology_gates>
