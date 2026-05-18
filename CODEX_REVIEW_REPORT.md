# Unified Code Review Report — Phase 14-09

**Scope:** Phase 14-09 substrate work (V40+V42+V43 migrations, session_termination, claudex_recall ID contract, MCP tool, generation-backend wrapper, CHR async, CLAUDE.md rules)
**Date:** 2026-05-18
**Grade:** D
**Perspectives:** Quality [4/4 OK], Acceptance [3/4 OK — core rate-limited], Security [1/3 OK — core+surfaces rate-limited], General [1/4 OK — angel+core+surfaces failed or rate-limited]
**Diff:** 100 files / 5236 insertions / 438 deletions vs origin/master

---

## Coverage Gap

8 of 16 codex calls failed to return findings:

- **Explicitly missing (4):** chunk-angel-security, chunk-angel-general, chunk-core-general, chunk-surfaces-general
- **Rate-limited by OpenAI — no output (4):** chunk-core-acceptance, chunk-core-security, chunk-surfaces-security

The only security findings come from chunk-docs-security, which reviewed the angel generation-backend changes visible in the docs/angel diff. Core migration logic and surfaces MCP/hook code received no security coverage. The grade below is a lower bound — additional criticals may exist in unreviewed paths.

---

## Critical

### [QUALITY-ANGEL][ACCEPTANCE-ANGEL] Model name routing across incompatible backend namespaces
**File:** `src/angel/generation-backend.ts:82`, `src/angel/highlights-extractor.ts:378`, `src/angel/transcript-chunker.ts:172`, `src/angel/consolidator.ts:247`
**Issue:** The generation backend abstraction leaks model namespaces bidirectionally. Callers that migrated to Claude aliases (`haiku`, `sonnet`) pass them through when `CLAUDEX_GENERATION_BACKEND=ollama`, sending invalid model IDs to Ollama. Conversely, `highlights-extractor.ts` passes `config.localModel` (default: `glm-5.1:cloud`, an Ollama tag) into the Claude CLI path.
**Recommendation:** Normalize model selection per backend. Claude path: ignore `config.localModel`/Ollama tags; default to a canonical Claude alias. Ollama path: ignore Claude aliases; fall back to `config.localModel` or configured Ollama default.
**Impact:** Both paths can fail silently or call the wrong model. Production highlights generation is at risk.

### [SECURITY-DOCS] PII/credential leakage through Claude subprocess generation
**File:** `src/angel/generation-backend.ts:82`, `src/angel/last-session-synthesis.ts:291`, `src/angel/last-session-synthesis.ts:318`
**Issue:** Generation now defaults to the Claude subprocess backend. LSS builds prompts from raw user/assistant transcript dialogue via `_filterToDialogue()` without running `redactContent()`. Credentials, `.env` contents, or PII the user pasted into a session are forwarded to Anthropic's CLI verbatim.
**Recommendation:** Apply `redactContent()` at every cloud-generation boundary before `generate()` when the resolved backend is `claude`. Consider explicit opt-in for cloud generation on sensitive projects.
**Filter note:** Not a vacuum-only concern — the backend default changed from Ollama to Claude in this diff, making this a new risk surface.

### [QUALITY-CORE][QUALITY-SURFACES][ACCEPTANCE-SURFACES] Crash inference uses COALESCE instead of MAX + millisecond/second unit mismatch
**File:** `src/core/session-termination.ts:145`
**Issue (two sub-issues in same function, fixed together):**
1. `COALESCE(last_heartbeat_ts, last_jsonl_write_ts, created_at_epoch_ms)` returns the first non-null value, not the most recent. A session with a stale heartbeat and a recent JSONL write will be classified as crashed.
2. The cutoff is computed in milliseconds, but existing hooks still write `last_heartbeat_ts` in seconds. The millisecond cutoff is ~1000x larger than any heartbeat value, causing all active sessions with a heartbeat to be immediately crash-terminated on first run.
**Recommendation:** Fix both in one pass: (a) use `MAX(COALESCE(last_heartbeat_ts, 0), COALESCE(last_jsonl_write_ts, 0), created_at_epoch_ms) < cutoff`; (b) normalize heartbeat writes to milliseconds, or convert the cutoff to seconds when comparing against `last_heartbeat_ts`. Also: update `sessions.status` and `ended_at_epoch_ms` when a crash is inferred, so active-session queries stop surfacing the session.

---

## Recommended

