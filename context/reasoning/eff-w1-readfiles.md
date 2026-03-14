# Context Efficiency Audit: Read/Active Files List
**Date:** 2026-03-13
**Scope:** How read/active files accumulate and whether they bloat context injection.

---

## Data Flow Summary

The files list in a checkpoint has two independent sources with completely different tracking mechanisms:

1. **Hot files** (`checkpoint.files.hot`) — sourced from `pressure_scores` table, scoped by `project`.
2. **Read files** (`checkpoint.files.read`) — sourced from `observations.files_modified` JSON column, scoped by `session_id`.

These are assembled at checkpoint-write time in `src/checkpoint/writer.ts:writeCheckpoint()`, then cap-truncated at render time in `src/checkpoint/inject.ts:renderCheckpointMarkdown()`.

---

## Finding 1: Cap Mechanics — Data Loss at the Storage Layer, Not Display Layer

**Verdict: The caps are display-only. All data is retained in the DB.**

### Hot files
`src/checkpoint/writer.ts:185`:
```
const hotFiles = getHotFiles(db, project, 20);
```
`getHotFiles` (in `src/core/pressure.ts:73-85`) queries `pressure_scores WHERE project=? AND temperature='HOT' ORDER BY raw_pressure DESC LIMIT ?` with `limit ?? 100`.

Writer fetches up to 20 HOT files and stores all 20 into the checkpoint YAML in `files.hot`. The render cap in `inject.ts:68` then slices to 15:
```typescript
const hotFiles = checkpoint.files.hot?.slice(0, MAX_HOT) ?? [];  // inject.ts:68
```
The `_(N more)_` overflow annotation at `inject.ts:83` hints at suppressed entries, but the full 20 are still in the stored YAML file — just not rendered.

**Issue:** The writer fetches 20, stores 20 in the YAML checkpoint, but only 15 are rendered. 5 hot files are silently hidden without being removed. This divergence between what is stored and what is rendered could cause confusion during checkpoint review.

### Read files
`src/checkpoint/writer.ts:193-203`:
```sql
SELECT DISTINCT json_each.value AS file_path
FROM observations, json_each(observations.files_modified)
WHERE observations.session_id = ? AND observations.deleted_at_epoch IS NULL
LIMIT 50
```
Writer fetches up to **50** distinct file paths and stores all 50 in `files.read`. The render cap at `inject.ts:69` slices to 20:
```typescript
const readFiles = checkpoint.files.read?.slice(0, MAX_READ) ?? [];  // inject.ts:69
```
30 entries are silently hidden per checkpoint. Same pattern as hot files.

**Conclusion:** Caps are insufficient in the sense that their purpose (context bloat prevention) is already defeated at the storage layer. The YAML checkpoint file always has 20 hot + 50 read = 70 file entries, but only 15 + 20 = 35 are rendered. The extra 35 are dead weight in stored checkpoints.

---

## Finding 2: Stale Files Leaking Through — The Hot Files Problem

**Verdict: YES. Stale hot files from old activity leak across sessions.**

### The pressure_scores table is project-scoped, not session-scoped.

`src/core/pressure.ts:38-51`: `pressure_scores` has a PRIMARY KEY of `(file_path, project)`. There is **no `session_id` column**.

`src/core/pressure.ts:73-85`: `getHotFiles()` queries `WHERE project = ? AND temperature = 'HOT'`. No time filter, no session filter.

This means: if a file reached HOT status in session 1 of a project, and session 2 starts days later on a completely different task, that file's pressure score persists and will appear in session 2's checkpoint as a HOT file — unless decay has demoted it.

### Decay does not fire during or between sessions

`src/decay/pressure-decay.ts:decayPressureStratified()` is called only from `runSessionEndCleanup()` (`src/adapters/shared/lifecycle.ts:297`). This is the `SessionEnd` hook.

HOT threshold requires `raw_pressure >= 0.851` (from `pressure-decay.ts:32`). The initial promotion threshold is `raw_pressure > 0.5` (`src/core/pressure.ts:20`). Each tool-use increments by 0.1 (`lifecycle.ts:126`).

Half-life for HOT files is 7 days. A file that reaches pressure 0.9 in session 1 will still read as HOT for several days into future sessions before decaying below 0.851.

**Stale scenario:** Agent reads 15 source files day 1. Checkpoint at day 7 will still include some of those files as HOT even if the agent is working on a completely different problem.

---

## Finding 3: No Session-Boundary Reset for Read Files

**Verdict: The read files query is session-scoped but accumulates indefinitely within a session.**

The read files query (`writer.ts:193-203`) uses `WHERE observations.session_id = ?`. This IS session-scoped, which is correct.

