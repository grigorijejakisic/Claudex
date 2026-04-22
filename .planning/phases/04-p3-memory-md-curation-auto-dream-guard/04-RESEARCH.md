# Phase 4: P3 — MEMORY.md curation + auto-dream guard — Research

**Researched:** 2026-04-23
**For planner consumption.** CONTEXT.md locks decisions; this document maps those decisions onto the live code surfaces.

Phase boundary is intentionally narrow: Angel writes one MEMORY.md per project at `/endsession`, guards it against CC's auto-dream, and starts emitting `transcript_chunk` artifacts. **No injection-path changes in this phase** — dual-injection stays, Phase 5 kills it.

---

## 1. Code surface inventory (what already exists, what doesn't)

### 1.1 MEMORY.md locations

Two distinct MEMORY.md files live on disk with very different roles:

| Path | Owner today | Role |
|------|-------------|------|
| `~/.claude/projects/<slug>/memory/MEMORY.md` | **CC auto-memory** (native) | CC's own ephemeral index; Claudex reads and prunes it. |
| `~/.claude/projects/<slug>/memory/*.md` (siblings) | **User auto-memory** | User-authored per-file memories with YAML frontmatter — `user_pc_specs.md`, `self_name_crux.md`, feedback files. These ARE the "universal user memories" referenced in CUR-02. |

Phase 4 decision (CONTEXT §Sentinel semantics): Angel now takes **authoritative ownership** of `~/.claude/projects/<slug>/memory/MEMORY.md`. The top portion becomes Angel-managed (sentinel-hashed); the bottom `## User Notes` block after `<!-- USER EDITABLE -->` is preserved byte-for-byte.

### 1.2 Modules that currently touch MEMORY.md

- `src/angel/memory-monitor.ts` — scans all CC projects, **migrates** excess non-pinned entries out of CC's MEMORY.md into `observations`, then rewrites the file. Runs every heartbeat. Uses `## Universal` / `## Pinned` / `## Keep` as pin markers. Pre-existing Phase-4-era behavior: prune-down, not curate-up.
- `src/angel/user-profile-sync.ts` — scans sibling files (`user_pc_specs.md`, etc.) with `type: user` frontmatter, writes canonical versions as `__global__` `memory_file` artifacts (importance 5). Runs every heartbeat (5-min rate-limit).
- `src/adapters/cc-hooks/session-start.ts:164-176` — detects CC auto-memory conflicts (`detectCcMemoryConflict` from `src/adapters/shared/env-file.ts:51`). Purely diagnostic; records `cc_memory_conflict` event.
- `src/adapters/shared/env-file.ts:29-40` — `writeClaudeEnvFile()`. Writes exactly two lines today:
  ```
  export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
  export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1
  ```
  Called from `session-start.ts:96` and `cwd-changed.ts`.
- `src/core/file-ingester.ts` — ingests MEMORY.md contents into the retrieval corpus as `artifacts(artifact_type='memory_file', importance=5)`.

### 1.3 What does NOT yet exist in code (new surfaces for this phase)

