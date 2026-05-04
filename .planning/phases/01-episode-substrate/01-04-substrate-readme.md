# Episode Substrate — Operator Reference (v5 Phase 1)

**Status:** SHIPPED in Phase 1 (V25 schema, Plans 01-01..01-04).
**Audience:** Phase 2-7 implementers + operators inspecting `~/.claudex/db/claudex.db`.
**Authoritative:** This document, plus `01-CONTEXT.md` for the design rationale and `01-03-environmental-audit.md` for the environmental site map. If this README disagrees with `01-CONTEXT.md`, CONTEXT wins; the disagreement should be reconciled before commit.

---

## What this is

The episode substrate is an append-only event log (`episodic_events` table) that captures every signal the agent sees with the **provenance** explicitly attached as a row attribute. Reading with `WHERE provenance='organic'` returns ONLY the user's actual organic content — wrappers, tool output, and environmental events are structurally filtered out by a closed-enum CHECK constraint at the column level. This makes the Mem0 inflation feedback loop impossible by construction: any reader that limits itself to organic rows cannot see what the recall pipeline injected, period.

Phase 1 ships the **write path only**. No reader (Angel, CARA, assembly, hybrid-retrieval) consumes from `episodic_events` yet — Phase 3 cuts retrieval over.

---

## Schema reference

Defined by `migrateV24toV25` in `src/core/migration-steps.ts` (V25 step). 13 columns, 4 indexes, 1 CHECK constraint.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | yes | Surrogate key. |
| `session_id` | TEXT | yes | Same value space as `conversation_turns.session_id`. Synthetic IDs (e.g. `'angel-heartbeat'`) are allowed for non-session-bound writers. |
| `project` | TEXT | yes | Project scope; `__global__` (`GLOBAL_PROJECT_SCOPE`) for cross-project events like Angel heartbeat ticks. |
| `ts_epoch` | INTEGER | yes | Unix seconds; primary order. Defaults to `unixepoch()` so callers don't need to set it. |
| `turn_number` | INTEGER | NULL | Set for turn-bound events (`user_prompt`, `assistant_message`, `tool_result` chained to a turn). NULL for environmental events. |
| `type` | TEXT | yes | Open string. Phase 1 well-known values: `user_prompt | assistant_message | tool_call | tool_result | hook_injection | environmental_event | session_boundary`. New values do NOT require a migration; readers should `.includes()` on the open set. |
| `source` | TEXT | yes | Identifier of the producer: hook script name, tool name, adapter name (e.g. `cc-hooks/user-prompt-submit`, `Bash`, `wrapper:experience-data`, `angel/heartbeat`). |
| `content` | TEXT | yes | Raw payload as the agent saw it (post wrapper-strip for organic rows; wrapper inner text for injected rows; raw stringified tool output for tool_result; human-readable description for environmental). |
| `provenance` | TEXT | yes | **Closed enum** — `'organic' | 'injected' | 'tool_result' | 'environmental'`. Enforced by CHECK constraint at the column level. |
| `parent_event_id` | INTEGER | NULL | Self-FK to `episodic_events.id`. Used to link injected rows to their organic parent prompt (Plan 02). NULL for organic, tool_result, environmental rows in Phase 1. |
| `content_hash` | TEXT | yes | sha256 of `content` only (raw byte fingerprint). Composers needing more (provenance/source) build a wider hash at query time. |
| `metadata_json` | TEXT (JSON1) | NULL | Modality-specific fields. Phase 2 indexes read from here without schema migration. Examples: `{ "tag": "...", "attributes": "..." }` for injected rows; `{ "tool_input": {...} }` for tool_result rows; `{ "session_id": "...", "cwd": "..." }` for session_boundary rows. |
| `schema_version` | SMALLINT | yes | Defaults to 1. Bumping is reserved for breaking metadata_json contract changes. |

### Indexes

