---
date: 2026-05-15
auditor_session: b5e053ba-8406-47cf-8045-34daab62ee93
projects_in_scope: claudex-v3, big-mozzy-v2
mode: read-only — research deliverable
companions:
  - 2026-05-15-big-mozzy-substrate-audit.md
  - 2026-05-15-cross-project-equivalence-hit-rate.md
---

# Substrate Contract Matrix — 2026-05-15

A systematic mapping of every "Thing" the Claudex substrate stores ×
every "Surface" that reads or writes it × the contract each surface
assumes. The motivation: the operator observed that the system "is
not systematic about session and learnings from it, handoff or
anything else." The audit and hit-rate measurement (companions above)
made the symptom concrete; this document maps the structural cause.

The substrate works *in isolation* on every surface. Together, the
surfaces have **no shared contract** about what a session is, when it
ends, what counts as a substantive artifact, what schema a handoff
follows, what project a thing belongs to, or which surface is
authoritative when two disagree. claudex-v3 happens to satisfy enough
unwritten conventions that its sessions land coherent; big-mozzy-v2,
which writes its handoffs in a different but-valid shape, gets
silently degraded.

This is a research document, not a fix. No code changes are proposed
to ship — the deliverable is the map, the conflicts found, and the
contract decisions Phase 14 needs to make.

---

## Method

For every concept in the substrate, I read the type definitions,
schema DDL, write paths, and read paths. For every surface in the
session-start cascade, the per-turn UPS pipeline, the Angel
heartbeat, and the cross-project surfaces, I documented the inputs,
outputs, schema assumptions, freshness rules, and project-scope
rules. Conflicts surface where two contracts disagree about the
same Thing.

Verification: I cross-referenced against `big-mozzy-v2` substrate to
test whether each contract holds for a project that grew under
slightly different conventions (different ACTIVE.md schema, different
naming, different lesson density).

---

## Part 1 — The Things

The substrate stores 16 distinct concepts. Several occupy multiple
tables (often a "modern" V17 kernel row + a "legacy" row in the
original `artifacts` table). Naming inconsistencies are inherited
from the migration history.

### 1.1 Session

- **What:** A continuous span of work between session-start and
  either explicit completion, transfer, idle timeout, or process
  death.
- **Stored in:**
  - `sessions` (PRIMARY KEY `session_id` TEXT, `project` TEXT,
    `status` IN active/completed/failed/transferred,
    `created_at_epoch`, `ended_at_epoch`, `last_heartbeat_ts`,
    `extraction_cursor`, `last_jsonl_write_ts`)
  - `Sessions/<YYYY-MM-DD>_<session_id>.md` per-turn-fsync transcript
- **Lifecycle owners:** `session-start.ts` (creates), `user-prompt-submit.ts`
  (writes turn + heartbeat), `stop.ts` (writes assistant turn), Angel
  heartbeat (boundary detection, status updates), session-discovery
  (auto-naming).
- **Naming column:** `project` (TEXT).

### 1.2 Handoff

- **What:** A persistent operator-facing summary of "where we are"
  that survives across sessions.
- **Stored in:** `<projectDir>/context/handoffs/ACTIVE.md` (single
  authoritative file per project).
- **Schema (claudex-v3 / handoff-writer.ts):**
  - Frontmatter: `status` (active|archived|paused), `phase`,
    optional `summary`, `topic`, `created_at_epoch_ms`.
  - Body LOCKED order: `**What we found:**` / `**What we decided:**`
    / `**What's next:**` / `**Where to look:**`.
- **Schema (big-mozzy-v2 / observed):**
  - Frontmatter: `schema: claudex/handoff`, `version: 1`,
    `handoff_id`, `status`, `created_at` (ISO), `updated_at`,
    `origin_session_id`, `supersedes`. **No `phase`,
    no `created_at_epoch_ms`.**
  - Body free-form: `## Bot state`, `## Tonight's outage`,
    `## Next session — first actions`, etc.
- **Lifecycle owners:** Operator (manual edits), `handoff-writer.ts`
  (atomic write API), Angel session-summarizer (proposes drafts —
  not authoritative).
- **Critical reader:** `parseHandoffHeader` in `handoff-writer.ts`
  — REQUIRES `status` AND `phase`, returns null otherwise.

### 1.3 Lesson (Phase 4.1 lesson files)

- **What:** Operator-curated pattern memory with strict telemetry
  handles, classified by `task_pattern`, written as standalone
  Markdown files.
