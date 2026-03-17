# Full Multi-Model Code Review Report

**Scope:** Uncommitted changes — 24 files, +905/-535 lines (session 14 review fixes + experience patterns + team shared memory)
**Date:** 2026-03-17 08:50 UTC
**Models:** Codex CLI (0.105.0) + Gemini CLI (0.33.1, gemini-2.5-pro)
**Tests:** 79 files, 1478/1478 passing

---

## Combined Grade: **B+**

| Model | Focus | Grade | Weight | Confidence |
|-------|-------|-------|--------|------------|
| Codex | Security, Quality, Acceptance (7 perspectives) | **A-** | 0.55 | High — diff-focused, line-level |
| Gemini | Architecture, Patterns, Contracts (5 perspectives) | **C-** | 0.45 | Low — sandbox-limited, couldn't run `git diff` |

**Note:** Gemini was sandbox-restricted (no shell access), used `codebase_investigator` instead of `git diff`. Its critical finding is on an **unmodified file**. One recommended finding is a false positive. Effective grade weighted toward Codex.

---

## Cross-Model Findings

None — Gemini couldn't access the actual diff, so no genuine cross-model agreement was possible.

---

## Critical Findings

| # | Source | File | Finding | Verdict |
|---|--------|------|---------|---------|
| 1 | GEMINI | `src/embeddings/embedding-provider.ts` | SSRF via DNS rebinding in `isLocalOrPrivateUrl` | **NOT IN DIFF** — file is unmodified. Pre-existing concern for future hardening. |

**Verdict: 0 critical findings in the actual uncommitted changes.**

---

## Recommended Findings

| # | Source | File | Finding | Action |
|---|--------|------|---------|--------|
| R1 | CODEX | `correction-detection.ts` | No unit tests for `extractLessonFromUserCorrection` — primary extraction path for experience patterns | **Add tests** |
| R2 | CODEX | `behavioral-signals.ts` + `experience-patterns.ts` | Secret content regex (`Bearer/sk-/AKIA/ghp_/xox`) duplicated — inline lambda vs exported constant | **Deduplicate** |
| R3 | CODEX | `cli/worker-context.ts:148` | `main().catch(() => process.exit(0))` silences all errors with success exit code | **Fix (1 line)** |
| R4 | CODEX | `assembly/worker-context.ts:157-163` | Hard-cap line trimming may break mid-XML-section, leaving unclosed tags | **Consider** |
| R5 | CODEX | `assembly/worker-context.ts` | Premature async — function body is entirely synchronous, 26 tests updated to async | **Accept (intentional prep)** |
| R6 | GEMINI | `experience-flags.ts` | JSON blob state in `thread_state.key_exchanges` sacrifices queryability | **Accept (known tradeoff)** |
| R7 | GEMINI | `experience-patterns.ts:deduplicateCheck` | SQL string concatenation | **FALSE POSITIVE** — uses `cachedPrepare` with parameterized `?` placeholders |

---

## Observations

| # | Source | File | Finding |
|---|--------|------|---------|
| O1 | CODEX | `correction-detection.ts` | `USER_LESSON_PATTERNS` regex could backtrack on adversarial input; bounded by try/catch |
| O2 | CODEX | `worker-observations.ts:215-220` | `splitReportIntoObservations` substring check could produce near-duplicate observations |
| O3 | CODEX | `assembler.ts` | Naming confusion: two `renderExperienceWarnings` functions (one aliased) |
| O4 | CODEX | Multiple files | Spec markers (O25, O26, etc.) cleanly removed from comments |
| O5 | CODEX | `migrations.ts` | `migrateSchemaFixes` guard is efficient — fast path for already-migrated DBs |
| O6 | CODEX | `worker-observations.ts:50` | Good: switched to `cachedPrepare` for hot-path `isDuplicate` |
| O7 | CODEX | `artifact-claims.ts` | Good: removed unnecessary CAST now that column types match |
| O8 | CODEX | Tests | High quality — proper async conversion, better integration paths, timing fixes |
| O9 | CODEX | `correction-detection.ts` | Well-structured dual extraction with clear header comments |
| O10 | GEMINI | `behavioral-signals.ts` | Good: automatic secret redaction in tool signatures |
| O11 | CODEX | `sections.ts` | Full XML escape is correct — `&` first, then `<>"'` |
| O12 | CODEX | Multiple files | Systematic `emitErrorTelemetry` addition in catch blocks — consistent cross-cutting |

---

## Actionable Summary

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **Do now** | R3: Fix CLI error swallowing | 1 line | Prevents silent failures |
| **Do now** | R2: Deduplicate secret regex | 5 min | Prevents drift |
| **Do soon** | R1: Add correction extraction tests | 30 min | Covers primary extraction path |
| **Consider** | R4: Section-boundary truncation | Medium | Edge case in worker context |
| **Accept** | R5: Premature async | — | Intentional prep |
| **Accept** | R6: JSON blob state | — | Known tradeoff |
| **Dismiss** | R7: SQL concatenation | — | False positive |

---

## Codex Perspective Grades

| Perspective | Grade | Notes |
|---|---|---|
| Code Quality | B+ | Sound logic. Hard-cap truncation and CLI error swallowing are concerns. |
| Acceptance | A- | Code matches intent. Handoff doc stale but code correct. |
| Security | A- | Tighter secret patterns, content scanning, XML escape, enrichment redaction. One DRY issue. |
| General | A | Clean naming, consistent style, good comments. |
| Reuse | B+ | One DRY violation (secret regex), one minor (trigger context cleaning). |
| Efficiency | A | No regressions. Several micro-optimizations. |
| Code Health | B+ | Systematic error telemetry. Missing unit tests for new extraction path. |

## Gemini Perspective Grades

| Perspective | Grade | Notes |
|---|---|---|
| Coherence | B+ | Architecture is coherent. JSON blob state is a smell. |
| Design Patterns | B | Good facade/batching. SQL concatenation is false positive. |
| Dead Weight | A | Dense, purposeful code. |
| Contract Compliance | A- | Excellent docs/types. SSRF finding is pre-existing. |
| Dependency Health | D | Dragged down by SSRF finding that's not in the diff. |
