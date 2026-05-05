---
phase: 04-angel-reduction
type: research
created: 2026-05-05
inputs:
  - .planning/phases/04-angel-reduction/04-CONTEXT.md
  - .planning/ROADMAP.md (Phase 4 entry)
  - .planning/REQUIREMENTS.md (AR-01..05, VAL-02)
  - .planning/reframes/2026-05-05-multi-handle-kill.md
---

# Phase 4 — Angel reduction: Research

> Goal of this document: surface everything a planner needs to write actionable PLAN.md files. CONTEXT.md already locks the *what* (3 deletion sites, 3-layer cutoff, surgical-not-flagged); this doc grounds the *where* and *how* against the live codebase as of commit `ac2bcb2` (2026-05-05) and surfaces the open implementation questions that planning must resolve.

## 1. Codebase grounding (verified against working tree)

### 1.1 Deletion site A — `src/angel/pattern-extractor.ts`

| Element | Line(s) | Status post-Phase-4 |
|---|---|---|
| `INJECTED_BLOCK_TAGS` const | 76–87 | DELETE (zero external imports) |
| `stripInjectedBlocks` (exported) | 96–105 | DELETE (zero non-test imports) |
| `formatTranscript` | 115–137 | DELETE |
| `EXTRACTION_SYSTEM_PROMPT` | 139–187 | DELETE |
| `DIRECTIVE_INDICATORS` | 200–211 | DELETE |
| `extractDirectiveCandidates` | 222–236 | DELETE |
| `findCrossSessionDirectives` | 247–290 | DELETE |
| `measureSessionOutcome` (+`SessionOutcome`) | 296–351 | DELETE |
| `bridgeCorrectionToSkill` | 366–397 | DELETE |
| `reviewCandidatePatterns` | 403–474 | DELETE |
| `buildExtractionManifest` | 484–540 | DELETE |
| `extractPatternsFromSession` (exported) | 554–749 | DELETE |
| `getSessionTurns` (exported, transcript loader) | 40–63 | DELETE |
| `classifySessionDomains` (exported) | 756–801 | KEEP — extracted to `src/angel/domain-classifier.ts` |
| `extractDomain` import (from `../intelligence/capability-tracker`) | 30 | KEEP — moves with `classifySessionDomains` |
| `recordDomainInteraction` import | 30 | KEEP — moves with `classifySessionDomains` |

After surgical extraction, `src/angel/pattern-extractor.ts` becomes empty (or is deleted entirely and its name freed). Planner picks: delete-the-file vs leave-empty-file-with-tombstone. **Recommendation: delete the file** — the new `src/angel/domain-classifier.ts` carries the surviving export; tombstone in `src/intelligence/experience-patterns.ts` already fingerprints the kill. Leaving an empty file invites someone to "fix" it.

### 1.2 Deletion site B — `src/intelligence/experience-scoring.ts`

| Element | Line(s) | Status post-Phase-4 |
|---|---|---|
| `import { ... extractPatternFromAssistantText, extractLessonFromUserCorrection ... } from './correction-detection'` | 26 | TRIM — drop the two extraction functions, keep `findCausalEvent`, `storeCausalAttribution`, (`detectCorrectionSignal` is used elsewhere, not here) |
| `import { createPattern ... } from './experience-patterns'` | 17–23 | TRIM — drop `createPattern` import |
| Step 1 block (lines 64–112) — pattern creation on `correction_flagged=true` | 64–112 | DELETE (entire `if (correction_flagged && lastUserText)` block) |
| Step 2 block (lines 114–171) — topic-aware score feedback | 114–171 | KEEP verbatim |
| Step 3 (`finally` flag rotation, lines 189–209) | 189–209 | KEEP verbatim |
| Outcome-tracker call (lines 173–186) | 173–186 | KEEP — uses surviving `inferOutcomeFromSession` |

**Note:** the surviving step 2 (lines 125–171) reads `awaiting_feedback_ids` set by the *previous* turn's injection. Score-absorption on existing rows is binding/indexing, not extraction-time creation. Survives unchanged.

### 1.3 Deletion site C — `src/angel/heartbeat.ts`

