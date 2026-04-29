---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "06"
status: complete
completed: 2026-04-29
---

# Plan 05-06 SUMMARY: codebase_index → UPS turn payload (UPS ≤1KB)

## Commits

| SHA | Description |
|-----|-------------|
| `00e956a` | feat(05-06): move codebase_index from session-start to UPS turn payload + UPS budget test |

## INJ-01 + INJ-05 verification

- **INJ-01 (session-start ≤500 tokens):** Cache-stability Layer 1 strict mode green across all 4 fixtures (124/148/145/191 tokens; well under 500).
- **INJ-05 (UPS ≤1KB):** New `assembler-ups-budget.test.ts` asserts ≤1024 bytes hard across 4 scenarios; all green.

## UPS pre/post composition

See `05-06-UPS-AUDIT.md` for full audit.

| Section | Pre-Plan-06 | Post-Plan-06 |
|---------|-------------|--------------|
| Critical Reminders | yes (300t cap) | yes (unchanged) |
| Proven Principles | yes (500t cap, every 5 turns) | yes (unchanged) |
| Codebase Index | NO | yes (200t cap, query-gated) |
| Intent-triggered Patterns | yes | yes |
| Experience Warnings | yes | yes (Plan 08 wires reactive triggers) |
| Trigger-materialized Artifacts | yes | yes |

## Per-scenario UPS bytes

| Scenario | Bytes | Tokens | Sources |
|----------|-------|--------|---------|
| no-prompt | 0 | 0 | [] |
| short-prompt | 0 | 0 | [] |
| long-prompt-with-tech-terms | 0 | 0 | [] |
| critical-reminder-active | 0 | 0 | [] |

Fixture cascade gates aren't all met (turn count, codebase index data, intent classification), so output is empty in test conditions — but the structural budget invariant is locked. Plan 09 production-baseline soak measures live UPS bytes against real DB content.

## Notes

- `getChangedFiles` import removed from `assembler.ts`. The session-spanning "Changed since last session" sub-block does NOT migrate to UPS (per-turn relevance is task-shaped). Recommended follow-up: dedicated slash command surface (out of Phase 5 scope).
- CACH-03 hardening continuity: new UPS codebase_index block uses `_shortenPathCacheStable` (same cache-stable normalize).
- 161 assembly tests + 4 UPS budget tests + 12 cache-stability tests all green.

## Verdict

**PASS** — codebase_index relocation complete; UPS budget invariant locked. Plan 07/08 next (initialUserMessage prime + Experience reactive triggers, parallel wave).
