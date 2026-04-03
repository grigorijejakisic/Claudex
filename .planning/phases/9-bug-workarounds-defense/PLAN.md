# Phase 9: Bug Workarounds & Defense — Implementation Plan

**Status:** Ready to implement
**Files to modify:** 6 (5 code, 1 doc)

---

## Wave 1 — Independent implementations (parallel)

### K4: `cch=` Billing Sentinel Guard
**File:** `src/adapters/cc-hooks/infrastructure.ts`
**Location:** `writeStdout()` function

- Before `JSON.stringify`, sanitize the output string
- Regex: `/cch=[a-f0-9]{3,}/gi` → replace `=` with `_`
- This is the single chokepoint — all hook output flows through `writeStdout()`
- Cache safety measure: CC's standalone binary does global string substitution of `cch=XXXXX` patterns, permanently breaking prompt cache

**Verification:** Unit test with payload containing `cch=abc123` confirms output has `cch_abc123`.

### B2: Resume Cost Awareness
**File:** `src/adapters/cc-hooks/session-start.ts`
**Location:** After session creation, before checkpoint recovery

- Check `input.type === 'resume'`
- Record `session_resume_cost` event via `recordEvent()`
- Include CC version in metadata (from `input.version`)
- Log-only — no user-facing output, no assembly injection
- Rationale: Resume sessions re-read the full conversation, consuming disproportionate tokens (regression since CC v2.1.69)

**Verification:** Session event recorded when type is 'resume', not recorded for 'startup'.

### B4: Duplicate Compaction Agent Detection
**File:** `src/adapters/cc-hooks/stop.ts`
**Location:** New `runHookStep` after existing checkpoint check

- Read `input.usage` for token counts: `cache_creation_input_tokens`, `input_tokens`
- Heuristic: if `cache_creation_input_tokens` > 200,000 in a single stop event, likely duplicate compaction agent
- Record `duplicate_compaction_detected` event with token counts in metadata
- Log-only — no user-facing output

**Verification:** Event recorded when cache_creation exceeds threshold, not recorded for normal turns.

### C3: KAIROS Mode Detection
**File:** `src/adapters/cc-hooks/session-start.ts`
**Location:** After existing `cc_environment` detection block

- Existing code already detects `ccKairosActive` — reuse that variable
- Add dedicated `kairos_detected` event when `ccKairosActive` is true
- Inject one line into `fullContent`: `"KAIROS mode active -- Angel consolidation may conflict"`
- Conditional — only when KAIROS is actually detected

**Verification:** Event recorded and warning injected only when KAIROS log dir exists.

### B5: Edit Integrity Tracking
**Files:** `src/adapters/cc-hooks/post-tool-use.ts` + `src/adapters/cc-hooks/post-compact.ts`

**post-tool-use.ts:**
- After existing session events section, check if Edit/Write tool touched a Claudex-relevant path
- Tracked paths: `src/`, `CLAUDE.md`, `.claude/rules/`, `context/`
- Record `claudex_file_edit` event with file path and tool name
- Uses relative path matching against cwd

**post-compact.ts:**
- After recording compaction event, query recent `claudex_file_edit` events
- For each tracked edit, check if file still has expected mtime (simple freshness check)
- If any file mtime is older than the edit event timestamp → potential revert
- Record `edit_integrity_warning` event with details
- Log-only — silent logging is sufficient; next session catches reverts via git status

**Verification:** Edit events recorded for src/ files, not for unrelated paths. Warning fires when mtime discrepancy detected.

---

## Wave 2 — Document-only items

### B8: Plugin Permissions Note
**File:** `.claude/rules/hooks-safety.md`
- Add section: "On Linux/macOS, hook scripts installed by plugins may lose execute permissions. Run `chmod +x` after plugin install."

### C5: VERIFICATION_AGENT Readiness
**Status:** Document-only — no code changes needed.
- `solution_outcomes` table already exists in V12 schema
- Infrastructure is ready to receive structured PASS/FAIL/PARTIAL verdicts
- When CC ships VERIFICATION_AGENT hook, wire its output into `solution_outcomes` via PostToolUse or a dedicated hook
- Wiring plan: PostToolUse checks for `tool_name === 'VerificationAgent'` → parse structured verdict → INSERT into `solution_outcomes` with session_id, pattern_id (from context), outcome enum, detail text

---

## Wave 3 — Build, test, commit

1. `bun run build` — esbuild, verify clean compilation
2. `bun run test` — vitest, verify no regressions
3. Atomic commit with all changes