### [ACCEPTANCE-SURFACES] `last_activity_epoch` alias stores ms, consumed as seconds
**File:** `src/intelligence/cross-session-coordination.ts:50`
**Issue:** Query aliases `MAX(o.timestamp_epoch_ms) AS last_activity_epoch`, but formatter computes `Date.now() / 1000 - a.last_activity_epoch` — producing huge negative "Xm ago" values.
**Recommendation:** Return seconds with `MAX(o.timestamp_epoch_ms) / 1000 AS last_activity_epoch`, or rename alias to `last_activity_epoch_ms` and use `(Date.now() - a.last_activity_epoch_ms) / 60000`.

### [QUALITY-CORE][ACCEPTANCE-SURFACES] Health schema expectations not updated for V43 renames
**File:** `src/cli/health.ts:202`
**Issue:** `checkColumns` still expects `artifact_links.created_at_epoch`, renamed by V43 to `created_at_epoch_ms`. A correctly migrated V43 database is falsely reported unhealthy.
**Recommendation:** Update all health expectations for V43-renamed columns: `created_at_epoch_ms`, `valid_at_epoch_ms`, `invalid_at_epoch_ms` in `artifact_links`.

### [QUALITY-CORE] `ArtifactLinkRow` TypeScript contract stale after V43 rename
**File:** `src/core/artifacts.ts:648`
**Issue:** Public `ArtifactLinkRow` still exposes `created_at_epoch`; schema and graph-walk code now use `created_at_epoch_ms`, `valid_at_epoch_ms`, `invalid_at_epoch_ms`.
**Recommendation:** Update `ArtifactLinkRow` to reflect post-V43 column names.

### [QUALITY-CORE] V17 decision view reads `$.timestamp_epoch_ms` but existing JSON has `$.timestamp_epoch`
**File:** `src/core/migration/kind-mapping.ts:180`
**Issue:** V43 renames relational columns only — it does not backfill `artifact.data` JSON. Existing V17-backed decisions return null timestamps and sort incorrectly.
**Recommendation:** Add a JSON backfill in V43: `UPDATE artifact SET data = json_set(data, '$.timestamp_epoch_ms', json_extract(data, '$.timestamp_epoch') * 1000) WHERE kind = 'decision' AND json_extract(data, '$.timestamp_epoch') IS NOT NULL AND json_extract(data, '$.timestamp_epoch_ms') IS NULL`.
**Filter note:** Correct finding — V43 is a relational column rename; JSON sidecar fields need independent migration.

### [ACCEPTANCE-ANGEL] CHR drain silently swallows LLM classification failures
**File:** `src/angel/chr-async.ts:155`
**Issue:** `drainChrQueue` only increments `errors` if `classifyTurnAsDecisionBoundary` throws. That function catches all failures internally and returns a no-op result. Failed LLM calls are marked processed with `last_error = null` and counted as `no_boundary`. Error counter is permanently zero even at 100% failure rate.
**Recommendation:** Extend `WatcherResult` with an explicit failure flag, or let the watcher throw on classifier failure so `chr_pending_classifications.last_error` and `DrainChrResult.errors` reflect reality.

### [QUALITY-ANGEL] `generateRich` structured-output contract violated on Ollama fallback
**File:** `src/angel/generation-backend.ts:133`
**Issue:** When a JSON schema is supplied but the Ollama fallback fails to parse the response, `generateRich` silently returns raw text. Callers cannot rely on the typed return contract.
**Recommendation:** Throw on schema parse failure when a schema was requested, or make the failure explicit in the return type.

### [SECURITY-DOCS] Claude subprocess resolved from PATH — hijack risk
**File:** `src/angel/claude-subprocess.ts:51`, `src/angel/claude-subprocess.ts:264`
**Issue:** Subprocess executable resolves from `CLAUDE_CLI_PATH` or bare `claude` via PATH. A malicious binary earlier in PATH, or attacker-controlled `CLAUDE_CLI_PATH`, receives the full prompt on stdin with the complete environment.
**Recommendation:** Resolve `claude` to a trusted absolute path at install/config time. Spawn with a minimal allowlisted environment rather than `...process.env`.

### [QUALITY-CORE] V43 reverse migration guard cannot distinguish new vs renamed columns
**File:** `src/core/migration-steps.ts:4363`
**Issue:** Rollback only checks that `_ms` exists and the legacy name is absent — it cannot distinguish a freshly-created `_ms` column from a renamed one. Rollback may rename canonical `_ms` columns that predate V43.
**Recommendation:** Store a manifest of columns actually renamed by V43 (e.g., migration metadata table) and only reverse those specific columns.

### [DOCS-ACCEPTANCE] CLAUDE.md schema version claims V41, code targets V43
**File:** `CLAUDE.md:14`
**Issue:** Project contract says "V41 schema"; `src/core/migrations.ts` exports `TARGET_USER_VERSION = 43`. Future agents following CLAUDE.md for migration/debug decisions operate on wrong assumptions.
**Recommendation:** Update to V43, or phrase as "current `TARGET_USER_VERSION`" and keep synchronized with `migrations.ts`.

