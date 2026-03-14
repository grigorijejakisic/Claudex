---
schema: claudex/handoff
version: 1
id: v3-grade-a-push
session_id: session-8-2026-03-14
scope: project:claudex-v3
status: active
created_at: 2026-03-14T10:00:00Z
updated_at: 2026-03-14T17:00:00Z
---

# Handoff: Grade A Push — Refinement, Not Architecture

**Priority: HIGH**
**Goal: 84/100 → 95/100 (Grade A)**
**Approach: No new features. No architecture changes. Refine what exists.**

## Current State

Session 8 shipped the complete artifact-based assembly architecture + multi-model review infrastructure. 1158 tests, 68 files, build clean. Live DB schema fixed, hooks firing, zero errors. 45+ commits pushed.

**Current scores (Gemini re-review):**

| Dimension | Score | Target |
|-----------|-------|--------|
| Coherence | 65* | 90 |
| Patterns | 92 | 95 |
| Contracts | 82 | 90 |
| Dependencies | 93 | 95 |
| Dead Weight | 92 | 95 |

*Coherence scored before 3 fixes were applied (materialize moved, learning dedup, decision dedup removed). Should recover to 85-90 on re-review.

**Codex quality scores (averaged):**

| Dimension | Score | Target |
|-----------|-------|--------|
| naming_quality | 84.5 | 88 |
| error_consistency | 66.5 | 82 |
| abstraction_fitness | 75.2 | 82 |
| logic_clarity | 71.8 | 80 |
| ai_generated_debt | 59.5 | 78 |
| type_safety | 66.7 | 78 |
| contract_coherence | 65.1 | 82 |

---

## PHASE 1: AI-Generated Debt Cleanup (59.5 → 78)

**The single highest-impact improvement.** Every chunk scored poorly here. The code works but reads like unrefined AI output.

### 1.1 Strip patch-history comments

Search for and remove all inline fix-reference comments. These belong in git history, not source code.

```bash
# Find them all:
grep -rn "// R[0-9]\|// C[0-9]\|// Upgrade [0-9]\|// Fix [0-9]\|// CRIT-\|// REC-\|// ARCH-\|// DWT-\|// CTR-\|// DEP-\|// PAT-\|// CDX-\|// GEM-\|@see Security fix\|@see Upgrade" src/ --include="*.ts" | grep -v test
```

**Rules:**
- Delete comment lines that are pure fix references (`// R34: size limit` → delete)
- Keep comments that explain WHY (`// Escape sentinels to prevent boundary break` → keep)
- If a fix reference is the ONLY documentation for non-obvious logic, rewrite it as a proper explanation

**Estimated: ~100-150 lines to clean across 30+ files**

### 1.2 Consolidate repetitive try/catch boilerplate

The codebase has two catch patterns that repeat everywhere:

**Pattern A: Silent swallow (bad)**
```typescript
} catch {
  // Non-throwing
}
```

**Pattern B: Telemetry-aware (good)**
```typescript
} catch(e) {
  try { emitTelemetry(db, sessionId, 'error', { subsystem: '...', error: sanitizeErrorForTelemetry(e) }); } catch {}
}
```

**Action:** Create a shared helper in `src/shared/error-utils.ts`:
```typescript
export function nonThrowingWithTelemetry(
  fn: () => void,
  db: Database | null,
  sessionId: string,
  subsystem: string
): void {
  try { fn(); } catch(e) {
    if (db) {
      try { emitTelemetry(db, sessionId, 'error', { subsystem, error: sanitizeErrorForTelemetry(e) }); } catch {}
    }
  }
}
```

Then replace bare `try/catch` blocks with this helper where `db` is available. Where `db` isn't available (shared utilities), the bare catch is acceptable but should have a comment explaining why.

**Priority files** (most bare catches):
- `src/assembly/assembler.ts` (~8 bare catches)
- `src/adapters/shared/lifecycle.ts` (~10 bare catches)
- `src/checkpoint/loader.ts` (~6 bare catches)
- `src/checkpoint/writer.ts` (~5 bare catches)

### 1.3 Remove "architecture section" references

