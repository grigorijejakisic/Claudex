---
date: 2026-05-15
auditor_session: b5e053ba-8406-47cf-8045-34daab62ee93
mode: read-only — root cause analyses
companion: 2026-05-15-substrate-contract-matrix.md
---

# Substrate RCAs — 2026-05-15

Three follow-up investigations from the contract-matrix doc. All
read-only, all reproducible.

---

## RCA-1 — Sessions/ writer underfire (big-mozzy) — DEBUNKED

**Hypothesis:** Big-mozzy has 4 Sessions/ files for 474 edits in 7d
because the per-turn writer is mis-wired or silently failing for
that project.

**Investigation:**
- Filesystem: `big-mozzy-v2/Sessions/` actually contains **6 files**
  (I miscounted earlier from a `wc -l` trailing-newline issue):
  3 from 2026-05-14, 3 from 2026-05-15.
- DB: 30 recent sessions exist for big-mozzy-v2 in the `sessions`
  table, all with `last_jsonl_write_ts` populated (writer fired).
- Telemetry: zero `sessions_write_error` rows. Zero error rows in
  any session_writer/appendTurn subsystem. Only one error subsystem
  recorded for big-mozzy ever: `session_start/file_ingest` (1 row).
- Hook registration: `big-mozzy-v2/.claude/settings.json` has
  permissions but no per-project hook overrides. Global
  `~/.claude/settings.json` hooks apply (correct).
- Git history: 15 commits in last 7 days, mostly `session(N)` and
  `auto-close` shape — confirms session activity.

**Root cause:** Phase 13 Plan 01 (per-turn fsync writer) shipped on
2026-05-13/14. Before Phase 13, Sessions/ files weren't being
written *for any project*. The 6 files visible on disk represent
the 6 sessions that have run since per-turn writer landed. There is
no bug — 6 files for 2 days of work is correct. The contract-matrix
doc's claim "Sessions/ writer underfires for big-mozzy" was based on
a stale "474 edits in 7d" comparison; that 474 number includes
pre-Phase-13 activity that predates the writer.

**Fix shape:** None needed. The writer is healthy.

**Action item for the contract matrix:** Conflict F (Sessions/
writer underfires) is **withdrawn**. Update the matrix doc to
reflect.

---

## RCA-2 — Highlights extraction 100% degraded — ROOT CAUSE FOUND, GLOBAL FAILURE

**Hypothesis:** big-mozzy session_highlights are all degraded
because of a project-specific Opus failure mode (prompt size, auth
scope, or transcript shape).

**Investigation:**

```
session_highlights — degraded breakdown:
  big-mozzy-v2 / opus_non_2xx: 5
  claudex-v3   / opus_non_2xx: 5
  non-degraded count (any project): 0
```

**Zero non-degraded highlights exist in the entire DB.** This is
not a big-mozzy issue — it is a **global substrate failure** that
has been silent because the fallback (`glm-5.1:cloud`) produces a
*usable* artifact, so neither the operator nor any downstream
surface notices.

Earliest degraded artifact: `2026-05-14T09:05:05.665Z`. This
coincides with Phase 13 ship — the highlights extractor itself
shipped in Phase 13 Plan 03. So highlights extraction has **never
once succeeded with Opus** since the feature shipped.

**Reproducing the failure** — direct OAuth call to
`api.anthropic.com/v1/messages` with the exact credential path and
headers the extractor uses:

```
HTTP status: 429
Response: {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}
```

**Root cause:** The MAX subscription's OAuth token (in
`~/.claude/.credentials.json`, `claudeAiOauth.accessToken`) is
**rate-limited for programmatic / non-CC API access**. Interactive
Claude Code sessions consume the same token through CC's own
client and do not hit this limit (presumably because CC negotiates
a separate quota, uses session-bound headers, or the limit is
per-process-identity). When `highlights-extractor.ts` (inside Angel
heartbeat, a separate process) makes the same Authorization-header
call directly, Anthropic returns 429 immediately. Every time.

The extractor catches the failure, falls back to `glm-5.1:cloud`,
writes `degraded=1` + `degraded_reason='opus_non_2xx'`, and the
substrate moves on. Phase 13 Plan 04's "frame extraction degraded"
health line surfaces correctly when degraded rows exist — but it
fires for *every* project's session-start and is treated as
informational. The actual cross-project failure pattern (100% Opus
miss) was never noticed because the fallback content "looks fine"
unless you compare it to what an Opus-quality frame would have been.