1. **No Angel-side MEMORY.md writer.** `memory-monitor` only prunes; `user-profile-sync` only syncs siblings into DB. Angel never writes a sectioned index.
2. **No `autoDreamEnabled: false` knob.** `writeClaudeEnvFile` only disables `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Auto-dream is a separate CC feature (see `context/research/cc-source/06-dream-kairos.md`).
3. **No transcript chunker.** There is no module producing `transcript_chunk` anywhere in `src/`. The V17 unified table has no pre-existing `transcript_chunk` kind in `kind-mapping.ts`; the `artifact.kind` column is free-form, so introducing it is schema-legal today (will register via the `kind_registry` insert trigger).
4. **No session-start MEMORY.md verifier.** session-start reads MEMORY.md only for CC auto-memory conflict detection; it does not check Angel's sentinel or file size.

### 1.4 Heartbeat tick ordering (where new work plugs in)

`src/angel/heartbeat.ts::tick()` (line 1275) runs phases in order. Relevant anchor points for Phase 4:

| Existing phase | Line | What it does | Phase 4 interaction |
|----------------|------|--------------|---------------------|
| Phase 1b: auto-close escalated idle sessions | ~152 | Closes sessions that stayed idle past warning. | **Auto-close path must trigger transcript chunking** for just-closed sessions — same write site as `/endsession`, since the user isn't around to run the skill. |
| Phase 2a: directive detection | 239 | `extractDirectivesFromSession` per unprocessed session. | Chunker runs in an adjacent slot — consumes the same completed-session queue but with its own cursor. |
| Phase 2: pattern extraction | ~254 | `extractPatternsFromSession`. | Chunker must NOT block pattern extraction (precedent: directive detector is in its own try/catch). |
| Phase 5: memory monitor | ~373 | `monitorMemoryFiles(db)`. | **Replace / supplement:** today it prunes CC's MEMORY.md entries. Phase 4 makes Angel the writer — the pruning path stays (still useful for projects Angel hasn't curated yet) but the new curator owns any file with the sentinel. |
| Phase 6b: embedding backfill | ~394 | Gated by `heavyWorkRan`. | `transcript_chunk` rows get embedded through the same backfill path because `embedding_ref=null` at insert time — no new wiring needed, just ensure `backfillEmbeddings` covers `artifact(kind='transcript_chunk')`. |

The natural slot for **curation** (writing MEMORY.md) is a new phase that runs **only when a session has just transitioned to `completed`** — otherwise we'd rewrite every project's MEMORY.md every 30s for no reason. Two triggers:
1. `/endsession` path (user-initiated): enqueue curation work; Angel picks it up on next tick.
2. Angel auto-close path (Phase 1b escalation): enqueue as well.

The signalling mechanism already exists — `sessions.status='completed'` + `ended_at_epoch` is the one post-condition both `/endsession` and auto-close set. A new "curation queue" can be a `session_events` row (`event_type='memory_curation_pending'`) consumed by the new heartbeat phase, or a simpler watermark column (`projects.last_curation_epoch`). The planner picks.

---

## 2. The V17 `artifact` schema vs. CONTEXT's importance decision

**Friction point the planner must resolve.** CONTEXT says:

> Rank by existing `artifact.importance` column. Do not introduce a new composite score.

But the unified `artifact` kernel DDL (src/core/migration/v17-ddl.ts:47-71) has **no `importance` column**:

```sql
CREATE TABLE IF NOT EXISTS artifact (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT,
  body              TEXT NOT NULL,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  confidence        REAL,
  created_at_epoch  INTEGER NOT NULL,
  updated_at_epoch  INTEGER NOT NULL,
  session_id        TEXT,
  project_id        TEXT,
  embedding_ref     INTEGER,
  supersedes_id     TEXT REFERENCES artifact(id),
  data              TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data))
);
```

Moreover, `kind-mapping.ts` does NOT migrate any `importance` value into the V17 `data` JSON sidecar for any of learning / decision / experience_pattern / angel_opinion / critical_rule / mental_model. **Crucially, `entity_summary` artifacts were NOT included in the Phase 2 migration at all** — they still live in the **legacy `artifacts` table** (lowercase plural, `artifact_type='entity_summary'`), which does carry an `importance` column (see `src/angel/entity-summarizer.ts:173` — still writes to `artifacts` today).

Reconciliation the planner must adopt:

- **Entity source for `## Entities` = the legacy `artifacts` table** (`artifact_type='entity_summary'`, read `importance`, `timestamp_epoch` directly). This satisfies CONTEXT "rank by existing `artifact.importance` column" — the existing column is on `artifacts`, not on V17 `artifact`. It is unambiguous: entities ARE the only kind CONTEXT asks us to rank by importance, and entities have not moved to V17 yet.
- **Projects and Recent Threads** are not ranked by importance per CONTEXT — they rank by activity count / recency. No schema friction.
- **Do not add a new column to `artifact` in this phase.** P5 ("retrieval simplification") is the natural place to harmonize scoring; adding schema columns now is out of scope.

The planner should call this out explicitly in PLAN.md Acceptance Criteria so the next planner round can verify and so the verifier doesn't ding for "missing importance column."

---

## 3. Decision-by-decision implementation mapping

### 3.1 Sectioned MEMORY.md file shape (CUR-01, CUR-02)

Target shape (from CONTEXT + ROADMAP):

```markdown
<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<sha256> -->
<preamble: ≤5 lines of universal user memories — no header>

## Entities
- [name] — summary (≤15)

## Active Projects
- project_name — activity_count in last 7d (≤5)

## Recent Threads
- topic_label — session_id, turn X-Y (≤5)

## Handoff
<≤10 lines from ACTIVE.md Commander's Intent + What's Left To Do>
See: context/handoffs/ACTIVE.md

## How to Query
<static stock text>

<!-- USER EDITABLE -->

## User Notes
<user content, preserved byte-for-byte>
```

