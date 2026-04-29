---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "01"
status: complete
completed: 2026-04-29
---

# Plan 05-01 SUMMARY: Pre-flight + CACH-03 hardening + scope-decisions + Vesna baseline

## What landed

**Task 1 — Pre-flight backup + scope decisions + Vesna baseline (commit `a01eb46`)**
- `scripts/p4-pre-backup.ts` (TS, registered in `build.ts` optional entry points). Creates `~/.claudex/backups/pre-v4-P4-{ts}.db`, opens readonly, smoke-queries `pragma_user_version` + `artifacts/sessions/learnings` counts. Exits 1 with destination unlinked if zero rows in core tables.
- Backup verified: `pre-v4-P4-1777478253.db` (schema_version=18, 8859 artifacts, 989 sessions, 191 learnings).
- `05-SCOPE-DECISIONS.md` locks the 4 ambiguous-section verdicts (claudex_ready KEEP, learnings KEEP, project_overview DELETE Tier B, codebase_index MOVE-to-UPS Plan 06).
- `05-VESNA-BASELINE.md` captures pre-deletion baseline: phase-4-1-perceptual-similarity-probes 4/4 = 100% (proxy until Phase 10 lands the full ~20-probe suite).
- All 9 Phase 5 PLAN.md files, CONTEXT-AMENDMENT, and RESEARCH committed to git (they were untracked).

**Task 2 — Clock leaks + session-ID strips + host-env normalization (commit `a052d0d`)**
- `assembler.ts`:
  - `FullAssemblyParams.nowEpoch?: number` added (pinnable wall-clock).
  - `:572` STALE_OBS_CUTOFF: `params.nowEpoch ?? Date.now()/1000`.
  - `:657` lastSessionEpoch fallback: `params.nowEpoch ?? Date.now()/1000`.
  - `:447` `unixepoch() - 604800`: replaced with bound parameter `?` and computed cutoff (defensive; project_overview deletes in Plan 04).
  - `:646` `shortenPath`: extracted to exported `_shortenPathCacheStable`; normalizes `\\` → `/` BEFORE searching; hardcoded `'src/'` (no `path.sep`).
- `sections.ts`:
  - `:861` `getSessionAttribution`: returns `'prior session'` surrogate (no UUID slice); exported for tests.
  - `:1005-1006` `renderCuratedBlock`: omits session-UUID slice from provenance.
- 9 new probes in `src/tests/assembly/sections-cache-stability.test.ts`. Two pre-existing tests adjusted to assert the new "prior session" surrogate / no-UUID provenance.

**Task 3 — Tiebreakers + STATE.md parser + CRLF/BOM + .gitattributes + handoff spec (commit `ae383fb`)**
- Tiebreakers: `learnings.ts:60`, `artifacts.ts:178/:212/:222`, `codebase-indexer.ts:306` all append deterministic secondary sort keys.
- `parseStateMd` now exported; tolerates `**markdown bold**` headers; extracts `Current Phase Name`; supports decimal phases (`4.1`, `5`); preserves canonical `phase_string` for INJ-06 EXACT match.
- `GsdState` interface: `phase_string?: string` + `phase_name?: string`.
- `normalizeText()` in `src/shared/text-utils.ts`: strips BOM + rewrites CRLF/CR → LF. Applied at all 6 `fs.readFileSync` sites in `sections.ts`.
- `.gitattributes`: `* text=auto eol=lf` repo-wide.
- `05-HANDOFF-FRONTMATTER-SPEC.md`: documents the INJ-06 contract Plan 07 implements (status active + EXACT phase string equality).
- 6 new `parseStateMd` probes (decimal phases, phase_name, pure-function guarantee).

## Test counts

| Suite | Pre | Post | Δ |
|-------|-----|------|---|
| sections-cache-stability (new) | 0 | 9 | +9 |
| state-reader (extended) | 12 | 18 | +6 |
| sections.test.ts | 1 changed | 1 changed | 0 net |
| curated-context-section.test.ts | 1 changed | 1 changed | 0 net |
| **Net new tests** | | | **+15** |

All 171 (assembly + gsd + shared) and 421 core tests pass. `bun run build` green.

## Verification

- ✓ Backup file present: `~/.claudex/backups/pre-v4-P4-1777478253.db` opens read-only with all counts non-zero.
- ✓ `05-SCOPE-DECISIONS.md` contains "project_overview" with "DELETE" verdict.
- ✓ `05-VESNA-BASELINE.md` records 4/4 probe pass-rate (proxy).
- ✓ `bun run test src/tests/assembly/sections-cache-stability.test.ts` — 9 pass.
- ✓ `bun run test src/tests/gsd/state-reader.test.ts` — 18 pass.
- ✓ `bun run build` — 0 errors, all hook smoke tests green.
- ✓ `git check-attr text -- src/assembly/assembler.ts` shows `text: auto`.
- ✓ All 14 CACH-03 sites addressed: 3 clock + 2 session + 2 host + 4 tiebreaker + CRLF + STATE parser + handoff spec.

## Notes for downstream plans

- Plan 02 builds the 3-layer cache-stability harness on top of `_shortenPathCacheStable` + `params.nowEpoch` plumbing. Layer 2 (byte-identical SHA-256) and Layer 3 (clock/session/host invariance) now have hardening to lock against.
- Plan 04 deletes `project_overview` (~447); the defensive `?`-bound parameter at 447 is removed alongside the section.
- Plan 07 consumes `phase_string` from `GsdState` for the EXACT-match prime contract.
- The L3 `CLAUDEX_P4_INJECTION_MODE` env flag is NOT built upfront (per AMENDMENT — built lazily only if L3 fires).