However, the query has no recency filter:
```sql
SELECT DISTINCT json_each.value AS file_path
FROM observations, json_each(observations.files_modified)
WHERE observations.session_id = ? AND observations.deleted_at_epoch IS NULL
LIMIT 50
```

Every file touched in the entire session is eligible. In a long session (many tool calls), the oldest files from the start of the session will appear alongside recently touched files, with no ordering by recency or importance. The `DISTINCT` deduplication helps but the `LIMIT 50` could fill entirely with early-session irrelevant files.

**Missing:** No `ORDER BY timestamp_epoch DESC` to surface the most recently touched files. The query returns whatever SQLite's query planner decides, which may be insertion order — meaning the oldest observations in the session dominate.

---

## Finding 4: Agent Team Sessions — Shared Project Scope Is a Real Problem

**Verdict: YES, multi-agent file bloat is a significant issue.**

Each CC agent runs as a separate CC process with its own `session_id`. All agents in a team working on the same directory will resolve to the **same `project` key** (via `getProjectId(cwd)` in `infrastructure.ts:102`).

The shared project means:

1. **Hot files accumulate across all agents:** Every agent's file activity increments `pressure_scores` for the same project key. 20 agents each reading 5 files = up to 100 distinct files accumulating pressure, all competing for the 20 slots returned by `getHotFiles(db, project, 20)`.

2. **Pressure scores are not agent-partitioned:** The `pressure_scores` table has no `agent_id` or `session_id` column. Agent A's tool activity raises the pressure scores that Agent B will see in its checkpoint.

3. **Checkpoint writer uses project scope for hot files but session scope for read files:** `writer.ts:185` uses `project` for hot files, `writer.ts:193-203` uses `session_id` for read files. This asymmetry means hot files are polluted by other agents, but read files are correctly isolated per session.

4. **Stale pressure scores are not cleared when a new agent team session begins.** The decay only fires at `session_end`, and each agent's session ends at different times. An orchestrating agent's `SessionEnd` will decay its own pressure contributions, but by then the worker agents' contributions are already baked in from the whole run.

**In a 20-agent team:** The 20 hot file slots in each agent's checkpoint could be entirely occupied by files that *other* agents touched, not the agent reading the checkpoint. This is exactly the wrong behavior.

---

## Finding 5: Redundant Entries — Same File Appearing in Both Lists

**Verdict: YES, this can happen.**

`files.hot` contains files with high pressure scores (project-scoped, any session).
`files.read` contains files from `observations.files_modified` within the current session.

Any file that the current session has read AND reached HOT pressure status will appear in both lists. The render function in `inject.ts` does not deduplicate between hot and read lists. Both sections are emitted independently (`inject.ts:76-97`).

**Example:** Agent reads `src/core/pressure.ts` 6 times in a session (6 × 0.1 = 0.6 > HOT threshold 0.5). That file will appear in `### Active Files > **Hot:**` AND in `### Active Files > **Read:**`. Double-listed in the rendered context.

There is also a potential for the same file to appear multiple times in the `read` list if it is referenced in multiple observations (though the SQL `DISTINCT` on `json_each.value` should prevent this — but only if the paths are literally identical strings after sanitization).

---

## Finding 6: Token Cost Estimate at Maximum Capacity

Using `estimateTokens = ceil(chars / 4)` from `src/shared/text-utils.ts:36-43`.

### Files section rendered markdown structure at max capacity:

```
### Active Files
**Hot:**
- src/path/to/some/file.ts — edit
- src/path/to/another/file.ts — read
[... 13 more entries ...]
_(5 more)_

**Read:**
- src/path/to/file1.ts
- src/path/to/file2.ts
[... 18 more entries ...]
_(30 more)_
```

**Per-line estimates (average file path ~40 chars, action ~10 chars):**
- Header: `### Active Files` = 16 chars = 4 tokens
- `**Hot:**` = 8 chars = 2 tokens
- 15 hot file lines: `- src/some/file.ts — edit\n` ≈ 30 chars each = 450 chars = 113 tokens
- Overflow note: `_(5 more)_\n` = 12 chars = 3 tokens
- Blank line + `**Read:**` = 9 chars = 3 tokens
- 20 read file lines: `- src/some/file.ts\n` ≈ 24 chars each = 480 chars = 120 tokens
- Overflow note: `_(30 more)_\n` = 14 chars = 4 tokens

**Total files section: approximately 245-300 tokens** with average-length paths.

With long absolute paths (e.g., `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\...` = 70+ chars):
- 15 hot lines × 85 chars = 1275 chars = 319 tokens
- 20 read lines × 75 chars = 1500 chars = 375 tokens
- **Total with long paths: approximately 700-800 tokens**

This is not catastrophic on its own, but the assembly budget (not directly found in this investigation, but referenced in `assembler.ts:71` as `params.config.injection.budget_tokens`) could be meaningfully impacted if paths are long and the section is fully populated.