- **Preamble source** = sibling files in the SAME `~/.claude/projects/<slug>/memory/` dir with `type: user` YAML frontmatter. `src/angel/user-profile-sync.ts` already parses these — reuse the scanning helper. Cap 5 lines total; if a single user-memory file is multi-line, render its description (from frontmatter) or first-line only. The existing `memory_file` `__global__` artifact is the DB reflection of these but NOT the source for rendering — always read files directly at write time so a user edit picked up before Angel's next sync still renders fresh.
- **Entities source** = legacy `artifacts WHERE artifact_type='entity_summary' AND project=<slug>` (read `importance DESC, updated_at_epoch DESC, created_at_epoch DESC`). Use the project's `entities`; fall back to `__global__` entities only if the project has zero.
- **Active Projects** — `SELECT project_id, COUNT(*) AS activity_cnt, MAX(updated_at_epoch) AS last_touched FROM artifact WHERE updated_at_epoch >= (now-7d) GROUP BY project_id ORDER BY activity_cnt DESC, last_touched DESC LIMIT 5`. Cross-project by design — MEMORY.md is per-project but the "active projects" list is a dashboard of what's hot everywhere. Exclude the current project from its own list if it'd be redundant — planner decides.
- **Recent Threads** — `SELECT topic_label, MAX(created_at_epoch) AS latest, session_id FROM artifact WHERE kind='transcript_chunk' AND project_id=? GROUP BY topic_label ORDER BY latest DESC LIMIT 5`. Cold-start zero rows is acceptable; section still renders.
- **Handoff** — read `context/handoffs/ACTIVE.md` via `resolveProjectPath(project)`. Missing/empty → render `No active handoff.`. When present, distill `## Commander's Intent` paragraph + `## What's Left To Do` list, capped at 10 lines total. Append the `See:` pointer.
- **How to Query** — static constant. One planner decision is whether to include more than three tool lines; CONTEXT says "brief one-liner examples for `claudex_search`, `claudex_events`, `claudex_recall` + pointer to `~/.claude/CLAUDE.md`."

Size check: 15 entities × ~80 chars + 5 projects × ~60 + 5 threads × ~80 + handoff 10×80 + how-to-query ~400 + preamble 5×120 = ~4.2KB — well under the 25KB / 200-line ceiling.

Line-count hard cap on RENDER (not after append of user block): count lines written ABOVE `<!-- USER EDITABLE -->`; if >200, trim from the lowest-priority section (planner picks the trim order — likely Recent Threads → Entities tail → Active Projects tail → Handoff tail, preserving user memories and How to Query which is a contract).

### 3.2 Idempotency (CUR-04)

Claim: "given identical inputs, two runs produce byte-identical bytes above `<!-- USER EDITABLE -->`."

Inputs to the writer are:
- list of entity rows (stable SELECT with deterministic ORDER BY importance DESC, updated_at_epoch DESC, created_at_epoch DESC, id ASC — the `id ASC` is the final deterministic tiebreaker the planner must add, since two entities created in the same second would otherwise flip)
- list of active projects (activity count DESC, last_touched DESC, project_id ASC)
- list of recent threads (created_at DESC, session_id ASC, topic_label ASC)
- handoff bytes (file read)
- preamble bytes (scan of sibling files, sort by filename ASC, render frontmatter description)
- static how-to-query text

Rendering must:
- use LF line endings unconditionally on write (normalize any CRLF from handoff / user-memory files before inclusion);
- trim trailing whitespace on each line;
- collapse runs of blank lines to single (matches existing `rewriteMemoryMd` behavior);
- end with exactly one trailing newline before `<!-- USER EDITABLE -->`.

Sentinel hash covers bytes above `<!-- USER EDITABLE -->` post-normalization (sha256, hex). Verification suite: pick a fixed fixture (one entity, one project, one thread, one handoff snippet, one user-memory file), run writer twice, assert `readFileSync(path) === readFileSync(path)` and that the sha matches. A separate test must mutate ONLY the user block and re-run — sentinel hash unchanged.

### 3.3 Sentinel write-guard (CUR-03)

Rewrite rule (from CONTEXT):
1. Read file; find `<!-- USER EDITABLE -->` marker. If absent, treat as "never curated" → initialize.
2. Parse top sentinel `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<hex> -->`. If absent on a file that does have `<!-- USER EDITABLE -->` → **refuse write**, record `memory_md_sentinel_missing` event. Fail loud at the boundary.
3. Compute Angel-owned bytes; compute sha256. If hash matches the sentinel on disk AND inputs haven't changed (per 3.2 input equality) → no-op (don't even re-write). This gives cheap idempotency at steady state.
4. Otherwise rewrite the top portion (above `<!-- USER EDITABLE -->`) with the new sentinel + content; preserve the marker and everything below byte-for-byte.
5. Write atomically: write to `MEMORY.md.tmp`, `fsync`, `rename(2)`. On Windows `fs.renameSync` is atomic only if the target exists; planner uses `fs.writeFileSync(tmp); fs.renameSync(tmp, final)` — idiomatic in this codebase (see `src/core/migration/v17-backup.ts` for prior-art).

