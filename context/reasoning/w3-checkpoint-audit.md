# W3: Checkpoint System Data Round-Trip Audit

**Scope:** `src/checkpoint/writer.ts`, `loader.ts`, `inject.ts`, `types.ts`
**Date:** 2026-03-13
**Status:** Complete

---

## Architecture Summary

The checkpoint lifecycle is:

1. **Write** (`writer.ts`): Build `CheckpointV3` object from DB queries -> `JSON.stringify` into `checkpoint_meta.data` (TEXT column) -> `yaml.dump` to `.yaml` file (optionally gzip-compressed to `.yaml.gz`) -> update `latest.yaml` pointer
2. **Load** (`loader.ts`): DB-first (JSON.parse from `data` column) -> file fallback (yaml.load) -> selective preset filtering -> return `CheckpointV3`
3. **Inject** (`inject.ts`): `CheckpointV3` -> markdown string via `renderCheckpointMarkdown` -> consumed by `sections.ts` -> final `redactContent` in assembler

---

## FINDING 1: YAML Special Character Handling (Severity: LOW)

**Location:** `writer.ts:326`, `loader.ts:111,140,179`

`js-yaml` v4.x `dump()` with default settings properly quotes strings containing YAML-special characters (colons, `#`, `>`, `|`, `{`, `}`, `[`, `]`). The `lineWidth: 120` option controls line folding; `noRefs: true` prevents YAML anchors/aliases.

**Safe patterns:**
- `<project>/path` -- angle brackets are safe in YAML values (no special meaning outside tags)
- `[REDACTED_SECRET]` -- brackets in string values are quoted by js-yaml when they start a value
- Backticks -- no special meaning in YAML, pass through safely
- Newlines in string values -- js-yaml uses block scalars or escaping automatically
- Colons in values -- js-yaml quotes when ambiguous (e.g., `"key: value"`)

**No issue found.** `js-yaml` 4.x handles all these cases correctly in default `CORE_SCHEMA` mode. Round-trip `dump` -> `load` preserves string content faithfully.

---

## FINDING 2: Implicit Type Coercion via YAML (Severity: MEDIUM)

**Location:** `loader.ts:111` -- `yaml.load(content) as CheckpointV3`

`js-yaml` 4.x uses `CORE_SCHEMA` by default, which auto-converts:
- `"null"` string -> `null`
- `"true"` / `"false"` strings -> booleans
- Numeric-looking strings -> numbers (e.g., `"0.75"` -> `0.75`)

**Risk path:** The `CheckpointV3.gsd` field is typed `unknown | null`. If GSD contains string values that look like YAML scalars (e.g., a status field with value `"true"` or `"null"`), the YAML round-trip will silently coerce them.

**Concrete scenario:**
1. `writer.ts:326` serializes `gsd: { active: "true", count: "42" }` via `yaml.dump`
2. YAML output: `active: true` and `count: 42` (unquoted, because js-yaml detects core types)
3. `loader.ts:111` `yaml.load` parses them as `boolean true` and `number 42`
4. The `gsd` object now has different types than what was stored

**Mitigation:** This does NOT affect the DB path (JSON.stringify/JSON.parse preserves types). It ONLY affects the file-fallback path (yaml.dump -> yaml.load). The DB path is the primary path and is safe.

**Impact:** Low in practice because:
- The DB is the primary recovery layer; file fallback is secondary
- Most string fields in the checkpoint schema are explicitly typed and contain natural language (not "true"/"null"/"42")
- The `gsd` field is the main risk, but GSD data typically has explicit schemas

**Recommendation:** Consider using `yaml.dump(checkpoint, { lineWidth: 120, noRefs: true, schema: yaml.JSON_SCHEMA })` to force all values to be quoted/typed correctly. Alternatively, use `yaml.load(content, { schema: yaml.JSON_SCHEMA })` on the load side. This would eliminate all implicit coercions.

---

## FINDING 3: Gzip Compression Round-Trip (Severity: NONE)

**Location:** `writer.ts:70-95`, `loader.ts:27-38`

Write path: `Buffer.from(content, 'utf-8')` -> `zlib.gzipSync` -> `fs.writeFileSync`
Read path: `fs.readFileSync` -> `zlib.gunzipSync` -> `decompressed.toString('utf-8')`

