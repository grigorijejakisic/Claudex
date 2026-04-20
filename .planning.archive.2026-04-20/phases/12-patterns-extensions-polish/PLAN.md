# Phase 12: Patterns, Extensions, Polish — PLAN

**Status:** Implementing
**Items:** 3 implement + 2 doc/stub = 5 actionable (7 already done)

---

## Wave 1 — Parallel Implementation (no dependencies)

### P2: Cursor-based incremental extraction (~40 lines)
**Files:** `src/core/migration-steps.ts`, `src/angel/pattern-extractor.ts`

1. Add `migrateV13toV14()` in migration-steps.ts: `ALTER TABLE sessions ADD COLUMN extraction_cursor INTEGER`
2. Wire into `runMigrations()` in migrations.ts (bump TARGET_VERSION to 14, add migration entry)
3. Modify `getSessionTurns()` to accept optional `afterTurn` parameter
4. In `extractPatternsFromSession()`: read cursor before fetching turns, pass to `getSessionTurns()`, update cursor after successful extraction
5. Include 2-turn overlap for LLM context continuity
6. Skip extraction when 0 new turns since cursor

**Verification:** Unit test — cursor tracks last turn, incremental fetch returns only new turns

### P3: Manifest injection for Angel LLM (~50 lines)
**File:** `src/angel/pattern-extractor.ts`

1. Add `buildExtractionManifest()` function: queries recent patterns (top 10 by score for project), active CARA opinions (top 5 by confidence), session metadata
2. Inject as `--- EXISTING CONTEXT ---` section before transcript in the LLM prompt
3. Add dedup instruction to EXTRACTION_SYSTEM_PROMPT
4. Cap manifest at 1000 chars

**Verification:** Unit test — manifest includes existing patterns, prompt contains manifest section

### H12: TeammateIdle hook (~30 lines)
**Files:** New `src/adapters/cc-hooks/teammate-idle.ts`, `build.ts`, `src/cli/setup.ts`

1. Create hook following task-created.ts pattern (wrapHook, recordEvent)
2. Extract `teammate_name`, `session_id` from payload
3. Record `teammate_idle` event
4. Add to build.ts optional entries + smoke test payloads
5. Add to setup.ts HOOK_FILES

**Verification:** Build succeeds, smoke test passes

## Wave 2 — Doc/Stub

### E1: Plugin manifest stub
Create `plugin.json` at project root with minimal structure per CONTEXT.md spec.

### E2: Channel MCP defer doc
Documented here: Channel MCP server (E2) is deferred until CC's channel API stabilizes. Current cross-session messaging works via `session_messages` table + hook injection in UserPromptSubmit — functional and sufficient. When CC's channel API reaches stable, Claudex can expose a dedicated MCP server for real-time cross-session channels. No code needed now.

---

## Already Done (no action)
P1, P4, P5, P6, E3, K2, K3, H11