Logging: on refusal, record `session_events` row with `event_type='memory_curation_refused'`, `entity=<memoryMdPath>`, `detail=<reason>`. Reasons: `sentinel_missing`, `sentinel_invalid`, `write_io_error`, `user_notes_truncated` (if the tail below marker is suspiciously empty when the prior file had content).

### 3.4 Auto-dream disable (CUR-03 mechanical half)

Add `export CLAUDE_CODE_AUTO_DREAM_ENABLED=0` (planner verifies the exact CC env-var name in `context/research/cc-source/06-dream-kairos.md` — name may be `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` instead; pick the exact CC-defined var). This goes into `writeClaudeEnvFile()` at `src/adapters/shared/env-file.ts:34-38`. The test already lives at `src/tests/adapters/cc-hooks/hooks.test.ts:626` — extend its asserts to cover the new line.

Detection: `detectCcMemoryConflict` returns new MD files since the last session. Phase 4 adds an auto-dream-specific check: look for files matching `dream*.md` or whatever CC's dream system writes. Research note: this is diagnostic only; the sentinel is the real defence.

### 3.5 Transcript chunker (STOR-06, EXTR-06)

Input: `SELECT turn_number, user_text, assistant_text FROM conversation_turns WHERE session_id=? ORDER BY turn_number ASC`. Entries where both texts are null (or only embedding backfill ran) are skipped.

Algorithm (LLM topic-detected, Q1 decision, ~20-30s budget):
1. If turn count < 3 → write a single chunk (min bound).
2. Else pass a compact representation (turn_number + first 200 chars of user_text + first 200 chars of assistant_text) to `callLocalLLM` with a topic-segmentation prompt (planner drafts the prompt; format: strict JSON `{"segments":[{"start":N,"end":M,"topic_label":"..."}]}`).
3. Enforce soft bounds (3 ≤ span ≤ 20) and hard cap (30) post-LLM: merge segments <3 turns with their predecessor; split segments >30 turns at turn boundaries.
4. For each final segment, compose the chunk body from the full (not truncated) turn texts joined. Compute `turn_range = [start, end]`. Insert as `artifact(kind='transcript_chunk', title=topic_label, body=<joined text>, project_id=<session.project>, session_id=<session.id>, created_at_epoch=<last_turn.ts>, data={turn_range:[s,e], topic_label:"..."})`. The `kind_registry` insert trigger catches the new kind automatically.
5. Embedding: leave `embedding_ref` null; Phase 6b's `backfillEmbeddings` picks it up on the next tick when no heavy work ran. No synchronous embed inside `/endsession`.

Cursor/dedup: add a per-session check — if any `artifact(kind='transcript_chunk', session_id=?)` already exists, skip re-chunking. Re-run only if forced (flag on event).

Trigger: same queue as curation — driven by session-completed signal. Runs strictly before curation so that Recent Threads can read fresh chunks within the same tick.

### 3.6 Session-start verification (CUR-01 SC-5, CUR-04 SC-5)

At session-start, after ingesting file artifacts, add a verification step that:
- reads `~/.claude/projects/<slug>/memory/MEMORY.md` size and line count;
- checks presence of both sentinels (managed top, user-editable bottom);
- if > 25KB or > 200 lines OR sentinel malformed → emit `session_events` row `event_type='memory_md_invalid'` with `detail={size, lines, reason}`. Do not mutate the file from session-start (Angel owns writes). This is pure verification.

This can live in `session-start.ts` near line 259 (right where `cc_environment` already reads the same file) or a dedicated helper — planner picks.

---

## 4. Test strategy

Existing tests relevant: `src/tests/adapters/cc-hooks/hooks.test.ts` (env-file), `src/tests/angel/*.test.ts` (monitor, user-profile-sync), `src/tests/assembly/sections.test.ts` (memory_file formatter).

New tests the plans must require:

