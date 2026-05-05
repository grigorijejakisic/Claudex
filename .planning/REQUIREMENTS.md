# Requirements: Claudex v5 — Bound Multi-Modal Episodes

**Defined:** 2026-05-04 (v5 milestone seed)
**Reframed:** 2026-05-05 — multi-handle thesis KILL after 3 consistent KILL bound experiences in Phases 2 and 2.1. RET-* and ABS-* dropped; IDX-* closed as investigation; v5 narrows to substrate-only milestone. See `.planning/reframes/2026-05-05-multi-handle-kill.md`.

**Core Value (post-reframe):** Claudex stores bound multi-modal episodes with provenance; recall remains v4's hybrid-retrieval (semantic + FTS + reranker) unchanged in v5; abstraction-from-density is empirically rejected at our scale and is not a v5 deliverable.

> **v4 requirements** (STOR / EXTR / INJ / RETR / CUR / FRAM / LIFE / DIR / HAND / TOK / CACH / OBS / ABL / VESN / LIC / DOC / PLAT / INST / DIAG / VER / REL) shipped at v4.0.0 (2026-04-30) and v4.1.0 (2026-05-02). Their roll-up is preserved in `.planning/v4-final/REQUIREMENTS.md`. v4.2+ deferred items are also archived there.

## v5 Requirements (Post-Reframe Scope)

EPI-* shipped with Phase 1. IDX-* closed as Phase 2/2.1 investigation (verdict KILL × 3). RET-* and ABS-* dropped with the multi-handle thesis. AR-*, EBD-*, MIG-*, VAL-* survive (with VAL-03 transformed). Categories map to surviving roadmap phases (1 shipped, 4, 6, 7).

### Episode Substrate (EPI) — SHIPPED 2026-05-04 (Phase 1)

- [x] **EPI-01**: `episodic_events` table with structured row schema (V25 migration)
- [x] **EPI-02**: Provenance enum: `organic | injected | tool_result | environmental` (closed-enum CHECK constraint)
- [x] **EPI-03**: Dual-write helpers (`dualWriteUserPrompt`, `dualWriteAssistantMessage`, `writeToolResult`, `writeEnvironmentalEvent`) populate `episodic_events` parallel to `conversation_turns`
- [x] **EPI-04**: Hook-injected wrapper blocks write as separate `provenance='injected'` event rows (Mem0-trap structurally impossible — proven by stub-extractor test EPI-07)
- [x] **EPI-05**: Tool results write with `provenance='tool_result'` and typed source identifier
- [x] **EPI-06**: V25 forward-only migration; legacy `conversation_turns` remain readable
- [x] **EPI-07**: Stub-extractor test asserts injected `<experience-data>` blocks produce single `provenance='injected'` rows, not organic user turn fragments (60+ EPI-tagged tests passing)

### Multi-Modal Indexes (IDX) — INVESTIGATION CLOSED 2026-05-05 (Phase 2/2.1, verdict KILL × 3)

- [x] **IDX-01**: Error-fingerprint index built (V26 sidecar `episodic_index_error_fingerprint` + pure fingerprinter + idempotent backfill: 135 fingerprints / 19 projects / 10,678 sidecar rows)
- [-] **IDX-02**: Error-fingerprint recall does NOT measurably improve over semantic-only at our scale. Phase 2 (n=20) and Phase 2.1 strict (n=20) and relaxed (n=19) all failed CI-binding on Δp@5 and Δr@10. Three KILL bound experiences in `.planning/aggregates/multi-handle.json`.
- [-] **IDX-03**: Additional non-semantic indexes NOT pursued. Multi-handle thesis dropped before second index investigated.
- [-] **IDX-04**: Density at our scale does NOT produce fire patterns distinguishable from noise. Intra-project share measured at 0.2418 in both 2.1 tiers (threshold 0.30). Repeatability across labelers confirms it's the corpus's actual density floor.

### Multi-Handle Retrieval (RET) — DROPPED 2026-05-05 (multi-handle thesis KILL)

- [-] **RET-01..05**: Dropped. v4's `hybrid-retrieval.ts` (semantic + FTS + reranker) stays in production unchanged. No RRF cutover ships in v5. `experience_warning_triggers` continues firing from `experience_patterns` legacy rows. Provenance-aware extraction is achieved structurally by EPI-02..04 (not by RET-02 retrieval-side filtering). Reasoning: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

### Density-Based Abstraction (ABS) — DROPPED 2026-05-05 (density thesis KILL)

- [-] **ABS-01..04**: Dropped. No retrieval-time clustering as inferred patterns ships in v5. `experience_patterns` legacy reads remain live; no replacement. Reasoning: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

### Angel Reduction (AR)

- [ ] **AR-01**: Code trace produced: every reader of `experience_patterns`, `directive_rule` (the extraction-driven flavor), and `pattern-extractor.ts` outputs catalogued
- [ ] **AR-02**: Each reader either re-pointed at episode-based retrieval, or marked legacy with explicit follow-up
- [ ] **AR-03**: Extraction-time pattern creation deleted from `pattern-extractor.ts`; the Angel's role becomes binding + indexing, not abstraction
- [ ] **AR-04**: The Mem0 stripping defense from commit `0d0fbca` becomes structurally obsolete (provenance tags do the job); confirm before deletion
- [ ] **AR-05**: LLM use moves to query-time fusion (or eliminated entirely if embedding-only path proves sufficient — phase 5 informs)

