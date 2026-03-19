# Session 14 — Lost Worker Edits (Detailed Specs)

5 files were NOT modified despite workers reporting success. Re-apply these manually.

## File 1: `src/intelligence/behavioral-signals.ts`
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

## File 2: `src/intelligence/experience-patterns.ts`
**Findings: C6/C7, R17, O2, O6, O1, O5**

**C6/C7:** Add `AND pattern_type = 'discovery'` to `promoteToGlobalIfCrossProject` SQL. In `createPattern`, force non-discovery patterns away from `GLOBAL_PROJECT_SCOPE`.
**R17:** Broaden sanitizePatternText verb filter — add FETCH/WRITE/DELETE/CALL/INVOKE/DROP/DISABLE/ENABLE/MODIFY/REMOVE + mid-sentence imperatives.
**O2:** Fix misleading dedup comment about score threshold.
**O6:** Apply `redactContent()` to pattern fields before enrichment endpoint.
**O1:** Add `emitTelemetry` in catch blocks where `db` is available.
**O5:** Strip `(O26)` spec markers.

## File 3: `src/intelligence/experience-flags.ts`
**Findings: R1, R2, O1**

**R1:** Wrap `readRoleExchange` body in try/catch returning `defaults`.
**R2:** Sanitize `file_edit_counts` with `Number(v)` + `isFinite()` per entry.
**O1:** Add telemetry in `setExperienceFlags` and `setBehavioralCounters` catch blocks.

## File 4: `src/adapters/cc-hooks/user-prompt-submit.ts`
**Finding: R6**

Add `setExperienceFlags(ctx.db, input.session_id, { correction_flagged: false, correction_prompt: '' })` at START of experience detection section, before correction detection runs.

## File 5: `src/assembly/sections.ts`
**Finding: C2**

Replace incomplete `escapeXml` (only handles `</`) with full XML escape: `&` → `&amp;` FIRST, then `<`, `>`, `"`, `'`.
