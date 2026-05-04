# Phase 12: Metadata + License + README Foundation — Context

**Gathered:** 2026-04-30 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + v4.1 milestone kickoff conversation)
**Status:** Ready for planning
**Generative axiom:** Strangers landing on `github.com/grigorijejakisic/Claudex` should — within 60 seconds of reading the repo — understand what Claudex is, who it's for, why it matters, and that it's MIT-licensed and documented enough to attempt installation.

---

<domain>
## Phase Boundary

This phase delivers seven things and ONLY these seven:

1. **LIC-01:** `LICENSE` file at repo root with MIT text, copyright "2026 Grigorije Jakisic"
2. **LIC-02:** `package.json` removes `"private": true` and adds `"license": "MIT"`
3. **LIC-03:** `package.json` adds `"version": "4.1.0"`, `"repository"`, `"bugs"`, `"homepage"`, `"keywords"`, `"engines"` (Bun >=1.3)
4. **DOC-01:** `README.md` rewritten — explains what Claudex is and who it's for in <500 words, plain English (insider jargon banned)
5. **DOC-02:** README "Why Claudex" section conveys the v4 thesis (organic memory tool use) with one concrete example (the canonical shadowban example from PROJECT.md core value)
6. **DOC-05:** `CHANGELOG.md` at repo root with v4.0.0 release notes — 16-phase summary + SC#1-#4 evidence
7. **DOC-06:** `CONTRIBUTING.md` (or README section) covering development setup, `bun run test` (NOT `bun test`), commit convention

**Out of scope:**
- Quick Start section in README (DOC-03) — defers to Phase 16, can't be honest until Phase 14's `bun run setup` works
- Troubleshooting section in README (DOC-04) — defers to Phase 16, references `bun run doctor` which Phase 15 ships
- Cross-platform code changes — Phase 13's territory
- Bootstrap install logic — Phase 14's territory
- Diagnostics tooling — Phase 15's territory
- Onboarding fixtures — Phase 16's territory
- Public push / tag / release — Phase 17's territory

