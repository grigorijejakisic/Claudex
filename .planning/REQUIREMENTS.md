# Requirements: Claudex v4

**Defined:** 2026-04-19. **Rebound:** 2026-04-27 (audit-driven; benchmarks dropped, 5 new upgrade phases added, Vesna promoted to Phase 10 central validation).

**Core Value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) get reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

## v1 Requirements

### Storage (STOR)

- [x] **STOR-01**: `artifact(kind, ...)` unified table via V17 migration with free-form `kind` column + `kind_registry`
- [x] **STOR-02**: Migrate rows from `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, `entity_summary` into unified table
- [x] **STOR-03**: Legacy SQL views preserve names/shapes; existing v3 callers keep working
- [x] **STOR-04**: Migration transaction-wrapped; legacy tables retained until Phase 11 zero-caller gate
- [x] **STOR-05**: Stale `project_curated_context` rows flagged `status='stale'` during migration (9 mental_model rows flagged)
- [ ] **STOR-06**: `artifact(kind='transcript_chunk')` rows carry `session_id`, `turn_range`, `topic_label`, embedding — owned by Phase 4.1 (reach fix)
- [x] **STOR-07**: Path-scoped artifacts (`scope='project'` + `paths:` glob) surface via `.claude/rules/` lazy-load
- [x] **STOR-08**: DB backup to `~/.claudex/backups/pre-v4-{phase}-{ts}.db` before irreversible drops; restore verified
- [ ] **STOR-09 (NEW 2026-04-27)**: task-pattern fingerprint column on artifacts of `kind ∈ {mental_model, learning, experience_pattern, workspace_fact, lesson}` — auto-classified at write time by Angel's segmentation; short tag (e.g., `scraping rate-limits`)

### Extraction (EXTR)

- [x] **EXTR-01**: `src/intelligence/directive-detector.ts` — regex pass for emphasis signals + LLM confirmation at threshold ≥0.7
- [x] **EXTR-02**: Detector writes `artifact(kind='directive_rule', scope=...)` with LLM-classified scope ∈ {session, project, universal}
- [x] **EXTR-03**: Detector runs in Angel extraction phase BEFORE generic ingester
- [~] **EXTR-04**: Detector precision — partial-B at joint=0.50; **held-out recall measurement + `negation_dont` family tune owned by Phase 3 merger**, target ≥0.85, floor ≥0.70
- [ ] **EXTR-05**: Replace 6 v3 extractors with single Angel semantic ingester — owned by Phase 9
- [ ] **EXTR-06**: Transcript chunking via LLM topic-segmentation at `/endsession` — owned by Phase 4.1 (reach fix)

### Injection (INJ)

- [ ] **INJ-01**: Session-start ≤500 tokens (identity, handoff pointer, MEMORY.md native load, active safety-critical signals)
- [ ] **INJ-02**: Remove from `assembler.ts`: Proven Principles (P4.1), Entity Summaries auto-surface (P4.05), Angel Opinions (P4.07), Predicted Context, Curated Context (P2.1), Experience Warnings auto-surface, Flow, Reference Layer (L2), Materialization (L3 auto-trigger)
- [ ] **INJ-03**: Keep assembler sections: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD
- [ ] **INJ-04**: All surviving injected text stripped of timestamps, turn counts, session IDs, wall-clock — cache-stable prefix
- [ ] **INJ-05**: UPS per-turn payload ≤1KB; only dynamic signals
- [ ] **INJ-06**: `initialUserMessage` auto-prime — system-role; fires only when handoff frontmatter `status: active` AND `phase` matches `STATE.md` (no mtime gate); kills existing auto-`/starthere` in `session-start.ts:333+`
- [ ] **INJ-07**: Experience-warning content surfaces only on explicit agent query OR PreToolUse hook trigger — never auto-injected at session-start

### Retrieval (RETR)

- [x] **RETR-01** (Phase 6, 2026-04-29): Hybrid-retrieval scoring consolidated into a single canonical `computeArtifactScore` function (RRF over FTS5 + vec0 + recency + graph_walk + temporal channels → cross-encoder rerank → top-k budget-gated). Same simplification outcome as the original deletion plan, achieved via consolidation under the W2 evidence-floor argument.
- [x] **RETR-02** (Phase 6, 2026-04-29): Multiplier chain consolidated into one helper per multiplier with one flat documented weight vector (3 inner factors + 4 outer multipliers; 7 helpers; 1 canonical scoring function). Aggressive deletion deferred to a post-Phase-10 follow-up plan when the larger Vesna suite can resolve effects below 5pp. See `06-MULTIPLIER-ABLATION.md`.
- [x] **RETR-03** (Phase 6, 2026-04-29): RIF suppression and spread activation retained verbatim; behavior locked by `phase-6-rif-spread-retained.test.ts` (8 invariant tests).
- [x] **RETR-04** (Phase 6, 2026-04-29): MCP surface unchanged for the five canonical tools; verified via static structural lock-down in `phase-6-mcp-surface-unchanged.test.ts` against `mcp-surface-canonical.json`.
- [x] **RETR-05** (Phase 6, 2026-04-29): Per-multiplier ablation A/B run on 11-probe set; 0pp delta on every flag at N=11 (below ~9pp resolution floor). Results in `06-MULTIPLIER-ABLATION.md` with deletion-debate-deferred-to-post-Phase-10 hook. Default-conservative axiom (KEEP unless evidence drops) applied per CONTEXT.md.
- [ ] **RETR-06 (NEW 2026-04-27)**: Task-pattern fingerprint matching at search time — when query is task-shaped, expand to also search cross-project artifacts where task-pattern fingerprint matches via cosine + rerank
- [ ] **RETR-07 (NEW 2026-04-27)**: Cross-project query expansion **default-ON** per Q10. Per-project opt-out via CLAUDE.md flag (no opt-out implemented unless requested)
- [x] **RETR-08** (Phase 6, 2026-04-29): Cross-encoder reranker (BGE-v2-m3 on port 7439) is now load-bearing infrastructure. Bi-encoder fallback explicitly degraded; every fallback writes one row to `telemetry` with `event_kind='reranker_fallback'` and a reason from `unreachable/non_2xx/timeout/empty_response`. Session-start surfaces `## Reranker Health` line when 24h count > 0. CLAUDE.md and README.md updated.

