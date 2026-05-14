# Phase 13: Organic Claudex — Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Six marks that eliminate the ritual gap — every place where the operator currently has to manually trigger memory work because the autonomous channels are failing. Root cause confirmed 2026-05-14: session `afcf6a10` died on PC crash and has zero rows in `transcript_chunk_v6` ~24 hours later; idle-sweep did not recover it.

Phase 13 thesis: the markdown text of every session, written per-turn to disk in `Sessions/`, is the source of truth. Everything else (vectors, FTS, embeddings, highlights, curated context) is a derived index over that text.

Plans: 13-01 through 13-06 across three waves + 13-CLOSE.

Wave 1 (substrate): Plans 13-01, 13-02
Wave 2 (frame + orientation): Plans 13-03, 13-04 — depend on W1
Wave 3 (organic pull + cleanup): Plans 13-05, 13-06 — depend on W2

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Sessions/ as Source of Truth (13-01)

**Already operator-locked in conversation log (pre-discuss):**
- Sessions/ folder lives at **project root** (e.g., `<project>/Sessions/`), gitignored by default, operator opt-in to commit.
- Per-turn, append-only, fsync after each write — both user turns and assistant turns.
- Markdown format: human-readable, format-stable across CC version changes, zero dependency on Claudex DB for durability.
- `<system-reminder>`, `<experience-data>`, and similar wrappers preserved in raw text at write-time; redaction moves to extraction-time when chunks are created for retrieval.
- File naming: `<ISO-date>_<session-id>.md` default.
- Planner owns: exact hook events (PostToolUse + UserPromptSubmit + Stop are the spec's candidates), timestamp format, section header conventions. These are implementation-level choices within the locked constraints.

---

### Area 2 — DB-as-Derived-Index (13-02)

**Watch mechanism (operator-locked):**
Angel heartbeat tick — heartbeat-scan stat()'s `Sessions/` file mtimes; files modified since last tick get re-indexed via the existing Phase 8 chunk + embed + upsert pipeline. Chokidar explicitly rejected (Windows-fragility + dependency-graph surface). Generic polling explicitly rejected (redundant with Angel's existing heartbeat).