**Important:** The token cost is born entirely at session-start injection via `assembleFullContext()`. The checkpoint section is Priority 3 in the assembly cascade, behind Identity (P1) and Project context (P2). If the budget is tight, the files section within the checkpoint competes with the overall checkpoint section token cost — but they are not individually budgeted; the entire checkpoint block is rendered and then checked against budget as a unit.

---

## Finding 7: The `last_action` Field Is Always Null

**Verdict: Structural bug — the field exists but is never populated.**

`writer.ts:263-265`:
```typescript
hot: hotFiles.map((f) => ({
  path: f.file_path,
  last_action: null,  // always null
})),
```

The `PressureRow` type has no `last_action` field (it has `temperature`, `raw_pressure`, `last_touched_epoch`, `decay_rate`). The `last_action` is always set to `null` on write.

In the renderer (`inject.ts:79-81`):
```typescript
const action = f.last_action ? ` — ${f.last_action}` : '';
lines.push(`- ${f.path}${action}`);
```

The action is always empty. The annotation capability is structurally dead code — the feature was designed (field in the type, rendering code in inject) but never wired to actual data.

---

## Summary of Issues

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| 1 | Writer fetches 20 hot / 50 read files but renderer caps at 15 / 20 — caps are at wrong layer | Medium | `writer.ts:185`, `writer.ts:195-202`, `inject.ts:68-69` |
| 2 | Hot files are project-scoped with no session boundary reset — stale files from days ago appear | High | `pressure.ts:73`, `writer.ts:185`, `pressure-decay.ts` |
| 3 | Read files query has no ORDER BY timestamp — oldest session observations may dominate | Medium | `writer.ts:193-203` |
| 4 | Multi-agent teams share the project-scope pressure_scores — agent A's files appear in agent B's checkpoint | High | `infrastructure.ts:102`, `pressure.ts:38-51` |
| 5 | Same file can appear in both Hot and Read lists — no deduplication between lists | Low | `inject.ts:65-97` |
| 6 | `last_action` is always null — action annotation is dead code | Low | `writer.ts:264`, `inject.ts:79` |
| 7 | Overflow annotations (`_(N more)_`) are rendered for hidden entries still stored in YAML | Low | `inject.ts:82-83`, `inject.ts:93-94` |

---

## Recommendations

### R1: Move the caps to the writer, not the renderer
**Addresses:** Issues 1, 7.
In `writer.ts:writeCheckpoint()`, change `getHotFiles(db, project, 20)` to `getHotFiles(db, project, 15)` and the observation query LIMIT from 50 to 20. This ensures checkpoints don't store more entries than will ever be rendered.

### R2: Add recency ordering to the read files query
**Addresses:** Issue 3.
Add `ORDER BY observations.timestamp_epoch DESC` to the read files query in `writer.ts:193-203`. This ensures the most recently touched files populate the limited read slots rather than the oldest ones from early in the session.

### R3: Filter hot files by recency for agent team contexts
**Addresses:** Issues 2, 4.
Add a time-bounded filter to `getHotFiles()` or to the `getHotFiles` call in `writer.ts:185`. For example: `AND last_touched_epoch > unixepoch() - 86400` (last 24 hours). Alternatively, add a `session_id` filter to `pressure_scores` so agents don't pollute each other's hot file views.

### R4: Deduplicate hot and read lists before rendering
**Addresses:** Issue 5.
In `inject.ts`, after building both lists, remove from `readFiles` any path already present in `hotFiles`. A `Set` lookup is O(1) and trivial.

### R5: Fix or remove `last_action`
**Addresses:** Issue 6.
Either wire `last_action` to the most recent observation action for that file path, or remove the field from `CheckpointFiles` and the renderer. Dead fields add noise to the type contract.

### R6: Clarify the cap ownership
**Addresses:** Issues 1, 3 combined.
The architectural intent should be: caps enforced at write time (what goes into the YAML) and rendering is 1:1 with stored data. The current design has caps at both layers with different limits, creating a confused contract.

---

## Are the Current Caps Sufficient?

**For solo use:** The MAX_HOT=15 and MAX_READ=20 rendering caps are reasonable. Token cost is bounded at ~300-800 tokens for the files section (depending on path lengths). The caps are sufficient for the rendering budget concern.

**For agent team use:** No. The project-scoped pressure tracking means 20 agents working in parallel will flood the hot files list with files irrelevant to any individual agent's current task. The caps become meaningless because the 15 slots are occupied by cross-agent noise rather than the agent's own working set.

**For stale data:** Partially. Decay handles long-term staleness (7-day half-life), but there is no intra-project session-boundary reset. Files from an earlier unrelated task on the same project will appear in hot files until decay demotes them, which can take multiple days.
