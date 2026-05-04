# Phase 1: Episode substrate - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Type:** engineering

<domain>
## Phase Boundary

Schema design + write path for a new `episodic_events` table that coexists with v4's `conversation_turns` (forward-only, no migration of legacy rows). Every UserPromptSubmit, every Stop hook, and every tool result writes a structured event row in parallel with the legacy flat-text capture. Provenance tags are applied at write time so injected (recalled) content is structurally distinguishable from organic content — making the Mem0 inflation feedback loop impossible by construction.

**In scope:**
- New `episodic_events` table + migration
- Modifying every relevant CC hook + adapter writer to dual-write
- Provenance-tagging logic (split organic vs injected spans)
- Telemetry on dual-write failures
- Unit + integration tests asserting "after hook X fires, episodic_events has Y rows with Z provenance"

**Explicitly out of scope (other phases):**
- Indexes beyond the table's own primary key + provenance/session/ts indexes (Phase 2 builds the first multi-modal index)
- Embedding generation for episodic events (Phase 2/3)
- Any reader of `episodic_events` — Angel, CARA, assembly, hybrid-retrieval (Phase 3 cuts retrieval over)
- Episode boundary semantics + `episode_id` (Phase 6)
- Deletion or migration of `conversation_turns` rows (Phase 7)
- Pattern-extractor reduction (Phase 4)

</domain>

<decisions>
## Implementation Decisions

### Event row shape

Concrete column set for `episodic_events`:

| Column | Type | Required | Purpose |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | yes | Surrogate key |
| `session_id` | TEXT | yes | Same value space as `conversation_turns.session_id` |
| `project` | TEXT | yes | Project scope; mirrors v4 convention |
| `ts_epoch` | INTEGER | yes | Unix seconds; primary order |
| `turn_number` | INTEGER | NULLable | Set for turn-bound events (user_prompt, assistant_message, tool_call/result chained to a turn). NULL for environmental events that don't belong to a conversational turn |
| `type` | TEXT | yes | Open string with documented well-known values (see taxonomy) |
| `source` | TEXT | yes | Open string identifying the producer (hook name, tool name, "claude-code-cli", etc.) |
| `content` | TEXT | yes | Raw payload as the agent saw it (post-strip wrappers extracted into their own rows — see provenance semantics) |
| `provenance` | TEXT | yes | Closed enum: `organic | injected | tool_result | environmental` |
| `parent_event_id` | INTEGER | NULLable | FK to `episodic_events.id`; ties injected spans to their parent organic prompt, ties tool results to their assistant call |
| `content_hash` | TEXT | yes | sha256 of `content` only (raw byte fingerprint). Composers needing more (provenance/source) build it at query time |
| `metadata_json` | TEXT (JSON1) | NULLable | Modality-specific fields (token_count, model_id, error fingerprint shingles, tool args, etc.). Phase 2 indexes read from here without schema migration |
| `schema_version` | SMALLINT | yes | Phase 1 ships v=1; any breaking change to the metadata_json contract bumps this |

Indexes: PK on `id`; secondary on `(session_id, turn_number, ts_epoch)`, `(project, ts_epoch)`, `(provenance)`, `(parent_event_id)`.

**Reasoning:** dedicated columns for everything that needs to be indexed today; `metadata_json` is the extension point so Phase 2 doesn't need DDL to add modality-specific indexes. `parent_event_id` makes provenance-aware queries trivial ("give me all organic prompts and skip their injected children"). `content_hash` is intentionally narrow — composing wider fingerprints is a query-side concern, not a column.

### Type / source / provenance taxonomy

- `provenance`: **closed enum** — `organic | injected | tool_result | environmental`. Locked by framing doc. The Mem0 structural fix depends on this being tight; readers MUST be able to filter by it without parsing strings.
- `type`: **open string with documented well-known values for v5.0** — `user_prompt | assistant_message | tool_call | tool_result | hook_injection | environmental_event | session_boundary`. Open because Phase 2/3 will surface modality types we haven't predicted (error fingerprint, affect signal, structural shape). New values added by writers don't require schema change.
- `source`: **open string**. Identifier of the producer: hook script name, tool name, adapter name. Cardinality is bounded by Claudex's runtime components, but no enum check.

**Reasoning:** provenance is a structural lever (extractor filters on it); type and source are descriptive metadata that must be evolvable.

### Provenance write semantics

**Split per provenance, not structured spans inside one row.**