**Latency target (operator-locked):**
Cross-session latency target: ≤2 minutes (Angel's typical heartbeat cycle). Same-session retrieval of just-written turns is explicitly OUT OF SCOPE — agents use CC's in-conversation transcript for that, not hybrid retrieval.

**Recovery = normal path (operator-locked):**
DB-wipe-then-rebuild and steady-state-indexing run the same heartbeat-scan loop. Chokidar would create two code paths (event-driven + batch-scan); heartbeat-tick gives one path for both. This is the core "recovery becomes a special case of normal operation" thesis.

**Optional cheap optimization (planner discretion):**
Heartbeat-scan can stat() mtime and skip files unchanged since last tick. No new dep, no Windows issues. Planner may include if it falls naturally out of the scan implementation.

**Anti-scope for 13-02 PLAN (operator-locked):**
Must include explicit anti-scope statement: "This plan indexes Sessions/ for cross-session retrieval. Same-session retrieval of just-written turns is intentionally out of scope and relies on CC's in-conversation transcript."

**WIR-01 coverage (inherited from methodology gates):**
Re-indexer must work against V32 and any V17-collapsed remnants. Plan 13-02 declares WIR-01 coverage explicitly.

---

### Area 3 — Highlights Extraction (13-03)

**Frame extraction LLM (operator-locked):**
Claude Opus 4.7 (OAuth, `~/.claude/.credentials.json`) as primary. Angel-configured local LLM (`angel.default_model` in `~/.claudex/config.json`) as fallback — reuses Angel's existing LLM call surface, no new model path introduced.

What counts as "unavailable": ANY of: network timeout, non-2xx response, OAuth auth failure, response-parse failure on expected schema. All four trigger fallback path.

**Degraded flag is REQUIRED (operator-locked):**
Every artifact produced via fallback writes:
- `degraded: true` in artifact
- `degraded_reason: 'opus_<timeout|non_2xx|auth_failed|parse_failed>'`
- `degraded_model: '<fallback model name>'`
- Telemetry event `frame_extraction_fallback` (matches Phase 12 item 5 telemetry shape)

Retry-on-degradation: Angel's next heartbeat tick re-attempts frame extraction with Opus on `degraded: true` artifacts. If Opus succeeds, higher-quality artifact REPLACES the degraded one (same artifact ID, `degraded: false`, `re_extracted_at_epoch_ms` field added). Degraded artifacts are never silently kept — they get upgraded or flagged.

Operator-visible health: if degradation persists >1 heartbeat cycle, next session-start surfaces a `## Frame Extraction Degraded` health line (mirrors existing Reranker Health line per CLAUDE.md).

**Frame artifact schema (operator-locked) — NEW `session_highlights` table via V33 migration:**
Distinct from `project_curated_context` (per-session vs. project-scoped; structured fields vs. blob; 1:1 session FK). NOT stored in `project_curated_context`, NOT in the artifact table.

Schema (planner refines column types and constraints):
- `session_id TEXT NOT NULL` (FK to sessions table)
- `project TEXT NOT NULL`
- `mental_model TEXT` — the project-state theory as of session-end
- `open_questions TEXT` — JSON array of unresolved-question entries with context
- `reframes TEXT` — JSON array of `{old_theory, new_theory, why}`
- `tools_introduced TEXT` — JSON array of `{path, purpose}`
- `decisions_not_made TEXT` — JSON array of `{gray_area, why_deferred}`
- `posture_context TEXT` — emotional/working-style notes if visible from transcript
- `degraded BOOLEAN DEFAULT 0`
- `degraded_reason TEXT NULL`
- `degraded_model TEXT NULL`
- `created_at_epoch_ms INTEGER NOT NULL`
- `re_extracted_at_epoch_ms INTEGER NULL`
- `UNIQUE(session_id, project)` constraint
- Index on `(project, created_at_epoch_ms DESC)` for session-start "latest N highlights" query

V33 migration: idempotent, shape-agnostic per v5.0.1 lesson (handles V17-collapsed + base-table fresh-DB). WIR-01 fixture coverage required for both shapes.

Reader/writer module: `src/intelligence/session-highlights.ts` exporting `upsertHighlights(row)`, `getLatestHighlights(project, limit)`, `getHighlightsBySessionId(session_id, project)`.

"Highlights feed into curated context" is conceptual at the human level (operator sees highlights accumulate and writes curated-context entries). There is NO automated table-to-table flow. Two distinct tables, two distinct read paths.

---

### Area 4 — Auto-Orient at Session-Start (13-04)

**Already operator-locked in conversation log (pre-discuss):**
- Phase 13 item 4 includes temporal awareness fold-in: per-turn timestamp + timezone injection.
- Timestamp format: ISO 8601 with timezone offset (e.g., `2026-05-14T00:55:14+02:00`).
- Injection frequency: SessionStart hook + every UserPromptSubmit (so long sessions stay timestamp-fresh).
- Timezone resolution: operator profile OR `process.env.TZ` OR system tz fallback.
- Static `currentDate` memory line stays as long-lived per-day reference; per-turn injection adds precision it can't have.
- Assembly extends existing `## Session Continuity` / `## Project Curated Context` blocks; no new section unless natural.
- Graceful degradation when `Sessions/` is empty (first session in project — fall back to scaffold).
- Token budget for highlights injection: capped at fraction of L1 budget (planner owns exact fraction).
- Planner owns: how many prior sessions' highlights surface (latest + N most recent for project), cross-session frame-delta injection format.

---

### Area 5 — Pull-Trigger Normalization (13-05)

**Cue surfaces — total system post-Phase-13: 6 types (operator-locked):**

Phase 12 item 8 surfaces (unchanged): `handoff_read`, `decision_lock`, `wait_for_direction`.

Phase 13 item 5 new surfaces:

**(a) `script_encounter`** — INCLUDE
Trigger: PreToolUse on `Read` where ALL hold:
- `file_path` matches `**/scripts/**`, `**/src/cli/**`, `**/src/skills/**`, `**/bin/**`, OR ends in `.{ts,js,mjs,cjs,py,sh,ps1}` AND is under `**/src/**`
- AND `claudex_events` shows ≥3 prior-session reads/edits on that path for this project
- AND file hasn't already been read in current session

Cue payload: "This {script,skill,module} has prior-session history — N prior reads/edits across M sessions. Recent context: [top-1 claudex_recall for the path]."

**(b) `error_investigation`** — INCLUDE
Trigger: PreToolUse on `Bash` matching ANY (case-insensitive):
- `\b(cat|tail|less|head)\s+[^|]*\.log\b`
- `\b(grep|rg)\s.*\b(error|stack|trace|exception|failed)\b`
- `\bnpm\s+test|bun\s+test|vitest|pytest\b.*\b(--reporter|-v|--verbose)\b`
- `\bjournalctl\b` or `\bdocker\s+logs\b`

Cue payload: "Similar error/log patterns explored in prior sessions: [top-2 claudex_search results for matched keywords]."

**(c) Ambiguous user instruction — EXCLUDED (not deferred)**
High false-positive risk on legitimate clarifying questions. If `retrieved_but_unapplied` telemetry post-Phase-13 shows material volume correlated with clarifying-question turns, revisit in v6.x with calibration data. Must be documented in 13-05 PLAN anti-scope section.

**(d) `package_install`** — INCLUDE
Trigger: PreToolUse on `Bash` matching ANY:
- `^(npm|pnpm|yarn)\s+(install|add|i)\s+`
- `^bun\s+(install|add)\s+`
- `^pip\s+install\s+` / `^uv\s+(pip\s+)?install\s+`
- `^cargo\s+add\s+`
- `^go\s+get\s+`

Cue payload: "Package `{name}` history in this project: [evaluation/usage notes from claudex_search]. If prior sessions rejected this dependency, the reason."

**Opt-out structure (operator-locked) — per-type flags matching Phase 12 item 8 pattern:**
- `v6.cues.enabled` — master switch (all 6 types)
- Phase 12 item 8 keys (unchanged): `v6.cues.handoff_read.enabled`, `v6.cues.decision_lock.enabled`, `v6.cues.wait_for_direction.enabled`
- Phase 13 item 5 new keys: `v6.cues.script_encounter.enabled`, `v6.cues.error_investigation.enabled`, `v6.cues.package_install.enabled`

Single collective flag for item 5 surfaces rejected: granular control is essential for per-pattern noise tuning (Big Mozzy V2 showed retrieval-fidelity issues are one-pattern-at-a-time).

**Highlights-coverage check mechanism (operator-locked) — option (c): bespoke per-surface structured-field lookup:**
No embedding-similarity calls in hooks (latency budget reserved for reranker fallback only per CLAUDE.md). Per-surface check against `session_highlights` schema fields:

| Cue type | Suppress if TRUE |
|---|---|
| `handoff_read` | Handoff path/topic matches `open_questions[].context` OR `mental_model` contains handoff filename stem |
| `decision_lock` | Config file path in `tools_introduced[].path` OR diff content matches `decisions_not_made[]` substring |
| `wait_for_direction` | `open_questions[]` is empty (never suppress otherwise — waiting-for-direction = under-oriented by definition) |
| `script_encounter` | File path matches any `tools_introduced[].path` |
| `error_investigation` | Error/log keyword matches any `open_questions[].context` (case-insensitive substring) |
| `package_install` | Package name in any `tools_introduced[].path` token OR `decisions_not_made[]` |

Algorithm shape:
```typescript
function shouldFireCue(cueType: CueType, triggerContext: TriggerContext, project: string): boolean {
  const latestHighlights = getLatestHighlights(project, /*limit=*/ 3);
  if (latestHighlights.length === 0) return true; // no highlights = always fire
  const coverageCheckFn = COVERAGE_CHECKS[cueType];
  const isCovered = latestHighlights.some(h => coverageCheckFn(h, triggerContext));
  return !isCovered;
}
```

Each `coverageCheckFn` is ~10–30 lines, unit-testable with synthetic fixtures.

**Telemetry (operator-locked):**
When cue fires AND agent's response references both cue content AND highlights content, emit `cue_overfired_with_coverage` event. Builds v6.x calibration data; current phase does not act on it. False-negative tolerance is high — cues are advisory; under-suppression = operator-tolerable noise.

Semantic-upgrade path: if telemetry post-Phase-13 shows material underfiring in specific cue types, v6.x can introduce embedding-similarity check for those types only. Gated on measured signal.

---

### Area 6 — Skill Obsolescence (13-06)

**Already operator-locked in conversation log (pre-discuss):**
- "ship them properly" + git commit at end.
- No autonomous push; no autonomous v6.0.0 retag (operator does this on wake).
- v6.0.0 retag = telemetry-based annotation at Phase 13 close-out, NOT W3-verdict-based.
- One-week deprecation window: skills warn but still function. No context-loss incidents before deletion.
- Deletion: `rm -r .claude/skills/starthere/ .claude/skills/endsession/` with CHANGELOG entry.
- Rollback contract: if Vesna handoff-pickup gate fails, items 1-5 reopen; skills do NOT return.
- Planner owns: exact warning format injected by deprecated skills during the one-week window.

---

### Claude's Discretion

No areas deferred to Claude's discretion — all BLOCK-class gray areas received explicit operator-locked answers.

Items left to planner:
- Exact hook events for per-turn Sessions/ write (PostToolUse + UserPromptSubmit + Stop are spec candidates — planner confirms)
- Exact markdown section format and timestamp conventions within locked constraints
- Token budget fraction for highlights injection at session-start
- Number of prior sessions surfaced in auto-orient assembly (latest + N; planner picks N)
- V33 column types and constraints (schema shape locked; planner refines)
- Deprecation-warning text format for 13-06 one-week window
- mtime-skip optimization inclusion in 13-02 (planner discretion)

</decisions>

<specifics>
## Specific Ideas

- The crash exercise (2026-05-14, session `afcf6a10`) is the empirical basis for items 1 and 2. Zero rows in `transcript_chunk_v6` 24 hours after PC-crash session death confirms idle-sweep failure on this corpus. The fix is not a tighter sweep — it's making the recovery path identical to the normal path.
- `session_highlights` degraded-flag discipline mirrors the reranker-fallback pattern in CLAUDE.md (`reranker_fallback` telemetry). Frame extraction is load-bearing for item 4 orientation; degradation must be visible, never silent.
- The 6-cue total (3 from Phase 12 item 8 + 3 new) is operator-confirmed. Ambiguous-user-instruction candidate explicitly excluded (not deferred) pending telemetry.
- Persona-tuning of behavioral rules is OUT of Phase 13 scope — manual track, post-Phase-13, operator + Claude direct iteration. Documented at `~/.claude/projects/<project>/memory/feedback_persona_tuning_manual_track.md`.
- W3 empirical re-bind DEPRECATED 2026-05-14. v6.0.0 retag is telemetry-based annotation at Phase 13 close-out (operator on wake; not autonomous).

</specifics>

<deferred>
## Deferred Ideas

All items below are explicitly out of Phase 13 scope per the spec and confirmed by operator:

- Cross-domain control on the claudex-v3-is-strongest hypothesis (v7 or beyond; diagnostic requires a parallel run on claudex-v3 sessions).
- Pairwise Elo / actual-user-task-success replacing Vesna's binary rubric (deferred from Phase 12, still deferred).
- Telemetry verdict structure (Phase 12 ships signal collection; verdict design happens with data in hand; v6.x).
- Mid-flight uncertainty-flag without correction (the agent-2 fabricated-30000 pattern; Phase 12 items 2/3 partially address; Phase 13 does not solve mid-session invention case).
- Cross-AGENT validation on Claude as production agent (v7 per `project_v6_polish_residual_concerns.md`).
- Replacing CC's JSONL with Sessions/ markdown for CC's own consumption (CC keeps its JSONL; Sessions/ is for Claudex).
- Semantic-upgrade for highlights-coverage check (v6.x, gated on telemetry showing material underfiring).
- Ambiguous-user-instruction cue surface (v6.x, gated on `retrieved_but_unapplied` telemetry data).

</deferred>

## Operator-Locked Answers (BLOCK-class)

- **Q [13-02/Q1]:** Item 2 watch mechanism — which of heartbeat-tick / chokidar / polling?
  - Answer: Angel heartbeat tick. Heartbeat-scan stat()'s Sessions/ file mtimes; files modified since last tick get re-indexed via existing Phase 8 chunk + embed + upsert pipeline. Chokidar rejected (Windows-fragility + dep graph). Polling rejected (redundant with heartbeat). Cross-session latency target: ≤2 minutes. Same-session retrieval of just-written turns explicitly out of scope (use CC's in-conversation transcript). Recovery = normal path (same loop for steady-state and DB-wipe-rebuild).
  - Timestamp: 2026-05-14