- **Stored in:** `~/.claude/projects/<cc-slug>/memory/<type>_<slug>.md`
  where `<type>` is `feedback|project|process` and `<slug>` matches
  `^[a-z0-9][a-z0-9_-]{0,59}$`.
- **Schema:** YAML frontmatter with REQUIRED `type`,
  `created_at_epoch` (ms-precision ≥ 1e12), `telemetry` block
  (`tools_used`, `files_touched`, `errors_encountered`,
  `user_framing_tokens`, `session_arc`, `duration_min`,
  `correction_count`, optional `triggered_by`); optional `shape`
  block. Body = Markdown prose.
- **Lifecycle owners:** Operator + `lesson-writer.ts` (atomic write,
  strict validation), Angel pattern-promoter (proposes), Angel
  lesson-pointer-writer (sidecar to `lesson_pointer` table).
- **Critical reader:** `parseLessonFile` — filename must match
  `^(feedback|project|process)_<slug>.md$` AND frontmatter `type`
  must match the filename prefix, else returns null.

### 1.4 Learning

- **What:** A consolidated lesson promoted from observations or
  patterns. Cross-session knowledge.
- **Stored in:**
  - V17: `artifact` (kind=`learning`, `project_id`, `body`,
    `confidence`, `supersedes_id`)
  - Legacy: `learnings` (`project` TEXT default `__global__`,
    `agent_id`, `fingerprint` UNIQUE, `content`,
    `promotion_count`, `provenance`)
  - Surfaced in: `learnings_fts` (legacy), `artifact_fts` (V17)
- **Lifecycle owners:** Angel pattern-extractor (initial write),
  Angel batch-reflection (promotion), curate operations.
- **Naming column:** `project` on legacy, `project_id` on V17 — same
  values, different column names.

### 1.5 Observation

- **What:** A single tool-call trace or environmental capture.
  Highest-volume artifact type.
- **Stored in:**
  - `observations` (one row per extracted observation —
    `session_id`, `project` TEXT, `tool_name`, `category` enum,
    `title`, `content`, `importance` 1–5, `files_modified` JSON,
    `obs_type`, `stability_class`, `novelty_score`, `consumed`
    flag, `consolidated_into` pointer)
  - Also: `artifacts` table with `artifact_type='observation'`
    (legacy reference layer)
- **Lifecycle owners:** post-tool-use hook (extraction), Angel
  consolidator (deduplication, retention sweep).

### 1.6 Frame / Highlight

- **What:** A session-end mental-model snapshot extracted by Opus
  (or fallback) from the Sessions/ markdown.
- **Stored in:** `session_highlights` (`session_id`, `project`,
  `mental_model`, `open_questions` JSON, `reframes` JSON,
  `tools_introduced` JSON, `decisions_not_made` JSON,
  `posture_context`, `degraded` flag, `degraded_reason`,
  `degraded_model`, `created_at_epoch_ms`,
  `re_extracted_at_epoch_ms`).
- **Required precondition:** Sessions/<id>.md must exist on disk —
  no Sessions/ file = no highlight extraction.
- **Lifecycle owners:** Angel highlights-extractor (one shot per
  session after session marked `completed`), Angel heartbeat
  re-attempt loop (retries Opus on degraded rows).

### 1.7 Opinion (CARA)

- **What:** Angel-formed belief with confidence dynamics.
- **Stored in:**
  - V17: `artifact` (kind=`angel_opinion`)
  - Legacy: `angel_opinions` table (now a view over V17)
- **Lifecycle owners:** Angel CARA reasoning subsystem.

### 1.8 Decision

- **What:** A captured commitment from operator-Claude conversation.
- **Stored in:**
  - V17: `artifact` (kind=`decision`)
  - Legacy: `artifacts` table (`artifact_type='decision'`)
  - Searchable via `decisions_fts` (legacy)
- **Lifecycle owners:** UPS hook `captureExplicitDecisions`,
  Angel batch-reflection.

### 1.9 Memory File

- **What:** Operator-curated narrative knowledge file. Project-level
  context that doesn't fit the lesson schema.