- One UserPromptSubmit hook firing produces:
  - 1 row, `provenance='organic'`, `content` = the user's actual typed text after wrappers are stripped
  - N rows, `provenance='injected'`, one per stripped wrapper block (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<task-notification>`, etc.)
  - All N+1 rows share the same `(session_id, turn_number)`; injected rows set `parent_event_id` to the organic row's id
- Tool results that surface recalled content (`claudex_recall`, `claudex_search`, etc.):
  - One row with `provenance='tool_result'`. `content` = what the agent saw. We do NOT decompose recall output into sub-rows — the tool boundary is the natural split, and Phase 4's extractor will treat tool_result as non-extraction-eligible by default.
- Assistant Stop hook: one row, `provenance='organic'`, `type='assistant_message'`. Tool calls inside the message become their own `tool_call` rows with `parent_event_id` pointing at the assistant_message.
- Environmental events (Angel heartbeats, session-start markers, hook errors): one row, `provenance='environmental'`, `turn_number=NULL`.

**Reasoning:** provenance-as-row-attribute means every reader filters with `WHERE provenance = ?` — no span parsing, no fragile substring filters. This is what makes the Mem0 trap structurally impossible: the extractor in Phase 4 simply skips rows where provenance != 'organic'.

### Dual-write contract

- **Write order**: legacy `conversation_turns` write happens first (preserves v4 behavior unconditionally). `episodic_events` writes second.
- **Transactionality**: **single SQLite transaction**, always — `BEGIN; INSERT conversation_turns; INSERT episodic_events × N; COMMIT`. SQLite's same-file model makes this free; "feasibility" is not the constraint, complexity is. On any insert failure: ROLLBACK, then write one row to the existing `telemetry` table outside the transaction (`event_kind='episodic_write_failure'`, `detail` includes hook name, attempted row count, error).
- **Awaited, not fire-and-forget**: hooks already await `conversation_turns` writes; same pattern. Phase 1's value is testability — unit tests assert "after hook X fires, episodic_events has Y rows" — fire-and-forget makes that flaky.
- **Phase 1 readers**: NONE. Pure write path. Angel does NOT read `episodic_events`. Assembly does NOT. CARA does NOT. Hybrid-retrieval does NOT. The new path is dark until Phase 3 cuts retrieval over.
- **No backfill from `conversation_turns`**: legacy rows do not enter `episodic_events`. Backfilling would default-tag legacy injected content as `organic` and re-introduce the Mem0 trap. Phase 2's empirical investigation runs against whatever corpus accumulates between Phase 1 ship and Phase 2 measurement; small corpus is preferable to corrupted corpus.

**Reasoning:** dual-write must be all-or-nothing per hook firing — the worst failure mode is "legacy succeeds, episodic fails silently," yielding a substrate that's randomly missing rows. Single-transaction + telemetry-on-rollback rules that out. Pure write-only in Phase 1 lets us validate correctness in production without breaking v4 readers.

### Episode binding

**No `episode_id` column in Phase 1.** Each row stands alone, identified by `(session_id, turn_number, ts_epoch)`. Phase 6 (Crash-resilient episode boundary) decides what an episode IS and adds the column / view via migration when it has a defensible answer. ROADMAP defers boundary semantics to Phase 6 explicitly.

**Reasoning:** adding a placeholder column we'll redesign is wasted DDL on an append-only table. Better to ship the substrate empty of premature commitments and decide grouping when we know the unit.

### Embedding / index timing

**Phase 1 write path does NOT embed and does NOT enqueue embeddings.** No synchronous index updates. Phase 2 builds the first multi-modal index (error-fingerprint candidate) AND backfills it from rows accumulated since Phase 1 ship. Phase 3 wires retrieval.

**Reasoning:** ROADMAP makes Phase 2 the empirical investigation phase. Eagerly embedding in Phase 1 commits us to embedding semantics before measuring whether multi-handle retrieval at Claudex's scale even justifies its complexity. Empty substrate first; populate indexes once we know which indexes earn their cost.

### Claude's Discretion

The planner has flexibility on:

- Migration mechanics — single migration file vs split, naming, whether to use the existing migration runner
- Test layout — how to extend the existing vitest harness to cover hook-level dual-write assertions
- Telemetry detail JSON shape — what fields exactly inside `detail` for `episodic_write_failure` (must be enough to debug; exact field set is operational judgment)
- Which existing helper module hosts the dual-write logic (`src/adapters/shared/lifecycle.ts` is the obvious candidate; planner may justify splitting)
- Wrapper-stripping regex / parser shared with assembly's existing strip logic (reuse vs duplicate-with-tests)

</decisions>

<specifics>
## Specific Ideas

- **Provenance is the lever.** Every design choice in this phase serves "provenance as a row attribute, queryable, structurally enforced." If a decision in planning compromises that, push back.
- **`parent_event_id` linkage.** Injected spans link upward to their organic prompt; tool results link to their assistant message. This makes "show me only organic conversation, threaded" a one-query problem.
- **Backfill is forbidden.** Legacy `conversation_turns` rows stay where they are. Don't quietly add a backfill task to the plan — it would corrupt the substrate's structural guarantee.
- **`metadata_json` is the schema-stability lever.** Phase 2 will want to add error-fingerprint shingles, token counts, model IDs, etc. None of those should require ALTER TABLE. If the planner finds itself wanting a new column for a Phase 2 concern, it likely belongs in metadata_json instead.
- **Test the trap directly.** A dedicated test should assert: "if a UserPromptSubmit fires with N injected wrappers, the resulting rows split N+1 and the extractor (a stub for now) skips the N injected when asked for organic." That test is the structural-impossibility proof for Mem0.

</specifics>

<deferred>
## Deferred Ideas

- **Episode boundary detection** — what defines an episode unit (per-task, per-intent-shift, per-commit)? → Phase 6
- **Multi-modal indexes** (error-fingerprint, affect signal, structural shape) → Phase 2 (empirical: prove ONE works first)
- **Retrieval cutover** — replacing `hybrid-retrieval.ts` fusion with multi-handle episode retrieval → Phase 3
- **Pattern-extractor reduction** — most of `src/angel/pattern-extractor.ts` becomes dead code under v5; deletion + dependency tracing → Phase 4
- **Density-based abstraction at retrieval time** → Phase 5
- **Crash-resilient session-end (Angel as source of truth)** — fsnotify + heartbeat + idle-timeout sweep + PID liveness → Phase 6
- **v4 storage decisions** (experience_patterns retire, learning/decision projection, mental_model retain) → Phase 7
- **Backfill of legacy `conversation_turns` into `episodic_events`** — explicitly rejected in Phase 1; revisit only if Phase 2/5 measurement demands more corpus AND a provenance-safe backfill design emerges. Default: never.

</deferred>

---

*Phase: 01-episode-substrate*
*Context gathered: 2026-05-04*