- **Q [13-03/Q1]:** Frame extraction LLM — primary, fallback, degraded-flag requirement?
  - Answer: Claude Opus 4.7 (OAuth) primary; Angel-configured local LLM (`angel.default_model`) fallback. `degraded: true` flag REQUIRED on fallback artifacts. Degraded-reason taxonomy: `opus_timeout` / `opus_non_2xx` / `opus_auth_failed` / `opus_parse_failed`. Telemetry event `frame_extraction_fallback` on fallback path. Retry-on-degradation via heartbeat: degraded artifacts re-extracted with Opus when available; higher-quality artifact replaces degraded version. Operator-visible health line if degradation persists >1 heartbeat cycle.
  - Timestamp: 2026-05-14

- **Q [13-03/Q2]:** Frame artifact schema — new `session_highlights` table vs. extension to `project_curated_context`?
  - Answer: New `session_highlights` table via V33 migration. Distinct from `project_curated_context` (per-session vs. project-scoped; structured fields vs. blob). Schema documented in decisions section. V33 migration idempotent + shape-agnostic (v5.0.1 lesson). WIR-01 fixture coverage required. Reader/writer module at `src/intelligence/session-highlights.ts`. No automated table-to-table flow with `project_curated_context`.
  - Timestamp: 2026-05-14

