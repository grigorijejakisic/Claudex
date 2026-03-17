---
schema: claudex/handoff
version: 1
id: v3-post-session-14
session_id: ec83b7f5-a425-4955-b85e-a2a4d9c64616
scope: project:claudex-v3
status: active
created_at: 2026-03-17T00:45:00Z
updated_at: 2026-03-17T00:45:00Z
---

# Handoff: Post-Session 14 — Review Fixes + Full Review Pending

**Priority: HIGH**
**Goal: Run /full-review, re-apply 5 lost worker edits, commit all changes**

## Current State

Session 14 deployed 3 PMs + 11 workers across 3 waves to fix all 46 review findings from unified + architecture review of Experience Patterns + Team Shared Memory features. 12 production files changed, 6 test files updated, 1 new file created. 79 files, 1477/1477 tests passing. BUT 5 files' worker edits didn't persist (Edit tool permission/concurrency issue with first parallel wave). Also built user-correction extraction as architectural fix for empty experience_patterns table.

## IMMEDIATE NEXT STEPS (in order)

### 1. Run /full-review on all changes
User explicitly requested this before committing. The diff is ~717 insertions, ~461 deletions across 17 files + 1 new. Large diff — use chunked multi-agent review.

### 2. Re-apply 5 lost worker edits
These files were NOT modified despite workers reporting success. Detailed specs below.

### 3. Commit everything
Single coherent commit covering all review fixes + user-correction extraction.

---

## LOST EDITS — Detailed Re-Application Specs

### File 1: `src/intelligence/behavioral-signals.ts`
**Findings: C1, R5, R18**

**C1 — Replace JSON.stringify fallback (line 44):**
Replace `JSON.stringify(toolInput).slice(0, 100)` with hash of sorted keys:
```typescript
const keys = Object.keys(toolInput).sort().join(',');
const inputHash = createHash('sha256').update(`${toolName}:${keys}`).digest('hex').slice(0, 12);
return `${toolName}:shape:${inputHash}`;
```

**R5 — Tighten SECRET_PATH_PATTERNS (line 13):**
Replace with segment-aware pattern: `/(?:^|[\/\\._-])(?:\.env|credentials|secrets?|tokens?|passwords?|private[_-]?keys?)(?:[\/\\._-]|$)/i`

**R18 — Add content-based secret scanning:**
Add `SECRET_CONTENT_PATTERNS` regex (Bearer, sk-, AKIA, PEM, ghp_, xox) and `hasSecretContent()`. Integrate into buildToolSignature's safeContent check.

### File 2: `src/intelligence/experience-patterns.ts`
**Findings: C6/C7, R17, O2, O6, O1, O5**

**C6/C7:** Add `AND pattern_type = 'discovery'` to `promoteToGlobalIfCrossProject` SQL. In `createPattern`, force non-discovery patterns away from `GLOBAL_PROJECT_SCOPE`.
**R17:** Broaden sanitizePatternText verb filter — add FETCH/WRITE/DELETE/CALL/INVOKE/DROP/DISABLE/ENABLE/MODIFY/REMOVE + mid-sentence imperatives.
**O2:** Fix misleading dedup comment about score threshold.
**O6:** Apply `redactContent()` to pattern fields before enrichment endpoint.
**O1:** Add `emitTelemetry` in catch blocks where `db` is available.
**O5:** Strip `(O26)` spec markers.

### File 3: `src/intelligence/experience-flags.ts`
**Findings: R1, R2, O1**

**R1:** Wrap `readRoleExchange` body in try/catch returning `defaults`.
**R2:** Sanitize `file_edit_counts` with `Number(v)` + `isFinite()` per entry.
**O1:** Add telemetry in `setExperienceFlags` and `setBehavioralCounters` catch blocks.

### File 4: `src/adapters/cc-hooks/user-prompt-submit.ts`
**Finding: R6**

Add `setExperienceFlags(ctx.db, input.session_id, { correction_flagged: false, correction_prompt: '' })` at START of experience detection section, before correction detection runs.

### File 5: `src/assembly/sections.ts`
**Finding: C2**

Replace incomplete `escapeXml` (only handles `</`) with full XML escape: `&` → `&amp;` FIRST, then `<`, `>`, `"`, `'`.

---

## CHANGES THAT DID LAND (verified on disk)

| File | Fixes |
|------|-------|
| `assembler.ts` | C3 budget/side-effects split with applyEffects |
| `worker-context.ts` | A6 async, A9 fileScope, O3 heading, O4 cap, O9 CWD |
| `worker-observations.ts` | C5 dedup, C8 artifact promotion, R3 hash, R15, O7 |
| `artifact-claims.ts` | R4 TTL, O10, A5 JSDoc, schema alignment, O1 |
| `file-leases.ts` | R4 TTL, R16 expired filter, O1 |
| `migrations.ts` | C4 PK, C9 trigger, A1 type, A2 index, A3 FTS, A4 stemmer |
| `stop.ts` | R12 extracted to experience-scoring.ts |
| `post-tool-use.ts` | R9 NotebookEdit, O5 |
| `experience-scoring.ts` | NEW: scoring + user-correction primary |
| `correction-detection.ts` | extractLessonFromUserCorrection() PRIMARY path |
| `cli/worker-context.ts` | async cascade |
| 6 test files | async, fixtures, imports, DB handles, e2e, timers |

## Architectural Fix: User-Correction Extraction

experience_patterns table was EMPTY. Root cause: extraction relied on assistant self-reflective phrases that never occur. Built `extractLessonFromUserCorrection()` — extracts from user text ("always X", "never Y"). Wired as primary in experience-scoring.ts. No dedicated tests yet.

## Build & Test
- Build: clean (30ms)
- Tests: 79 files, 1477/1477 passing
- DO NOT commit until /full-review complete + lost edits re-applied

## Key Context
- Agent workers' Edit operations can silently fail — ALWAYS verify file contents post-completion
- OAuth is ALWAYS the auth method. Never API keys, never ask.
- Server: `ssh -p 3377 -i ~/.ssh/openclaw_server openclaw@srv.teneral.xyz`
- Echo OAuth fixed this session (switched profile from "token" to "oauth")
