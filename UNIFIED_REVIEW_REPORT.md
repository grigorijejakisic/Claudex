# Unified Code Review Report

**Scope:** Uncommitted changes — phases 3-11 + A+ team improvements + audit fixes (~16K lines, 100+ files)
**Date:** 2026-03-13 01:30 UTC
**Grade:** D
**Perspectives:** Quality [OK], Acceptance [OK], Security [OK], General [OK], Reuse [72/91], Efficiency [72/91], Code-Health [72/91]
**Additional source:** Data Flow Mismatch Audit (PM + 5 workers, independent investigation)

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| A | No critical, <=2 recommended |
| B | No critical, 3-5 recommended |
| C | No critical, 6+ recommended OR 1 critical |
| D | 2-3 critical |
| F | 4+ critical |

**Note:** Grade D reflects 3 true critical findings in production-hot paths. Many "critical" labels from individual perspectives were downgraded after dedup and impact analysis — several affect recovery/edge paths only, and several are security hardening for adversarial inputs unlikely in personal-use deployment. Those are tracked as Recommended-Security.

---

## Critical

### [QUALITY][ACCEPTANCE][AUDIT] Pressure stores raw paths while observations stores sanitized paths
**File:** src/adapters/shared/lifecycle.ts:122
**Issue:** `processToolAndPressure()` feeds raw file paths (with full username) to `updatePressureScore()`, while `extractor.ts:86` sanitizes via `sanitizePath()`. Cross-table joins silently fail. Hot file paths leak username into checkpoint YAML and assembly.
**Recommendation:** Apply `sanitizePath(filePath, params.cwd)` before `updatePressureScore()`.

### [ACCEPTANCE][GENERAL][AUDIT] Re-mirroring writes plain YAML even when mirror_path is .yaml.gz
**File:** src/checkpoint/loader.ts:62, :282
**Issue:** `recoverFromDb` writes plain YAML regardless of extension. `.yaml.gz` files become invalid, breaking compressed checkpoint recovery.
**Recommendation:** Check extension and compress when `.yaml.gz`.

### [QUALITY][GENERAL][REUSE] Token utilization formula mismatch between adapters
**File:** src/gauge/token-gauge.ts:77 vs src/adapters/openclaw-bridge/bridge-adapter.ts:77
**Issue:** CC hooks: `input / context`. Bridge: `(input + output) / context` clamped. Same workload triggers different checkpoint behavior.
**Recommendation:** Extract shared `computeUtilization()` with consistent formula.

---

## Recommended

### [SECURITY] latest.yaml ref path traversal
**File:** src/checkpoint/loader.ts:108, :177
**Issue:** `ref` and hop-chain values joined into paths without traversal checks. `..` sequences accepted.
**Recommendation:** Canonicalize, enforce prefix check, reject `..` and absolute paths.

### [SECURITY] Gzip bomb via gunzipSync with no size limits
**File:** src/checkpoint/loader.ts
**Issue:** `.yaml.gz` decompressed with no size cap.
**Recommendation:** Stream decompress with size limit or check file size heuristic.

### [SECURITY][GENERAL] resetAvailability() undoes external-URL safety block
**File:** src/embeddings/embedding-provider.ts:189
**Issue:** Constructor blocks external URLs, but `resetAvailability()` nulls that state.
**Recommendation:** Immutable URL safety field separate from health state.

### [AUDIT] Redaction tokens trigger false category classification
**File:** src/extraction/scoring.ts (classifyCategory)
**Issue:** `[REDACTED_SECRET]` matches `/secret|token/` regex, inflating importance to 5.
**Recommendation:** Exclude `[REDACTED_*]` from category regex.

### [AUDIT] FTS5 indexes redacted content — polluted search
**File:** src/core/observations.ts
**Issue:** Porter stemmer tokenizes `[REDACTED_SECRET]` into "secret" stem. Original terms unsearchable.
**Recommendation:** Strip `[REDACTED_*]` from FTS5 content.

### [ACCEPTANCE] Checkpoint hop chain basename mismatch
**File:** src/checkpoint/writer.ts:226
**Issue:** Fallback uses `${checkpoint_id}.yaml` but actual files are `${datePrefix}_${checkpoint_id}.yaml`.
**Recommendation:** Use correct filename format.