- **Q [13-05/Q1]:** Item 5 cue surfaces beyond Phase 12 item 8's three — which candidates, and opt-out structure?
  - Answer: Three new surfaces: `script_encounter` (tightened path+history trigger), `error_investigation` (bounded log/grep/test-debug patterns), `package_install` (dependency-add commands). Total system: 6 cue types. Ambiguous-user-instruction (candidate c) explicitly EXCLUDED for false-positive cost; revisit in v6.x with telemetry. Per-type opt-out flags matching item 8 pattern: `v6.cues.{script_encounter,error_investigation,package_install}.enabled`. Master switch `v6.cues.enabled` covers all 6. Single collective flag rejected (granular control essential).
  - Timestamp: 2026-05-14

- **Q [13-05/Q2]:** Highlights-coverage check mechanism — embedding similarity / lexical overlap / bespoke per-surface?
  - Answer: Bespoke per-surface structured-field lookup against `session_highlights` schema. No embedding calls in hooks (latency budget reserved for reranker fallback only). Six per-cue check functions (documented in decisions section). Telemetry `cue_overfired_with_coverage` captures calibration data for v6.x; Phase 13 does not act on it. Semantic-upgrade deferred to v6.x, gated on measured underfiring.
  - Timestamp: 2026-05-14

---

*Phase: 13-organic-claudex*
*Context gathered: 2026-05-14*