**Fix shape — four production-quality options:**

- **(A)** Switch programmatic Opus calls to use a real
  `ANTHROPIC_API_KEY` env var (separate billing path), not the OAuth
  token. Operator-side: requires generating an API key, putting it
  in env. Substrate-side: ~10 lines in `highlights-extractor.ts` to
  read env first, fall back to OAuth token.
- **(B)** Route Angel-driven extractions through the supervised
  local llama-server (LlamaServerSupervisor / Gemma 4 31B Q6_K).
  No rate limit. Quality lower than Opus but consistent. The
  extractor's `callLocalFallback` already uses this — promote it
  to primary, downgrade Opus to optional.
- **(C)** Rate-limit-aware retry with exponential backoff inside
  the extractor. Probably won't help — 429 on first call indicates
  the credential is *categorically* rate-limited, not bursting.
- **(D)** Accept fallback as primary, remove the Opus path. Cleanest
  code but loses the option to upgrade later.

**Recommendation:** **(A) + (B) hybrid.** Default to local
llama-server for routine extraction (no rate limit, no MAX impact);
when an `ANTHROPIC_API_KEY` env var is set, prefer Opus (operator
opts in for higher quality). Operator-config-driven, no MAX
subscription dependency for background work. This matches the
existing "CliProxy removed in Path B" decision (CLAUDE.md) — Angel
should be self-sufficient on local resources.

**Action items:**
- Update `frame_extraction_fallback` telemetry to include the HTTP
  status code in `detail` (currently records only `reason` enum;
  the actual `429` is lost).
- Add a measurement: re-run highlights extraction against an
  existing session under each option to confirm.
- This is a **HIGH-priority decision** for Phase 14 because every
  Recent Session Frames in production is currently degraded.

---

## RCA-3 — V17 kernel vs legacy `artifacts` migration impact

**Hypothesis:** "Decision 7 — fully migrate legacy `artifacts` into
V17 with new kinds" is a phase-shaped piece of work, not a session.
RCA needs to scope the actual cost.

### Production callers — legacy `artifacts` table

22 production read/write sites:

| File | Site count | Operation | Note |
|---|---|---|---|
| `core/hybrid-retrieval.ts` | **8** | SELECT + UPDATE state/activation_score | L3 retrieval centerpiece |
| `intelligence/retrieval-feedback.ts` | 5 | retrieval_score read/write | activation lifecycle |
| `core/file-ingester.ts` | 2 | INSERT/UPDATE | writes memory_file, session_log, handoff, entity_summary |
| `embeddings/embed-pipeline.ts` | 2 | UPDATE embedding | per-artifact embedding writes |
| `mcp/recall-server.ts` | 2 | SELECT by id / artifact_ref | exposed via `claudex_recall` |
| `core/migration-steps.ts` | 4 | DDL + bulk migrations | already migration-aware |
| `intelligence/experience-tier.ts` | 1 | candidate pool SELECT | Conflict C noise source |
| `embeddings/sqlite-vec-backend.ts` | 1 | JOIN to vec sidecar | embedding read |
| `core/observations.ts` | 1 | SELECT artifact_ref | observation lookup |
| `core/cross-project-search.ts` | 1 | SELECT cross-project | claudex_search expansion |
| `cli/health.ts` | 1 | INSERT (test fixture) | health check seed |
| `intelligence/batch-reflection.ts` | 1 | SELECT id (dedup) | learning promotion |
| `angel/consolidator.ts` | 1 | UPDATE consolidated_into | retention sweep |
| `angel/retention-sweep.ts` | 1 | DELETE / UPDATE | TTL enforcement |
| `angel/entity-summarizer.ts` | 1 | INSERT entity_summary | Angel writer |
| `intelligence/intent-predictor.ts` | 1 | SELECT | per-turn prediction |

### Production callers — V17 `artifact` kernel

7 production read/write sites:

| File | Site count | Operation |
|---|---|---|
| `intelligence/directive-detector.ts` | 4 | INSERT/UPDATE/SELECT by `kind='directive_rule'` |
| `mcp/recall-server.ts` | 2 | FTS JOIN |
| `intelligence/retrieval-log.ts` | 1 | SELECT by `kind='transcript_chunk'` |
| `angel/transcript-chunker.ts` | n | INSERT `kind='transcript_chunk'` |
| `core/migration/v17-runner.ts` + `v17-triggers.ts` | n | DDL + INSTEAD OF triggers |
| `angel/memory-md-writer.ts` | 1 | guard `SELECT 1 FROM artifact` |

### Schema field mapping (legacy → V17)

| Legacy `artifacts` field | V17 `artifact` field | Notes |
|---|---|---|
| `id` (INTEGER autoinc) | `id` (TEXT hash) | **Type mismatch — needs ID mapping table for transition** |
| `session_id` (TEXT) | `session_id` (TEXT) | identical |
| `project` (TEXT) | `project_id` (TEXT) | **Conflict B — naming collision** |
| `artifact_type` (enum) | `kind` (string) | needs new V17 kinds (see below) |
| `artifact_ref` (TEXT) | (no equivalent) | drop or move to `data` JSON |
| `summary` (TEXT) | `title` (TEXT) | conceptually equivalent |
| `content` (TEXT) | `body` (TEXT) | conceptually equivalent |
| `state` (TEXT enum 'fresh','packed') | `status` (TEXT enum) | enum mismatch — V17 uses 'active','stale','superseded' |
| `ttl` (INTEGER) | `data.ttl` (JSON) | move to JSON sidecar |
| `importance` (INTEGER 1-5) | `confidence` (REAL 0-1) | scale conversion |
| `timestamp_epoch` (sec) | `created_at_epoch` (sec) | identical, rename |
| `last_materialized_epoch` | `data.last_materialized_epoch` | move to JSON |
| `retrieval_score` | `data.retrieval_score` | move to JSON |
| `embedding` (BLOB) | `embedding_ref` (TEXT) | **Embedding storage location changes** — V17 uses sidecar table `artifact_embeddings`, legacy keeps it on row |
| `activation_score` | `data.activation_score` | move to JSON |
| `superseded_by` | `supersedes_id` (reverse direction) | **Schema-direction flip** — legacy points forward (this row was replaced by X), V17 points backward (this row replaces X) |
| `valid_until` | `data.valid_until` | move to JSON |
| `confidence` (REAL) | `confidence` (REAL) | identical |
| `novelty_score` | `data.novelty_score` | move to JSON |
| `retrieval_count`, `success_count` | `data.retrieval_count`, `data.success_count` | move to JSON |

### New V17 kinds needed

V17 currently supports 8 kinds: `mental_model`, `learning`,
`transcript_chunk`, `angel_opinion`, `decision`, `directive_rule`,
`experience_pattern`, `critical_rule`. Migration adds:

- `observation` (high-volume — 9270 rows in claudex-v3 alone)
- `flow` (256 rows in claudex-v3)
- `session_log` (64 rows in claudex-v3)
- `memory_file` (19 rows in claudex-v3, 33 in big-mozzy)
- `handoff` (13 rows in claudex-v3)
- `entity_summary` (10 rows in claudex-v3)
- `hot_file`
- `milestone`

Each new kind requires:
- `kind_registry` row
- DDL constraint update on `artifact.kind` enum
- Update to `artifact_task_pattern` sidecar (the
  `artifact_task_pattern` table currently joins to legacy artifacts;
  needs to learn V17 IDs)
- INSTEAD OF triggers updating per-kind legacy views

### Sidecar consolidation

| Legacy | V17 | Migration step |
|---|---|---|
| `artifacts_fts` (FTS5) | `artifact_fts` (FTS5) | merge — re-index legacy rows into V17 FTS |
| `vec_artifacts` (vec0) | `artifact_embeddings` + `artifact_embeddings_chunks` (different shape — V17 uses chunked storage) | migrate row-by-row, recompute embeddings if dim changed |
| `artifact_task_pattern` (joins to legacy.id INTEGER) | needs new schema joining to V17.id TEXT | new sidecar table or schema change |
| `artifact_links` (V17-only) | n/a | already V17 |

### Estimated migration cost

A production-quality migration would need:

1. **DDL phase** (~1 day):
   - New V17 kinds registered + constraint update
   - `artifact_id_map` (legacy_id INTEGER → v17_id TEXT)
     transitional table
   - `artifact_task_pattern` schema update or replacement
   - INSTEAD OF triggers added for the new legacy views