**Hard gates:**
- README must NOT cite stale v3 numbers or claims — current README has "Persistent memory, incremental checkpointing, and context-aware intelligence" framing which is v3-era
- CHANGELOG must NOT reintroduce benchmarks as gates (audit decision — see PROJECT.md Q8)
- Phase 7 advisory-voice rewrite means README/CHANGELOG should also use observational tone where possible, but this isn't blocking — those formatters were the agent surfaces, not human-facing docs
- No emoji unless the user has authorized them (user hasn't; default no)
- Build must remain green after package.json changes — `"private": true` removal can break some publish-related tooling but `bun run build` and `bun run test` should keep working

</domain>

<decisions>
## Implementation Decisions

### LICENSE (LIC-01)
- **Format:** Standard MIT (https://choosealicense.com/licenses/mit/) with `Copyright (c) 2026 Grigorije Jakisic`
- **Location:** Repo root as `LICENSE` (no `.md` extension — convention)
- **No deviations** from boilerplate text

### package.json metadata (LIC-02, LIC-03)
- `private: true` → remove
- `license: "MIT"` → add (top-level)
- `version: "4.1.0"` → set explicitly (was likely "0.0.1" or absent)
- `repository`: `{ "type": "git", "url": "git+https://github.com/grigorijejakisic/Claudex.git" }`
- `bugs`: `{ "url": "https://github.com/grigorijejakisic/Claudex/issues" }`
- `homepage`: `"https://github.com/grigorijejakisic/Claudex#readme"`
- `keywords`: `["claude-code", "mcp", "agent-memory", "llm-tools", "typescript", "bun", "claudex", "persistent-memory", "claude"]`
- `engines`: `{ "bun": ">=1.3" }` — Bun is the runtime; package.json's `engines` is advisory not enforced for bun, but it documents the dependency
- `author` field not specified in REQUIREMENTS.md — add as `"Grigorije Jakisic"` for consistency with LICENSE copyright

### README (DOC-01, DOC-02)
- **Length target:** 500 words for the "what is Claudex" + "why Claudex" sections combined; total file longer is fine but the front matter (above the fold) must be tight
- **Structure (top-down):**
  1. Logo / project title (just text — no logo yet)
  2. One-line tagline
  3. Status badges (placeholders — actual badges populate in Phase 17 once CI gates green on public repo)
  4. **What is Claudex?** (~150 words, plain English)
  5. **Why Claudex?** (~250 words, concrete example)
  6. Quick Start placeholder linking to Phase 16 work (or "Coming soon — see CHANGELOG")
  7. Links to docs (.claude/rules/, CHANGELOG, CONTRIBUTING)
  8. License footer
- **Tone:** Direct, technical-literate-but-not-condescending. Match the user's voice in PROJECT.md. No marketing fluff.
- **The concrete example for DOC-02:** verbatim from PROJECT.md core value — "if last session we discovered '60 HTTP polls to backend X = 15-min IP shadowban', and this session user says 'investigate another backend for intel gathering,' the agent should automatically (1) recognize this is rate-limit-research-shaped work, (2) recall the shadowban finding, (3) apply it to scoping — all without being told to query memory."
- **What to AVOID:** vague claims ("revolutionary", "AI-powered"), feature lists without context, install instructions that don't yet work, comparisons to other systems (Mem0/Letta — these can go in a separate "Compared to" doc later if desired)

### CHANGELOG (DOC-05)
- **Format:** [Keep a Changelog](https://keepachangelog.com/) convention (Added/Changed/Deprecated/Removed/Fixed/Security headers)
- **Sections:**
  - **`## [4.0.0] — 2026-04-30`** — the initial public-eligible release
  - **`### Added`** — new v4 capabilities (advisory voice, Vesna probe suite, recall observability, cross-project recall, retrieval simplification, lessons section, etc.)
  - **`### Changed`** — what shifted from v3 (assembly pipeline rewrite, MEMORY.md schema, etc.)
  - **`### Removed`** — the deletion phases (Phase 9 cognitive layer, RL stack, legacy `_old` tables via V24, benchmark gates)
  - **`### Fixed`** — Phase 4.1 writer regression, mixed-precision timestamps, etc.
- **Phase summary:** brief — 16 phases each named with one-line accomplishment, NOT a re-narration of every commit
- **SC#1-#4 evidence:** one paragraph noting Vesna 17/17, cache-stable 12/12, MEMORY.md aggregate 90, handoff pickup 3/3
- **Pre-v4 history:** acknowledge v3 existed, link to commit history, but do NOT itemize. v3 era was internal — public history begins at v4.0.0.
- **Footer:** `## [Unreleased]` placeholder for v4.1 to add as it lands

### CONTRIBUTING (DOC-06)
- **Decision:** ship as `CONTRIBUTING.md` at repo root (separate file), not as a README section. Convention; GitHub auto-surfaces it.
- **Coverage:**
  - Development setup (clone, `bun install`, build)
  - Running tests: **`bun run test`** (vitest), with explicit warning that `bun test` invokes Bun's native runner and will produce confusing failures
  - Commit convention: Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `phase(NN):`); atomic per task; co-authored where applicable
  - PR workflow: Vesna CI must be green; SC#1 ≥80% per category; SC#2 cache-stable; SC#3 MEMORY.md content quality
  - Hook safety rule (no CC CLIProxyAPI calls from hooks — deadlock)
  - Reference to `.claude/rules/` for deeper architectural context (loaded conditionally during work)

</decisions>

<integration_points>
## Integration Points

- **PROJECT.md `## Current Milestone: v4.1 — Distribution`:** ground truth for milestone scope. README's "Why Claudex" section pulls from PROJECT.md core value verbatim.
- **`.claude/rules/`:** internal architectural rules; CONTRIBUTING.md links here as the deeper-dive surface for contributors editing schema/hooks/Angel.
- **PROJECT.md `## Key Decisions` table:** CHANGELOG references Q1-Q12 audit decisions implicitly via the phase-by-phase summary.
- **`.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md`:** SC#1-#4 evidence rollup for CHANGELOG's release-notes section.
- **`.planning/phases/<N>-*/**-SUMMARY.md`:** the per-phase completion notes are the source material for the CHANGELOG's phase summaries — but CHANGELOG should distill, not copy.
- **Existing `package.json`:** has dependencies, scripts, version. Need to read it to understand current state before editing.
- **Existing `README.md`:** is v3-era. Will be REPLACED, not patched.
- **Build pipeline:** `bun run build` (esbuild) outputs to `dist/`. Adding metadata fields shouldn't affect build.
- **CI pipeline:** `.github/workflows/vesna.yml` runs SC#1; CHANGELOG should reference this as the merge gate.

</integration_points>

<acceptance>
## Acceptance Criteria

The phase is closed when:

1. `LICENSE` file exists at repo root, contains MIT text with `Copyright (c) 2026 Grigorije Jakisic`, no deviations from MIT boilerplate
2. `package.json` has `"license": "MIT"` and lacks `"private": true`; has `"version": "4.1.0"`; has `repository`, `bugs`, `homepage`, `keywords`, `engines.bun: ">=1.3"`
3. `README.md` at repo root is <500 words for the What+Why sections combined; "Why Claudex" includes the verbatim shadowban concrete example from PROJECT.md core value; no v3-era claims, no benchmarks-as-gates language, no marketing fluff
4. `CHANGELOG.md` at repo root has `## [4.0.0] — 2026-04-30` with Added/Changed/Removed/Fixed sections and SC#1-#4 evidence paragraph
5. `CONTRIBUTING.md` at repo root explains dev setup, `bun run test` (with `bun test` warning), commit convention, PR workflow, hook safety rule
6. `bun run build` produces `dist/` clean (package.json changes don't break build)
7. `bun run test` passes the same 3000+ tests it passed at v4.0.0 ship (no regressions from this phase)
8. Atomic commits per task following the existing `phase(NN):` convention; SUMMARY.md per plan; phase-close commit at the end
9. STATE.md/ROADMAP.md/REQUIREMENTS.md updated at phase close (Phase 12 row → `[x]`; LIC-01..03 + DOC-01/02/05/06 → `[x]` in REQUIREMENTS.md traceability)

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Choose between "CONTRIBUTING.md as separate file" (preferred per `<decisions>`) vs "CONTRIBUTING section in README" (acceptable fallback if file becomes unwieldy)
- Decide whether to merge LIC-02 + LIC-03 into one task or split (split is bisectable; merge is faster; either works for ~30-line edit)
- Reference any v4 phase SUMMARY.md or VESNA-RESULT.md when drafting CHANGELOG Phase summaries
- Skip the placeholder badges in README (since CI is on private repo currently); add them in Phase 17 once public CI is green

The plan-phase agent does NOT have authority to:

- Add Quick Start or Troubleshooting sections to README — those are explicitly Phase 16's territory
- Modify cross-platform code (paths, hooks, file locks) — Phase 13's territory
- Change the SC#1-#4 success criteria definitions
- Reintroduce benchmarks-as-gates language anywhere
- Replace the canonical shadowban example with a different one without reason

</plan_authorization>

<open_questions>
## Open Questions

None at phase-context creation time. All scope decisions for Phase 12 are locked from the v4.1 milestone kickoff conversation (license MIT, platforms Win+Mac+Linux, harness Claude Code only, self-host only). Phase 12 specifically is mechanical document/metadata work with the structural decisions above.

If the plan-phase agent surfaces a question that genuinely needs operator input mid-flow, it should SendMessage team-lead and wait — but the bar is "this changes the deliverable shape" not "I want to confirm an obvious choice."

</open_questions>