### Curation (CUR)

- [x] **CUR-01..CUR-04**: original Phase 4 deliverables — sectioned MEMORY.md writer, idempotent curation, auto-dream guard, write-time integrity
- [x] **CUR-05**: Delete from Angel: `cara-reasoning.ts`, `autonomous-investigator.ts`, `consolidator.ts::runDreamConsolidation`, `pattern-extractor.ts::crystallizePatternToSkill`, `cross-project-consolidator.ts`, `proactive-curator.ts`, `data-quality.ts` — owned by Phase 9
- [x] **CUR-06**: Gut `heartbeat.ts` phases — drop CARA, investigation, dream, skill crystallization, proactive curation, cross-project consolidation. Heartbeat tick from ~20 phases to ~8
- [x] **CUR-07**: Angel keeps: idle monitoring, session auto-close, pattern→artifact extraction, entity resolution, embedding backfill, retention sweep, artifact promotion, MEMORY.md maintenance, service health supervision
- [x] **CUR-08**: MEMORY.md write-time integrity defense — sha256 read-back, alert + skip on external mutation, agents-don't-edit-above-sentinel rule

#### Phase 4.1 redesign (NEW 2026-04-27)

- [ ] **CUR-09**: MEMORY.md schema redesign — drop `## Entities` (frequency-extraction noise) + `## Recent Threads` (50% session-IDs as topics); add `## Lessons` (curated, task-pattern indexed) + promote `## User Notes` (user-authored verbatim)
- [ ] **CUR-10**: Lessons format — each pointer carries `task_pattern` tag + one-line salience (e.g., `[60-poll shadowban — backend X](project_backendx_shadowban.md) — 60 polls/window = 15min IP ban — task-pattern: scraping rate-limits`)
- [ ] **CUR-11**: `/endsession` curation flow — Angel reads Session Memory file (`~/.claude/sessions/<id>/.session-memory.md`) + `conversation_turns`; proposes 1-3 candidate Lessons / User Notes pointers; user accepts/edits/rejects in brief prompt
- [ ] **CUR-12**: Writer reach = 5/5 active projects via Angel heartbeat sweep — Lacuna/Oracle/Nexus get auto-managed `## Active Projects` + `## Handoff` blocks PREPENDED above existing manual pointer-indexes (which migrate verbatim into `## User Notes`). Migration NEVER stomps existing user content.
- [ ] **CUR-13**: Writer state-machine bug fix — duplicate `<!-- USER EDITABLE -->` markers eliminated; idempotent re-run produces byte-identical output (the bug visible at MEMORY.md line 42 of CLAUDEXv3 right now)
- [ ] **CUR-14**: Mixed-precision `created_at_epoch` normalized to milliseconds across all artifact kinds (T3 finding: `mental_model` stores 13-digit ms, `transcript_chunk` stores 10-digit s)
- [ ] **CUR-15**: transcript_chunk reach verified — chunker runs for all sessions; live-fire confirms ≥1 chunk per session (T3 finding: 20 chunks total in DB suggests low reach)