2. **Data migration phase** (~1-2 days):
   - Per-kind backfill from `artifacts` → `artifact` rows
   - Embedding migration (re-embed if dim changed, or
     blob → chunked migration)
   - FTS5 re-index
   - Verification: row counts per kind match, embedding integrity
   - Reversibility: keep legacy `artifacts` populated during
     transition for rollback
3. **Caller migration phase** (~3-5 days):
   - Update each of the 22 production sites to read V17
   - `hybrid-retrieval.ts` is the single biggest file (8 sites)
   - `retrieval-feedback.ts` activation_score lifecycle needs to
     move to V17 `data` JSON path
   - `embed-pipeline.ts` writes need to land in V17 sidecar tables
   - `experience-tier.ts` candidate pool query needs rewrite
     (good time to fix Conflict C noise filter at the same time)
4. **Cutover phase** (~1 day):
   - Remove legacy `artifacts` table reads
   - Convert legacy table to a view over V17 (read-only) for any
     external/test callers
   - Or: hard-drop legacy table after migration verification
5. **Test phase** (~2 days):
   - Update ~20 test files that currently seed `artifacts` schema
   - Verify hybrid retrieval ranking didn't regress (Vesna +
     LongMemEval + LoCoMo)
   - Verify experience-tier surface still works (and is now
     noise-filtered)

**Total realistic cost: ~8-12 days** of focused engineering.
This is a **proper Phase**, not a turn or even a session.

### Migration risks

- **Hybrid retrieval ranking regression.** `hybrid-retrieval.ts`
  carefully orchestrates FTS5 + vec + reranker over the legacy
  schema. Moving to V17 FTS + V17 vec sidecar with chunked storage
  is non-trivial. Risk of silent ranking drift unless benchmark-
  guarded.
- **Activation score / state lifecycle.** Many surfaces depend on
  the `state IN ('fresh','packed')` enum and `activation_score`
  decay. Moving these to `data` JSON requires every read/write to
  go through a typed accessor; raw SQL paths break.
- **Embedding dim or storage shape.** If V17 sidecar uses chunked
  embedding storage, legacy single-blob embeddings need
  re-chunking. Re-embedding from scratch is safer (snowflake-arctic-
  embed2 is fast) but costs Ollama time.
- **Test fixture proliferation.** ~20 test files seed the legacy
  schema. Production tests need full migration; some unit tests
  may legitimately keep legacy schema if they test legacy-specific
  behavior.

### Recommendation

Migration is **the right call** for Decision 7 — but it should be
specced as its own phase (call it Phase 14.7 or whatever fits your
roadmap), not slipped into general substrate work. The spec needs
to address:
1. Schema mapping (above table, peer-reviewed)
2. ID mapping strategy (the INTEGER↔TEXT bridge)
3. Embedding migration path (re-embed vs blob-convert)
4. Caller migration order (read-side first to validate, then
   write-side, then cutover)
5. Rollback plan (keep legacy populated until verification, OR
   snapshot-restore plan if hard-cutover)
6. Benchmark gates (Vesna, LongMemEval, LoCoMo must not regress)
7. Telemetry: per-caller migration completion event so we can
   verify no caller is left on legacy

---

## Summary — the three findings

1. **RCA-1 withdraws Conflict F.** Sessions/ writer is healthy.
   The matrix doc needs an erratum.
2. **RCA-2 finds a critical global failure.** Highlights
   extraction has never succeeded with Opus since the feature
   shipped — every Recent Session Frames in production is
   fallback-quality. **This is a substrate-wide bug, not a
   big-mozzy bug.** The fix is an operator-side decision (use
   API key for programmatic calls, or accept local-LLM as
   primary for Angel work). Cheap fix; high impact.
3. **RCA-3 confirms Decision 7 is a real Phase.** ~8-12 days of
   focused engineering across DDL, data migration, 22 caller
   updates, test reconciliation, and benchmark protection.
   Should not be slipped into general work; needs its own spec.

These findings reshape the matrix's priority ordering. RCA-2's fix
is the highest-leverage cheap move available right now (one file,
operator decision required). RCA-3 confirms why Decision 7 needs
its own roadmap slot. RCA-1 simplifies the matrix by removing one
conflict.
