# Unified Review Fix Tracker

**Review date:** 2026-03-13
**Initial grade:** F (18 critical, ~53 recommended, ~25 observations)
**Target grade:** A (0 critical, ≤2 recommended)

---

## Phase 1: Original 12 Critical Findings (from diff-only review)

All fixed in prior session. Confirmed resolved and excluded from full codebase grade.

| # | Finding | File | Status |
|---|---------|------|--------|
| 1 | Duplicate path import | sections.ts | FIXED |
| 2 | Non-atomic DB swap in migrate.ts | migrate.ts | FIXED |
| 3 | WAL-unsafe backup in migrate.ts | migrate.ts | FIXED |
| 4 | Migrated DB at wrong path for legacy detection | migrate.ts | FIXED |
| 5 | BridgeContext test type errors | bridge-adapter.test.ts | FIXED |
| 6 | Auto-checkpoint cooldown ineffective | user-prompt-submit.ts | FIXED |
| 7 | Trust directive on file-derived context | assembler.ts | FIXED |
| 8 | Project-wide observation consumption blast radius | lifecycle.ts | FIXED |
| 9 | Observations consumed before checkpoint write | lifecycle.ts | FIXED |
| 10 | Cooldown state in key_exchanges leaks into context | thread.ts, inject.ts | FIXED |
| 11 | Wasted getToolCostEstimates query | assembler.ts | FIXED |
| 12 | Duplicate migration workflows between setup and migrate CLIs | db-stats.ts | FIXED |

---

## Phase 2: 18 NEW Critical Findings (from full codebase review)

All fixed by 6-worker team. Build clean, 1069/1069 tests pass.

| # | Finding | File | Worker | Status |
|---|---------|------|--------|--------|
| C1 | mirror_path traversal — dir validation added | loader.ts | w1 | FIXED |
| C2 | Gzip bomb — compressed size already checked (verified) | loader.ts | w1 | FIXED |
| C3 | Untrusted file content — data boundary wrappers added | sections.ts | w2 | FIXED |
| C4 | User-controlled topic — sanitizeTopicText added | sections.ts | w2 | FIXED |
| C5 | Hook protocol fail-open — validation + early return | infrastructure.ts | w3 | FIXED |
| C6 | Enrichment redirect bypass — redirect:'manual' | enrichment.ts | w4 | FIXED |
| C7 | Tool output provenance — external: prefix tagging | quality-gate.ts, extractor.ts | w5 | FIXED |
| C8 | EPERM fallback — copy fallback removed | fs-helpers.ts | w3 | FIXED |
| C9 | transcript_path UNC — isPathSafe() validation | token-gauge.ts | w3 | FIXED |
| C10 | Shell injection — single-quote escaping | setup.ts | w6 | FIXED |
| C11 | DB JSON schema validation — schema+version check | loader.ts | w1 | FIXED |
| C12 | migrateFromV2 adapter columns — ALTER TABLE added | migrations.ts | w6 | FIXED |
| C13 | v2 session columns — PRAGMA introspection | migrations.ts | w6 | FIXED |
| C14 | Setup same-path — path.resolve guard | setup.ts | w6 | FIXED |
| C15 | Type classifier priority — reordered checks | type-classifier.ts | w5 | FIXED |
| C16 | Co-occurrence overcounting — json_each query | decay-engine.ts | w6 | FIXED |
| C17 | Topic write-once — updateTopic method added | thread-tracker.ts | w4 | FIXED |
| C18 | Empty string dedup — normA && normB guard | semantic-dedup.ts | w4 | FIXED |

**Test fixes:** Updated 2 test files (loader.test.ts, setup.test.ts) for new validation behaviors.

---

## Phase 3: 53 Recommended Findings (in progress)

9-worker team deployed. Status will be updated as workers complete.

