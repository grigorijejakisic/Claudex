# Claudex v3 Architecture Review

Date: 2026-03-09
Reviewer: Codex (GPT-5)
Scope: `ARCHITECTURE.md` vs predecessor behavior in Claudex v2 + OpenClaw Context Manager

## Executive Summary

The direction is strong: one core, one storage system, two adapters is better than the current dual-system coordination contract. The design captures many proven patterns from both predecessors.

But the current spec still has several implementation-critical gaps (event contract mismatch, concurrency semantics, schema edge cases, migration realism, and operational guardrails). As written, this is a high-quality draft, not yet an implementation-ready blueprint.

Recommended grade: **B-**.

---

## A. What Is Missing or Underspecified

### 1. Runtime event model is underspecified and partially mismatched

The proposed `RuntimeAdapter` interface is clean conceptually, but it hides host-specific requirements that are still needed for correctness.

- `beforePrompt(prompt, ctx)` assumes a single prompt string. OpenClaw `context` events are often full-message-context events, not a strict one-prompt boundary.
- Decision capture/open-item extraction in the proposal depends on assistant/user message content, but the CC hook side has no first-class message-history object in this interface.
- `message_end` is mapped as "no direct map," but existing OpenClaw behavior uses it for feedback/reference tracking.

Net: the abstraction currently leaks and also drops capabilities.

### 2. Decision/open-item capture source of truth on Claude Code is unclear

In predecessors:
- Claudex v2 captures lightweight decision signals in `user-prompt-submit` and thread signals in `post-tool-use`.
- OpenClaw CM captures richer decision/open-item signals from full context message arrays and compaction-time snapshots.

In v3, this is described as happening in `afterTool()` and `beforePrompt()`, but the required data source (assistant text + message chronology) is not defined for CC hooks. Without this, quality will regress vs OpenClaw CM.

### 3. Storage schema has edge-case bugs/regressions

Several schema details are risky as currently written:

- `learnings` uniqueness on `(project, agent_id, fingerprint)` with nullable `project` allows duplicate "global" rows in SQLite because `NULL` does not participate in uniqueness like normal values.
- `observations.files_modified` is documented as comma-separated text; predecessor logic and decay/co-occurrence logic rely on JSON-array semantics.
- JSON-in-text columns (`thread_state.key_exchanges`, `checkpoint_tracking.thresholds_hit`) have no `json_valid` guard.

### 4. Concurrency and consistency model is not specified enough

The architecture says WAL mode + defensive non-throwing, but it does not define:

- Per-session serialization model (actor queue/mutex) across overlapping hooks/events.
- Transaction boundaries for multi-step writes (observation + pressure + thread + checkpoint tracking).
- Idempotency keys for duplicate/replayed events.
- Checkpoint ID race prevention (date+sequence by directory scan is race-prone under concurrent writers).

### 5. Operational plan is thin for a persistent, multi-runtime system

Missing or too brief:

- Metrics/observability contract (latency, checkpoint write failures, injection size, dedup hit ratio, DB lock wait time).
- DB maintenance policy (WAL checkpointing, vacuum, integrity checks, corruption recovery).
- Debug tooling (event replay, session timeline, "why was this injected" audit trace).
- Deployment compatibility matrix for `better-sqlite3` across CC hook runtime and OpenClaw plugin packaging.

### 6. Migration path is incomplete for real cutover

The phase plan is good structurally, but incomplete in migration safety:

- No explicit import/backfill path for OpenClaw CM state files (`decisions.json`, `thread.json`, `open_items.json`, `learnings.json`) into SQLite.
- No shadow mode with diffing (v2/CM output vs v3 output) before switching ownership.
- No rollback strategy if adapter behavior diverges in production.
- Migration SQL drops tables immediately; no archival/backup checkpoint in plan.

### 7. Boundary-only strategy does not fully address mid-session topic shifts

Boundary-only injection is excellent for performance, but the spec only triggers full restore at session start and post-compaction. It does not define what happens when the user intentionally pivots topics mid-session before compaction.