Comments like `@see Architecture Section 7.2` or `@see Architecture Section 3.1` reference an architecture document that isn't in the repo. They add noise without value for a developer reading the code.

```bash
grep -rn "@see Architecture\|Architecture Section" src/ --include="*.ts" | grep -v test
```

Replace with inline explanations where the reference was the only documentation, or delete if the code is self-evident.

---

## PHASE 2: Error Consistency (66.5 → 82)

**The second highest-impact improvement.** Every module is "non-throwing" but achieves it by hiding all failures.

### 2.1 Add telemetry to critical catch blocks

Not every catch needs telemetry — but these do:

| File | Function | Why |
|------|----------|-----|
| `assembler.ts` | Tier 1→2→3 fallthrough | Silent assembly degradation is invisible |
| `lifecycle.ts` | processToolAndPressure | Observation capture failures are invisible |
| `lifecycle.ts` | runCompactionSequence | Compaction failures are invisible |
| `checkpoint/writer.ts` | writeCheckpoint | Checkpoint write failures are invisible |
| `checkpoint/loader.ts` | loadCheckpoint | Recovery failures are invisible |
| `decision-capture.ts` | captureDecisions | Decision loss is invisible |

**For each:** Add `emitTelemetry(db, sessionId, 'error', { subsystem: '...', error: sanitizeErrorForTelemetry(e) })` in the catch block. The function stays non-throwing — it just becomes observable.

### 2.2 Standardize error handling in shared utilities

Files in `src/shared/` can't emit telemetry (no DB access). Their catch blocks should at minimum document WHY they swallow:

```typescript
} catch {
  // Non-throwing: caller handles missing config gracefully
  return DEFAULT_CONFIG;
}
```

Not just `} catch { }` with nothing.

---

## PHASE 3: Contract Coherence (65.1 → 82)

### 3.1 Config cleanup — wire 3, delete 7

Full audit completed. 32 config values total: 22 working, 3 need wiring, 7 are false promises.

**DELETE these 7 (from DEFAULT_CONFIG in constants.ts + ClaudexConfig type in config.ts + validation):**

| Config Value | Default | Why Delete |
|-------------|---------|------------|
| `observations.enabled` | true | Never checked — observations always captured unconditionally |
| `checkpoint.compression` | false | Parsed but never passed to writeCheckpoint — compression never happens |
| `learnings.surface_count` | 10 | Assembler uses artifacts now, not direct learnings. Legacy reference |
| `gsd.enabled` | true | Never checked — GSD state always read unconditionally |
| `features.fts5_search` | true | Refers to deleted legacy FTS5 formatters. Artifact search is unconditional |
| `observability.enabled` | true | Most modules ignore it — telemetry fires unconditionally |
| `adapter` | 'auto' | Adapters self-identify via their own constants. Config value is meaningless |

**WIRE these 3 (config exists but code ignores it):**

