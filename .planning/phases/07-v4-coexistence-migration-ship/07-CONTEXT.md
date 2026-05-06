# Phase 7: v4 coexistence / migration / ship - Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 7 ships v5.0.0 as a **substrate-only milestone**. Deliverables:

1. Per-category decisions on v4 storage tables (retire / re-derive / preserve-as-legacy).
2. Reader-site deprecation strategy across the 9 sites Phase 4 left "TODO Phase 7" comments at.
3. Three new Vesna probes + three new vitest integration tests covering the four v5 SC gates (SC-V5-1 through SC-V5-4).
4. v5.0.0 git tag + CHANGELOG entry on master after the last Phase 7 plan merges.

Out of scope (and locked elsewhere): multi-handle retrieval cutover (Phase 3 dropped), density-based abstraction (Phase 5 dropped), any new retrieval thesis, schema migration of v4 data into v5 shape (preserve-as-legacy chosen instead). v4's `hybrid-retrieval.ts` stays in production unchanged.

**Phase name caveat (historical accident, not blocking):** "v4 coexistence / **migration** / ship" — the "migration" word is misleading after the preserve-as-legacy locks below. There is no schema migration of v4 data; the only migration is V30 adding a `provenance` column to one v4 table. CONTEXT keeps the name unchanged (same call as Phase 4's "Angel reduction" name surviving Site B/C scope expansion); user-approval gate at v5.0.0 tag time may retroactively rename in ROADMAP.

</domain>

<decisions>
## Implementation Decisions

### 1. Per-category retirement verdict

| Category | Rows | Verdict | Notes |
|---|---|---|---|
| `experience_patterns` | 88 (inflated) | preserve-as-legacy, NO DELETE | Phase 4 killed the mechanism; deleting historical rows is revisionism. Reader sites already advisory-voice-render them. The 88 rows stay as historical evidence of the dead mechanism. |
| `learnings` | 191 | KEEP THE WRITER + add provenance + write-path filter | The only category where preserve-as-legacy / re-derive framing is wrong. `captureInsightsAsLearnings` (`src/adapters/shared/lifecycle.ts:755`) → `promoteLearnings` (`src/intelligence/learnings-promoter.ts`) is live, useful, and not part of the killed extraction-time-pattern-creation surface. What's missing is Phase 1's provenance-tag discipline. **V30 schema migration adds `provenance` TEXT column to `learnings` with closed-enum CHECK matching `episodic_events`: `organic \| injected \| tool_result \| environmental`. Default `organic` for new rows. Backfill existing 191 rows: write `organic`** (default-on-existing baseline; if grep reveals clearly-injected-shaped content, audit specifically). |
| `decisions` | 126 | preserve-as-legacy, NO provenance work | Tier 4 explicit-marker requirement + Stage-2 classifier filter + fingerprint dedup + redaction make Mem0-trap structurally unlikely. Tier 1 captures user intent (their own text), not assistant text. Adding provenance everywhere costs schema bloat for diminishing returns; v6+ can revisit if real-world data surfaces an issue. |
| `mental_model` | 659 | preserve-as-legacy, no migration | User-/agent-confirmed long-term content. Not extraction artifacts. ROADMAP language: "probably keep". |
| `directive_rule` | — | preserve-as-legacy, no migration | Explicit rules that earned status. ROADMAP: "likely keep". |
| `critical_rule` | — | preserve-as-legacy, no migration | Same as `directive_rule`. |
| `transcript_chunk` | ~20 | preserve-as-legacy, comment downgrade | Phase 1's `episodic_events` substrate supersedes new writes. The 20 historical rows carry potentially-useful audit content; re-deriving 20 rows is over-engineering, deletion is destructive. |

**Net retirement work — zero deletions of existing rows.** One V30 schema migration on `learnings` (provenance column + backfill). One write-path filter in `captureInsightsAsLearnings` skipping injected-block-tagged content pre-promotion. The injected-block-tag list is the same set Phase 4 used in `pattern-extractor.ts` (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<task-notification>`, etc.) — preserved as a small utility or re-imported from Phase 1's provenance-detection source-of-truth.

### 2. Reader deprecation strategy

**Forever-legacy reads with no fade.** v5 is substrate-only post-reframe; readers don't need to change because the substrate doesn't change for them. The 9 reader sites Phase 4 added "legacy-with-TODO Phase 7" comments to **keep working as-is**. Phase 7 mechanically downgrades the comment from a migration TODO to a steady-state documentation comment:

> `// reads pre-Phase-4 legacy table; new INSERTs blocked at V28 trigger; rows persist for as long as their content is useful`

Hard-cutoff at v5.0.0 is wrong (substrate-only doesn't mandate reader removal). Feature-flag fade is wrong (nothing is replacing the readers, so the flag would never flip). Forever-legacy is what substrate-only literally means for these tables.

The 9 reader sites are mechanical updates, not behavioral changes. List confirmed via grep on `Phase 7 owns retirement direction`:
- `src/assembly/assembler.ts:215`
- `src/intelligence/trigger-engine.ts:112`
- `src/intelligence/outcome-tracker.ts:71`
- `src/intelligence/contradiction-detector.ts:71`
- `src/mcp/recall-server.ts:494`
- `src/angel/heartbeat.ts:382`
- `src/angel/heartbeat.ts:1035`
- `src/adapters/cc-hooks/stop.ts:370`
- `src/embeddings/sqlite-vec-backend.ts:394`
- `src/embeddings/embed-pipeline.ts:207`

(Site count may be 10 by latest grep; final list determined at plan time. The "9 reader sites" figure originates in Phase 4 04-RESEARCH/04-CONTEXT and is the published number from Phase 4's outcome.)

`mental_model`, `directive_rule`, `critical_rule` reads stay surfaced exactly as v4 surfaced them — these are user-/agent-confirmed long-term content, not legacy-with-deprecation.

### 3. Vesna probe + vitest test surfaces

Right tool for the contract: **Vesna asserts regex-over-`agent_text` from production assembly**; **vitest asserts substrate-level DB state**. Each new ship-gate concern routes to the tool whose contract fits.

**Vesna grows 18 → 21 probes.**

| Probe | Category | Maps to | Setup shape |
|---|---|---|---|
| `episodic-recall-001` | `entity-recall` | SC-V5-1 (parable canonical regression) | `observation` artifact whose summary contains the parable content. `user_prompt` semantically related but with `lexical_exclusions` blocking distinctive parable terms (e.g., "single experience", "abstraction", "parable"). `expected_recall` regex matches the parable's distinctive phrasing surfacing in `agent_text`. |
| `episodic-recall-002` | `entity-recall` | SC-V5-1 (generic episodic-recall) | Generic episodic recall. E.g., V28 trigger episode — `observation` artifact about V28 BEFORE INSERT trigger, prompt asks about it without lexical leakage. |
| `learnings-injected-guard-001` | `self-instrumented` | SC-V5-2 extension (mirrors `extraction-deleted-001`) | `observation` artifact whose summary wraps phantom content in `<system-reminder>...</system-reminder>` (or `<experience-data>`). `lexical_exclusions` block the wrapped phantom phrases. After `captureInsightsAsLearnings` test path runs, agent_text must NOT surface the phantom phrases (negative-recall framing). |

Existing `extraction-deleted-001` (Phase 4) remains; episodic-recall + learnings-injected-guard add to the suite.

**Vitest grows by 3 integration tests.**

| Test | Path | Maps to | Assertion |
|---|---|---|---|
| `phase-7-learnings-provenance` | `src/tests/integration/phase-7-learnings-provenance.test.ts` | SC-V5-2 DB-state contract | After `captureInsightsAsLearnings` processes injected-block-tagged content, assert `learnings` table has zero rows where `provenance != 'organic'`. Substrate-level mirror of `learnings-injected-guard-001`'s agent_text contract. |
| `phase-2-1-kill-regression` | `src/tests/integration/phase-2-1-kill-regression.test.ts` | SC-V5-3' KILL-regression | Reads `.planning/phases/02.1-corpus-expansion-rerun/02.1-results.json`. Asserts `verdict.tier_strict == 'KILL'`, `verdict.tier_relaxed == 'KILL'`, Wilson CI lower-bounds byte-match locked values. Catches accidental aggregator mutation that would drift the verdict. |
| `phase-6-crash-resilience` | `src/tests/integration/phase-6-crash-resilience.test.ts` | SC-V5-4 (deferred from Phase 6) | Simulates kill -9: writes a heartbeat row, advances clock past idle threshold, writes NO clean SessionEnd marker. Runs `runBoundaryTick`. Asserts `episode_closed` row materialized with correct `session_id` and `via='idle_timeout'` (not `'clean_endsession'`). |

**Optional release-gate-only:** `bun run kill-regression` script that re-invokes the full Phase 2.1 measurement harness against the locked corpus and asserts the KILL verdict reproduces end-to-end. Slow (minutes). NOT in default `bun run test` or `bun run vesna`. Documented in REQUIREMENTS.md as ship-gated by the vitest assertion above; the script is for manual paranoia.

**No Vesna probe for VAL-04 in v5.0.0.** Phase 6 substrate has no consumer surface for behavioral assertion; Vesna's regex-over-`agent_text` contract requires assembled output to assert against, and there is none until `episode_closed` markers feed a user-visible recall surface. v6+ revisits when the consumer lands. Vitest test (above) covers SC-V5-4 ship-gate at substrate level.

### 4. v5.0.0 ship gates + version cut

**v5.0.0 straight, not -rc / -rc1 / v4.99.** Substrate is real (Phase 1 V25 + 60 EPI tests; Phase 4 ~1100 lines deleted on production path; Phase 6 V29 + 55 boundary tests; Phase 7 V30 + provenance + 3 probes + 3 vitest tests). Methodology promotion documented (PROJECT.md + reframe artifact). Thesis kill is feature-complete v5 — calling it "rc" implies more iteration is coming inside v5; calling it "v4.99" buries one of v5's most important outputs (an honest negative result on a fashion-driven retrieval thesis). Tag note LEADS with the kill, not buries it.

**Seven must-pass ship gates plus one substrate-health gate:**

| # | Gate | Threshold | Tool |
|---|---|---|---|
| 1 | Vesna full suite | 21/21 PASS at 100% (`gated=true`) | `bun run vesna` |
| 2 | Phase-7 vitest tests | 3/3 PASS | `bun run test -- src/tests/integration/{phase-7-learnings-provenance,phase-2-1-kill-regression,phase-6-crash-resilience}.test.ts` |
| 3 | Build | exit 0 (~70ms) | `bun run build` |
| 4 | Test pass-count diff | no NEW regressions vs Phase-7-immediate-post-merge baseline; the 27 pre-existing failures (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`) persist unchanged | `bun run test` |
| 5 | MEMORY.md content quality | ≥80% across active projects | `bun run sc3` |
| 6 | Handoff pickup probes | 3/3 (active + paused + archived) PASS | `bun run vesna` (already in suite) |
| 7 | CLI bundle smoke | 7/7 PASS | `bun run test -- cli-bundle-smoke` |
| + | `bun run doctor` exit 0 | substrate health (reranker:7439, Ollama, hooks, Angel) | `bun run doctor` |

All seven plus `doctor` must-pass. None nice-to-have.

**Pass-count baseline rebase discipline (LOCKED — applies across Phase 7 plans):**
Each Phase 7 plan PR runs `bun run test` and records the post-merge baseline in its SUMMARY.md (file path + pass-count). The next plan's "no NEW regressions" gate compares against THAT baseline, not the pre-Phase-7 baseline. Same convention Phase 4 used (04-01-SUMMARY.md:79 explicitly cites the post-fixture-patch baseline). Catches Phase-7-internal regressions without making the gate brittle to baseline drift.

The 27 pre-existing failures map partially to thesis-killed surfaces (`phase-5-full-gate` tests the dropped density-abstraction phase). Fixing them inside v5.0.0 means triaging tests for capabilities that no longer exist — that's v5.1+ cleanup, not v5.0.0 ship work.

**Tag location:** annotate `master` after Phase 7's last plan merges. No release branch. Standard convention from v4.1.0 (Phase 17). Tag annotation message LEADS with the kill — see Specific Ideas below.

**CHANGELOG.md ship discipline:** SHIP a v5.0.0 entry in the existing `[Unreleased]` section using Keep-a-Changelog format with `### Added`, `### Removed`, `### Changed`, `### Coverage` sub-sections. Specific bullet content is plan-phase / execute-phase scope (drafted against final shape of what shipped). CONTEXT only locks the **decision to ship a v5.0.0 CHANGELOG entry**, not the bullet content.

### Claude's Discretion

- **Provenance backfill audit depth.** Default-on-existing is `provenance='organic'` for all 191 existing `learnings` rows. If grep against the row content surfaces clearly-injected-shaped content (e.g., wrapped block tags), audit those individually; otherwise default-organic is the safe baseline. Plan-phase decides depth.
- **Injected-block-tag list source-of-truth.** Phase 4 deleted the tag list from `pattern-extractor.ts` (which is now structurally unreachable). Phase 7 re-imports/re-codifies the tag list. Source-of-truth choice: a small module under `src/extraction/injected-tags.ts` (or wherever Phase 1's provenance-detection codified it). Plan-phase decides exact module location.
- **Vesna probe `source_session_id`.** Phase 4's `extraction-deleted-001` used `phase-4-design`. New probes can follow that fallback pattern (`phase-7-design`) or cite a real session ID where the regression originated (e.g., the 2026-05-04 parable failure session for episodic-recall-001).
- **Optional `bun run kill-regression` script existence.** Documented as optional release-gate-only above; whether to actually ship the script vs ship just the vitest assertion is plan-phase scope. Vitest assertion is mandatory; the script is bonus rigor.
- **Wave parallelization shape.** Phase 6 used 5 plans in 5 waves; Phase 4 used 9 plans across waves. Plan-phase decides the right shape for Phase 7's surface (V30 migration; write-path filter; reader-comment downgrades; 3 vitest tests; 3 Vesna probes; CHANGELOG + tag).

</decisions>

<specifics>
## Specific Ideas

### v5.0.0 git tag annotation message

```
v5.0.0 — Bound Multi-Modal Episodes (Substrate-Only)

Substrate-only milestone. Three load-bearing legs proposed at v5
start; legs 2 and 3 (recall-by-any-modality via fusion, abstraction-
from-density) killed empirically by Phase 2/2.1 (3 KILL bound
measurements, .planning/aggregates/multi-handle.json). Leg 1
(provenance-tagged episode substrate) shipped + extended to learnings.

Phases shipped: 1 (substrate), 2 (multi-modal seed), 2.1 (corpus
rerun), 4 (Angel reduction), 6 (crash-resilient boundary), 7
(coexistence + Vesna update + v5 tag).
Phases dropped: 3 (multi-handle cutover), 5 (density abstraction).
Reframe artifact: .planning/reframes/2026-05-05-multi-handle-kill.md.

Methodology promoted to v5 standard practice: pre-committed decision
rule, locked corpus, multiple bound measurements, append-only
aggregator, Wilson/Newcombe CI binding.

Not delivered: improved retrieval. v4 hybrid-retrieval.ts unchanged
in production; future milestones may revisit on the substrate this
milestone built.
```

### CHANGELOG.md format reference

Existing pattern (v4.1.0, v4.1.2): `### Added` / `### Fixed` / `### Coverage` / occasionally `### Pending (HITL…)`. v5.0.0 entry adds an explicit `### Removed` block (Phase 3, Phase 5, requirements RET-01..05, ABS-01..04) and a `### Changed` block (multi-handle thesis status). Reframe artifact gets a callout at the top of the entry. Specific bullet content drafted at plan-phase / execute-phase against final shipped shape.

### Reference points for plan-phase teammate

- **Probe-precedent:** `src/benchmark/vesna/probes/extraction-deleted-001.json` (Phase 4 self-instrumented probe). Mirror this design for `learnings-injected-guard-001`.
- **Vitest-precedent:** `src/tests/integration/extraction-deleted.test.ts` (Phase 4 DB-state assertion). Mirror this design for `phase-7-learnings-provenance.test.ts`.
- **Schema-migration-precedent:** Phase 4's V28 migration with TEMP `session_pragmas` sidecar (`src/core/migration-steps.ts:1942`). V30's provenance column on `learnings` is simpler (additive column + backfill, no trigger), but the Phase 4 migration shape is the source-of-truth for closed-enum `provenance` CHECK constraint syntax (matches `episodic_events`).
- **Reader-comment-precedent:** Phase 4 added the "TODO Phase 7" comments at the 9-10 reader sites; Phase 7 downgrades them to steady-state. Mechanical text replacement, not behavioral.
- **Wave/plan-shape precedent:** Phase 6 (5 plans, 5 waves) and Phase 4 (9 plans, multi-wave) — plan-phase decides which shape fits Phase 7.
- **Phase 4 baseline-citation precedent:** 04-01-SUMMARY.md:79 cites `3438 / 3473 passing (vs 3370 / 3473 baseline pre-fixture-patch); 27 pre-existing failures remain in llama-client, llama-server-supervisor, and phase-5-full-gate`. Use the same explicit-citation style in each Phase 7 plan SUMMARY.

</specifics>

<deferred>
## Deferred Ideas

- **Re-derive learnings/decisions as projections from `episodic_events`.** Considered for `learnings` and `decisions` per ROADMAP language. Verdict: not v5. Both have live, useful writers post-Phase-4; preserve-as-legacy framing for them was wrong; KEEP-the-writer is the right call. A future milestone (v6+) could revisit if the substrate grows enough to make projection cheaper than direct writing.
- **Provenance tagging for `decisions`, `mental_model`, `directive_rule`, `critical_rule`, `experience_patterns`.** Skipped for v5. Schema bloat for diminishing returns given each table's existing structural defenses (Tier 4 markers + redaction for `decisions`; user-confirmation for `mental_model`/rules; V28 trigger blocks new INSERTs to `experience_patterns`). v6+ revisits if real-world data surfaces a Mem0 vector through one of these surfaces.
- **VAL-04 Vesna probe (`crash-resilience-001`).** Phase 6 substrate has no consumer surface yet — Vesna's contract requires `agent_text` to assert against. v5.0.0 ships SC-V5-4 via vitest substrate-level test only. v6+ adds the Vesna probe when consumer wiring lands.
- **Retroactive Phase rename "v4 coexistence / migration / ship" → accurate post-lock name.** "Migration" is now misleading (no schema migration of v4 data). User-approval gate at v5.0.0 tag time decides whether to retroactively rename in ROADMAP. Not blocking; CONTEXT carries the explanation.
- **Replacement retrieval thesis for v6+.** Out of v5 scope by reframe-artifact discipline ("don't install a new load-bearing thesis from one round of reflection"). When the next retrieval thesis arrives, it tests against Phase 1's substrate using the methodology Phase 2/2.1 proved (pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator, Wilson/Newcombe CI binding).
- **Cleanup of the 27 pre-existing test failures** (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`). Two of these test thesis-killed surfaces. v5.1+ cleanup phase can triage which to delete (Phase-5-related) vs which to fix (llama-server-supervisor noise). Not v5.0.0 ship scope.

</deferred>

---

*Phase: 07-v4-coexistence-migration-ship*
*Context gathered: 2026-05-05*
*Reframe context: .planning/reframes/2026-05-05-multi-handle-kill.md*
*Roadmap entry: .planning/ROADMAP.md lines 94-104*