The architecture mentions topic tracking, but not how that changes injection behavior in-flight.

---

## B. Architectural Flaws or Risks

### High Risk

1. **Adapter abstraction leaks host internals while still losing capability**
- `PromptContext` mixes host-specific fields (`transcriptPath`, `contextUsage`) directly into core interface.
- At the same time, core intelligence features need richer message history that is not guaranteed by this interface.
- This creates a "worst of both worlds" contract.

2. **Potential race conditions around checkpointing and threshold state**
- Overlapping hook/event execution can race checkpoint creation and `latest` pointer updates.
- Without idempotency/event sequence checks, duplicate or out-of-order writes can produce state drift.

3. **Deadlock/timeout risk for CC enrichment path**
- The document itself flags a risk when PreCompact calls back into local CC API while CC waits for hook completion.
- This is not just an open question; it is a production blocker unless explicitly disabled or moved async.

4. **Boundary-only injection can underperform on long, non-compacting sessions**
- If compaction does not happen for a long time, context relevance can drift while injection stays near-zero.
- Topic changes or phase changes may not be reflected quickly enough.

### Medium Risk

5. **SQLite as sole state bus without explicit session actor model**
- WAL helps concurrency, but not logical sequencing correctness.
- Multi-step state updates can become partially applied under failures.

6. **Schema simplification can silently drop behavior quality**
- Removing/mutating fields without preserving predecessor semantics (especially thread/decision signal quality and co-occurrence features) risks regressions masked as "simplification."

7. **Mutual exclusion is policy, not enforcement**
- "Deploy one adapter or the other" is a convention unless enforced by lockfile/registration guard.
- Misconfiguration can still activate both paths for overlapping scope.

8. **Debounce policy may skip critical checkpoints near compaction thresholds**
- A fixed 60s debounce for non-compaction writes can block high-value checkpoint writes during rapid token growth.

### Low-to-Medium Risk

9. **Semantic dedup false positives/negatives at scale**
- Jaccard + stemming + substring is practical, but short operational decisions can over-dedup or miss paraphrases.
- Needs observability and override strategy.

---

## C. Concrete Improvements

### 1. Replace current adapter interface with capability-aware event envelopes

Introduce a host-neutral event model plus capabilities:

- `RuntimeEvent` (kind, session identity, timing, payload)
- `RuntimeCapabilities` (hasFullHistory, hasContextUsage, supportsSystemInjection, supportsAsyncEnrichment, etc.)

Then implement intelligence modules against required capabilities instead of implicit host assumptions.

### 2. Add per-session serialization and idempotency

- Per-session actor queue/mutex in core.
- `event_id` + monotonic `sequence_no` on all runtime events.
- Ignore/replay-protect duplicate events.

This resolves most race and reordering issues.

### 3. Wrap multi-table writes in explicit transactions

For `afterTool` and checkpoint triggers, use one transaction for:
- observation insert
- pressure updates
- thread/decision updates
- checkpoint_tracking updates

Guarantee all-or-nothing state transitions.

### 4. Fix schema edge cases now

- Make JSON fields explicit with validity checks.
- Represent `files_modified` as JSON, not comma-separated text.
- For global learnings uniqueness, avoid nullable uniqueness trap (e.g., generated key with `COALESCE(project, '__global__')`).
- Add `updated_at_epoch` to all mutable rows for debugging/time-order checks.

### 5. Harden checkpoint write protocol

- Generate checkpoint IDs from DB sequence/ULID, not directory scan.
- Write checkpoint metadata in SQLite first, then file mirror.
- Mark checkpoint as `pending` -> `committed` -> `mirrored` to support recovery and replays.

### 6. Make enrichment asynchronous or adapter-scoped

- Disable synchronous enrichment on CC hook path by default.
- Run enrichment async post-compaction (or OpenClaw-only where safe).
- Keep heuristic checkpoint as canonical immediate output.