- **Stored in:** `~/.claude/projects/<cc-slug>/memory/*.md`
  (anything that isn't a lesson file or MEMORY.md), AND mirrored
  into `artifacts` table (`artifact_type='memory_file'`).
- **Lifecycle owners:** Operator (writes/edits), Angel file-ingester
  (mirrors to `artifacts`).

### 1.10 Checkpoint

- **What:** Compressed working-state snapshot (task / decisions /
  files / open items / learnings) at compaction or session end.
- **Stored in:**
  - DB: `checkpoint_meta` (`checkpoint_id`, `session_id`, `trigger`,
    `status` IN pending/committed/mirrored, `data` JSON,
    `mirror_path`, `created_at_epoch` SECONDS not ms)
  - File: `<projectDir>/context/checkpoints/*.yaml` + `latest.yaml`
    pointer
- **Lifecycle owners:** UPS hook on post-compaction, stop hook on
  session end, Angel heartbeat for re-mirror.

### 1.11 Mental Model

- **What:** V17 kernel artifact representing a coherent piece of
  agent self-knowledge.
- **Stored in:** `artifact` (kind=`mental_model`).
- **Lifecycle owners:** Angel pattern-extractor + curators.

### 1.12 Transcript Chunk

- **What:** One semantic chunk of conversation, embedded for
  hybrid retrieval.
- **Stored in:**
  - `transcript_chunk_v6` (`session_id`, `project_id`, `turn_index`,
    `sub_index`, `role`, `provenance`, `body`,
    `created_at_epoch_ms`, `wrapper_redacted`)
  - V17: `artifact` (kind=`transcript_chunk`)
  - Vec sidecar: `vec_transcript_chunks_v6` (vec0 1024d)
- **Lifecycle owners:** Angel sessions-indexer (chunks Sessions/
  markdown), session-start defensive indexer (catches up if Angel
  is hung).

### 1.13 Directive Rule

- **What:** Operator-issued behavioral instruction extracted from
  conversation.
- **Stored in:** V17 `artifact` (kind=`directive_rule`).
- **Lifecycle owners:** Angel directive-detector.

### 1.14 Critical Rule

- **What:** Cross-session always-injected behavioral rule (e.g.,
  "MAX subscription — never ask about API costs").
- **Stored in:** V17 `artifact` (kind=`critical_rule`); legacy
  `critical_rules` table (now a view).
- **Lifecycle owners:** Angel critical-rule promoter, manual seeds.

### 1.15 Experience Pattern

- **What:** A pattern with helpful/harmful counts that powers the
  per-turn experience-warning surface.
- **Stored in:**
  - V17 `artifact` (kind=`experience_pattern`)
  - Legacy `experience_patterns` table with `helpful_count`,
    `harmful_count`, `confidence`, `needs_reembed` flag (V14)
- **Lifecycle owners:** Angel pattern-extractor, UPS hook updates
  helpful_count after pattern verification.

### 1.16 Sessions/ Markdown File

- **What:** Per-turn append-only Markdown transcript of the session,
  written by hooks before any DB indexing happens.
- **Stored in:** `<projectDir>/Sessions/<YYYY-MM-DD>_<session_id>.md`.
- **Lifecycle owners:** UPS hook (`appendTurnToSessionFile` with
  role='user'), stop hook (role='assistant'), Angel sessions-indexer
  (chunks for retrieval — read-only).
- **Required by:** highlights-extractor (no file = no highlight),
  sessions-indexer (no file = no transcript chunks).

---

## Part 2 — The Surfaces

Surfaces fall into four categories: **session-start cascade**,
**per-turn UPS cascade**, **Angel write paths**, and **side
channels**.

### 2.1 Session-start cascade (assembler.ts → assembleFullContext)

Priority-ordered, budget-gated. Each section reads N Things and
writes 0 things (renders text only).

| Priority | Section | Reads | Schema Assumptions | Freshness Rule | Project Scope |
|---|---|---|---|---|---|
| P1 | Identity | `~/.claude/USER.md` (filesystem) | Free Markdown | None | None (global) |
| P1.1 | ClaudexReady | static text | n/a | n/a | n/a |
| P1.2 | RerankerHealth | `telemetry` rows where event_kind=`reranker_fallback` in 24h | telemetry V21 schema | 24h window | Per-DB (single source) |
| P1.3 | SubstrateHealth (Fix #5) | `episodic_events` (heartbeat ticks) + `session_highlights` (non-degraded MAX) + `telemetry` (phase-2 errors) | metadata_json shape lock | 10min heartbeat / 24h highlights / 24h phase-2 | Per-project (highlights), global (heartbeat) |
| P2 | Project | `<projectDir>/CLAUDE.md` or `PROJECT_PRIMER.md` | Free Markdown | None | Per-cwd |
| P2.5 | SessionContinuity (Fix #1) | `<projectDir>/context/handoffs/ACTIVE.md` via `parseHandoffHeader` | **REQUIRES status + phase** | None (would have been Fix #6 floor if floor existed for the project) | Per-cwd |
| P2.6 | RecentSessionFrames | `getLatestHighlights(db, project, 3, floorMs?)` JOIN sessions | `session_highlights` schema | Optional Fix #6 floor | Per-project (JOIN) |
| P2.6 | FrameExtractionDegraded | latest 3 highlights for project | `degraded` flag | Latest-3 window | Per-project |
| P3 | Checkpoint | `loadCheckpoint(db, projectDir, undefined, project, floorSec?)` | checkpoint_meta + YAML | Optional Fix #6 floor (sec) | Per-project (filtered) |
| P4 | Learnings | `getTopLearnings(db, project, 5)` | `learnings` table OR V17 view | None (importance + recency) | Per-project + `__global__` |
| P4.05 | EntitySummaries | `entity_summary` artifacts | summary text | None | Per-project |
| P4.07 | AngelOpinions | `angel_opinions` view | confidence ≥ 0.7 | None | Per-project |
| P4.1 | ProvenPrinciples | always-applicable patterns | own filter | 500-token cap | Cross-project |
| P4.25 | ProjectOverview | cross-project metadata | own | None | Cross-project |
| Flow | SessionFlow | journal entries | own | None | Per-project |
| L2 | Reference | packed artifact summaries | metadata only | own | Per-project |
| L2.5 | DeliberationSurface | v6 routing | v6.routing.token_pct_cap | None | Per-project |
| L3 | Materialization | FTS5-selected full content | hybrid retrieval | None | Per-project |
| Codebase | CodebaseContext | symbols + recent changes | own | 800-token cap | Per-cwd |
| Predicted | PredictedContext | Proactive memory | own | 2000-token cap | Per-project |
| GSD | GSDState | `.planning/STATE.md` | Markdown | None | Per-cwd |
| INJ-06 | Prime initialUserMessage | ACTIVE.md frontmatter + STATE.md | **REQUIRES status=active AND phase==STATE.md `Current Phase` (EXACT string)** | None | Per-cwd |

### 2.2 Per-turn UPS cascade (assembler.ts → assembleRegularPrompt)

Lighter — runs every user prompt. Caps tighter (≤1KB injection).

| Section | Reads | Schema | Project Scope |
|---|---|---|---|
| ProvenPrinciples | always-applicable patterns | own | cross-project |
| CriticalReminders | `critical_rules` view, decay-based TTL | own | per-project |
| IntentTriggeredPatterns | `experience_patterns` keyword/category match | own | per-project + cross |
| ExperienceWarnings | `experience_patterns` FTS5 + vec hybrid | own | per-project + cross |
| TriggerMaterializedArtifacts | hybrid-retrieval pipeline | hybrid | per-project |
| **ExperienceTier** (cross-project, K=3, 200 tokens) | `artifacts` JOIN `artifact_task_pattern` WHERE `artifact_type IN (learning, observation, memory_file, flow, milestone) AND project != current` | **legacy artifacts schema** | **EXCLUDES same-project** |

### 2.3 Angel write paths

| Component | Writes | Trigger | Schema Assumed |
|---|---|---|---|
| `heartbeatTick` | `episodic_events` (env event), drives every other path | ~60s loop | own |
| pattern-extractor | `experience_patterns`, V17 `artifact` (kind=experience_pattern) | per-session cursor | own |
| CARA | `angel_opinions` / V17 (kind=angel_opinion) | post-pattern | own |
| memory-md-writer (`curateMemoryMd`) | `~/.claude/projects/<slug>/memory/MEMORY.md` | heartbeat + Fix #2 defensive at session-start | reads ACTIVE.md via `parseHandoffHeader` for ## Handoff line |
| handoff-writer | `<projectDir>/context/handoffs/ACTIVE.md` | manual API (operator-driven) | locked schema |
| lesson-writer | `~/.claude/projects/<slug>/memory/<type>_<slug>.md` + `lesson_pointer` | manual API + pattern-promoter | strict frontmatter |
| highlights-extractor | `session_highlights` row | post-session-completed for sessions with `Sessions/<id>.md` on disk | Opus prompt-shaped |
| sessions-indexer | `transcript_chunk_v6` + `vec_transcript_chunks_v6` | heartbeat + Fix #2 defensive at session-start | Sessions/ markdown shape |
| consolidator / retention sweep | mutates `observations.consolidated_into`, sets `deleted_at_epoch` | heartbeat | own |
| message-sender | `session_messages` | inter-session | own |
| entity-summarizer | `artifacts` (entity_summary) | entities in 3+ sessions | own |
| directive-detector + classify-domains | `artifact` (directive_rule), domain tags | per-session cursor | own |

### 2.4 Hook write paths

| Hook | Writes | Notes |
|---|---|---|
| session-start | `sessions` row, recovers checkpoints, prunes telemetry, `Sessions/` may not yet exist | creates session_id, calls assembler |
| user-prompt-submit | `Sessions/<id>.md` user turn (pre-anything), `sessions.last_heartbeat_ts`, conversation_turns, intent_classification event, topic_shift, decisions, framing tokens, signals, messages | per-turn — substantial work |
| post-tool-use | `observations` (extraction), `pressure_scores`, signals on file edits | per-tool |
| stop | `Sessions/<id>.md` assistant turn, session_summary, contradiction detection | per-stop |

### 2.5 Side channels

- **MCP recall server** (`src/mcp/recall-server.ts`): exposes
  `claudex_search`, `claudex_recall`, `claudex_events`,
  `claudex_store`, `claudex_message`, `claudex_session`,
  `claudex_curated_context`. Reads from V17 `artifact` + legacy
  `artifacts` + `session_events` + hybrid retrieval.
- **Hybrid retrieval**: FTS5 + sqlite-vec + cross-encoder reranker
  (BGE-v2-m3 @ 7439). Used by UPS triggered-materialized surface
  and by the recall MCP.

---

## Part 3 — The Conflict Matrix

The conflicts ranked by impact on the operator-visible question
"does fresh-session-me arrive with the right context?"

### Conflict A — Handoff schema (HIGH)

Two valid schemas exist in production:

| Field | claudex-v3 (handoff-writer.ts) | big-mozzy-v2 (observed) |
|---|---|---|
| `status` | required | present |
| `phase` | **required** | **absent** |
| `summary` | optional | absent (in body) |
| `topic` | optional | absent (in body) |
| `created_at_epoch_ms` | optional but recommended | **absent** (only ISO `created_at`) |
| `schema` / `version` | absent | present |
| `handoff_id` | absent | present |
| `supersedes` | absent | present |
| Body shape | locked: `**What we found:**` etc. | free `## Bot state` etc. |

Surfaces that read handoffs:
- `parseHandoffHeader` → REJECTS big-mozzy (no `phase`)
- `renderSessionContinuity` → returns null for big-mozzy
- `memory-md-writer.curateMemoryMd` → MEMORY.md `## Handoff` shows
  "No active handoff" for big-mozzy
- `computeInitialUserMessage` (INJ-06 prime) → returns null for
  big-mozzy (status check passes; phase exact-match against
  STATE.md fails because STATE.md may not exist or phases differ)
- Fix #6 freshness floor → never activates for big-mozzy

Net effect: big-mozzy's 119-line operator-quality handoff is
**invisible to every session-start surface**.

### Conflict B — Project naming column (LOW symptomatic, HIGH structural)

The same identifier (`big-mozzy-v2`, `claudex-v3`) is stored as:
- `project` (TEXT) on `sessions`, `observations`, `learnings`,
  `artifacts`, `episodic_events`, `session_events`,
  `session_highlights`, `pressure_scores`, etc.
- `project_id` (TEXT) on V17 `artifact` and `transcript_chunk_v6`

No view or trigger enforces consistency. A query that JOINs across
these tables must hand-write the column-name disagreement. Discovered
during audit when `WHERE project='big-mozzy-v2'` against V17 failed.

### Conflict C — Cross-project candidate pool poisoned by observations (HIGH)

`fetchCandidatePool` in `experience-tier.ts`:

```sql
WHERE atp.task_pattern != '__abstain__'
  AND a.project != ?
  AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
```

Includes `observation` rows. The artifact_task_pattern classifier
runs against every artifact regardless of substance, so single-action
`Read: file.ts` observations end up classified with a task_pattern
and become legitimate candidates. Cross-project equivalence stage 1
boosts on shared `user_framing_tokens` derived from the summary,
which is just the filename. Result: 84% of injections into big-mozzy
are noise (measured N=100 — see hit-rate companion doc).

### Conflict D — Same-project routing has no fallback (HIGH)

The Experience Tier surface explicitly EXCLUDES same-project (`a.project != ?`).
The intent: same-project knowledge surfaces through Recent Session
Frames (P2.6) instead. But:
- big-mozzy session_highlights are 4/4 degraded — Recent Session
  Frames either silent or low-quality fallback
- 4 Sessions/ files for a project with 474 edits in 7d means most
  sessions never had highlights extracted at all
- big-mozzy memory_files (`bet365-cascade-precursor.md`,
  `fl365-passive-architecture.md`) are mirrored to `artifacts` and
  CAN match same-project FTS in hybrid retrieval — but FTS triggers
  on per-turn keyword match, not on session-start `here's what
  matters`

Net effect: when big-mozzy session-start fires, **same-project
context only reaches the agent if the agent runs a search query**.
There's no proactive "here's the relevant big-mozzy knowledge"
section.

### Conflict E — Lesson file schema vs memory file schema (MEDIUM)

`parseLessonFile` requires:
- Filename matches `^(feedback|project|process)_<slug>.md$`
- Frontmatter `type` matches filename prefix
- Required telemetry block

big-mozzy memory files like `bet365-cascade-precursor.md`,
`mozzart-nightly-pause.md` do NOT match — they're not lessons.
They're surfaced via the `artifacts` table (`memory_file` type)
mirror but never appear in MEMORY.md `## Lessons` section. Two
different systems for two different shapes — both work, but neither
covers "rich domain knowledge that isn't a behavioral feedback
pattern."

### Conflict F — Sessions/ writer underfires for big-mozzy (MEDIUM)

UPS hook calls `appendTurnToSessionFile` synchronously per user
turn. Stop hook calls it for assistant turns. Both wrapped in
non-throwing try/catch. big-mozzy has 4 Sessions/ files for the
recent multi-week activity window — meaning either:
- The hooks are not registered for big-mozzy (CC settings.json
  scope mismatch); OR
- `appendTurnToSessionFile` is failing silently (try/catch swallows
  the error → telemetry was supposed to capture but maybe not for
  this path); OR
- The cwd resolution to a Sessions/ directory is wrong for
  big-mozzy

Without Sessions/ files: no highlights extraction, no transcript
chunks, no per-turn fsync durability.

### Conflict G — Frontmatter epoch shape (MEDIUM)

Three different epoch shapes are in active use:
- `created_at_epoch_ms` (handoff-writer, session_highlights,
  transcript_chunk_v6) — milliseconds
- `created_at_epoch` (checkpoint_meta, observations, sessions,
  learnings, artifact V17) — seconds
- `created_at` ISO 8601 (big-mozzy ACTIVE.md, lesson frontmatter)

Fix #6 freshness floor reads `created_at_epoch_ms` from ACTIVE.md
and converts to seconds for checkpoint, BUT only fires when ACTIVE.md
has the ms field. big-mozzy ACTIVE.md has only ISO → floor stays
unset → pre-pivot leaks not blocked.

### Conflict H — Multi-agent ACTIVE.md invisibility (LOW per-project, HIGH for multi-agent users)

Assembler reads only `ACTIVE.md`. big-mozzy has `ACTIVE-agent2.md`
for parallel-agent work — permanently invisible at session-start.

### Conflict I — INJ-06 prime vs P2.5 SessionContinuity (LOW)

Both surfaces exist in session-start. INJ-06 prime requires
`status=active` AND `phase` exactly equals STATE.md `Current Phase`
(string equality, no fuzzy match) AND a summary. P2.5 SessionContinuity
requires only `parseHandoffHeader` to succeed. Two different
contracts on the same source file. The prime is more strict; can
return null while P2.5 succeeds (or vice versa, in theory).

### Conflict J — `project` value source-of-truth ambiguity (MEDIUM)

`session_highlights.project` is set by the writer (the highlights
extractor passes its own value). `sessions.project` is set by
session-start hook (from cwd resolution). They CAN disagree (we
caught a case during the morning's substrate audit where the agent
was in CLAUDEXv3 cwd but conversing about big-mozzy → both tables
got `claudex-v3`, which is technically correct by cwd but wrong by
topic). Fix #4 (today) wired a JOIN-based filter so the read side
trusts `sessions.project`; the write-side integrity check throws on
mismatch. But there's no shared `getProjectForSession(sessionId)`
helper — every writer derives `project` independently.

### Conflict K — V17 kernel and legacy `artifacts` co-resident (LOW per-query, HIGH structural)

V17 kernel `artifact` (kind=...) was supposed to collapse 6
knowledge tables. The legacy `artifacts` table (artifact_type=...)
still exists with different content (observations, flows,
session_logs, memory_files, handoffs, entity_summaries). They have:
- Different ID column types (V17 = TEXT hash; legacy = INTEGER)
- Different naming column (`project_id` vs `project`)
- Different schema (V17 has `body`, `confidence`, `supersedes_id`;
  legacy has `summary`, `content`, `state`, `ttl`, `importance`,
  `novelty_score`, `retrieval_count`, `success_count`)
- Different FTS sidecars (`artifact_fts` vs `artifacts_fts`)
- Different vec sidecars (V17 `artifact_embeddings*` vs legacy
  `vec_artifacts`)

Tier scorer reads legacy. Hybrid retrieval reads BOTH. Recall MCP
reads BOTH. No documented rule for which is authoritative on a
given concept.

### Conflict L — MEMORY.md regenerator schema-blindness (MEDIUM)

`memory-md-writer.curateMemoryMd` calls `parseHandoffHeader` to
populate the `## Handoff` line. When parser returns null
(big-mozzy), the line says "No active handoff." There is no
fallback parser for the older `claudex/handoff` v1 schema or any
other schema variant. Today's Fix #2 makes this run more often,
but the parser blindness is unchanged.

---

## Part 4 — Cross-project case study

### Why claudex-v3 looks "good"

Every contract above happens to be satisfied:
- ACTIVE.md uses the exact `status + phase + topic + summary +
  created_at_epoch_ms` schema parseHandoffHeader expects
- ACTIVE.md body uses the exact `**What's next:**` /
  `**Where to look:**` inline fields renderSessionContinuity
  extracts
- `## Operator Gates` section was added today (Fix #3) and is
  surfaced
- 7 Sessions/ markdown files exist (writer is wired)
- session_highlights succeed (Opus extraction works for these
  prompts/sessions)
- 50 V17 learnings + 71 decisions + 142 mental_models fill
  P3/P4/P4.07
- Cross-project Experience Tier is mostly noise too, but doesn't
  matter much because P2.5/P2.6/P3/P4 already carry the load

### Why big-mozzy looks "broken"

Every contract above fails differently:
- ACTIVE.md schema mismatch → P2.5 silent, MEMORY.md `## Handoff`
  silent, INJ-06 prime null
- 4 Sessions/ files → highlights mostly never extracted →
  P2.6 silent
- 4/4 highlights degraded → FrameExtractionDegraded fires (correct)
  but the actual frame content is fallback-quality
- No `created_at_epoch_ms` → Fix #6 floor never activates → if
  highlights ever DID succeed, pre-pivot ones could leak
- Cross-project Experience Tier fires 5.5× more (per measurement)
  but 100% of substantive injections are claudex-v3 self-knowledge
  with zero domain relevance to bet365/Mozzart/FL365
- Same-project Experience Tier surface doesn't exist (by design —
  Experience Tier is cross-project-only)
- Multi-agent `ACTIVE-agent2.md` invisible

The substrate density itself is FINE (487 V17 artifacts, 30+
memory files, dense vocabulary). The plumbing carries none of it
to session-start.

---

## Part 5 — Contract decisions Phase 14 needs to make

The fix isn't "add another surface." It's: **define one contract
per concept and enforce it at every read/write site.**

### Decision 1 — Handoff schema: one or many?

Options:
- **(a)** Force one schema. parseHandoffHeader rejects everything
  else. Operator must rewrite all handoffs to the locked schema.
  Cleanest, most painful migration.
- **(b)** Accept schema variants. parseHandoffHeader becomes
  pluggable; first-match wins. Each variant declares its own
  field-extractor for downstream surfaces. No migration; complexity
  grows with surface count.
- **(c)** One schema, automated migration. Add a one-shot tool that
  reads any ACTIVE.md, infers the missing fields, writes the
  canonical shape. Operator runs it once per project.

Recommendation: **(c)** — same outcome as (a) without the manual
rewrite tax.

### Decision 2 — Project naming column: one or two?

Options:
- **(a)** Rename V17 `project_id` → `project`. Migration one-liner.
- **(b)** Rename legacy `project` → `project_id`. Bigger blast
  radius (8+ tables, all hooks).
- **(c)** Add a view `unified_artifact` that exposes both columns
  with a single `project` alias. No DDL change.

Recommendation: **(a)** — small blast radius, removes the
gotcha entirely.

### Decision 3 — Substantive-artifact filter: one or N?

The Experience Tier "is observation a candidate?" question shows
up in N other places (consolidator, retention sweep, lesson
promoter). Each has its own filter. Decision: define **one**
`isSubstantive(artifact)` predicate (rules: not a single tool-call
trace, length ≥ 60 chars, importance ≥ 4 OR has a non-default
classification) and use it everywhere.

### Decision 4 — Session-start same-project surface: where does it live?

Today's gap: when Recent Session Frames is empty/degraded,
nothing else proactively surfaces same-project knowledge at
session-start. The agent has to query.

Options:
- **(a)** Add a P2.7 `## Project Knowledge` section that surfaces
  top-K `memory_file` artifacts from the current project. Cheap.
- **(b)** Same as (a) but routed through hybrid retrieval against
  the handoff summary as the implicit query.
- **(c)** Promote big-mozzy-style memory_files to first-class
  "lessons" with the strict schema. Operator-tax.

Recommendation: **(b)** — most ergonomic for operators who write
memory files in their own shape.

### Decision 5 — Lifecycle owner: who owns "session ended"?

Today: session-start sets status=active. UPS heartbeats
last_heartbeat_ts. Stop hook may or may not write a session_summary
(depending on platform). Angel boundary detector reads
last_heartbeat_ts and decides ALIVE/DORMANT/TERMINATED. Sessions/
writer fires on UPS + Stop. Highlights extractor fires when status
becomes 'completed'. Multiple owners, no single "session ended →
all surfaces converge" event.

Decision: nominate **Angel boundary detector** as the single owner
of the `completed` transition. When it fires:
1. Set `sessions.status='completed'` + `ended_at_epoch`
2. Write a session-end episodic_event
3. Trigger highlights extraction (already does)
4. Trigger a final pattern-extractor pass over the session
5. Trigger MEMORY.md regeneration

Today these all happen on different cadences with different
triggers; some don't happen at all for some projects.

### Decision 6 — Epoch shape: one or N?

Three shapes today (`*_epoch_ms`, `*_epoch`, ISO). Options:
- **(a)** All ms-precision in DB; ISO only for human-facing files.
- **(b)** All ms-precision everywhere including handoff frontmatter.
- **(c)** Status quo + an `epoch.ts` helper that converts on read.

Recommendation: **(b)** — eliminates the Fix #6 floor's silent
failure mode.

### Decision 7 — V17 kernel vs legacy `artifacts`: which is canonical?

V17 was supposed to collapse 6 knowledge tables but legacy
`artifacts` has independent content (observations, flows,
session_logs). Decision needed: do we **fully migrate** the legacy
content into V17 with appropriate `kind` tags, or do we declare them
**different concepts** with documented boundaries?

Recommendation: **migrate**, with new V17 kinds (`observation`,
`flow`, `session_log`, `memory_file`, `entity_summary`, `handoff`).
Then there's exactly one knowledge table; tier scorer / recall
MCP / hybrid retrieval read from one place; the legacy `artifacts`
table becomes a view that maps to V17 for transitional callers.

### Decision 8 — Multi-agent handoff: one ACTIVE or N?

Decision: assembler reads `ACTIVE*.md` (glob), surfaces each as a
distinct continuity block tagged with the agent. Trivial code
change once a contract for "what's an agent ID in a handoff" exists.

---

## Part 6 — Investigation deliverables (next phase research)

The matrix above is the high-altitude map. To move on it, three
follow-up investigations would close the remaining unknowns:

1. **Sessions/ writer underfire RCA for big-mozzy.** Why are there
   only 4 files? Hook registration, cwd resolution, or silent
   write failures? Probably a one-day dig.
2. **Highlights extraction failure RCA for big-mozzy.** All 4
   degraded — Opus rejection pattern? Auth? Rate limit? Read
   `frame_extraction_fallback` telemetry rows for the
   `degraded_reason` distribution.
3. **Schema migration impact assessment for Decision 7.** Concrete
   PR-shaped plan: which tables migrate, which views replace them,
   which callers need updates, what's the rollback path.

---

## Part 7 — What this is NOT

To prevent scope creep:

- This document does **not** propose code. Decisions 1–8 are
  options to choose between, not a fix list.
- This document does **not** declare claudex broken. The substrate
  works in isolation; the issue is contract coherence.
- This document does **not** require Phase 14 to land tomorrow.
  The claudex-v3 disposition test passing tomorrow is independent
  of these decisions.
- This document does **not** endorse rewriting big-mozzy substrate
  to fit. Decisions 1, 4, 8 are explicitly designed to accommodate
  big-mozzy as it is.

The deliverable is the matrix and the contract decisions. The
operator picks which to act on, when, and with what scope.
