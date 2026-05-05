# Phase 4: Angel reduction — Context

**Gathered:** 2026-05-05
**Status:** Ready for planning
**Type:** engineering (with code-trace prerequisite)

<domain>
## Phase Boundary

Delete extraction-time pattern creation across the production code path so the v5 thesis claim 4 ("extraction-time pattern creation is dead under v5") becomes structurally true. Trace dependencies of `src/angel/pattern-extractor.ts` and the `experience_patterns` table; preserve readers as legacy-with-TODO; do not re-point at episode-based fusion (Phase 3 was dropped). Angel's role becomes binding + indexing on Phase 1's substrate, not abstraction. The 88 inflated rows in `experience_patterns` stay untouched (Phase 7 owns retirement direction).

The phase is named "Angel reduction" historically — the survey expanded the deletion scope beyond Angel to two additional sites (hook-side `experience-scoring.ts`, heartbeat-side LLM merge synthesis). The principle is applied uniformly: any code path that creates a new abstraction at write time from N=1 inputs (or from already-extracted abstractions) is killed. The phase name stays; CONTEXT explicitly documents the scope expansion so future readers see the surveyed-vs-shipped delta.

**Out of scope** (belongs in other phases):
- Re-pointing readers at episode-based fusion (was Phase 3, dropped 2026-05-05)
- Replacing `experience_warning_triggers` reader surface (Phase 7)
- Density-clustering / inferred-pattern surfaces (was Phase 5, dropped 2026-05-05)
- Retiring the 88 existing `experience_patterns` rows (Phase 7 — drop / project / keep)
- v4 hybrid-retrieval changes (production retrieval stays as-is)

**Reframe references:** `.planning/reframes/2026-05-05-multi-handle-kill.md`, ROADMAP.md Phase 4 entry, PROJECT.md claim 4.

</domain>

<decisions>
## Implementation Decisions

### Three extraction sites must die (the load-bearing kill)

**Site A — Angel-side, LLM-driven (the obvious site, named in ROADMAP)**
- File: `src/angel/pattern-extractor.ts`
- Function: `extractPatternsFromSession` (line 554)
- Caller: `src/angel/heartbeat.ts:306`
- Mechanism: Reads `conversation_turns`, prompts Gemma via `callLocalLLM`, parses JSON, writes `createPattern` (line 682) + `createTipAndStrategy` (line 711) per extracted item.
- The 0d0fbca Mem0 fix (`stripInjectedBlocks` + `INJECTED_BLOCK_TAGS`) lives here.