| Element | Line(s) | Status post-Phase-4 |
|---|---|---|
| Outer try block (line 1094) | 1094 | KEEP |
| `findSimilarPatterns` import + call | 1095, 1104 | KEEP (read-only vector search) |
| `mergeTargets` SELECT (lines 1096–1099) | 1096–1099 | KEEP |
| `synthesizedLesson` initialization (line 1109) | 1109 | DELETE |
| LLM synthesis try/catch block (lines 1110–1124) | 1110–1124 | DELETE |
| Score absorption + DELETE absorbed (lines 1126–1138) | 1126–1138 | KEEP verbatim |
| `lesson` UPDATE on synthesized text (lines 1140–1144) | 1140–1144 | DELETE |
| `merged.size > 0` `result.patterns_merged` (lines 1147–1149) | 1147–1149 | KEEP |

**Important** for the planner: heartbeat.ts line 34 imports `extractPatternsFromSession, classifySessionDomains` from `./pattern-extractor.js`. After Site A extraction, this becomes:

```ts
import { classifySessionDomains } from './domain-classifier.js';
```

Site A also kills the `extractPatternsFromSession` call site at heartbeat.ts:306–324 (Phase 2 / extraction loop). The surrounding scaffolding around that call (`session_processed++` accounting, `markSessionProcessed`, `definitiveOutcomes` list at line 320) all become dead — see §2.4.

### 1.4 Deletion site D (newly identified) — `src/intelligence/correction-detection.ts`

CONTEXT.md item 4 says delete `extractLessonFromUserCorrection` and `extractPatternFromAssistantText` from this module. Verified:

| Function | Status |
|---|---|
| `detectCorrectionSignal` | KEEP — used by hook-side correction signal detection |
| `extractLessonFromUserCorrection` | DELETE — only called from Site B |
| `extractPatternFromAssistantText` | DELETE — only called from Site B |
| `findCausalEvent` | KEEP — used by surviving Site-B causal trace path |
| `storeCausalAttribution` | KEEP — same |

Verify before deletion: grep across `src/` for both function names — expect ZERO non-Site-B production callers.

### 1.5 Function library — `src/intelligence/experience-patterns.ts`

| Symbol | Line(s) | Status |
|---|---|---|
| Module-level docblock | 1–14 | UPDATE — prepend tombstone paragraph |
| `createPattern` (exported) | 342–476 | KEEP — add JSDoc tombstone |
| `createTipAndStrategy` (exported) | search | DELETE — only called from Site A |
| `generalizeLessonToStrategy` (exported) | search | LIKELY DELETE — feeder for `createTipAndStrategy`. Planner verifies. |
| All other exports (35 total — see §1.6) | various | KEEP verbatim |

**Critical** — `createPattern` callers post-deletion (must be exhaustively re-grepped at execution time):

Production:
- `src/angel/pattern-extractor.ts:29,682` — DELETED with Site A
- `src/intelligence/experience-scoring.ts:18,98` — DELETED with Site B

After Sites A+B die, **zero production callers remain.** All remaining usages are tests + fixtures (worker-context.test.ts, experience-patterns.test.ts, etc.).

### 1.6 V28 schema migration target

Current `experience_patterns` schema at `src/core/schema.ts:390-450`:

- Table created via `CREATE TABLE IF NOT EXISTS experience_patterns` in `SCHEMA_V3` constant
- FTS5 sidecar `experience_patterns_fts` (line 433–439)
- AFTER INSERT trigger `experience_patterns_ai` (line 442–445) — keeps FTS in sync; runs *after* a successful insert. Our new BEFORE INSERT trigger fires earlier and aborts the insert before `_ai` runs, so they don't conflict.
- AFTER DELETE trigger `experience_patterns_ad` (line 447–450)

`runMigrations` at `src/core/migrations.ts:100-141`. Current `TARGET_USER_VERSION = 27` (line 98). Migration step pattern (see `migrateV25toV26`, `migrateV26toV27` in `src/core/migration-steps.ts:1828, 1874`):

1. Add `migrateV27toV28` to `migration-steps.ts`
2. Re-export from `migrations.ts:20-52` import block
3. Append `[27, () => { migrateV27toV28(db); }]` to migration array (line 141)
4. Bump `TARGET_USER_VERSION = 28`

Migration-step implementation:

