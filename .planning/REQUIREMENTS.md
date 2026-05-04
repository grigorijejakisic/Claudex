# Requirements: Claudex v5 — Bound Multi-Modal Episodes

**Defined:** 2026-05-04 (v5 milestone seed; refinable during phase 1 discuss)
**Core Value:** Claudex stores bound multi-modal episodes; recall is by any modality; abstraction emerges from density.

> **v4 requirements** (STOR / EXTR / INJ / RETR / CUR / FRAM / LIFE / DIR / HAND / TOK / CACH / OBS / ABL / VESN / LIC / DOC / PLAT / INST / DIAG / VER / REL) shipped at v4.0.0 (2026-04-30) and v4.1.0 (2026-05-02). Their roll-up is preserved in `.planning/v4-final/REQUIREMENTS.md`. v4.2+ deferred items are also archived there.

## v5 Requirements (Initial Scope — Refinable During Phase Planning)

These requirements are a seed, not a contract. Phase 1's discuss step may add, split, merge, or remove them based on what the substrate work surfaces. Categories map to roadmap phases.

### Episode Substrate (EPI)

- [ ] **EPI-01**: New `episodic_events` table (or rename of canonical equivalent) with structured row schema: `id, session_id, project, ts_epoch, type, source, content, provenance, metadata_json`
- [ ] **EPI-02**: Provenance enum: `organic | injected | tool_result | environmental` — every write tags one
- [ ] **EPI-03**: Write path from existing hooks (UserPromptSubmit, Stop, PostToolUse, etc.) populates `episodic_events` parallel to `conversation_turns` — both alive during transition
- [ ] **EPI-04**: Hook-injected wrapper blocks (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<task-notification>`, ...) write as separate event rows with `provenance='injected'` rather than being concatenated into user_text — structural fix for the Mem0 trap
- [ ] **EPI-05**: Tool results write with `provenance='tool_result'` and a typed source identifier (`Bash`, `Read`, `Edit`, ...) usable as a recall handle
- [ ] **EPI-06**: Schema migration is forward-only; legacy `conversation_turns` remain readable for v4 backwards-compat
- [ ] **EPI-07**: Tests assert that injecting an `<experience-data>` block into a prompt produces a single `provenance='injected'` event row, not part of the organic user turn

### Multi-Modal Indexes (IDX)

- [ ] **IDX-01**: Error-fingerprint index — token-shingle + edit-distance over stack traces / build errors / exception messages. Built on episode rows where `type='tool_result'` and content matches error patterns
- [ ] **IDX-02**: Error-fingerprint recall measurably improves over semantic-only on a fixture corpus of 30+ historical error episodes (empirical phase 2 success criterion)
- [ ] **IDX-03**: At least one additional non-semantic index validated by Phase 2 measurement (structural-shape / affect-signal / speaker-typed) — choice deferred to phase 2 discuss
- [ ] **IDX-04**: Density at our scale (~9K episodes after backfill) produces fire patterns distinguishable from noise — measured, not assumed

### Multi-Handle Retrieval (RET)

- [ ] **RET-01**: `hybrid-retrieval.ts` rewritten to fuse N indexes (semantic + FTS + ≥1 multi-modal) via RRF or learned weights
- [ ] **RET-02**: Provenance-aware extraction — when reading episodes for any LLM-facing output (synthesis, dashboard, recall), `provenance='injected'` content is filtered or flagged so the Mem0 loop cannot reform
- [ ] **RET-03**: `experience_warning_triggers` cuts over to fire from episodes-by-handle (not from `experience_patterns` rows)
- [ ] **RET-04**: Assembly pipeline's experience-pattern injection cut over to episode-based density abstraction (depends on ABS phase)
- [ ] **RET-05**: Existing `experience_pattern` rows remain readable as a deprecation surface; no cold-cut

### Density-Based Abstraction (ABS)

- [ ] **ABS-01**: Retrieval-time clustering: when N>=K episodes match a query and cluster by similarity above threshold T, surface as inferred pattern in advisory voice
- [ ] **ABS-02**: K and T tuned against real recall queries (Phase 5 measurement)
- [ ] **ABS-03**: Inferred clusters are NOT persisted as rows — they exist only at recall time
- [ ] **ABS-04**: Phase 5 measurement output: does density abstraction subsume `experience_patterns` injection at our scale, or under-/over-surface? Negative result is a valid finding.

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

- [ ] **VAL-01** (= SC-V5-1): Episodic recall probe — keyword/concept from session N-1 fires the relevant episode in session N. Probe corpus draws from real session history (including the 2026-05-04 parable failure as a regression test)
- [ ] **VAL-02** (= SC-V5-2): No-re-extraction-inflation probe — inject an `<experience-data>` block, run a session, assert no new `experience_pattern`-equivalent row was created from that span
- [ ] **VAL-03** (= SC-V5-3): Density-at-scale probe — Phase 5's measurement output, packaged as a probe that future ablations can replay
- [ ] **VAL-04** (= SC-V5-4): Crash-resilience probe — kill -9 a session mid-conversation; verify Angel synthesizes on idle timeout via fsnotify
- [ ] **VAL-05**: Vesna suite update — existing 17 probes pass against v5 substrate; new probes added for VAL-01..04
- [ ] **VAL-06**: One-turn handoff pickup probe (v4's SC#4) still passes — episodes carry handoff content; recall surface delivers it

## Out of Scope for v5

- Multi-harness support (Cursor/Zed/etc) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- Privacy/PII redaction infrastructure (engineering-doc Rec #5) — captured as MIG/EBD-adjacent but the v5 scope is **substrate**, not the privacy layer; if privacy work proves larger than expected during phase planning, split into a v5.1 milestone
- Real-time PII redaction at write time — same; deferred unless phase planning escalates it

## v4 Deferrals Carried Forward

The 8 HITL-pending v4.1 items (PLAT-06/07/08 fresh-VM installs, VER-04/05 onboarding fixtures, REL-04/05/07 GitHub UI clicks) remain in `v4-final/` archive. Operator can close them on their own timeline; they do not block v5.

The v4 deferrals from REQUIREMENTS.md (STOR-09 task-pattern fingerprint, EXTR-04/06 partials, LIFE-01..04, DIR-CONSUMER-01..02, FRAM-05 A/B verdict) — under v5's binding substrate, several of these (notably STOR-09 task-pattern fingerprint, DIR-CONSUMER-01..02) are subsumed by IDX/RET requirements above. Phase 1 discuss should explicitly check each carry-forward item against v5 scope and either close-as-subsumed or carry to v5.1.