| # | Finding | File | Worker | Status |
|---|---------|------|--------|--------|
| R1 | any[] types in topic pivot | assembler.ts | w1 | FIXED |
| R2 | Post-redaction reclaim violates budget | assembler.ts | w1 | FIXED |
| R3 | formatGaugeSection unused threshold | sections.ts | w1 | FIXED |
| R4 | Raw exception messages in telemetry | assembler.ts | w1 | FIXED |
| R5 | Enriched decision timestamp ms→s | writer.ts | w2 | FIXED |
| R6 | latest.yaml write failure ignored | writer.ts | w2 | FIXED |
| R7 | Directory scan ignores .yml/.yml.gz | loader.ts | w2 | FIXED |
| R8 | Unchecked YAML/JSON casts | loader.ts | w2 | FIXED |
| R9 | decayPressure return value wrong | pressure.ts | w3 | FIXED |
| R10 | getDecisionsBySession limit=0 | decisions.ts | w3 | FIXED |
| R11 | Broad catch blocks in migrations | migrations.ts | w3 | FIXED |
| R12 | Decision content stored unredacted | decisions.ts | w3 | FIXED |
| R13 | Decision dedup unbounded fetch | decision-capture.ts | w4 | FIXED |
| R14 | Learnings cap by agent_id not project | learnings-promoter.ts | w4 | FIXED |
| R15 | getLearningsByProject N+1 | learnings-promoter.ts | w4 | FIXED |
| R16 | LLM enrichment JSON no validation | enrichment.ts | w4 | FIXED |
| R17 | Enrichment JSON no sanitization | enrichment.ts | w4 | FIXED |
| R18 | Confirmation stores entire text | decision-capture.ts | w4 | FIXED |
| R19 | ThreadTracker re-instantiated | lifecycle.ts | w5 | FIXED |
| R20 | Bridge lacks topic shift fallback | bridge-adapter.ts | w5 | FIXED |
| R21 | transcript_path trust boundary | infrastructure.ts | w5 | FIXED |
| R22 | Raw error text in telemetry | infrastructure.ts | w5 | FIXED |
| R23 | File dedup omits deleted_at_epoch | extractor.ts | w6 | FIXED |
| R24 | Bash extractor drops stderr | bash.ts | w6 | FIXED |
| R25 | sanitizePath prefix edge case | redaction.ts | w6 | FIXED |
| R26 | Secret redaction misses patterns | redaction.ts | w6 | FIXED |
| R27 | Tool payload size not validated | extractor.ts | w6 | FIXED |
| R28 | deepMerge copies unknown keys | config.ts | w7 | FIXED |
| R29 | atomicWriteFile async with sync I/O | fs-helpers.ts | w7 | FIXED |
| R30 | Config validation no range checks | config.ts | w7 | FIXED |
| R31 | isKnownTool matches prototype | tool-catalog.ts | w7 | FIXED |
| R32 | Scope detector trailing separator | scope-detector.ts | w7 | FIXED |
| R33 | Caller signal overwritten | fetch-utils.ts | w7 | FIXED |
| R34 | Fetch body no timeout/size limit | fetch-utils.ts | w7 | FIXED |
| R35 | emitTelemetry type mismatch | telemetry.ts | w8 | FIXED |
| R36 | getToolCostEstimates contract | telemetry.ts | w8 | FIXED |
| R37 | Embedding allows LAN endpoints | embedding-provider.ts | w8 | FIXED |
| R38 | Build fail-open on missing entries | build.ts | w9 | FIXED |
| R39 | Co-occurrence LIKE SQL wildcards | decay-engine.ts | w8 | FIXED (by C16) |
| R40 | queryTelemetry not non-throwing | telemetry.ts | w8 | FIXED |
| R41 | Embedding response cast no validation | embedding-provider.ts | w8 | FIXED |
| R42 | Dashboard filter precedence | dashboard.ts | w9 | FIXED |
| R43 | Dashboard swallows DB errors | dashboard.ts | w9 | FIXED |
| R44 | session_end with empty sessionId | plugin-entry.ts | w5 | FIXED |
| R45 | Learnings dedup scope mismatch | learnings-promoter.ts | w4 | FIXED |
| R46 | computeAvgRecent returns 0 | topic-shift.ts | w9 | FIXED |
| R47 | Pivot without existing topic | topic-shift.ts | w9 | FIXED |
| R48 | Grep quality gate no context check | quality-gate.ts | w6 | FIXED |
| R49 | Trivial command bypassed by whitespace | quality-gate.ts | w6 | FIXED |
| R50 | Pressure zone thresholds duplicated | constants.ts | w7 | FIXED |
| R51 | RuntimeEvent kind/payload typed independently | types.ts | w7 | FIXED |
| R52 | initTemplates no embedBatch length check | templates.ts | w8 | FIXED |
| R53 | Enrichment config.provider ignored | enrichment.ts | w4 | FIXED |

---

## Observations (25 — not targeted for fixing)

Low-severity items documented in UNIFIED_REVIEW_REPORT.md. Will reassess after recommended fixes land.

---

## Verification Checkpoints

| Checkpoint | Result |
|-----------|--------|
| Phase 1 complete — build | PASS |
| Phase 1 complete — tests | 1069/1069 PASS |
| Phase 2 complete — build | PASS |
| Phase 2 complete — tests | 1069/1069 PASS |
| Phase 3 complete — build | PASS |
| Phase 3 complete — tests | 1073/1073 PASS |
| Re-grade after all fixes | PENDING |
