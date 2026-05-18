# Unified Code Review Report — Phase 14-09

**Scope:** Phase 14-09 substrate work (V40+V42+V43 migrations, session_termination, claudex_recall ID contract, MCP tool, generation-backend wrapper, CHR async, CLAUDE.md rules)
**Date:** 2026-05-18
**Grade:** D
**Perspectives:** Quality [4/4 OK], Acceptance [3/4 OK — core rate-limited], Security [1/3 OK — core+surfaces rate-limited], General [1/4 OK — angel+core+surfaces failed or rate-limited]
**Diff:** 100 files / 5236 insertions / 438 deletions vs origin/master

---

*Previous report content superseded. Full Phase 14-09 findings follow.*

---
**Scope:** All 149 source files + 103 test files under `src/`
**Runtime:** Bun + esbuild + Vitest (2076 tests passing)

---

## Grade: C (67/100)

---

## Summary Statistics

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 11 |
| Medium | 16 |
| Low | 10 |
| **Total** | **40** |

---

## Top 3 Most Impactful Improvements

1. **Remove all process orchestration/CLIProxy calls from hooks** and keep hook execution fully awaited/deterministic.
2. **Fix cross-entity ID mismatches** in retrieval/consolidation/retention paths (`artifact_id` vs observation IDs; invalid artifact columns).
3. **Re-establish type/test contract integrity** (`tsc --noEmit` in CI + black-box hook payload tests + full-schema migration assertions).

---

## Wiring and Safety Check Verdict

| Check | Result |
|-------|--------|
| CC-hook CLIProxy rule (deadlock) | **FAILED** -- `session-start.ts` calls CLIProxy API |
| Hook await/ephemeral rule | **FAILED** -- `spawn(...).unref()` fire-and-forget in hook |
| Hook JSON return schema | **LIKELY MISMATCH** -- `pre-compact.ts` returns undocumented `customInstructions` field |
| `lifecycle.ts` composability | **BUG** -- DB-global state + minor efficiency issue |
| `/tmp` compatibility | **PASS** -- no major runtime hardcoded `/tmp` paths |
| Unparameterized SQL | **PASS** -- no confirmed user-input SQL injection; dynamic SQL is constant/escaped/migration-internal |

---

## Findings by Severity

### Critical (3)

| # | File : Line | Issue | Suggested Fix |
|---|-------------|-------|---------------|
| 1 | `src/adapters/cc-hooks/session-start.ts:79,84,119,171` | CC hook calls CLIProxy API (`127.0.0.1:8317`), violating the explicit deadlock rule for hooks. This is the single most dangerous pattern in the codebase. | Remove CLIProxy probing/startup from hooks; keep hooks Ollama/DB-only and move proxy orchestration to a persistent process. |
| 2 | `src/angel/memory-monitor.ts:268,283` | `entry.filename` from `MEMORY.md` is joined and then read/deleted without canonical containment validation (`../` traversal risk allows arbitrary file delete/read). | Resolve to real path and enforce `resolved.startsWith(path.resolve(memoryDir) + path.sep)` before file operations. |
| 3 | `src/angel/consolidator.ts:132,135` | Clustering compares Qdrant `artifact_id` (artifacts PK) against observation IDs, so most valid neighbors never cluster -- consolidation is functionally broken. | Map Qdrant artifact IDs back to observation IDs via `artifacts.artifact_ref` (or include observation ID in payload) before `batchIds.has(...)`. |

### High (11)