#### Phase 5.5 curation feedback loop (NEW 2026-04-27)

- [x] **CUR-16**: New table `pointer_recall_log(pointer_id, session_id, retrieved_at, helpful_yn, query)` — recorded when retrieval surfaces a Lesson/User-Notes pointer
- [x] **CUR-17**: Auto-archive: pointer with 0 retrievals in 90d AND `helpful_yn = null` → moved out of MEMORY.md index (artifact preserved in DB)
- [x] **CUR-18**: Auto-promote: pointer with ≥3 retrievals + `helpful_yn = true` → moved to high-salience top of section

### Framing (FRAM)

- [ ] **FRAM-01**: Rewrite every surviving formatter in `sections.ts` for advisory voice — no `WARNING:`, no `**Correct approach:**`, no `Apply them proactively`, no `supersedes CLAUDE.md on conflict`
- [ ] **FRAM-02**: Experience-warning surface (when agent explicitly queries) reframes as descriptive observation: *"Similar prior situation (session X): user wanted Y; outcome was Z."*
- [ ] **FRAM-03**: `<experience-data>` wrap retained for prompt-injection isolation; inner content descriptive, not imperative
- [ ] **FRAM-04**: Manual inspection confirms no imperative framing across all formatters
- [ ] **FRAM-05 (NEW 2026-04-27)**: Behavioral A/B for 1 week of real sessions — subjective scoring of agent-thinks-with-experience vs follows-rules. User-led review at week's end. Documented in `.planning/phases/07/07-BEHAVIORAL-AB.md`

### Lifecycle (LIFE) — owned by Phase 3 merger

- [ ] **LIFE-01**: Every `artifact(kind='directive_rule')` carries `scope ∈ {session, project, universal}` detected at ingestion by LLM
- [ ] **LIFE-02**: Supersession edges — when new directive contradicts existing active directive of same scope, LLM confirms and writes `supersedes_id`
- [ ] **LIFE-03**: Confidence decay — daily sweep reduces confidence for unreinforced rules; below threshold → `status='archived'`
- [ ] **LIFE-04**: Rule accumulation bounded — verified against fixture sessions. **Sub-gate (prerequisite to LIFE acceptance):** detector recall on held-out fixture set ≥0.85 (target) / ≥0.70 (floor)