### 7. Add topic-shift micro-injection policy

Keep boundary-only default, but add small restore triggers when:
- topic similarity drops below threshold,
- user explicitly asks to switch tasks,
- phase/branch changes.

Inject small "context pivot" blocks, not full 4k context.

### 8. Expand migration strategy to production-safe cutover

Use staged migration:

1. Read-only shadow mode (`v3` computes outputs, does not own writes).
2. Dual-write mode (v2/CM + v3) with diff reports.
3. Cutover with rollback switch.
4. Table drop only after retention period and snapshot export.

### 9. Add an operations contract

Define and implement minimum telemetry:

- hook/event latency p50/p95/p99
- checkpoint attempts/success/failure
- injection tokens by section
- dedup/promote rates
- DB lock/wait stats
- error budget dashboards

### 10. Explicitly define interaction with Claude Code native memory

Add a first-class policy section now:

- what v3 reads from `MEMORY.md` (if anything),
- what v3 writes (if anything),
- conflict resolution when native memory and v3 disagree,
- fallback when native context features improve.

---

## D. Grade (A-F)

## Grade: **B-**

### Why B-

What is strong:
- Clear unification direction.
- Good reuse of proven predecessor mechanisms (FTS5 retrieval, checkpoint recovery, semantic dedup, enrichment safety-net).
- Better conceptual architecture than maintaining a coordination contract between two independent systems.

What prevents higher grade:
- Critical runtime/interface ambiguities.
- Missing hard guarantees for event ordering and state consistency.
- Migration path underestimates real-world cutover complexity.
- Some schema details are likely to cause correctness drift.

### Compared to predecessors

- **Better than dual-system v2 + OpenClaw CM** from a maintainability and ownership perspective.
- **Not yet safer than current production behavior** until concurrency, event contracts, and migration are tightened.

### Would I implement as written?

Not directly. I would implement after a design revision that resolves:

1. capability-aware adapter/event contract,
2. per-session serialization + idempotency,
3. schema edge fixes,
4. shadow migration plan.

---

## E. Upgrade Ideas (Good -> Great)

### 1. Retrieval quality upgrades (memsearch-style patterns)

Add a hybrid retrieval ranker:
- lexical relevance (FTS5/BM25)
- semantic similarity (embeddings, optional)
- recency decay
- reinforcement from historical selection/usefulness

This reduces over-reliance on keyword overlap and improves recall for paraphrased tasks.

### 2. Memory confidence and feedback loops (claude-mem-style patterns)

Tag memories with confidence/source quality:
- heuristic-only
- user-confirmed
- repeated-success promoted

Then preferentially surface high-confidence items and decay low-confidence noise faster.

### 3. Decision quality pipeline

Promote decision capture from regex-only to a two-stage model:
- fast heuristic candidate extraction
- lightweight verifier/classifier (small model or deterministic structural checks)

This keeps latency low while improving precision.

### 4. Native Claude Code auto-memory strategy

Treat native auto-memory as a peer system, not a competitor:

- Keep v3 as authoritative operational memory store.
- Optionally publish a curated, bounded subset to `MEMORY.md` (stable cross-session learnings only).
- Never blindly overwrite model-managed memory; use append/merge with provenance markers.

### 5. Future-proofing for native context-management evolution

Assume Claude Code will add stronger native context APIs. Build v3 as:
- a policy + intelligence layer,
- with pluggable transport adapters,
- and feature flags to disable redundant subsystems when host-native equivalents become available.

If host-native context becomes robust, v3 should degrade into "high-signal memory compiler + checkpoint mirror + analytics," not break.

---

## Final Recommendation

Proceed, but do not start full implementation from this draft unchanged.

First produce an Architecture v1.1 that locks down:

1. runtime event/capability contract,
2. serialization/idempotency model,
3. schema corrections,
4. migration and rollback plan,
5. operational SLOs + telemetry.

That revision would move this from **B-** to **A-/B+** and make it implementation-ready.