- PK on `id` (implicit from AUTOINCREMENT).
- `idx_epev_session_turn_ts` ON `(session_id, turn_number, ts_epoch)`.
- `idx_epev_project_ts` ON `(project, ts_epoch)`.
- `idx_epev_provenance` ON `(provenance)`.
- `idx_epev_parent` ON `(parent_event_id)`.

---

## Provenance semantics — the closed enum

The four values are the structural lever of the entire substrate. Readers MUST be able to filter on this column without parsing strings.

### `organic`

The user's actual content (or the assistant's actual reply). Wrapper blocks have been stripped at write time by `parseWrappers`. **Safe to feed to any LLM-facing surface** — synthesis, abstraction, retrieval. Phase 4's reduced extractor reads ONLY from this provenance.

Producers: `dualWriteUserPrompt` (writes one organic row per UserPromptSubmit), `dualWriteAssistantMessage` (one per Stop hook).

### `injected`

A wrapper block that was present in the user prompt at submit time. Each block becomes its own row, linked back to the organic parent via `parent_event_id`. **NEVER feed back into extraction loops** — doing so re-introduces the Mem0 inflation trap that the substrate exists to prevent.

Producers: `dualWriteUserPrompt` (writes N injected rows per prompt, one per wrapper). Source is `wrapper:<tag>`; metadata_json carries `{ tag, attributes? }`.

### `tool_result`

A tool's response, opaque to the substrate. Tool boundary is the natural split — rows are NOT decomposed into sub-rows (per CONTEXT.md). **Treat as the boundary for any structured search.** Phase 4's extractor treats tool_result rows as non-extraction-eligible by default.

Producers: `writeToolResult` (one per PostToolUse hook firing). Source is the literal tool name (`Bash`, `Read`, `claudex_search`, etc.); metadata_json carries `{ tool_input }` so Phase 2 indexes can filter without parsing.

### `environmental`

Session boundaries, Angel heartbeats, process lifecycle markers. **Ignore for content extraction.** Phase 6's `fsnotify + heartbeat + idle-sweep + PID-liveness` work reads these to compute episode windows.

Producers: `writeEnvironmentalEvent` (called by `cc-hooks/session-start`, `cc-hooks/session-end`, `angel/heartbeat`). `turn_number=NULL`, `parent_event_id=NULL`, type ∈ {`session_boundary`, `environmental_event`}.

---

## Write-path map

| Hook / Producer | File | Helper called | Rows produced |
|-----------------|------|---------------|---------------|
| UserPromptSubmit | `src/adapters/cc-hooks/user-prompt-submit.ts` (via lifecycle.ts shim) | `dualWriteUserPrompt` | 1 organic + N injected (one per wrapper) + 1 conversation_turns row |
| Stop | `src/adapters/cc-hooks/stop.ts` (via lifecycle.ts shim) | `updateConversationTurnAssistant` (UPDATE path with mirrored INSERT) OR `dualWriteAssistantMessage` (fallback path via `storeConversationTurn`) | 1 organic assistant_message + 1 conversation_turns UPDATE/INSERT |
| PostToolUse | `src/adapters/cc-hooks/post-tool-use.ts` | `writeToolResult` | 1 tool_result |
| SessionStart | `src/adapters/cc-hooks/session-start.ts` | `writeEnvironmentalEvent` | 1 session_boundary |
| SessionEnd | `src/adapters/cc-hooks/session-end.ts` | `writeEnvironmentalEvent` | 1 session_boundary |
| Angel heartbeat | `src/angel/heartbeat.ts` (`heartbeatTick`) | `writeEnvironmentalEvent` | 1 environmental_event per tick |

For the complete environmental site catalogue including 17 deferred sites and 6 never-instrumented sites, see `01-03-environmental-audit.md`.

---

## Telemetry signal

Every helper wraps its writes in a single `db.transaction()`. On any throw, the transaction rolls back AND a single row is written to `telemetry` with:

- `event_kind = 'episodic_write_failure'`
- `adapter = 'episodic-events'`
- `detail` = JSON object with at least:
  - `hook` — `'user-prompt-submit' | 'stop' | 'post-tool-use' | 'cc-hooks/session-start' | 'cc-hooks/session-end' | 'angel/heartbeat'` (or other producer source)
  - `error_message` — first 500 chars of `err.message`
  - `error_stack` (optional) — first 5 lines of `err.stack`
  - **For `dualWriteUserPrompt`:** `attempted_rows` (1 + N), `organic_id` (id of the organic row if it landed before failure)
  - **For `writeToolResult`:** `tool` (toolName), `kind: 'tool_result'`
  - **For `writeEnvironmentalEvent`:** `kind: 'environmental'`, `type` (the type field passed in)

The telemetry row commits OUTSIDE the rolled-back transaction, so the failure is queryable even when the writes are not.

### Surfacing in Angel / dashboards (Phase 6+ work)

Angel's session-start hook (existing) injects a `## Reranker Health` line when the 24h count of `event_kind='reranker_fallback'` is non-zero. The same pattern can be applied to `episodic_write_failure` — query:

```sql
SELECT COUNT(*) FROM telemetry
 WHERE event_kind = 'episodic_write_failure'
   AND timestamp_epoch >= unixepoch() - 86400;
```

If non-zero across multiple sessions, investigate. The substrate writes are load-bearing for Phase 3 retrieval and Phase 4 extractor reduction.

---

## Things future phases MUST NOT do

These are structural prohibitions. Violating any of them re-introduces the Mem0 trap or breaks the substrate's invariants.

1. **Don't backfill `conversation_turns` rows into `episodic_events`.** The legacy table predates provenance and contains injected content mixed with organic. Any backfill that defaults legacy rows to `organic` corrupts the substrate's defining property. CONTEXT.md explicitly forbids this.
2. **Don't store wrapper content inside organic rows.** The wrapper-strip at write time is the structural defense. Bypassing it (e.g., by adding a "skip parser" flag for performance) re-opens the trap.
3. **Don't decompose `tool_result` into sub-rows.** The tool boundary is the natural split. CONTEXT.md prohibits decomposition; Phase 4's extractor assumes tool_result rows are opaque single units.
4. **Don't add embeddings to Phase 1 rows.** Phase 2 builds the first multi-modal index after measuring at scale; Phase 1 ships indexes empty by design. Eagerly embedding now commits the substrate to embedding semantics before measurement.
5. **Don't add a reader from production code in Phase 1's lifetime.** Readers cut over in Phase 3. Until then, `episodic_events` is dark — Angel does NOT read it; assembly does NOT; CARA does NOT; hybrid-retrieval does NOT.
6. **Don't add new wrapper tags to `KNOWN_WRAPPER_TAGS` casually.** Adding a tag is a substrate change. Phase 2/3 surface new modalities via `metadata_json` on existing provenance values, NOT by widening the wrapper-tag enum.
7. **Don't widen the `provenance` CHECK enum.** The four values (`organic | injected | tool_result | environmental`) are locked by the framing doc. New event kinds that don't fit one of these belong in `telemetry` or a new table, not in `episodic_events`.

---

## Open questions deferred to later phases

See `01-03-environmental-audit.md` for the canonical deferred-sites map. Major outstanding decisions:

- **Episode boundary semantics** (Phase 6) — what defines an episode unit? `episode_id` column lands here.
- **Multi-modal indexes** (Phase 2) — error-fingerprint, affect signal, structural shape. Phase 2 measures one at scale to justify complexity.
- **Retrieval cutover** (Phase 3) — replacing `hybrid-retrieval.ts` fusion with multi-handle episode retrieval.
- **Pattern-extractor reduction** (Phase 4) — `src/angel/pattern-extractor.ts` becomes mostly dead code under v5.
- **Density-based abstraction at retrieval time** (Phase 5).
- **Backfill of legacy `conversation_turns`** — explicitly rejected in Phase 1; revisit only if Phase 2/5 measurement demands more corpus AND a provenance-safe backfill design emerges. Default: never.

---

*Phase: 01-episode-substrate*
*Plan: 04*
*Substrate shipped: 2026-05-04*