What dies in this module: `extractPatternsFromSession`, `formatTranscript`, `EXTRACTION_SYSTEM_PROMPT`, `DIRECTIVE_INDICATORS`, `extractDirectiveCandidates`, `findCrossSessionDirectives`, `reviewCandidatePatterns`, `measureSessionOutcome`, `bridgeCorrectionToSkill`, `stripInjectedBlocks`, `INJECTED_BLOCK_TAGS`, `getSessionTurns` (extractor's transcript loader).

What survives in this module: `classifySessionDomains` (line 756) and `extractDomain` import — these write to `capability-tracker` (`recordDomainInteraction`), NOT to `experience_patterns`. Domain classification IS binding/indexing on Phase 1 substrate per the reframe. Extracted to a new module `src/angel/domain-classifier.ts`. `heartbeat.ts:327` re-imports from new location.

**Site B — Hook-side, heuristic-driven (NOT named in ROADMAP — discovered during survey)**
- File: `src/intelligence/experience-scoring.ts`
- Function: `applyExperienceFeedback` step 1 (lines 64–112)
- Caller: `src/adapters/cc-hooks/stop.ts`
- Mechanism: On `correction_flagged=true`, calls `extractLessonFromUserCorrection` / `extractPatternFromAssistantText` (regex), then `createPattern` (line 98).

What dies: step 1's pattern-extraction block (lines 64–112), its `createPattern` import, `extractLessonFromUserCorrection` + `extractPatternFromAssistantText` (functions in `intelligence/correction-detection.ts`).

What survives in `applyExperienceFeedback`: step 2 (topic-aware score feedback on already-existing patterns) and step 3 (flag rotation). Both read existing rows and update `score`/`confidence`/`maturity`/`needs_reembed` — that's binding/indexing on existing data, NOT extraction-time creation.

What survives in `correction-detection.ts`: `findCausalEvent`, `storeCausalAttribution`, `detectCorrectionSignal`. Causal trace and linguistic signal detection are not extraction.

**Site C — Heartbeat-side, LLM-merge synthesis (also discovered during survey)**
- File: `src/angel/heartbeat.ts`
- Block: lines 1090–1149 (the merge/synthesis loop inside the heartbeat tick)
- Mechanism: Selects up to 10 high-score `experience_patterns`, calls `findSimilarPatterns` for each, then `callLocalLLM` to synthesize a new abstract principle (`synthesizedLesson`), DELETEs absorbed rows, UPDATEs the target's `lesson` with the synthesized text, absorbs scores.

What dies: lines 1110–1124 (the LLM synthesis call and `synthesizedLesson` write). The `lesson` UPDATE at line 1140–1144 also dies (it only fired when `synthesizedLesson !== target.lesson`).

What survives: lines 1090–1109 + 1126–1138 + 1147–1149 (the dedup/score-absorption mechanics — finding similar rows, DELETEing absorbed ones, UPDATing `score = score + ?` on the target). Pure cleanup, no new content generated. The `findSimilarPatterns` call survives because it's read-only vector search.

Phase-name fit: this third site lives in `src/angel/heartbeat.ts`, so "Angel reduction" actually fits Site C better than the original Site A/B framing. Naming hygiene improves rather than degrades.

### Survey gaps explicitly recorded

The original ROADMAP Phase 4 entry named only Site A. Survey added Site B and Site C. CONTEXT records this so future readers see surveyed-vs-shipped delta. If at user-approval gate the phase name gets revised to something broader (e.g., "Strip extraction-time pattern creation"), it's a 30-second ROADMAP edit; not a blocker.

### Reader policy per consumer (legacy-with-TODO unless noted)

All consumers below get a uniform comment near their main SELECT:

```
// Reads experience_patterns (pre-Phase-4 legacy table). Phase 4 stopped
// new INSERTs (V28 trigger blocks them). Phase 7 owns retirement direction
// — drop / project / keep. See .planning/reframes/2026-05-05-multi-handle-kill.md.
```

Greppable via "Phase 4 stopped new INSERTs" — single search returns the full surface map.

Consumers receiving the comment (no code change beyond the comment unless noted):
- `src/assembly/assembler.ts:200–248` — P1.5/P4.1 injection tier reader. UPDATEs `confidence` and `needs_reembed` on read (reconsolidation pattern). UPDATEs are unaffected by V28 INSERT-only trigger.
- `src/angel/heartbeat.ts:380–403` — pruning + auto-verification of existing rows (SELECT + DELETE).
- `src/angel/heartbeat.ts:1030–1089` — retrieval-mode promotion (saturated→categorical, proven→always). UPDATEs `retrieval_mode` only.
- `src/intelligence/trigger-engine.ts` — trigger-time injection decision reader.
- `src/intelligence/contradiction-detector.ts` — contradiction detection reader.
- `src/intelligence/outcome-tracker.ts` — outcome reinforcement reader + UPDATE on `score`.
- `src/embeddings/sqlite-vec-backend.ts:386–396` — embedding pipeline reader.
- `src/embeddings/embed-pipeline.ts:208` — UPDATEs `embedding` column on existing rows.
- `src/mcp/recall-server.ts` — FTS5 search.
- `src/adapters/cc-hooks/stop.ts:323` — `applyExperienceFeedback` step 2 reader (already locked in Site B above as surviving).

Keep-as-is without TODO (infrastructure that survives v5 unchanged regardless of Phase 7 retirement direction):
- `src/intelligence/experience-patterns.ts` — function library. Function-level JSDoc tombstone on `createPattern` per cutoff signal Layer 1; rest of the module stays.
- `src/core/schema.ts` / `src/core/migrations.ts` — schema/migration infra.

No reader is re-pointed at `episodic_events`. The reframe explicitly excludes this (was Phase 3).

### Existing data fate

Leave the 88 `experience_patterns` rows untouched in Phase 4. Phase 7's MIG-* requirements own retirement direction (per ROADMAP Phase 7 line: "experience_patterns (88 rows, inflated): retire — Phase 4 stops new instances; reads stay live during deprecation"). Phase 4 stops new INSERTs; existing rows stay readable so legacy readers don't blow up mid-deprecation. Touching the rows in Phase 4 would foreclose Phase 7 options.

### Cutoff signal & deprecation marker (3-layer)

V4 history shows regression-shaped patterns warrant layered defense, not a single deterrent:
- v4 Phase 4 (`MEMORY.md curation`) closed 2026-04-26 with "visible content regressions verified by audit T1"; Phase 4.1 superseded it
- PROJECT.md Q8 (benchmarks dropped): "Re-introducing is the failure mode replaying"
- The 88 inflated rows themselves are evidence — they accumulated under code-level fix (0d0fbca) without structural guard

**Layer 1 (code) — JSDoc tombstone**
- File: `src/intelligence/experience-patterns.ts`
- Module-level header + function-level JSDoc on `createPattern` (the function survives, exported for fixtures/migrations/Phase-7 retirement work).
- Body in module header, abbreviated on `createPattern`. Points at `.planning/reframes/2026-05-05-multi-handle-kill.md`.
- `createTipAndStrategy` deleted entirely with Site A (orphaned writer).

**Layer 2 (test) — `extraction-deleted.test.ts`**
- New file: `src/tests/intelligence/extraction-deleted.test.ts`
- Asserts:
  (a) `applyExperienceFeedback` against `correction_flagged=true` does NOT increment `experience_patterns` row count
  (b) Heartbeat tick does NOT increment `experience_patterns` row count even with seeded conversation_turns containing correction-shaped content
  (c) `classifySessionDomains` (the surviving Angel-side LLM call) does NOT write to `experience_patterns`
  (d) **Heartbeat tick MUST NOT modify `lesson` column on any `experience_patterns` row** — seed two similar high-score rows, run heartbeat tick, assert both rows' `lesson` strings byte-identical pre/post. Score-absorption UPDATEs on `helpful_count` / `harmful_count` / `times_triggered` remain allowed; the test does NOT assert those columns are unchanged.
- Together (a)+(b)+(c) catch resurrection of Sites A and B; (d) catches resurrection of Site C.

**Layer 3 (schema) — V28 migration**
- TEMP `session_pragmas(key TEXT PRIMARY KEY, value TEXT)` created at DB-connection-open time (one place — connection-open path in `src/core/migrations.ts` or `src/shared/db.ts`; planner picks exact wiring). Per-connection scope prevents stray writes leaking into shared state.
- General-purpose name (`session_pragmas`) — Phase 7 retirement work for `learning` / `decision` / `transcript_chunk` can reuse the same table with different keys; avoids `legacy_insert_overrides_for_X` proliferation.
- `BEFORE INSERT` trigger on `experience_patterns`:

  ```sql
  CREATE TRIGGER IF NOT EXISTS experience_patterns_insert_blocked
  BEFORE INSERT ON experience_patterns
  WHEN (SELECT value FROM temp.session_pragmas
        WHERE key='allow_legacy_pattern_insert' LIMIT 1) IS NULL
  BEGIN
    SELECT RAISE(FAIL,
      'experience_patterns is read-only legacy after Phase 4 (.planning/reframes/2026-05-05-multi-handle-kill.md). Set session_pragma allow_legacy_pattern_insert=1 only for tests, fixtures, or Phase 7 retirement work.');
  END;
  ```

- Test/fixture impact: ~1 line in `beforeEach` for `experience-patterns.test.ts`, `worker-context.test.ts`, `outcome-tracker.test.ts`, `experience-patterns-e2e.test.ts`. `extraction-deleted.test.ts` does NOT set the pragma — that's the whole point.
- No table rename in Phase 4. Phase 7 owns retirement direction; renaming now forecloses Phase 7 options (drop / project / keep).

### Test posture (regression-safe deletion)

**SC#1 (Vesna 17/17) is the canonical ship gate.** Confirmed structurally insensitive to extraction deletion: `src/benchmark/vesna/runner.ts:60–76` uses pre-seed → assemble → evaluate; grep across `src/benchmark/vesna/**` for extraction symbols returns ZERO matches. Probes never trigger extraction. Vesna 17 → 18 PASS post-Phase-4 (one new probe added).

**SC#3 (`bun run sc3`, ≥80% MEMORY.md content quality)** independent of extraction (built by `angel/memory-monitor.js` + curator). Sanity-check post-delete; expected unchanged.

**Camp I — "extraction must work" (delete file or rewrite as anti-extraction assertion):**
- `src/tests/angel/pattern-extractor.test.ts` — DELETE FILE. Tests a JSON parser used only by the deleted extractor.
- `src/tests/intelligence/experience-detection.test.ts` — SPLIT + RENAME → `correction-signal.test.ts`. Keep behavioral-signal half (`detectCorrectionSignal` + `withBehavioralBatch` / `applyFileEditIncrement` / `applyToolCallPattern` / `getBehavioralCounters`); delete extraction half (`extractPatternFromAssistantText` / `extractLessonFromUserCorrection` tests). Renaming preserves git blame via `git log --follow`.
- `src/tests/integration/experience-patterns-e2e.test.ts` — INVERT: keep file, narrow assertions, add explicit "row count unchanged after correction signal" assertion.
- `src/tests/intelligence/directive-detector-integration.test.ts` — UPDATE MOCK: `vi.mock` target moves from `'../../angel/pattern-extractor.js'` to `'../../angel/domain-classifier.js'`. Drop `extractPatternsFromSession` mock entry; the call-order assertion (directive-extraction-before-pattern-extraction) becomes "directive extraction is the only LLM call in this phase."
- `src/tests/angel/heartbeat.test.ts` — SAME mock update.

**Camp II — "extraction shouldn't leak" (regression guards — keep):**
- New `src/tests/intelligence/extraction-deleted.test.ts` (4 assertions per Layer 2 above).
- `src/tests/angel/heartbeat-regression.test.ts` — CONDITIONAL DELETE. The `definitiveOutcomes` regression list may itself be dead code in heartbeat post-edit; planner verifies during execution.

**Camp III — "binding/indexing surface that survives" (keep verbatim):**
- `src/tests/intelligence/experience-patterns.test.ts` — CRUD/scoring tests on the surviving function library.
- `src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts` — reactive trigger detectors (readers).
- `src/tests/intelligence/experience-tier.test.ts` — `assembleExperienceTier` (reader).
- `src/tests/assembly/worker-context.test.ts` — uses `createPattern` to seed fixtures.
- `src/tests/intelligence/outcome-tracker.test.ts` — outcome tracker (reader + score UPDATE).
- `src/tests/mcp/recall-server.test.ts` — FTS5 search (reader).
- `src/tests/angel/task-pattern-classifier.test.ts` — likely keep; planner confirms unrelated to extraction.

`createPattern` itself stays exported. Callers die; the function is preserved for fixtures, migrations, and Phase 7 retirement tooling. Its presence does NOT violate the parable; only its production-path call sites do.

**Vesna probe added in Phase 4 — SC-V5-2 / VAL-02:**
ROADMAP SC-V5-2: "Provenance-tagged write path makes the Mem0 feedback loop structurally impossible. Probe asserts injected-span content does not contribute to extracted artifacts. Validated against the post-Phase-4 codepath (extraction-time pattern creation deleted)."

The probe IS the Vesna-grade test of Phase 4's deliverable — adding it in Phase 4 means future contributors who try to reintroduce extraction get caught at `bun run vesna` immediately, not at the next Phase 7 ship-gate run. Suite goes 17 → 18 PASS as ship gate.

REQUIREMENTS.md VAL-02 phrasing already says "Validated against post-Phase-4 codepath" — the deliverable is Phase 4's, the probe verifies it. Phase 7's remaining 3 probes (VAL-01 episodic recall, VAL-03' KILL-regression, VAL-04 crash-resilience) depend on Phase 6/7 substrate, so they correctly land in Phase 7.

### Mem0 fix obsolescence

Delete the fix code (`stripInjectedBlocks` + `INJECTED_BLOCK_TAGS`) together with Site A. PROJECT.md: "Phase 4 makes the Mem0 fix from 0d0fbca structurally obsolete via extraction-time-pattern-creation deletion." Audit step at execution: grep for `INJECTED_BLOCK_TAGS` and `stripInjectedBlocks` — if anything outside the extractor imports them, preserve the imported subset and add a one-line tombstone comment in the surviving file pointing to `.planning/reframes/2026-05-05-multi-handle-kill.md`. Survey shows zero external imports today, so clean delete is expected.

### Approach: surgical delete, no feature-flag-first

Vesna 17/17 doesn't depend on extraction creating new rows (probes test recall over fixtures). Feature-flag-off === delete for Vesna purposes. Feature-flag-then-delete ships dead code through Phase 6+7, adding "what was this flag again?" cognitive load. Surgical delete concentrates risk at one commit where plan-checker + Vesna can stress it.

### Claude's Discretion (planner/executor decides)

- Exact wiring location for `temp.session_pragmas` table creation (connection-open path in `src/core/migrations.ts` vs. `src/shared/db.ts`).
- Whether `heartbeat-regression.test.ts` survives based on whether `definitiveOutcomes` is still referenced post-edit.
- Whether `task-pattern-classifier.test.ts` survives (likely yes; planner confirms it's unrelated to extraction).
- Per-file commit boundaries within the surgical-delete commit cluster.
- Exact JSDoc body wording (ballpark provided in this CONTEXT; tighten for tone at execution).
- Whether to rename phase from "Angel reduction" to broader name at user-approval gate (deferred; not a blocker).
- Whether `extractDomain` import survives in `domain-classifier.ts` standalone or moves to `intelligence/domain-extractor.ts` (planner picks).

</decisions>

<specifics>
## Specific Ideas

- Uniform legacy-comment text reused across all 10 reader sites — greppable single-source audit trail.
- `session_pragmas` named generically (not `experience_patterns_overrides`) so Phase 7 retirement work for other legacy tables (`learning`, `decision`, `transcript_chunk`) can reuse the same sidecar with different keys.
- Vesna probe SC-V5-2 lives in Phase 4 alongside `extraction-deleted.test.ts` — single source of truth for "extraction is dead."
- Score-absorption mechanics in heartbeat's merge loop (Site C remnant) survive intentionally — it's housekeeping, not abstraction. The narrow distinction between "synthesizing a new lesson string" (dies) and "summing scores across rows" (survives) is the parable's edge cleanly drawn.
- Phase name fit: Site C lives in `src/angel/heartbeat.ts`, so "Angel reduction" actually fits the third site better than the original Site A/B framing. Naming improves rather than degrades.

</specifics>

<deferred>
## Deferred Ideas

- **Table rename `experience_patterns` → `experience_patterns_legacy`** — too much for Phase 4 (touches every reader, disrupts FTS5 sync, forecloses Phase 7 options). Phase 7 picks rename / drop / project / keep.
- **ESLint rule banning `createPattern` imports** — considered, rejected: lint rules don't catch dynamic imports, generated code, or non-TS callers. V28 trigger is tighter.
- **Feature flag in `DEFAULT_CONFIG`** — considered, rejected: same antipattern as v4's deferred kills (a flag that "should be off in production" gets flipped on by future Claude debugging something).
- **Phase rename to broader "Strip extraction-time pattern creation"** — deferred to user-approval gate. 30-second ROADMAP edit if preferred; not a Phase 4 blocker.
- **Investigation of how the 88 inflated rows accumulated** (which were Mem0-trap, which were synthesis loop, which were legitimate corrections) — Phase 7 retirement work. Phase 4 stops new accumulation; Phase 7 decides what to do with what's there.
- **VAL-01 / VAL-03' / VAL-04 Vesna probes** — stay in Phase 7 because each depends on Phase 6/7 substrate. Only VAL-02 lands in Phase 4.

</deferred>

## Locked deletion checklist (for planner)

The following are confirmed kills with no remaining ambiguity:

1. `src/angel/pattern-extractor.ts` — delete extraction code; preserve `classifySessionDomains` + `extractDomain` to new `src/angel/domain-classifier.ts`. Update `heartbeat.ts:34` import.
2. `src/intelligence/experience-scoring.ts:64–112` — delete step 1 of `applyExperienceFeedback` and `createPattern` import; keep steps 2 + 3.
3. `src/angel/heartbeat.ts:1110–1124` + lesson UPDATE at 1140–1144 — delete LLM synthesis + lesson rewrite; keep dedup + score absorption.
4. `src/intelligence/correction-detection.ts` — delete `extractLessonFromUserCorrection`, `extractPatternFromAssistantText`; keep `findCausalEvent`, `storeCausalAttribution`, `detectCorrectionSignal`.
5. `src/intelligence/experience-patterns.ts` — delete orphaned `createTipAndStrategy` writer; add module + function-level JSDoc tombstone on `createPattern`. Keep all other exports.
6. V28 migration: TEMP `session_pragmas` table at connection-open + `BEFORE INSERT` trigger on `experience_patterns`.
7. New file: `src/tests/intelligence/extraction-deleted.test.ts` (4 assertions).
8. New Vesna probe: SC-V5-2 / VAL-02 (extraction-must-not-fire post-Phase-4 codepath).
9. Test edits per Camp I/II/III table above.
10. Reader comments per uniform text on all 10 reader sites.

---

*Phase: 04-angel-reduction*
*Context gathered: 2026-05-05*
*Reframe: `.planning/reframes/2026-05-05-multi-handle-kill.md`*