| Concern | Test surface | Assertion |
|---------|--------------|-----------|
| Writer renders all 5 sections + preamble | unit — `memoryWriter.test.ts` | Byte-exact match against a fixture for a known DB snapshot. |
| Byte-identical idempotency | same | Two runs same bytes; sha256 match. |
| User block preserved | same | Mutate `## User Notes` between runs; tail preserved. |
| Sentinel-missing refusal | same | Strip top sentinel; writer refuses + records event. |
| File size cap | same | Force 30 entities + oversized handoff; ensure ≤25KB / ≤200 lines above marker via trim order. |
| Cold start (no transcript chunks) | same | Recent Threads section renders header with zero rows; file is still valid. |
| Env-file auto-dream flag | `hooks.test.ts:626` extension | Asserts new export line present. |
| Chunker boundary enforcement | `transcriptChunker.test.ts` | Fixture 50-turn session → ≥1 chunk, all spans ∈ [3,30]. |
| Chunker idempotency | same | Re-run on same session → zero new artifacts. |
| Chunker schema | same | `kind='transcript_chunk'`, `data.turn_range` present, `kind_registry` contains row. |
| Session-start verifier | `session-start.test.ts` | Oversized fixture MEMORY.md → `memory_md_invalid` event recorded. |
| Heartbeat wiring | `heartbeat.test.ts` | Completed session → chunker then curator fire once; errors in one don't block the other. |

Full 2020-test suite must still pass (BENCH-03).

---

## 5. Decisions open to the planner (Claude's Discretion)

Per CONTEXT §Claude's Discretion the planner may choose:

1. **Work-queue mechanism.** Recommended: a new `session_events` row `event_type='memory_curation_pending'` written by the stop hook (for /endsession path) and by Angel Phase 1b (for auto-close). Consumed by a new heartbeat phase. Alternative: a `projects.curation_watermark_epoch` compared to `MAX(ended_at_epoch)` — leaner but squirrelly on multi-project sessions. **Recommend events-based.**
2. **Chunker prompt details.** Strict JSON output, local model (glm-5.1:cloud per current Angel config), temperature 0.2 for determinism. Planner writes the prompt; researcher offers no template — keep it conventional.
3. **Atomic rename strategy.** `fs.writeFileSync(tmp); fs.renameSync(tmp, dest)`. On Windows, if rename fails because of a lock, retry once after 50ms. Prior-art: `src/core/migration/v17-backup.ts`.
4. **Normalization contract.** Planner specifies exactly: LF everywhere, `.replace(/\r\n/g, '\n')`, `.replace(/\s+$/gm, '')`, collapse runs of ≥2 blank lines to 1, ensure single trailing `\n` above the `<!-- USER EDITABLE -->` marker. Sentinel hashes post-normalized bytes.
5. **Session-start verification placement.** Inline in `session-start.ts` is fine; a small `src/core/memory-md-verify.ts` helper is cleaner. Planner picks.

---

## 6. Out-of-scope reminders (for the planner's "do NOT include" list)

From CONTEXT §Deferred:
- Context-aware How-to-Query generation.
- Project pin mechanism.
- Hand-curated entity importance overrides.
- Session-start MEMORY.md **injection** into the assembled prompt (Phase 5 / P4 work, gated by BENCH-05/06/07).
- **No retrieval scoring changes.** Phase 6 / P5 territory.
- **No assembler/injection-section deletions.** Phase 5 territory. Dual-injection is the safety net this phase runs under.
- **No directive-detector changes.** Phase 3 shipped; leave it alone.

And from ROADMAP §Phase 4 Depends on: Phase 2 (artifact table) only. No dependency on P2 directive detector; no cross-wiring with P5.

---

## 7. Requirement → code artifact crosswalk

| Req ID | Lives in (primary files the plan MUST create or modify) |
|--------|---------------------------------------------------------|
| CUR-01 | `src/angel/memory-md-writer.ts` (new); heartbeat wiring in `src/angel/heartbeat.ts`. |
| CUR-02 | Same writer — ranking + preamble logic; reuses `src/angel/user-profile-sync.ts` scanner. |
| CUR-03 | `src/adapters/shared/env-file.ts` (add auto-dream env line); writer sentinel logic; session-start verifier at `src/adapters/cc-hooks/session-start.ts`. |
| CUR-04 | Writer normalization + sha256 sentinel; test in `src/tests/angel/memory-md-writer.test.ts`. |
| STOR-06 | `src/angel/transcript-chunker.ts` (new); heartbeat wiring. Kind registers implicitly via V17 trigger. |
| EXTR-06 | Chunker LLM call via `src/angel/llama-client.ts::callLocalLLM`. |
| BENCH-01/02/03 (always-on) | Full test suite; LongMemEval + LoCoMo harness runs at phase close per gate policy. |

---

## RESEARCH COMPLETE