### Episode Boundary Detection (EBD)

- [ ] **EBD-01**: Angel observes session activity via fsnotify on the JSONL directory (engineering-doc Recommendation #1.1)
- [ ] **EBD-02**: Heartbeat row written by every UserPromptSubmit / PreToolUse / PostToolUse hook (Recommendation #1.2)
- [ ] **EBD-03**: Idle-timeout sweep: sessions with no JSONL writes for >T → marked dormant → terminated after grace (Recommendation #1.3 — survives PC reboot, OOM, hard ctrl-c, segfault)
- [ ] **EBD-04**: PID liveness with heartbeat-compare-before-cleanup (Recommendation #1.4-5 — avoids "Session Amnesia" failure)
- [ ] **EBD-05**: Episode boundary unit decided: per-thread, per-intent-shift, per-task-completion — investigated during phase 6 discuss (engineering-doc open question #2)
- [ ] **EBD-06**: Synthesis (binding+indexing finalization) fires when episode closes by ANY of: clean `/endsession`, idle timeout, JSONL write absent for T

### v4 Coexistence / Migration (MIG)

- [ ] **MIG-01**: Per-table decision: retire / re-derive / preserve — for `experience_patterns`, `learning`, `decision`, `mental_model`, `angel_opinion`, `directive_rule`, `critical_rule`, `transcript_chunk`
- [ ] **MIG-02**: For tables decided "re-derive": projection script that reads raw episodes (after EPI-03 backfill) and produces equivalent rows in modern shape
- [ ] **MIG-03**: For tables decided "preserve": no-op, but tagged with provenance so downstream readers know
- [ ] **MIG-04**: For tables decided "retire": deprecation surface + read-only mode + post-v5 deletion plan
- [ ] **MIG-05**: 88 inflated experience_patterns from v4 are NOT re-derived (they're noise); replaced by Phase 5 density abstraction

### Validation (VAL)

- [ ] **VAL-01** (= SC-V5-1): Episodic recall probe — keyword/concept from session N-1 fires the relevant episode in session N. Probe corpus draws from real session history (including the 2026-05-04 parable failure as a regression test). Recall surface is v4's hybrid-retrieval (unchanged in v5); the probe asserts that Phase 1's substrate makes the relevant episode *retrievable*, not that retrieval mechanics themselves changed.
- [ ] **VAL-02** (= SC-V5-2): No-re-extraction-inflation probe — inject an `<experience-data>` block, run a session, assert no new `experience_pattern`-equivalent row was created from that span. Validated against post-Phase-4 codepath (extraction-time pattern creation deleted).
- [ ] **VAL-03'** (= SC-V5-3' KILL-regression): Replay the Phase 2.1 harness (locked corpus + locked decision rule) and assert KILL verdict reproduces. Future accidental restoration of the dead multi-handle thesis fails this probe. Replaces the original VAL-03 density-at-scale probe (which presupposed density was real).
- [~] **VAL-04** (= SC-V5-4): Crash-resilience probe. **Phase 6 (2026-05-05) shipped the substrate** (composition rule + boundary detector + JSONL watcher + V29 schema) plus **55 vitest regression tests** at `src/tests/angel/boundary/` covering composition truth table, heartbeat-compare race, cursor replay, re-open branches, end-to-end integration. **Vesna probe form deferred to Phase 7** — Vesna's behavioral schema asserts on `agent_text`, which requires a consumer surface reading the close marker; Phase 7 wires that surface during v4 coexistence/migration. Until then, SC-V5-4 is regression-locked at unit level. Phase 7 adds the Vesna probe alongside VAL-01/03'.
- [ ] **VAL-05**: Vesna suite update — existing 17 probes pass against v5 substrate; new probes added for VAL-01/02/03'/04.
- [ ] **VAL-06**: One-turn handoff pickup probe (v4's SC#4) still passes — episodes carry handoff content; v4 recall surface delivers it.

## Out of Scope for v5

- Multi-harness support (Cursor/Zed/etc) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- Privacy/PII redaction infrastructure (engineering-doc Rec #5) — captured as MIG/EBD-adjacent but the v5 scope is **substrate**, not the privacy layer; if privacy work proves larger than expected during phase planning, split into a v5.1 milestone
- Real-time PII redaction at write time — same; deferred unless phase planning escalates it

## v4 Deferrals Carried Forward

The 8 HITL-pending v4.1 items (PLAT-06/07/08 fresh-VM installs, VER-04/05 onboarding fixtures, REL-04/05/07 GitHub UI clicks) remain in `v4-final/` archive. Operator can close them on their own timeline; they do not block v5.

The v4 deferrals from REQUIREMENTS.md (STOR-09 task-pattern fingerprint, EXTR-04/06 partials, LIFE-01..04, DIR-CONSUMER-01..02, FRAM-05 A/B verdict) — under v5's binding substrate, several of these (notably STOR-09 task-pattern fingerprint, DIR-CONSUMER-01..02) are subsumed by IDX/RET requirements above. Phase 1 discuss should explicitly check each carry-forward item against v5 scope and either close-as-subsumed or carry to v5.1.