### [ACCEPTANCE] recoverFromDb updates latest.yaml with wrong row
**File:** src/checkpoint/loader.ts
**Issue:** Uses `committedRows[0]` (global newest) rather than per-directory newest mirrored row.
**Recommendation:** Track per-directory newest.

### [ACCEPTANCE] recoverFromDb called without await in bridge
**File:** src/adapters/openclaw-bridge/bridge-adapter.ts (onInit)
**Issue:** Async function called without `await` — race between recovery and assembly.
**Recommendation:** Add `await`.

### [QUALITY][SECURITY] readStdin spread-order bug
**File:** src/adapters/cc-hooks/infrastructure.ts
**Issue:** `...parsed` overwrites normalized defaults; `null` values bypass normalization.
**Recommendation:** Filter nulls from parsed or spread defaults after parsed.

### [QUALITY][SECURITY] Silent error swallowing in wrapHook
**File:** src/adapters/cc-hooks/infrastructure.ts
**Issue:** All failures return `{}` without telemetry. Observability blind spot.
**Recommendation:** Emit telemetry on error, then return `{}`.

### [SECURITY] Unvalidated transcript_path from stdin
**File:** src/gauge/token-gauge.ts:51
**Issue:** Opens path directly with no canonicalization or boundary check.
**Recommendation:** Validate against transcript root, require `.jsonl`.

### [QUALITY] HTTP resp.ok not checked in EmbeddingProvider
**File:** src/embeddings/embedding-provider.ts:74, :112, :160
**Issue:** Non-2xx responses parsed as valid JSON.
**Recommendation:** Check `resp.ok` before parsing.

### [EFFICIENCY] Classifier built before checking for candidates
**File:** src/adapters/shared/lifecycle.ts:220
**Issue:** Embedding classifier initialized every turn even with zero candidates.
**Recommendation:** Run regex first; build classifier only if candidates exist.

### [EFFICIENCY] Decision embeddings requested sequentially
**File:** src/intelligence/decision-capture.ts:162
**Issue:** Sequential `embed()` in loop instead of `embedBatch()`.
**Recommendation:** Use batch API.

### [AUDIT] Thread gists stored raw (never redacted)
**File:** src/core/thread.ts
**Issue:** Thread state stored without redaction.
**Recommendation:** Apply redaction before storing.

### [AUDIT] js-yaml CORE_SCHEMA type coercion
**File:** src/checkpoint/writer.ts, loader.ts
**Issue:** Coerces `"true"` → boolean on file-fallback path.
**Recommendation:** Use `yaml.JSON_SCHEMA`.

### [AUDIT] sessionLearnings: [] dead code in compaction
**File:** src/adapters/shared/lifecycle.ts:257
**Issue:** Learnings promoter always receives empty array — no-op.
**Recommendation:** Pass actual learnings or remove dead path.

### [REUSE] Duplicated fetch/timeout pattern
**File:** src/embeddings/embedding-provider.ts, src/intelligence/enrichment.ts
**Issue:** Same pattern repeated 5+ times.
**Recommendation:** Extract `fetchJsonWithTimeout` helper.

### [REUSE] Private IP checks duplicated
**File:** src/embeddings/embedding-provider.ts:25, src/extraction/redaction.ts:91
**Recommendation:** Extract to `src/shared/network-safety.ts`.

---

## Observations

- Double-redaction in assembler (harmless but wasteful)
- Tests use `as unknown as ClaudexConfig` bypass — use proper test config builder
- Integration test wall-clock SLA assertions are flaky — move to benchmark suite
- Tests claim stronger behavior than assertions verify (BM25 ranking, assembly content)
- ~300 lines duplicated bootstrap across CC hooks
- CC hooks can't cache EmbeddingProvider (ephemeral process limitation)
- Integration tests are large "god test" files — split by concern
- `writeCheckpoint` is high-coupling orchestration function
- `<project>/` angle brackets could confuse LLM XML-tag parsing (low risk)
- `cosineSimilarity` can return NaN without throwing
- Checkpoint `files.read` label misleading (populated from `files_modified`)