### Directive Consumer Surface (DIR-CONSUMER) — NEW 2026-04-27, owned by Phase 3 merger

- [ ] **DIR-CONSUMER-01**: PreToolUse hook surface — surfaces relevant directive as system-role observation BEFORE matching tool runs
- [ ] **DIR-CONSUMER-02**: `applies_to_paths` (glob) + `applies_to_commands` (regex) fields per directive
- [ ] **DIR-CONSUMER-03**: Relevance threshold `helped/total ≥ 0.7` AND `total ≥ 10`. Max 1 surface per tool call (highest-relevance wins). v1 advisory only; v2 blocking deferred.
- [ ] **DIR-CONSUMER-04**: Production consumer count > 0 — verifiable in DB telemetry. Without this, Phase 3 is not "shipped" by definition (cross-cutting principle 1: writers ship with consumers).

### Handoff (HAND) — NEW 2026-04-27, owned by Phase 7.5

- [ ] **HAND-01**: Hybrid format — 2-line YAML status header (`status:`, `phase:`) + ADR-style body (*"What we found / What we decided / What's next / Where to look"*). One screen target. ~15 lines, replacing 372-line current schema.
- [ ] **HAND-02**: Writer in `src/angel/handoff-writer.ts` (or equivalent) outputs new shape; Phase 4.1's MEMORY.md `## Handoff` consumes the YAML header for programmatic queryability
- [ ] **HAND-03**: SC#4 — handoff pickup probe. Soft-allow handoff-referenced reads (files mentioned explicitly in body or frontmatter). Block exploratory glob/grep/Read of NOT-referenced files, plus discovery-shaped Bash (`ls`, `git status`, `find`) before first user-facing action.

### Token + Cache (TOK / CACH) — NEW 2026-04-27, owned by Phase 5

- [ ] **TOK-01**: Session-start ≤500 tokens (tokenizer assertion on actual session-start output). Hard.
- [ ] **CACH-01**: Golden snapshot byte-identical across runs (3-layer cache test, layer 1)
- [ ] **CACH-02**: Invariance under volatile-state mutation — clock change, session-ID change, host-env change must NOT change output bytes (3-layer cache test, layer 2)
- [ ] **CACH-03**: Pre-work hardening before deletion: clock leaks (3 sites: `assembler.ts:572,:657,:447`), session-ID strips (2: `sections.ts:859,:1005`), host-env normalization (2: `sections.ts:635`, `assembler.ts:646`), stable tiebreakers (4: `learnings.ts:60`, `artifacts.ts:178/:212`, `codebase-indexer.ts:306`, `state-reader.ts:109`), CRLF/BOM normalizer + `.gitattributes * text eol=lf`, STATE.md parser extension (extract phase name + number), handoff frontmatter spec (canonical `status`, `phase`)

### Content Quality (CONT) — NEW 2026-04-27, owned by Phase 4.1 + every subsequent PR

- [ ] **CONT-01**: Mechanical scoring rubric — zero parsing-bug rows; ≥80% of pointers carry project-specific salience (not generic nouns); thread topics not session-IDs; pointer density ≥1 useful pointer per 10 lines; freshness — handoff section reflects current state
- [ ] **CONT-02**: SC#3 — score ≥80% on every active project's MEMORY.md
- [ ] **CONT-03**: Scoring runs as CI on every PR for every active project's MEMORY.md

### Vesna Behavioral Suite (VESN) — NEW 2026-04-27, owned by Phase 10

