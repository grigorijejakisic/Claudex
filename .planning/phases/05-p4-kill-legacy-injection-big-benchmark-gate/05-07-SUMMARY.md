---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "07"
status: complete
completed: 2026-04-29
---

# Plan 05-07 SUMMARY: INJ-06 frontmatter-gated default-on initialUserMessage prime

## What landed

`src/adapters/cc-hooks/session-start.ts` — auto_prime config flag retired; new contract:

```
Resume handoff: ${summary}. Full state at .planning/handoffs/ACTIVE.md.
```

Fires if and only if:
1. `<cwd>/context/handoffs/ACTIVE.md` exists
2. Frontmatter `status: active` (case-insensitive `^status:\s*active\b`)
3. Frontmatter `phase` EXACTLY matches `Current Phase: <N>` from STATE.md (string equality)
4. Either `summary` frontmatter key OR a non-blank non-H1 body line is present
5. sessionType is `'startup'` or `''` (NOT `'resume'`, NOT `'compact'`)

## Canonical prime contract

`computeInitialUserMessage(cwd: string): string | null` is now exported from session-start.ts and serves as the unit-testable boundary. The wrapHook block reduces to:

```typescript
let initialMessage: string | undefined;
try {
  const sessionType = (input.type as string) ?? '';
  if (sessionType === 'startup' || sessionType === '') {
    initialMessage = computeInitialUserMessage(input.cwd) ?? undefined;
  }
} catch { /* non-fatal */ }
```

## Test counts

| File | Tests |
|------|-------|
| `src/tests/adapters/cc-hooks/session-start-prime.test.ts` | 12 |
| `src/tests/integration/handoff-pickup-one-turn.test.ts` | 5 |
| **Total new** | **17** |

All 17 PASS. Notable cases:
- EXACT match regression: handoff `4.1` against STATE `4` → no prime (per team-lead Q3 verdict)
- Decimal end-to-end: handoff `4.1` against STATE `4.1` → fires
- Quoted phase: `phase: "5"` works
- Case-insensitive status: `status: Active` works
- Body fallback: when no `summary:` key, first non-H1 body line becomes summary
- Quote-stripping in summary: `summary: "Resume Z"` → "Resume Z"

## Files

- `src/adapters/cc-hooks/session-start.ts` — `computeInitialUserMessage` exported helper at line ~46; main wrapHook block at line ~316
- `src/tests/adapters/cc-hooks/session-start-prime.test.ts` (NEW)
- `src/tests/integration/handoff-pickup-one-turn.test.ts` (NEW)

## Cumulative test counts (post-Plan-07)

- Assembly: 161
- Cache-stability: 12
- UPS budget: 4
- Prime contract: 12
- SC#4 integration: 5
- **Phase 5 net new tests: ~50**

## Verdict

**PASS** — INJ-06 contract live; Plan 09 reads `handoff-pickup-one-turn.test.ts` as one of SC#4's gate inputs.