This is a clean byte-preserving round-trip. UTF-8 encoding is explicit on both sides. No data loss possible.

**No issue found.**

---

## FINDING 4: DB Storage — Column Types and JSON Handling (Severity: NONE)

**Location:** `migrations.ts:189-200`, `writer.ts:282-284`

DB schema: `data TEXT` column stores `JSON.stringify(checkpoint)`.
Write: `JSON.stringify(checkpoint)` -> SQLite TEXT
Load: `JSON.parse(row.data)` -> `CheckpointV3`

JSON.stringify/JSON.parse is a lossless round-trip for all JavaScript types that `CheckpointV3` uses (strings, numbers, booleans, null, arrays, objects). No BLOBs are used; compressed files go to disk only.

**No issue found.** The DB path is the safest data channel.

---

## FINDING 5: DB vs. File Data Divergence (Severity: MEDIUM)

**Location:** `writer.ts:282-316` (enrichment path)

After enrichment, the writer updates the DB's `data` column with the enriched checkpoint (line 314-316), but then writes the YAML file from the same in-memory `checkpoint` object (line 326). So DB and file are consistent **after enrichment**.

However, the `data` column is updated TWICE if enrichment succeeds:
1. Line 283: `JSON.stringify(checkpoint)` -- pre-enrichment
2. Line 314: `JSON.stringify(checkpoint)` -- post-enrichment

The file is written once, post-enrichment (line 326-329). So DB and file are consistent.

**Subtle issue:** If the process crashes between step 1 (line 283, committed status) and step 2 (line 314), the DB contains the pre-enrichment data, and no file exists yet. On recovery, `recoverFromDb` will re-mirror the pre-enrichment data. This is correct behavior (enrichment is best-effort), but the `enriched` flag in the return value would have been lost.

**No data corruption found.** The enrichment crash window is handled correctly.

---

## FINDING 6: previous_checkpoint Basename Mismatch (Severity: MEDIUM-HIGH)

**Location:** `writer.ts:217-227`, `loader.ts:161-196`

The `previous_checkpoint` field stores a **basename** (e.g., `2026-03-13_01JXXXXXXXXX.yaml`). This basename is used by `followHopChain` to resolve the file path.

**Problem path:** When the previous checkpoint has no `mirror_path` (file write failed, status stayed `committed`), the writer falls back to constructing a basename:
```typescript
previousCheckpoint = `${prev.checkpoint_id}.yaml`;  // line 226
```

But the actual file naming convention is `${datePrefix}_${checkpointId}${ext}` (line 170). So the fallback basename is `01JXXXXXXXXX.yaml` but the real file (if it existed) would be `2026-03-13_01JXXXXXXXXX.yaml`.

**Impact:** `followHopChain` would fail to find the file at the wrong basename, breaking the hop chain silently (returns collected so far). This only triggers when:
1. A previous checkpoint's file write failed (status = `committed`, no `mirror_path`)
2. A later checkpoint references it
3. Someone calls `followHopChain`

This is a **real data flow mismatch**: the writer produces a basename that the loader cannot resolve.

**Recommendation:** The fallback should construct the basename using the same pattern: `${datePrefix}_${prev.checkpoint_id}.yaml`. But the date isn't available from the query. Better fix: store `mirror_path` even as an "intended" path before file write, or derive the date from the `created_at_epoch` column.

---

## FINDING 7: 3-Hop Recovery Chain Data Loss (Severity: LOW)

**Location:** `loader.ts:161-196`

The hop chain follows `previous_checkpoint` fields through YAML files up to `maxHops` (default 3). Each hop parses YAML, so FINDING 2 (implicit coercion) applies at each hop.

**Additional risk:** The hop chain is file-only. If a checkpoint exists in DB but its file is missing (committed but not mirrored), the chain breaks at that point. The `followHopChain` function doesn't consult the DB at all.

**Impact:** The hop chain is currently not used by the main `loadCheckpoint` flow -- it's an auxiliary function. But if called directly, it could silently lose history when intermediate files are missing.

**Recommendation:** Consider a `followHopChainWithDb` variant that can fall back to DB for missing file hops.

---

## FINDING 8: Double Redaction Risk (Severity: MEDIUM)