- [ ] **VESN-01**: Corpus mined from real session histories across all active projects (claudex-v3, lacuna-betting, oracle, big-mozzy-v2, desktop-01dcc792, nexus-e53c6c93). Each retrieval moment in real history becomes a candidate probe.
- [ ] **VESN-02**: Curated to ~20 probes covering entity recall (3-5), constraint recall (3-5), handoff pickup (3), cross-project (3-5), lesson application (3-5), self-instrumented gap detection (2-3)
- [ ] **VESN-03**: SC#1 — Vesna pass rate ≥80% across full suite, every category, every active project. Primary gate at every phase boundary with behavioral exposure.
- [ ] **VESN-04**: CI integration — probe suite runs on every PR via `bun run vesna` or equivalent; pass rate ≥80% required to merge. Probes maintained alongside code at `src/benchmark/vesna/probes/*.json` + harness in `src/benchmark/vesna/`.

### Recall Observability (OBS) — NEW 2026-04-27, owned by Phase 8.5

- [ ] **OBS-01**: Per-session retrieval log — every `claudex_search` / `claudex_recall` invocation captured with query, top-k results, which were used in subsequent agent output, token cost
- [ ] **OBS-02**: Agent system prompt addition (advisory voice) — when retrieval returns nothing useful, narrate (*"no prior experience on this — going in cold"*); when retrieval returns gold, narrate (*"checking shadowban research from Lacuna … found, applying"*). Visible by default, silent on demand.
- [ ] **OBS-03**: Visible token cost at `/endsession` — *"session-start spent N tokens; recall added M tokens; total memory cost X tokens (Y% of context)."*
- [ ] **OBS-04**: Slash command `/claudex-why` (or equivalent) shows retrieval log for current session

### RL Ablation (ABL) — NEW 2026-04-27 (replaces deprecated BENCH-08), owned by Phase 8

- [ ] **ABL-01**: Feature flag `CLAUDEX_DISABLE_RL_SCORING=1` bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks in heartbeat
- [ ] **ABL-02**: Run Vesna probe suite with flag set; baseline run without flag. Decision committed to `context/specs/V4_RL_ABLATION.md`. If flagged Vesna ≥ baseline -2pp: Phase 9 clears RL deletion. If flagged Vesna drops >2pp: RL load-bearing — keep stack and adjust scope or redesign with simpler learned signal.
- [ ] **ABL-03**: Edge case — if delta is exactly at -2pp, default to "keep RL" (conservative). Document, revisit after Phase 9.

### Removed Requirements (2026-04-27 audit-driven)

| Removed | Reason |
|---|---|
| BENCH-01 (LongMemEval ≥88% floor) | Benchmarks not used in v4 — see PROJECT.md Constraints + `feedback_benchmarks_are_sanity_not_gates.md` |
| BENCH-02 (LoCoMo ≥70% target / stretch 80%+) | Same |
| BENCH-03 (full v3 test suite passes after every phase) | Restated in PROJECT.md Constraints (kept as constraint, not benchmark requirement) |
| BENCH-04 (Vesna smoke check at rank 1-3) | Replaced by VESN-01..04 — Vesna is full central validation now, not single-point smoke |
| BENCH-05 (≤500 token tokenizer assert) | Restated as TOK-01 — same content, recategorized away from "benchmark" |
| BENCH-06 (UPS ≤1KB) | Restated as INJ-05 |
| BENCH-07 (cache-stable prefix proven) | Restated as CACH-01..03 |
| BENCH-08 (P6.5 RL ablation report) | Restated as ABL-01..03 — methodology unchanged but named correctly (it was always an ablation, never a benchmark) |
| BENCH-09 (agent-initiated retrieval ≥2× baseline) | Metric is contaminated (writer = deletion target) AND threshold mathematically impossible (cap=3 vs ≥10). Replaced by Vesna behavioral probes (VESN) and recall observability (OBS) which measure the same intent more directly. |

## v2 Requirements