| # | File : Line | Issue | Suggested Fix |
|---|-------------|-------|---------------|
| 1 | `src/adapters/cc-hooks/session-start.ts:92-95,101-111` | Spawns executable candidate from `%TEMP%` (`cliproxy_new`), creating local binary hijack/RCE risk. | Restrict executable paths to trusted install dirs and verify binary integrity/signature. |
| 2 | `src/adapters/openclaw-bridge/bridge-adapter.ts:137-140,290-293` | Shared `TopicShiftDetector` state leaks across sessions (cross-session behavioral contamination via cooldown/embedding state). | Store detector per-session instead of process-global cache. |
| 3 | `src/core/hybrid-retrieval.ts:594-596` | Temporal channel queries non-existent artifact columns (`status`, `created_at_epoch`); channel always throws and is silently disabled. | Replace with valid columns (`state`, `timestamp_epoch`) and add regression test. |
| 4 | `src/angel/retention-sweep.ts:420,431,442` | Observation pruning checks `observations.id NOT IN retrieval_events.artifact_id` -- these are different entities, so "keep referenced observations longer" rule is not enforced. | Join through `artifacts` (`JOIN artifacts a ON a.id=re.artifact_id AND a.artifact_type='observation'` and compare `CAST(a.artifact_ref AS INTEGER)=observations.id`). |
| 5 | `src/assembly/sections.ts:29` | `source` attribute in XML wrapper is not escaped; crafted refs can break boundaries/inject instructions. | Escape XML attrs (`& < > " '`) before interpolation. |
| 6 | `src/assembly/assembler.ts:583` | Predicted-context budgeting deducts `min(cost, 2000)` while injecting full content, allowing budget overflow. | Either truncate injected section to cap or deduct full injected token cost. |
| 7 | `src/core/migration-steps.ts:332,426` | v5->v6 and v6->v7 rebuild `sessions` with `CHECK(status IN ('active','completed','failed'))`, but transfer logic writes `status='transferred'`; upgraded DBs reject transfers. | Add `'transferred'` to both migration rebuild CHECK constraints and ship a repair migration. |
| 8 | `src/angel/index.ts:103,143` | OAuth loader exists but is never used in Anthropic client fallback path (acceptance mismatch vs docs/comments). | Integrate `loadOAuthToken()` into auth selection before API-key fallback. |
| 9 | `src/tests/adapters/cc-hooks/hooks.test.ts:45` | Hook tests mostly test internals, not hook-entry payload contract (`tool_response`, `prompt`, `last_assistant_message`). No black-box contract tests. | Add black-box tests invoking each hook entry with raw payload JSON and asserting outputs/DB effects. |
| 10 | `src/tests/embeddings/qdrant-client.test.ts:35` | Tests still assume 4 Qdrant collections; runtime has 5 (`conversations`) and that path is under-tested. | Assert all 5 collections and add conversation vector flow coverage. |
| 11 | `src/adapters/cc-hooks/user-prompt-submit.ts:348` | TypeScript health is broken (`cachedPrepare` missing + multiple strict errors in hooks/intelligence), reducing correctness confidence. | Fix compile errors and gate CI on `tsc --noEmit` pass. |

### Medium (16)

| # | File : Line | Issue | Suggested Fix |
|---|-------------|-------|---------------|
| 1 | `src/adapters/cc-hooks/session-start.ts:53-59,106-112,154-160` | Hook uses detached `spawn(...).unref()` fire-and-forget process starts (Qdrant/CLIProxy/Angel) in ephemeral context. | Move service startup out of hooks; keep hook async fully awaited and bounded. |
| 2 | `src/adapters/cc-hooks/session-start.ts:202-204,210-212` | Orphan recovery selects sessions across all projects but writes recall flow entries using current `ctx.project` (cross-project misattribution). | Select orphan `project` in query and pass per-orphan project to `captureRecallFlowEntry`. |
| 3 | `src/adapters/openclaw-bridge/plugin-entry.ts:34-38,47-63` | Session-end cleanup depends on mutable "last session" globals; concurrent/overlapping sessions can cleanup the wrong session. | Track cleanup state keyed by actual session ID. |
| 4 | `src/adapters/shared/lifecycle.ts:159-168,181-208` | `_tickColumnEnsured` is module-global, not DB-scoped; multi-DB composition can skip schema guard and fail-open TTL ticking. | Cache per DB handle/path (`WeakSet<Database>` or keyed map). |
| 5 | `src/adapters/cc-hooks/pre-compact.ts:56` | Returns `customInstructions` top-level field that likely does not match Claude Code hook output schema (undocumented field). | Return only documented schema fields (`systemMessage` / hook-specific output). |
| 6 | `src/mcp/recall-server.ts:403-408` | "Latest active session" query does not filter `status='active'`; completed sessions may be returned. | Add `AND status = 'active'` to project-scoped lookup. |
| 7 | `src/mcp/recall-server.ts:506,524` | Session `signal` action uses `defaultProject` instead of session's real project (cross-project signal misrouting). | Resolve project from `sessions` by `sessionId`. |
| 8 | `src/core/migrations.ts:107,117,160` | Migration failures are swallowed/broken out of, but `initializeSchema()` still unconditionally stamps `user_version=12` (partially migrated DBs marked as fully migrated). | Stamp version only after full verified migration completion. |
| 9 | `src/extraction/redaction.ts:215` | Path sanitization checks are not robust across Windows case/drive variants. | Normalize + case-insensitive Windows comparisons with generalized user-home redaction. |
| 10 | `src/extraction/extractor.ts:175` | Dedup key depends on file list order, causing false misses for same file set in different order. | Canonicalize `files_modified` (`sort + dedupe`) before keying. |
| 11 | `src/checkpoint/loader.ts:41` | Prefix-based containment allows symlink escape edge case. | Use `realpath`-based containment checks. |
| 12 | `src/assembly/worker-context.ts:179` | Trimming splits on `##` while sections are `###`, reducing effectiveness under hard caps. | Split by actual section markers or structured chunks. |
| 13 | `src/embeddings/embed-pipeline.ts:41` | Provider can be cached as permanently unavailable after first failed health check. | Add TTL/backoff re-check strategy. |
| 14 | `src/tests/core/migrations.test.ts:18` | "All tables" tests validate only subset; V12 regressions can pass unnoticed. | Validate against full expected-schema manifest. |
| 15 | `src/tests/adapters/cc-hooks/infrastructure.test.ts:103` | Broad try/catch in tests masks real failures. | Replace with deterministic mocks and strict assertions. |
| 16 | `src/tests/integration/e2e-flows.test.ts:400` | Hard wall-clock thresholds cause CI flakiness and false negatives. | Move perf checks to benchmark suite or use deterministic proxies. |

