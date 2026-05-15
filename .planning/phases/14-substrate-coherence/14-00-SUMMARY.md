---
plan: 14-00
status: shipped
shipped_at: 2026-05-15
shipped_commit: cfc45fe
retroactive: true
note: 14-00 shipped before the Phase 14 GSD plan-structure was formalized; this SUMMARY is written retroactively for milestone-close completeness.
---

# Plan 14-00 — RCA-2 Opus Rate-Limit Hybrid

## What shipped

Single-file production change to `src/angel/highlights-extractor.ts`
plus telemetry helper extension and 6 new tests. Removed the OAuth
path that was hitting HTTP 429 globally; gated Opus on
`ANTHROPIC_API_KEY` env var (real billing key, not the OAuth token);
made local LLM the chosen primary path when env var is unset
(degraded=0 on success). Captured HTTP status in
`frame_extraction_fallback` telemetry detail (was previously lost).

## Acceptance criteria

All 5 ACs from the spec met:
- AC-1: env-var-unset → local LLM as primary, degraded=0
- AC-2: env-var-set with API key → Opus first, fallback to local on 4xx/5xx
- AC-3: HTTP status preserved in telemetry detail
- AC-4: existing degraded session re-extracts cleanly under both paths
- AC-5: cold-start projects (no API key, no OAuth) work via fallback

## Why it matters

RCA-2 found that **every Opus highlights extraction since the feature
shipped on 2026-05-14 returned HTTP 429 (rate_limit_error)**. The
MAX subscription's OAuth token is rate-limited for programmatic API
access; interactive CC sessions consume the same token through CC's
own client and do not hit the limit, but Angel calling
`api.anthropic.com` directly does. Result: every
`session_highlights` row in production was `degraded=1`, falling
back to `glm-5.1:cloud`. Zero non-degraded highlights existed in
the entire DB.

This was the highest-leverage cheap fix on the Phase 14 board.

## Tests

11/11 highlights-extractor tests pass (5 prior + 6 new): env-var-unset,
env-var-set with key, env-var-set-empty (treated as unset),
env-var-set-whitespace (treated as unset), 429 captured with
`http_status` in telemetry, no-httpStatus omits the field, local-as-
primary failure produces `local_llm_failed` reason.

## Files

- `src/angel/highlights-extractor.ts` — Opus path rewired
- `src/core/telemetry-signals.ts` — `http_status?: number` added to
  `recordFrameExtractionFallback` detail
- `src/tests/angel/highlights-extractor.test.ts` — 6 new tests + 5 updated