*(none for v4 — this milestone is intentionally bounded. Post-v4 candidates: Angel-as-subagent migration, Agent Teams integration, cross-project consolidator redesign — but the rebind already covers cross-project recall in Phase 6.5.)*

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ground-up rewrite | v4 is consolidation + behavioral reframe + targeted upgrades; 124 commits of v3 bug fixes stay |
| Reranker service changes | `services/reranker.py` BGE-v2-m3 on port 7439 works |
| sqlite-vec / vec0 virtual tables | V15 foundation, don't touch |
| CC hook plumbing | 26 hooks in `src/adapters/cc-hooks/` are clean and working |
| Ollama arctic-embed2 embeddings | Infrastructure stays |
| `lifecycle.ts` shared module | 1466 lines reused across hooks + OpenClaw bridge |
| Angel-as-subagent migration | Parked until v4 stabilizes |
| Agent Teams integration | Experimental unstable API |
| `conversation_turns` schema change | Raw turn storage correct; new chunking pipeline layers on top |
| Public-release polish | v4.1 = Distribution as dedicated follow-up milestone |
| **Benchmark gates of any kind** (LongMemEval/LoCoMo/BENCH-09) | **Dropped 2026-04-27** — see PROJECT.md Q8 decision and `feedback_benchmarks_are_sanity_not_gates.md`. Re-introduction is the failure mode the audit caught. Harness on disk for one-shot ship-time record only. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STOR-01..STOR-08 | Phase 2 (P1) | Complete (T3 verified 2026-04-27) |
| STOR-09 | Phase 4.1 (or 6.5 — TBD in plan) | Pending |
| EXTR-01..EXTR-03 | Phase 3 (P2) | Complete |
| EXTR-04 | Phase 3 merger | Partial-with-followups — held-out recall measurement + `negation_dont` tune in merger |
| EXTR-05 | Phase 9 (P7) | Pending |
| EXTR-06 | Phase 4.1 | Pending |
| INJ-01..INJ-07 | Phase 5 (P4) | Pending |
| RETR-01..RETR-04 | Phase 6 (P5) | Done 2026-04-29 (RETR-02 partially: consolidation, deletion deferred to post-Phase-10) |
| RETR-05 | Phase 6 (per-multiplier ablation) | Done 2026-04-29 (0pp delta at N=11; deletion-debate-deferred-to-Phase-10) |
| RETR-06..RETR-07 | Phase 6.5 | Pending |
| RETR-08 | Phase 6 | Done 2026-04-29 |
| CUR-01..CUR-04 | Phase 4 (P3) | Complete (superseded by 4.1) |
| CUR-05..CUR-07 | Phase 9 (P7) | Pending |
| CUR-08 | Phase 4 (P3) | Complete |
| CUR-09..CUR-15 | Phase 4.1 | Pending |
| CUR-16..CUR-18 | Phase 5.5 | Complete (2026-04-29) |
| FRAM-01..FRAM-04 | Phase 7 (P6) | Pending |
| FRAM-05 | Phase 7 (P6) | Pending |
| LIFE-01..LIFE-04 | Phase 3 merger | Pending |
| DIR-CONSUMER-01..04 | Phase 3 merger | Pending |
| HAND-01..HAND-02 | Phase 7.5 | Pending |
| HAND-03 | Phase 11 (gate) | Pending |
| TOK-01 | Phase 5 (P4) | Pending |
| CACH-01..CACH-03 | Phase 5 (P4) | Pending |
| CONT-01 | Phase 4.1 | Pending |
| CONT-02 | Phase 11 (gate) | Pending |
| CONT-03 | Phase 4.1 (CI integration) | Pending |
| VESN-01..VESN-02 | Phase 10 | Pending |
| VESN-03 | Phase 11 (gate) | Pending |
| VESN-04 | Phase 10 (CI integration) | Pending |
| OBS-01..OBS-04 | Phase 8.5 | Pending |
| ABL-01..ABL-03 | Phase 8 (P6.5) | Pending |

**Coverage:**
- v1 requirements: 67 total (49 original − 9 BENCH dropped + 27 NEW from rebind)
- Mapped to phases: 67
- Unmapped: 0

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups — shipped at reduced acceptance with explicit follow-up tracked in a later phase