### Low (10)

| # | File : Line | Issue | Suggested Fix |
|---|-------------|-------|---------------|
| 1 | `src/mcp/recall-server.ts:191-205` | Vector dedupe set is not updated after insert; duplicate IDs can still append. | Add inserted IDs to the dedupe set in-loop. |
| 2 | `src/adapters/shared/lifecycle.ts:1122-1124` | Prepared statement created repeatedly inside loop (avoidable overhead, bypasses stmt cache). | Hoist prepare/cached statement outside loop. |
| 3 | `src/shared/config.ts:11,108,115,186` | `DEFAULT_CONFIG` omits fields typed as required (`features`, `gsd`, etc.), weakening config safety. | Make `DEFAULT_CONFIG` fully satisfy `ClaudexConfig`. |
| 4 | `src/cli/health.ts:536,538` | Comment says "fail on recent errors" but code emits warning; misaligned severity semantics. | Align implementation and documentation (return `fail` for `count5m > 0` or update comment). |
| 5 | `src/extraction/extractor.ts:151` | Sync/async extraction pipelines duplicate logic with drift risk. | Extract shared normalization/gating helper. |
| 6 | `src/benchmark/locomo-harness.ts:99` | `shell:'bash'` + `cat` pipeline is non-portable for Windows. | Use `spawnSync/execFileSync` with `input` and `shell:false`. |
| 7 | `src/benchmark/locomo-harness.ts:399` | Hardcoded machine-specific dataset defaults reduce portability. | Require explicit dataset path or env-configured location. |
| 8 | `src/benchmark/locomo-harness.ts:226` | Sequential embedding backfill slows large benchmark runs. | Use batch embedding or bounded concurrency. |
| 9 | `src/tests/helpers/test-db.ts:44` | `createTestDbWithData` appears unused. | Remove or reuse across suites. |
| 10 | `src/angel/heartbeat.ts:707` + others | Dead/unused exports: `resetLinkingRateLimit`, `resetSyncRateLimit` (`user-profile-sync.ts:52`), `MemoryMigrationStats` (`types.ts:154`), `resolveEntitiesInBatch` (`entity-resolver.ts:128`), `PREDICTED_CONTEXT_BUDGET` (`intent-predictor.ts:67`), `LifecycleParams` (`lifecycle.ts:47`). | Remove dead exports or wire real callers/tests. |

---

## Dead Exports Inventory

| Export | File : Line | Status |
|--------|-------------|--------|
| `resetLinkingRateLimit` | `src/angel/heartbeat.ts:707` | No external callers |
| `resetSyncRateLimit` | `src/angel/user-profile-sync.ts:52` | No external callers |
| `MemoryMigrationStats` | `src/angel/types.ts:154` | No external callers |
| `resolveEntitiesInBatch` | `src/intelligence/entity-resolver.ts:128` | No external callers |
| `PREDICTED_CONTEXT_BUDGET` | `src/intelligence/intent-predictor.ts:67` | No external callers |
| `LifecycleParams` | `src/adapters/shared/lifecycle.ts:47` | No external callers |

**Note per CLAUDE.md Angel-promoted rule:** Before deleting these, investigate whether they SHOULD be wired (connected to callers) rather than removed. Most "dead" code in this codebase is unwired code that was meant to be connected.

---

## TypeScript Build Health

`npx tsc --noEmit` **fails globally**. Key scope-local type issues:

- `src/intelligence/experience-scoring.ts:43` -- `ExperienceFlags` default omits required `session_injected_ids`
- `src/intelligence/experience-patterns.ts:514` -- Invalid cast pattern triggers strict TS error
- `src/adapters/cc-hooks/user-prompt-submit.ts:348` -- `cachedPrepare` missing reference

**Recommendation:** Gate CI on `tsc --noEmit` pass to prevent type drift.

---

## Review Methodology

Codex deployed 4 parallel sub-reviewers covering different subsystems:
1. **Core / Shared / CLI / Schema** -- migrations, storage, hybrid-retrieval, config
2. **Intelligence / Angel** -- pattern extraction, consolidation, retention sweep, heartbeat
3. **Extraction / Embeddings / Assembly / Checkpoint** -- redaction, embedding pipeline, context assembly
4. **Adapters / MCP** -- CC hooks, OpenClaw bridge, lifecycle, MCP recall server

Each reviewer performed static analysis, cross-referenced schemas and contracts, ran `ts-prune` for dead export detection, and validated against Claude Code hook documentation (fetched live from Anthropic docs). The coordinator cross-checked key findings directly in source before final synthesis.

Test suite validation: 2076 tests passing (`bun run test`).

---

*Report generated by OpenAI Codex CLI v0.105.0 (gpt-5.3-codex) via multi-agent review, coordinated by Claude Opus 4.6.*