**Location:** `inject.ts` (renderCheckpointMarkdown), `assembly/sections.ts:79` (formatCheckpointSection), `assembly/assembler.ts:195` (redactContent)

The data flow is:
1. Extraction layer applies `redactContent` when observations are stored (content goes through `[REDACTED_*]` patterns)
2. Checkpoint writer stores already-redacted observation data in checkpoint
3. `renderCheckpointMarkdown` renders checkpoint fields into markdown (no redaction here -- clean)
4. `assembler.ts:195` applies `redactContent` to the final assembled content

**Analysis of double-redaction:**
- `[REDACTED_SECRET]`, `[REDACTED_PII]`, `[REDACTED_ENTROPY]` tokens themselves:
  - These are 15-18 chars, below the 20-char entropy threshold
  - They don't match secret/PII patterns (no `@`, no digits in SSN format, etc.)
  - They pass through the second redaction safely

- However, `[REDACTED_SECRET]` contains the substring `SECRET` which could theoretically match in a larger context... checking the patterns: no, the secret patterns look for specific formats (JWT, AWS keys, etc.), not the word "SECRET".

**No double-redaction corruption found.** The redaction tokens are inert to all three redaction layers.

**But:** The assembler DOES re-redact the checkpoint markdown. If checkpoint data contains content that was NOT previously redacted (e.g., thread summaries, decision content that came from enrichment rather than extraction), the assembler's redaction is the only layer that catches it. This is correct behavior, not a bug.

---

## FINDING 9: Null/Undefined Field Handling in inject.ts (Severity: NONE)

**Location:** `inject.ts:14-122`

Every section in `renderCheckpointMarkdown` is guarded by null/falsy checks:
- `working.task` checked before inclusion (line 27)
- `thread?.topic` optional chain (line 38)
- `thread.summary` checked with `includeResume &&` (line 41)
- Arrays checked with `.length > 0` (lines 45, 56, 65-67, 93, 102)
- `gsd` checked for null (line 111), then type-checked for string vs object (line 113)
- Whole function wrapped in try/catch returning `''` (line 121)

**No issue found.** Null/undefined handling is thorough. The function is properly non-throwing and handles missing fields gracefully.

---

## FINDING 10: Selective Loading Deep Clone (Severity: NONE)

**Location:** `loader.ts:206` -- `JSON.parse(JSON.stringify(checkpoint))`

The deep clone in `applyPreset` uses JSON round-trip, which correctly clones all `CheckpointV3` fields since they are all JSON-safe types. No `Date` objects, no `undefined` values in arrays, no circular refs, no `BigInt`. The `gsd: unknown` field could theoretically contain non-JSON-safe values, but in practice it comes from `JSON.parse` (DB path) or `yaml.load` (file path), both of which only produce JSON-compatible types.

**No issue found.**

---

## Summary Table

| # | Finding | Severity | Data Loss Risk | Fix Needed |
|---|---------|----------|----------------|------------|
| 1 | YAML special chars | NONE | No | No |
| 2 | YAML implicit coercion (file path only) | MEDIUM | Type change on `gsd` field via file fallback | Recommend JSON_SCHEMA |
| 3 | Gzip round-trip | NONE | No | No |
| 4 | DB JSON storage | NONE | No | No |
| 5 | DB vs file enrichment window | NONE | No (handled correctly) | No |
| 6 | previous_checkpoint basename mismatch | **MEDIUM-HIGH** | Broken hop chain when fallback triggered | **Yes** |
| 7 | Hop chain is file-only | LOW | Incomplete history if files missing | Optional |
| 8 | Double redaction | NONE | No (tokens are inert) | No |
| 9 | Null/undefined in inject | NONE | No | No |
| 10 | Deep clone safety | NONE | No | No |

---

## Priority Fixes

1. **FINDING 6 (previous_checkpoint basename):** The fallback basename construction on `writer.ts:226` uses `${checkpoint_id}.yaml` but the actual naming convention is `${date}_${checkpoint_id}.yaml`. This is a real mismatch that breaks hop chains. Fix: derive date from `created_at_epoch` in the same query, or store intended mirror_path earlier in the lifecycle.

2. **FINDING 2 (YAML schema):** Optional hardening -- use `yaml.JSON_SCHEMA` on both dump and load to prevent implicit type coercion. Low priority since DB is the primary path.