### [DOCS-ACCEPTANCE] Build entry-point guards do not match `.cjs` output extension
**File:** `build.ts:80`
**Issue:** Three newly bundled scripts (`migrate-lesson-trigger.ts`, `migrate-handoff.ts`, `migrate-lesson-frontmatter.ts`) guard for `.ts`/`.js` direct invocation, but the build emits `.cjs`. Auto-run guard never fires from `dist/`.
**Recommendation:** Add `.cjs` to each guard, or use `require.main === module`.

### [SECURITY-DOCS] `migrate-handoff` script — path traversal on `--file` argument
**File:** `src/scripts/migrate-handoff.ts:530`
**Issue:** `--file` argument is joined into the handoffs directory without constraining to that path. `../` segments or absolute paths can target files outside `context/handoffs`.
**Recommendation:** Resolve the target path and assert it remains under `path.resolve(projectDir, 'context', 'handoffs')`.

### [ACCEPTANCE-SURFACES] Crashed sessions not marked inactive in `sessions` table
**File:** `src/core/session-termination.ts:152`
**Issue:** `inferCrashedSessions` creates `session_termination` rows but never updates `sessions.status` or `ended_at_epoch_ms`. Queries on `status='active'` continue surfacing crashed sessions.
**Recommendation:** After inserting the termination record, update `sessions` to `status='crashed'`/`'ended'` and set `ended_at_epoch_ms`.

---

## Observations

| ID | File | Issue |
|----|------|-------|
| OBS-01 | `src/angel/chr-async.ts:182` | `sweepChrQueue` exported and tested but not called from `runRetentionSweep` — processed CHR rows accumulate indefinitely. Wire it in. |
| OBS-02 | `src/angel/heartbeat.ts:1597` | `nowEpoch` stores milliseconds after ms migration — rename to `nowEpochMs`. |
| OBS-03 | `src/angel/chr-async.ts:78` | `enqueueChrClassification` suppresses all errors with no telemetry — log reason before returning. |
| OBS-04 | `src/adapters/cc-hooks/subagent-stop.ts:16` | `durationMs` stores seconds and serializes as `duration_s` — rename to `durationS`. |
| OBS-05 | `src/adapters/cc-hooks/session-end.ts:107` | `recordSessionTermination` return value ignored in empty catch — log `false` results. |
| OBS-06 | `src/mcp/recall-server.ts:649` | `artifact_id` input accepts any non-empty string — enforce `/^[0-9a-f]{32}$/`. |
| OBS-07 | `src/mcp/recall-server.ts:1317` | `claudex_recent_sessions` limit unclamped — clamp to `max(1, min(limit, 100))`. |
| OBS-08 | `src/angel/heartbeat.ts:344` | Phase-2 retry keys on 8-char session prefix + LIKE query — use full session ID or explicit DB state. |
| OBS-09 | `src/adapters/cc-hooks/stop.ts:700` | `CLAUDEX_CHR_SYNC=1` documented but not implemented — add branch or remove documented contract. |
| OBS-10 | `context/measurements/2026-05-18-legacy-epoch-columns-audit.md:7` | Audit presents pre-V43 state as current — add timestamp/historical framing. |
| OBS-11 | `context/measurements/2026-05-18-angel-await-audit.md:112` | Heartbeat watchdog overstated as true execution bound — `Promise.race` skips scheduler, does not cancel inner awaits. |

---

## Grade Rationale

| Tier | Count |
|------|-------|
| Critical | 3 (4 raw, crash-inference pair collapsed to 1) |
| Recommended | 12 |
| Observations | 11 |

3 criticals → **Grade: D**

Primary risks: (1) production generation routing an Ollama model tag into Claude CLI or vice versa, breaking highlights/synthesis silently; (2) raw transcript PII/credentials forwarded to Anthropic's servers after the backend default changed from Ollama to Claude; (3) crash inference COALESCE + unit mismatch that will incorrectly terminate active sessions on first run of `inferCrashedSessions`.

Coverage gap is material — the grade is a lower bound given 7 of 16 review perspectives produced no findings.

---

*Generated 2026-05-18. Source files: chunk-angel-quality, chunk-angel-acceptance, chunk-core-quality, chunk-core-acceptance (rate-limited), chunk-core-security (rate-limited), chunk-docs-quality, chunk-docs-acceptance, chunk-docs-security, chunk-docs-general (empty), chunk-surfaces-quality, chunk-surfaces-acceptance, chunk-surfaces-security (rate-limited). Missing: chunk-angel-security, chunk-angel-general, chunk-core-general, chunk-surfaces-general.*