| Config Value | Default | Where to Wire | How |
|-------------|---------|---------------|-----|
| `enrichment.timeout_ms` | 10000 | `lifecycle.ts` → `enrichCheckpoint()` | Pass `config.enrichment.timeout_ms` as timeout param instead of hardcoded 10000 |
| `learnings.max_per_project` | 50 | `learnings-promoter.ts` | Replace hardcoded `MAX_LEARNINGS_PER_PROJECT = 50` with `config.learnings.max_per_project` |
| `embeddings.jaccard_shift_threshold` | 0.15 | `user-prompt-submit.ts` | Pass to `detectTopicShift` config (bridge already does, CC hooks don't) |

**KEEP these 22 (already working correctly):**
- `injection.*` (2): budget_tokens, topic_shift_budget
- `observations.*` (3): retention_days, prune_threshold, prune_count
- `checkpoint.*` (2): debounce_seconds, compaction_instructions
- `learnings.max_per_project` (1, after wiring)
- `enrichment.*` (4): enabled, provider, ollama_base_url, ollama_model
- `embeddings.*` (7): enabled, provider, model, ollama_base_url, topic_shift_threshold, topic_shift_window, decision_confidence_threshold
- `observability.*` (2): retention_days, retain_error_count
- `context.*` (4): advisory_threshold, warning_threshold, critical_threshold, checkpoint_cooldown_seconds

### 3.2 Fix upsertThreadState semantics

`upsertThreadState` uses `INSERT OR REPLACE` which silently clears omitted optional fields. Callers don't expect this.

**Fix:** Change to `INSERT ... ON CONFLICT DO UPDATE SET` with explicit field updates, only updating fields that are provided:
```sql
ON CONFLICT(session_id) DO UPDATE SET
  topic = COALESCE(excluded.topic, topic),
  summary = COALESCE(excluded.summary, summary),
  ...
```

### 3.3 Pass missing parameters to hooks

From Codex CDX-HK-003/004:
- Pass `jaccardShiftThreshold` from config to topic shift detector in user-prompt-submit.ts
- Verify `sessionId` is passed to assembly (already fixed in Grade A push)

### 3.4 Fix bridge backward-compat re-exports

From Gemini DWT-002 — these re-exports exist for "backward compatibility" but should be direct imports:
- `infrastructure.ts` re-exports `sanitizeErrorForTelemetry` (bridge imports from here)
- `writer.ts` re-exports `writeCompressedFile`
- `token-gauge.ts` re-exports `isPathSafe`
- `thread.ts` re-exports `CooldownState`

Update the consumers to import from the canonical location, then delete the re-exports.

---

## PHASE 4: Type Safety (66.7 → 78)

### 4.1 Replace `any[]` in assembler

`assembler.ts:361` uses `any[]` for `relevantLearnings` and `relevantHotFiles` in the topic pivot path. Import the proper types.

### 4.2 Add runtime validation for DB row casts

The codebase uses many `as SomeRow[]` casts from `db.prepare().all()`. Add a validation helper:
```typescript
function validateRow<T>(row: unknown, requiredFields: string[]): row is T {
  return typeof row === 'object' && row !== null && requiredFields.every(f => f in row);
}
```

Priority: `checkpoint-tracking.ts` (JSON.parse without guard), `checkpoint/loader.ts` (version validation too loose).

### 4.3 Strengthen ArtifactRow.artifact_type

Change from `string` to the `ArtifactType` union in the interface definition.

---

## EXECUTION STRATEGY

### Wave 1 (parallel, independent):
- **Worker A:** Phase 1.1 + 1.3 — Strip comments across all files (touches many files, no logic changes)
- **Worker B:** Phase 2.1 + 2.2 — Add telemetry to catch blocks + document shared catches
- **Worker C:** Phase 3.1 + 3.4 — Config cleanup + re-export cleanup
- **Worker D:** Phase 4.1 + 4.2 + 4.3 — Type safety fixes

### Wave 2 (after Wave 1):
- **Worker E:** Phase 1.2 — Create error-utils.ts and consolidate catch blocks (needs W-B's telemetry first)
- **Worker F:** Phase 3.2 + 3.3 — upsert fix + hook parameter passing

### Verification:
- Run `/architecture-review` (Gemini) after all fixes
- Run `/unified-review` (Codex) when credits available
- Target: 0 critical, ≤2 recommended = Grade A

---

## KEY FILES

| File | Purpose |
|------|---------|
| `src/assembly/assembler.ts` | Pure three-layer assembly (read-render only) |
| `src/assembly/sections.ts` | Formatters: reference, materialization, flow, gauge |
| `src/core/artifacts.ts` | Artifact CRUD + TTL lifecycle |
| `src/adapters/shared/lifecycle.ts` | Orchestrator: tool processing, compaction, session end |
| `src/adapters/cc-hooks/user-prompt-submit.ts` | Materialize + assemble per turn |
| `src/shared/config.ts` | Config loading + validation |
| `src/shared/constants.ts` | DEFAULT_CONFIG definition |

## REVIEW INFRASTRUCTURE

| Command | Tool | Focus |
|---------|------|-------|
| `/architecture-review` | Gemini CLI | 5 architectural perspectives (coherence, patterns, dead weight, contracts, dependencies) |
| `/unified-review` | Codex CLI | 7 code perspectives (quality, acceptance, security, general, reuse, efficiency, code-health) |
| `/full-review` | Both | Runs both in parallel, merges findings |
