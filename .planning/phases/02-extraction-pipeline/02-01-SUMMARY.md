---
phase: 02-extraction-pipeline
plan: 01
subsystem: extraction
tags: [redaction, quality-gate, scoring, classification, entropy, pii, secrets]

requires:
  - phase: 01-storage-layer
    provides: "ObservationCategory type, observation schema"
provides:
  - "redactContent: three-layer redaction (secrets, PII, entropy) with allowlist"
  - "sanitizePath: username replacement and project-relative prefix"
  - "passesQualityGate: per-tool quality filter for low-signal observations"
  - "scoreImportance: 1-5 importance scoring based on tool, category, content"
  - "classifyCategory: keyword-first-match category auto-classification"
affects: [02-extraction-pipeline, 03-compaction-injection]

tech-stack:
  added: []
  patterns: [three-layer-redaction, quality-gate-per-tool, keyword-first-match-classification]

key-files:
  created:
    - src/extraction/redaction.ts
    - src/extraction/quality-gate.ts
    - src/extraction/scoring.ts
    - src/tests/extraction/redaction.test.ts
    - src/tests/extraction/quality-gate.test.ts
    - src/tests/extraction/scoring.test.ts
  modified: []

key-decisions:
  - "Base64 redaction excludes pure hex strings (hex hashes are not secrets)"
  - "PII patterns use negative lookbehind/lookahead to avoid matching inside UUIDs"
  - "Credit card pattern uses boundary assertions to prevent UUID false positives"

patterns-established:
  - "Non-throwing pattern: all extraction functions return input/default on error"
  - "Layer ordering: secrets first, PII second, entropy third (avoids double-redaction)"
  - "Allowlist-based entropy: check allowlist before redacting high-entropy strings"

requirements-completed: [EXTR-02, EXTR-03, EXTR-04]

duration: 4min
completed: 2026-03-10
---

# Phase 02 Plan 01: Shared Pipeline Components Summary

**Three-layer redaction engine (secrets/PII/entropy), per-tool quality gates, importance scoring (1-5), and keyword-first-match category classification**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T22:51:00Z
- **Completed:** 2026-03-10T22:55:32Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Three-layer redaction covering secrets (AWS, GitHub, JWT, Bearer, API keys, base64), PII (email, phone, SSN, credit card, public IPs), and entropy-based detection with allowlist
- Per-tool quality gates rejecting trivial bash, empty grep, structure-less reads while passing edits, writes, and meaningful content
- Importance scoring (1-5) with security/architecture at top and keyword-first-match category classification

## Task Commits

Each task was committed atomically:

1. **Task 1: Three-layer redaction engine with path sanitization** - `6c5a880` (feat)
2. **Task 2: Quality gates, importance scoring, and category classification** - `7c30c64` (feat)

## Files Created/Modified
- `src/extraction/redaction.ts` - Three-layer redaction engine (secrets, PII, entropy) + path sanitization
- `src/extraction/quality-gate.ts` - Per-tool quality gates that filter low-signal observations
- `src/extraction/scoring.ts` - Importance scoring (1-5) and category auto-classification
- `src/tests/extraction/redaction.test.ts` - 25 tests for all three redaction layers + path sanitization
- `src/tests/extraction/quality-gate.test.ts` - 18 tests for per-tool quality gate logic
- `src/tests/extraction/scoring.test.ts` - 15 tests for importance scoring and category classification

## Decisions Made
- Base64 pattern in Layer 1 excludes pure hex strings to avoid false-positive redaction of commit hashes and similar hex identifiers
- PII patterns (phone, SSN, credit card) use negative lookbehind/lookahead for hex chars and digits to prevent matching inside UUIDs
- Credit card pattern uses boundary assertions (`(?<![0-9a-fA-F-])...(?>![0-9a-fA-F-])`) to prevent UUID substring false positives

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Hex hashes falsely matched as base64 secrets**
- **Found during:** Task 1 (redaction engine)
- **Issue:** Pure hex strings like `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6` matched the base64 pattern `[A-Za-z0-9+/]{32,}` since hex chars are a subset of base64 chars
- **Fix:** Added hex-only check before redacting base64 candidates; pure hex strings are preserved
- **Files modified:** src/extraction/redaction.ts
- **Verification:** Test "preserves hex hashes despite high entropy" passes
- **Committed in:** 6c5a880 (Task 1 commit)

**2. [Rule 1 - Bug] UUID substrings falsely matched as credit card and phone numbers**
- **Found during:** Task 1 (redaction engine)
- **Issue:** UUID `550e8400-e29b-41d4-a716-446655440000` contained substring `716-446655440000` matching credit card and phone patterns
- **Fix:** Added negative lookbehind/lookahead boundary assertions to phone, SSN, and credit card patterns to prevent matching inside hex/UUID contexts
- **Files modified:** src/extraction/redaction.ts
- **Verification:** Test "preserves UUIDs despite high entropy" passes
- **Committed in:** 6c5a880 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness — preventing false-positive redaction of legitimate code content. No scope creep.

## Issues Encountered
None beyond the deviation auto-fixes above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All shared pipeline components ready for per-tool extractors (Plan 02)
- Exports: `redactContent`, `sanitizePath`, `passesQualityGate`, `scoreImportance`, `classifyCategory`
- 58 tests provide regression safety for extractor development

---
*Phase: 02-extraction-pipeline*
*Completed: 2026-03-10*

## Self-Check: PASSED
- All 6 created files verified on disk
- Commit 6c5a880 verified in git log
- Commit 7c30c64 verified in git log
- TypeScript: zero errors (npx tsc --noEmit)
- Tests: 58/58 passing across 3 test files