```ts
export function migrateV27toV28(db: Database): boolean {
  // Idempotent: trigger already created via CREATE IF NOT EXISTS (SQLite skips if exists)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS experience_patterns_insert_blocked
    BEFORE INSERT ON experience_patterns
    WHEN (SELECT value FROM temp.session_pragmas
          WHERE key='allow_legacy_pattern_insert' LIMIT 1) IS NULL
    BEGIN
      SELECT RAISE(FAIL,
        'experience_patterns is read-only legacy after Phase 4 (.planning/reframes/2026-05-05-multi-handle-kill.md). Set session_pragma allow_legacy_pattern_insert=1 only for tests, fixtures, or Phase 7 retirement work.');
    END;
  `);
  return true;
}
```

**Critical wiring choice** for the planner: where does `temp.session_pragmas` get created? The trigger references `temp.session_pragmas` — without that table existing per-connection, the WHEN clause errors and INSERTs fail loudly even from Phase-7-legitimate writers. Three candidates:

- `src/core/storage.ts` — `openDatabase()` is the canonical connection-open. Add `db.exec("CREATE TEMP TABLE IF NOT EXISTS session_pragmas(key TEXT PRIMARY KEY, value TEXT)")` after `runMigrations(db)` returns. **Recommended** — every reader/writer goes through this path.
- `src/core/migrations.ts` `runMigrations` — also runs at every open. But `runMigrations` returns early when `version >= TARGET_VERSION`, so the temp table creation must live OUTSIDE that early-return path.
- Migration step itself — wrong, runs once and is committed; temp tables are per-connection and CANNOT be created by a migration that only runs when version<target.

**Recommendation for planner:** create `temp.session_pragmas` in `openDatabase()` directly (the canonical entry point). Add a unit test that opens a fresh DB and confirms `temp.session_pragmas` exists. The trigger's `WHEN (SELECT value FROM temp.session_pragmas WHERE key='...' LIMIT 1) IS NULL` correctly evaluates to TRUE (block) when the table is empty AND when the key isn't set, so the default behavior is "block."

### 1.7 Vesna runner contract

`src/benchmark/vesna/runner.ts:48-83` runs each probe through:

```
resetTestDb → applySetup → composeAgentText (production retrieval surface) → evaluate(observation, expected_recall)
```

`evaluate` checks (a) `must_contain_phrase_pattern` regexes against `agent_text`, (b) turn-budget. **Vesna asserts retrieval-side observable behavior, not write-side state.**

This affects how SC-V5-2 / VAL-02 must be expressed as a Vesna probe — see §3.

### 1.8 Probe inventory (current count)

`src/benchmark/vesna/probes/` has 21 JSON files:
- 3 handoff-pickup, 3 entity, 3 constraint, 3 cross-project, 3 lesson-application
- 2 recall-observability (self-instrumented)
- 3 buffer (placeholder, skipped at runtime)
- `.disabled/` contains 2 phase-2 probes (correctly disabled per Phase 2 KILL)

Active runtime probes: 21 − 3 buffer = 18, but 2 are `recall-observability-*` which CONTEXT.md / CLAUDE.md describes as the 17/17 set + 1. Treat **17** as the SC#1 baseline (CLAUDE.md `bun run vesna` claim) and the new SC-V5-2 probe as **+1 → 18**.

## 2. Surveyed-but-not-named cleanup that comes for free

These are dead/orphan symbols that fall out of the deletions but aren't called out in CONTEXT.md's locked checklist. Planner decides per-item whether to also delete (low-risk) or leave for `gsd:cleanup` later (zero-risk).

### 2.1 `getSessionTurns` in `pattern-extractor.ts` (lines 40–63)

Currently exported. Used only by `extractPatternsFromSession` itself. Once Site A dies, this is orphaned. **Delete with Site A.**

### 2.2 `definitiveOutcomes` list at `heartbeat.ts:320`

```ts
const definitiveOutcomes = ['too few turns', 'insufficient content', 'no patterns found', 'no patterns array'];
const isDefinitive = extraction.patternsCreated > 0 || definitiveOutcomes.some(...)
```

This entire `try { extractPatternsFromSession(...) ... markSessionProcessed(...) ... }` block (heartbeat.ts:305–336) is dead once `extractPatternsFromSession` is deleted. Planner deletes the block; the surrounding loop shifts to call only `classifySessionDomains` (which moves to `domain-classifier.ts`). `result.sessions_processed` and `result.patterns_extracted` accumulators must be removed or re-purposed. **Confirm via `bun run build`** that no other heartbeat result-field writer breaks.

CONTEXT.md anticipated this with "CONDITIONAL DELETE" on `heartbeat-regression.test.ts` — that test asserts properties of `definitiveOutcomes`. With the list gone, the test is dead.

### 2.3 `getUnprocessedSessions` and `markSessionProcessed`

Used by Phase 2 of the heartbeat tick (the now-dead extraction loop). After §2.2's deletion, `getUnprocessedSessions` may have remaining callers (curated-context-extractor uses `getSessionsPendingCuratedExtraction` which is separate). Planner re-greps:

```bash
grep -rn "getUnprocessedSessions\|markSessionProcessed" src/
```

If only Site A scaffolding referenced them, they're orphan. Defer to `gsd:cleanup` or delete defensively if grep returns clean.

### 2.4 `result.sessions_processed` / `result.patterns_extracted` fields

Heartbeat tick result shape will lose two fields. Re-grep usages — observability surfaces (dashboard, telemetry, MEMORY.md curators) may print these. Two options:

- **Hard rename / delete** — cleaner, surfaces every consumer; small explosion across CLI/observability layer.
- **Soft no-op** — keep fields, set to `0` always. Deprecation-friendly.

**Planner recommendation:** soft no-op + TODO('Phase 7: remove') on the field initializers. Extraction-deletion regression is the load-bearing thing; field rename is cleanup that can land later.

### 2.5 `bridgeCorrectionToSkill` consumers

Orphan import surface: `findSkillByDomain`, `writeSkillFile` from `src/angel/skill-writer.ts`. Re-grep — if no other callers, planner deletes `skill-writer.ts` too. Otherwise leave it alone.

## 3. SC-V5-2 / VAL-02 Vesna probe — translation from CONTEXT.md to a runnable probe

CONTEXT.md says: *"Provenance-tagged write path makes the Mem0 feedback loop structurally impossible. Probe asserts injected-span content does not contribute to extracted artifacts. Validated against the post-Phase-4 codepath (extraction-time pattern creation deleted)."*

Vesna probes (per §1.7) test recall, not extraction. The probe-shaped translation:

> **Negative-recall framing.** Seed an injected `<experience-data>` block as if it had been pasted into a prior session. Probe a new session with a prompt that would normally surface that content. Assert that the agent's recalled context does NOT surface the injected text as a "remembered correction" — because no `experience_patterns` row exists from it (because extraction was deleted in Phase 4).

Probe spec sketch (planner refines):

```json
{
  "id": "extraction-deleted-001",
  "category": "self-instrumented",
  "source_session_id": "phase-4-design",
  "source_project": "claudex-v3",
  "scenario": "Phase 4 deleted extraction-time pattern creation. Inject an <experience-data> block matching SECRET_CONTENT pattern shape; new session prompt asks about the wrapped phrase; agent must NOT recall it as a previously-extracted correction (no row was ever created).",
  "user_prompt": "What was the rule we agreed on for handling that thing?",
  "expected_recall": {
    "artifact_id_or_pattern": "no-extraction-from-injected",
    "must_surface_within_turns": 2,
    "must_contain_phrase_pattern": ["no prior|going in cold|no relevant"]
  },
  "lexical_exclusions": ["always_use_X", "never_do_Y"],
  "evaluation": "auto",
  "setup_steps": [
    {
      "kind": "artifact",
      "payload": {
        "kind": "observation",
        "summary": "<experience-data>previous turn: always_use_X. never_do_Y.</experience-data>",
        "project": "claudex-v3"
      }
    }
  ]
}
```

The negative assertion is via `must_contain_phrase_pattern` matching the narration directive's "no prior… going in cold" phrasing — which fires when retrieval finds nothing useful. If the broken-feedback-loop ever resurrects, the wrapped phrases would resurface (currently in `agent_text` via `experience_warning_triggers` reader which still reads the legacy `experience_patterns` table). Probe inverts gold-recall framing: presence of the injected content *is* the failure.

**Open question for planner:** is `extraction-deleted.test.ts` (Layer 2) sufficient on its own, with Vesna probe optional? CONTEXT.md commits to the Vesna probe ("17→18"). My read: keep both. The unit test asserts the *write path* directly (counts rows). The Vesna probe asserts the *recall path* doesn't accidentally inject leaked content. Different failure modes.

**Risk to surface:** the `expected_recall` regex `"no prior|going in cold"` depends on the narration directive being live. Vesna's `narration_directive` setup-step controls this. Default is `silent: false`. Probe should NOT set narration silent — assertion depends on directive firing.

## 4. Test-impact map (cross-referenced against CONTEXT.md Camp I/II/III)

CONTEXT.md camps verified against grep:

### Camp I — extraction-must-work (modify or delete)

| Test file | Line count | Action |
|---|---|---|
| `src/tests/angel/pattern-extractor.test.ts` | ~210 | DELETE FILE (tests deleted symbols incl. `stripInjectedBlocks`) |
| `src/tests/intelligence/experience-detection.test.ts` | 683 | SPLIT into `correction-signal.test.ts` (keep `detectCorrectionSignal` + behavioral signals tests) and DROP extraction-half (`extractLessonFromUserCorrection` + `extractPatternFromAssistantText` tests) |
| `src/tests/integration/experience-patterns-e2e.test.ts` | unknown | INVERT: keep file, narrow assertions, add explicit "row count unchanged after correction signal" assertion |
| `src/tests/intelligence/directive-detector-integration.test.ts` | confirmed | UPDATE MOCK: `vi.mock('../../angel/pattern-extractor.js', ...)` at line 35 → change target to `'../../angel/domain-classifier.js'`, drop `extractPatternsFromSession` mock entry |
| `src/tests/angel/heartbeat.test.ts` | unknown | UPDATE MOCK: same as directive-detector-integration |

### Camp II — regression guards (keep + add)

| Test file | Action |
|---|---|
| `src/tests/intelligence/extraction-deleted.test.ts` | NEW (4 assertions per CONTEXT.md Layer 2) |
| `src/tests/angel/heartbeat-regression.test.ts` | CONDITIONAL DELETE (its `definitiveOutcomes` regression is dead post-§2.2) |

### Camp III — survives verbatim

| Test file | Why it's safe |
|---|---|
| `src/tests/intelligence/experience-patterns.test.ts` | Tests CRUD on the surviving function library; tests use `createPattern` against test DB → must set `temp.session_pragmas` pragma in `beforeEach` |
| `src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts` | Reactive trigger detector readers |
| `src/tests/intelligence/experience-tier.test.ts` | `assembleExperienceTier` reader |
| `src/tests/assembly/worker-context.test.ts` | Uses `createPattern` to seed fixtures → needs pragma in `beforeEach` |
| `src/tests/intelligence/outcome-tracker.test.ts` | Reader + score UPDATE only |
| `src/tests/mcp/recall-server.test.ts` | FTS5 search reader |
| `src/tests/angel/task-pattern-classifier.test.ts` | Verified unrelated to extraction (planner re-confirms) |

### Pragma-setting fixture pattern

For Camp III tests that seed via `createPattern`:

```ts
beforeEach(() => {
  db.exec("INSERT OR REPLACE INTO temp.session_pragmas(key, value) VALUES ('allow_legacy_pattern_insert', '1')");
});
afterEach(() => {
  db.exec("DELETE FROM temp.session_pragmas WHERE key='allow_legacy_pattern_insert'");
});
```

`extraction-deleted.test.ts` deliberately does NOT set this pragma — assertions (a)/(b)/(c) must observe the trigger blocking would-be writes.

Per `.claude/rules/angel-architecture.md`: heartbeat tests assert "5-turn hard budget" and "10-min debounce" patterns; Phase 4's heartbeat changes don't touch those. Extraction-deletion-related test edits are scoped to the merge loop + Phase-2 extraction loop only.

## 5. Reader-comment surface (uniform legacy comment)

CONTEXT.md item 10 + the consumer table specify 10 sites. Verified:

| File | Line(s) | Add comment near |
|---|---|---|
| `src/assembly/assembler.ts` | 200–248 | the SELECT for P1.5/P4.1 injection tier |
| `src/angel/heartbeat.ts` | 380–403 | the SELECT for pruning + auto-verification |
| `src/angel/heartbeat.ts` | 1030–1089 | the SELECT for retrieval-mode promotion |
| `src/intelligence/trigger-engine.ts` | grep | trigger-time injection decision SELECT |
| `src/intelligence/contradiction-detector.ts` | grep | contradiction SELECT |
| `src/intelligence/outcome-tracker.ts` | grep | outcome reinforcement SELECT |
| `src/embeddings/sqlite-vec-backend.ts` | 386–396 | embedding pipeline SELECT |
| `src/embeddings/embed-pipeline.ts` | 208 | embedding UPDATE call |
| `src/mcp/recall-server.ts` | grep | FTS5 SELECT |
| `src/adapters/cc-hooks/stop.ts` | 323 | `applyExperienceFeedback` invocation site |

Uniform comment text (per CONTEXT.md):

```
// Reads experience_patterns (pre-Phase-4 legacy table). Phase 4 stopped
// new INSERTs (V28 trigger blocks them). Phase 7 owns retirement direction
// — drop / project / keep. See .planning/reframes/2026-05-05-multi-handle-kill.md.
```

Greppable via `"Phase 4 stopped new INSERTs"` returns the full surface map. **Audit step in plan:** after applying, run `grep -rn "Phase 4 stopped new INSERTs" src/` and confirm count == 10 (or whatever final number after planner's verification — some sites may have additional SELECT locations to mark).

## 6. Build / test / Vesna grounding

- Build: `bun run build` — esbuild, ~70ms, outputs to `dist/`. Must pass after each commit boundary.
- Test: `bun run test` — vitest. Phase 4 changes test count: net delete pattern-extractor.test.ts (~30 cases), split experience-detection.test.ts (some kept, some deleted), add extraction-deleted.test.ts (4 cases), update 2 heartbeat-mock tests. Net change: ~−30 cases. Vitest must remain fully passing.
- Vesna SC#1: `bun run vesna` — must be 18/18 PASS post-Phase-4 (current 17/17 + new SC-V5-2 probe).
- SC#3: `bun run sc3` — independent of extraction (driven by `angel/memory-monitor.js` + curator). Run once post-delete to confirm unchanged.

## 7. Open questions for the planner

These are the specific decisions CONTEXT.md leaves to "Claude's Discretion" — the planner picks at PLAN.md write time:

1. **`temp.session_pragmas` wiring location** — `openDatabase()` in `src/core/storage.ts` recommended (§1.6). Confirm at planning.
2. **`heartbeat-regression.test.ts` survival** — CONDITIONAL DELETE depending on whether `definitiveOutcomes` is referenced post-edit. Re-grep at execute time.
3. **`task-pattern-classifier.test.ts` survival** — likely keep; re-confirm unrelated to extraction.
4. **`pattern-extractor.ts` file fate** — recommended DELETE THE FILE entirely after surviving exports relocate to `domain-classifier.ts`. Tombstone lives in `experience-patterns.ts` (the surviving module).
5. **Wave/plan boundary** — see §8.
6. **Soft-no-op vs. hard-rename** for `result.sessions_processed`/`result.patterns_extracted` (§2.4). Soft no-op recommended.
7. **`generalizeLessonToStrategy` deletion** — feeder for `createTipAndStrategy`; if no other callers, delete with same commit.
8. **Phase rename to "Strip extraction-time pattern creation"** — deferred to user-approval gate per CONTEXT decision; do NOT rename in PLAN.md frontmatter (keep `04-angel-reduction`).

## 8. Suggested wave / plan structure

Phase 4 is engineering — surgical-not-flagged. The deletions are interrelated (Site A's removal kills heartbeat.ts:34 import; Site C lives in heartbeat.ts beside Site-A-related Phase-2 loop). One coherent commit cluster, but plans can split for review-clarity.

**Recommended structure (planner refines):**

| Plan | Wave | Files modified | Description |
|---|---|---|---|
| 04-01 | 1 | `src/core/migration-steps.ts`, `src/core/migrations.ts`, `src/core/storage.ts`, new test for V28 + temp.session_pragmas | Land the V28 trigger and temp-table wiring FIRST, before any deletions, so test-fixture pragma pattern can be applied uniformly. Add the `beforeEach` pragma helper to test-db helpers. |
| 04-02 | 2 | `src/angel/pattern-extractor.ts` (DELETE), new `src/angel/domain-classifier.ts`, `src/angel/heartbeat.ts:34` (re-import), heartbeat extraction loop §2.2 (delete dead block), `src/tests/angel/pattern-extractor.test.ts` (DELETE), 2 heartbeat-mock tests (UPDATE) | Site A surgical deletion + classifySessionDomains relocation |
| 04-03 | 2 | `src/intelligence/experience-scoring.ts` (trim step 1), `src/intelligence/correction-detection.ts` (delete 2 funcs), `src/tests/intelligence/experience-detection.test.ts` (split → `correction-signal.test.ts`) | Site B + Site D surgical deletion |
| 04-04 | 2 | `src/angel/heartbeat.ts:1090–1149` (LLM-merge synthesis kill) | Site C surgical deletion |
| 04-05 | 3 | `src/intelligence/experience-patterns.ts` (delete `createTipAndStrategy`, optionally `generalizeLessonToStrategy`, add module + `createPattern` JSDoc tombstones) | Layer 1 cutoff signal |
| 04-06 | 3 | `src/tests/intelligence/extraction-deleted.test.ts` (NEW), `src/tests/integration/experience-patterns-e2e.test.ts` (INVERT) | Layer 2 regression guard |
| 04-07 | 3 | `src/benchmark/vesna/probes/extraction-deleted-001.json` (NEW) | SC-V5-2 / VAL-02 Vesna probe (17→18) |
| 04-08 | 4 | 10 reader files | Uniform legacy comment surface (audit-step at end) |
| 04-09 | 4 | `src/intelligence/correction-detection.ts:26-line import audit`, `src/angel/skill-writer.ts` (conditional delete), `result.sessions_processed` (soft no-op decision) | Cleanup-around (per §2 surveys) |

Plans 02/03/04 in wave 2 are independent (different files, different deletion sites) — can execute in parallel. Plan 05 depends only on 02/03/04 having killed all production callers of `createPattern`. Plans 06/07 depend on 05 (need tombstone visible). Plan 08 depends on the V28 trigger (plan 01) so the comment text is accurate. Plan 09 is housekeeping after the load-bearing kills land.

**must_haves (goal-backward verification):**

- AR-01: dependency trace produced (planner plan 04-02/03/04 individually demonstrate this; aggregate trace ships in PLAN.md frontmatter or 04-09 summary)
- AR-02: every reader either touched (re-pointed) or commented (10 sites — plan 04-08)
- AR-03: extraction-time pattern creation deleted (plans 04-02, 04-03, 04-04 collectively + Layer 3 V28 trigger from plan 04-01)
- AR-04: Mem0 fix obsolete — `INJECTED_BLOCK_TAGS` and `stripInjectedBlocks` deleted in plan 04-02 confirms this
- AR-05: LLM at extraction-time eliminated (plan 04-02 kills `extractPatternsFromSession`'s `callLocalLLM`; plan 04-04 kills heartbeat merge `callLocalLLM`; surviving LLM call in `classifySessionDomains` is binding/indexing — domain classification is not pattern abstraction)
- VAL-02: Vesna probe lands in plan 04-07; `bun run vesna` 18/18 PASS

## 9. References checked

- `.planning/phases/04-angel-reduction/04-CONTEXT.md` (locked decisions)
- `.planning/ROADMAP.md` (Phase 4 entry, post-reframe scope)
- `.planning/REQUIREMENTS.md` (AR-01..05, VAL-02)
- `.planning/reframes/2026-05-05-multi-handle-kill.md` (referenced in tombstone text)
- `src/angel/pattern-extractor.ts` (Site A — verified line numbers 30–801)
- `src/intelligence/experience-scoring.ts` (Site B — verified lines 26, 64–112, 125–209)
- `src/angel/heartbeat.ts` (Site C — verified lines 34, 305–336, 1090–1149)
- `src/intelligence/correction-detection.ts` (Site D — verified 5 exports)
- `src/intelligence/experience-patterns.ts` (function library — verified `createPattern` lines 342–476, ~35 exports total, 1471 lines)
- `src/core/schema.ts` (lines 390–450 — experience_patterns DDL + FTS5 + triggers)
- `src/core/migrations.ts` (lines 1–160 — TARGET_USER_VERSION = 27)
- `src/core/migration-steps.ts` (lines 1820–1919 — V25→V26→V27 patterns)
- `src/benchmark/vesna/runner.ts` (lines 1–100 — runner contract)
- `src/benchmark/vesna/types.ts` (probe schema)
- `src/benchmark/vesna/setup.ts` (setup-step DSL)
- `src/benchmark/vesna/probes/*.json` (21 files — confirmed inventory)
- `src/tests/intelligence/experience-detection.test.ts` (line count 683 — confirmed split candidate)
- `src/tests/intelligence/directive-detector-integration.test.ts` (line 35 — `vi.mock` target)

---

## RESEARCH COMPLETE

Phase 4 is well-grounded. CONTEXT.md's locked decisions are accurate against the live codebase. Open questions surfaced for the planner are scoped: wiring location, conditional-delete confirmations, plan/wave boundary. Vesna SC-V5-2 probe needs a negative-recall framing translation (§3) — direct write-side assertion already covered by `extraction-deleted.test.ts`.

Ready for `/gsd:plan-phase 4`.
