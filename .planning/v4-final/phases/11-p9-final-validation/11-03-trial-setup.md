# SC#4 Trial Setup — Pre-Committed Cold-Start Conditions

**Date:** 2026-04-30
**Inventory commit:** 79cee63 (post Plan 11-01 close)

Trial setup is captured BEFORE running any cold-start session, so the prompt isn't post-hoc reverse-engineered to fit observed agent behavior. Per Plan 11-03 spec.

## Handoff inventory

Across the 6 active projects measured by SC#3, 5 have an ACTIVE.md present and 4 of those have `status: active` with parseable frontmatter. Inventory script: `node` against `~/.claudex/projects.json` + `context/handoffs/ACTIVE.md` per project.

| Project | Status | Topic preview |
|---|---|---|
| claudex-v3 | active | `2026-04-27-phase-4-1` (now superseded by Phase 11 in-progress) |
| lacuna-betting-9f1d552c | active | "Handoff: Session 51 continued — FULL REGISTRY-BASED REFACTOR of big-mozzart-clean..." |
| oracle-3951898e | active | "Oracle — Session 9 to Session 10 transfer" (frontmatter prepended in Plan 11-01) |
| big-mozzy-v2 | active | "Handoff v2-handoff-12 — Matcher overhaul, telegram simplified, STOMP+CDP watchdogs..." |
| desktop-01dcc792 | NO HANDOFF FILE | n/a (CWD-level project; no handoffs/ dir) |
| nexus-e53c6c93 | (no-frontmatter) | (Plan 11-03 will not pick Nexus — frontmatter is malformed) |

## Diversity selection (per Plan 11-03 spec)

Selecting **3 projects with distinct topics**:

1. **claudex-v3** — internal-infrastructure ship gate (Phase 11)
2. **lacuna-betting-9f1d552c** — production betting bot rate-limit + matcher refactor
3. **big-mozzy-v2** — matcher overhaul + watchdog systems for parallel betting bot

Three distinct domains: agent infrastructure, scraping/rate-limit production system, real-time-matching production system.

## Pre-committed natural user prompts (locked BEFORE trials)

### Trial 1 — claudex-v3
**Pre-committed prompt:** `"where were we on phase 11?"`

This is the exact phrasing a returning user would naturally type to resume Phase 11 work. The active handoff topic is `2026-04-27-phase-4-1` but the *current state* (per STATE.md) is Phase 11 in progress. The right pickup is to read ACTIVE.md, recognize it points to phase-4-1 work that was superseded by current Phase 11, and address Phase 11 — not exploratory grep across `src/`.

**Allowed handoff-referenced reads:**
- `context/handoffs/ACTIVE.md`
- `.planning/STATE.md` (named in CLAUDE.md as canonical state file)
- `.planning/phases/11-p9-final-validation/11-CONTEXT.md` (cited in active session work)
- MEMORY.md (auto-loaded; not exploratory)

### Trial 2 — lacuna-betting-9f1d552c
**Pre-committed prompt:** `"what's the status on Mozzart?"`

Lacuna's active handoff focuses on the registry-based refactor + Cloudflare 429 rate limit. The natural returning question is "Mozzart status" — agent should pick up the ACTIVE.md handoff topic without exploratory glob across `src/`.

**Allowed handoff-referenced reads:**
- `context/handoffs/ACTIVE.md`
- Files explicitly cited in lacuna's ACTIVE.md (e.g. `big-mozzart-clean/SubgameMap.ts` if named there)
- MEMORY.md

### Trial 3 — big-mozzy-v2
**Pre-committed prompt:** `"how did the matcher do overnight?"`

big-mozzy's active handoff opens on overnight observation window for big-balkan + matcher overhaul. The user's natural returning question post-overnight-soak is matcher status. Agent should pick up via ACTIVE.md without exploratory grep.

**Allowed handoff-referenced reads:**
- `context/handoffs/ACTIVE.md`
- Files cited in big-mozzy's ACTIVE.md
- MEMORY.md

## Procedure for the trial-runner (operator-driven HITL)

The Phase 11 executor cannot run true cold-start sessions inside its own (hot) context. Per Plan 11-03 fallback: HITL-pending placeholders with exact procedure for the operator. Each trial:

1. Open a NEW Claude Code session in the project's CWD with `/clear` (or fresh terminal).
2. Wait for session-start banner to render.
3. Send the pre-committed prompt verbatim.
4. Capture the agent's complete first response in chronological tool-call order.
5. Classify each tool call as handoff-referenced (allowed) or exploratory (fails the trial).
6. Paste the captured transcript into the corresponding `11-03-cold-start-trial-N.md` placeholder.

**Honesty gate:** the executor MUST NOT fabricate trials or roleplay them. The 3 placeholders below carry verdict `HITL-PENDING` until the operator runs them, with the Vesna synthetic counterpart serving as the under-executor-control evidence.
