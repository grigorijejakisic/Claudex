# Gemini Review — v6 Assembly Integration

**Date:** 2026-05-09
**Reviewer:** Gemini (via gemini-cli)
**Scope:** `src/assembly/deliberation-surface.ts` + `src/tests/assembly/deliberation-surface.test.ts` + `src/assembly/assembler.ts` + `src/assembly/sections.ts`
**Overall grade:** **F**
**Trigger:** v6.0.0 pre-push consultation

---

## Summary

The integration contains critical regressions related to object shape mutation, asynchronous bleed into synchronous paths, and swallowed context signals that defeat the token asymmetry design.

---

## Findings

### 1. Backwards Compat: Critical State Loss via Payload Reshaping — CRITICAL

- **Citation:** `src/assembly/assembler.ts:934-938`
- **Issue:** `appendDeliberationSurfaceToPayload` returns a newly constructed object containing only `content`, `tokenEstimate`, and `sources`. It drops all other keys from the original `InjectPayload` — most notably `commitEffects?: () => void`. This permanently breaks existing experience patterns and telemetry that rely on this callback to update state or trigger counts after successful injection.
- **Fix:** Spread the original payload properties when returning: `return { ...payload, content: newContent, ... }`.

### 2. Opt-in Semantics: Accidental Promise Bleed into Sync Paths — CRITICAL

- **Citation:** `src/assembly/assembler.ts:912-915`
- **Issue:** Because `appendDeliberationSurfaceToPayload` is declared `async`, it is guaranteed to return a `Promise<InjectPayload>`. If a synchronous, non-opt-in caller (like the legacy `SessionStart` hotpath) accidentally invokes this wrapper, it will immediately hit `if (!params.deliberationSurfacing) return payload;` but will receive a `Promise` instead of the expected `InjectPayload` object. This causes a silent `[object Promise]` injection or hard runtime crashes when consumers try to read `payload.content`.

### 3. Token Asymmetry: Consumer Blindness to Fallback Quality — CRITICAL

- **Citation:** `src/assembly/sections.ts:1188` (also `src/assembly/deliberation-surface.ts:109`)
- **Issue:** The system properly scales down the token budget for bi-encoder fallbacks, and the core pure function correctly surfaces `bi_encoder_budget_applied`. However, `formatDeliberationSurfaceSection` discards this boolean and only forwards `result.text`. The LLM (consumer) is completely blinded to this context; it has no way of knowing whether the spans it is reading are high-confidence cross-encoder validations or low-confidence bi-encoder fallbacks.
- **Fix:** Utilize `result.bi_encoder_budget_applied` to append a warning (e.g., `(Low Confidence Fallback)`) to the returned text block.

### 4. Token Budget: Hidden Header and Separator Costs — RECOMMENDED

- **Citation:** `src/assembly/deliberation-surface.ts:96-101, 108`
- **Issue:** The greedy-packing loop strictly measures `estimateTokens(r.text)` for the spans. It fails to account for the tokens consumed by the advisory header (`buildAdvisoryHeader`, ~8-10 tokens) and the `\n\n` joining characters. In scenarios where spans are packed right up to the limit, concatenating the header and separators at the end will cause the final payload to violate the strict token cap.
- **Fix:** Pre-initialize `usedTokens` with an estimate for the header, and account for separator costs inside the loop.

### 5. Async Post-Step Cascade: Stale Payload State Assumptions — OBSERVATION

- **Citation:** `src/assembly/assembler.ts:912-938`
- **Issue:** The architectural decision to use a post-step means that the initial payload returned from the sync pipeline is technically incomplete. If any pipeline consumer (e.g., caching, or logging) captures the `tokenEstimate` immediately after the synchronous phase but before the post-step runs, it will calculate against stale metrics. Additionally, because the wrapper returns a new object reference, legacy listeners holding a reference to the pre-append payload will not see the deliberation surface.

---

## Overall grade: F

3 CRITICAL findings invalidate the production safety of this integration. The fixes are concrete and the regressions are reproducible by reading the diff. Phase 11 must address all three before v6.0.0 is published.
