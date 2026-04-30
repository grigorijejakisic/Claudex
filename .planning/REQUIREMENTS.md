# Requirements: Claudex v4.1 — Distribution

**Defined:** 2026-04-30 (v4.1 milestone kickoff)
**Core Value:** A stranger clones Claudex, follows the README, and has a working session in <30 minutes with no insider knowledge.

> **v4.0 requirements** (STOR / EXTR / INJ / RETR / CUR / FRAM / LIFE / DIR-CONSUMER / HAND / TOK / CACH / CONT / VESN / OBS / ABL) are SHIPPED at v4.0.0 (2026-04-30) and live in `PROJECT.md` `## Requirements > Validated`. v4 deferrals carried forward to v4.2+ are listed below in this file under `## v4.2+ Requirements (Deferred)`.

## v4.1 Requirements

44 requirements across 7 categories. Each maps to a roadmap phase.

### Licensing & Metadata (LIC)

- [x] **LIC-01**: Repo root contains `LICENSE` file with MIT license text, current year (2026), "Grigorije Jakisic" as copyright holder
- [x] **LIC-02**: `package.json` removes `"private": true` and adds `"license": "MIT"`
- [x] **LIC-03**: `package.json` adds `"version": "4.1.0"`, `"repository"`, `"bugs"`, `"homepage"`, `"keywords"`, `"engines"` (Bun >=1.3)

### Documentation (DOC)

- [x] **DOC-01**: `README.md` at repo root explains what Claudex is and who it's for in <500 words, in plain English (not insider jargon)
- [x] **DOC-02**: README has a "Why Claudex" section that conveys the v4 thesis (organic memory tool use) with one concrete example
- [ ] **DOC-03**: README has a Quick Start section: clone → `bun run setup` → open Claude Code → working session, all in <30 minutes
- [ ] **DOC-04**: README has a Troubleshooting section covering Ollama not running, port 7439 dead, Bun version mismatch, hook registration failure
- [x] **DOC-05**: `CHANGELOG.md` at repo root with v4.0.0 release notes (16-phase summary + SC#1-#4 evidence)
- [x] **DOC-06**: `CONTRIBUTING.md` (or README section) covers development setup, running tests (`bun run test` not `bun test`), commit conventions

### Cross-Platform (PLAT)

- [x] **PLAT-01**: All path handling uses `path.join` / `path.resolve` (no hardcoded `\\` separators); audit `src/` exhaustively — closed in Phase 13 (13-01 audit confirmed src/ already clean: 39 hits all keep-with-reason)
- [x] **PLAT-02**: Hook scripts run on Mac/Linux without modification (no PowerShell-only constructs, correct shebangs, file permissions handled) — closed in Phase 13 (13-02 audit found 0 PowerShell constructs in src/adapters/cc-hooks/)
- [x] **PLAT-03**: File-lock handling works on Mac/Linux (current Windows uses `taskkill`; Unix uses signal-based termination) — closed in Phase 13 (13-03 introduced src/shared/process-control.ts with terminateProcess + 8 unit tests; 0 callsites needed migration)
- [x] **PLAT-04**: Subprocess spawning works cross-platform (no `cmd /c` chains; uses Node `spawn` or Bun `$` portably) — closed in Phase 13 (13-02 audit + 13-04 fix: heartbeat.ts:202 git auto-commit refactored from shell-string execSync to no-shell execFileSync array args)
- [x] **PLAT-05**: Line endings normalized via `.gitattributes` (LF for source, CRLF for batch scripts) — closed in Phase 13 (13-05 extended .gitattributes with explicit per-extension rules; renormalize converted experience-patterns.ts CRLF→LF)
- [ ] **PLAT-06**: Install verified end-to-end on macOS (latest stable) on a fresh VM; friction captured as test fixtures
- [ ] **PLAT-07**: Install verified end-to-end on Linux (Ubuntu 24.04 LTS) on a fresh VM; friction captured as test fixtures
- [ ] **PLAT-08**: Install verified end-to-end on Windows 11 on a fresh VM; regression check (current development platform)

### Setup & Install (INST)

- [ ] **INST-01**: One-command bootstrap (`bun run setup` and/or `./install.sh`) sets up everything from clean clone, returns 0 on success
- [ ] **INST-02**: Bootstrap detects Ollama; if missing, prints platform-specific install instruction and exits 1
- [ ] **INST-03**: Bootstrap pulls `snowflake-arctic-embed2` model via Ollama (idempotent — skips if already pulled)
- [ ] **INST-04**: Bootstrap starts BGE reranker service on port 7439 (Python venv setup + dependencies + boot) or prints actionable failure
- [ ] **INST-05**: Hardcoded `~/Desktop/Projects/` path replaced with configurable `CLAUDEX_PROJECTS_DIR` env var (default: `~/Projects/` cross-platform)
- [ ] **INST-06**: MCP server registration uses the configurable projects directory; existing project registry migrates to new path conventions
- [ ] **INST-07**: First-session UX: after `bun run setup`, opening Claude Code in any project produces working assembly within 1 user turn

### Diagnostics (DIAG)

- [ ] **DIAG-01**: `bun run doctor` command exists and is documented in README
- [ ] **DIAG-02**: Doctor checks Bun version (>=1.3) — pass / fail / version-found
- [ ] **DIAG-03**: Doctor checks Ollama running + `snowflake-arctic-embed2` model pulled
- [ ] **DIAG-04**: Doctor checks BGE reranker reachable on port 7439 (HTTP probe)
- [ ] **DIAG-05**: Doctor checks `~/.claudex/db/claudex.db` exists and schema version matches build
- [ ] **DIAG-06**: Doctor checks Claude Code hooks registered (reads CC settings, finds Claudex hooks)
- [ ] **DIAG-07**: Doctor checks Angel process alive (PID file + heartbeat freshness)
- [ ] **DIAG-08**: Doctor returns exit 0 if all pass, exit 1 with actionable error per failed check

### Verification (VER)

- [ ] **VER-01**: Onboarding fixture document at `docs/onboarding/macos.md` records every friction encountered installing on a fresh macOS VM
- [ ] **VER-02**: Onboarding fixture at `docs/onboarding/linux.md` for Ubuntu 24.04 LTS VM
- [ ] **VER-03**: Onboarding fixture at `docs/onboarding/windows.md` for Windows 11 VM (regression check)
- [ ] **VER-04**: Each friction point in the three fixtures is resolved as: a code fix (preferred), a doctor check, or a README troubleshooting entry — none left as open
- [ ] **VER-05**: <30 minute install target measured and met on each platform; total elapsed time recorded in fixture

### Release & Ship (REL)

- [ ] **REL-01**: Public GitHub remote configured pointing to `github.com/grigorijejakisic/claudex`
- [ ] **REL-02**: Initial push includes complete master history + all tags (v4.0.0 + v4.1.0)
- [ ] **REL-03**: `v4.1.0` annotated git tag created and pushed
- [ ] **REL-04**: GitHub release for v4.1.0 published with notes derived from `CHANGELOG.md`
- [ ] **REL-05**: Repository topics set on GitHub for discoverability (final list TBD; candidates: `claude-code`, `mcp`, `agent-memory`, `llm-tools`, `typescript`, `bun`)
- [ ] **REL-06**: README badges (license, version, build status) display correctly on GitHub
- [ ] **REL-07**: Branch protection rule for Vesna CI applied via GitHub UI (manual step from Phase 10 carry-forward)

## v4.2+ Requirements (Deferred)

Tracked but not in v4.1 roadmap.

### Multi-Harness Support
- **MULTI-01**: Cursor adapter — Cursor lacks Claude Code's hook lifecycle; needs separate adapter layer
- **MULTI-02**: Zed adapter
- **MULTI-03**: Generic harness contract enabling third-party adapters

### v4 Internal Carry-Forward
- **EXTR-04**: Detector precision held-out recall measurement + `negation_dont` family tune
- **EXTR-06**: Transcript chunking via LLM topic-segmentation (Phase 4.1 partial)
- **STOR-09**: Task-pattern fingerprint column on artifact kinds (write-time auto-classification)
- **LIFE-01..04**: Directive lifecycle (scope detection, supersession, decay, accumulation)
- **DIR-CONSUMER-01..02**: PreToolUse hook surface for directives
- **FRAM-05**: Week-of-use behavioral A/B subjective verdict (separately tracked, due 2026-05-06)
- **HAND-03**: Handoff pickup probe live trials (synthetic 3/3 already shipped at v4.0.0)

### v5 (Future Milestone)
- **V5-EPISODIC**: Episodic memory layer / Angel evolution per `.planning/research/2026-04-30-v5-episodic-memory.md` — out of scope for v4.x; standalone milestone

## Out of Scope

Explicit exclusions for v4.1.

| Feature | Reason |
|---------|--------|
| Hosted/SaaS variant | Self-host only by milestone decision; revisit post-v5 if at all |
| Cursor / Zed / generic harness adapters | v4 was built for Claude Code's hook lifecycle; multi-harness is structurally different work and warrants its own milestone |
| v5 episodic memory architecture | Captured at `.planning/research/2026-04-30-v5-episodic-memory.md`; separate future milestone |
| Aggressive RL stack re-introduction | RL deleted in Phase 9.8 (verdict DELETE_ALLOWED); not coming back in v4.1 |
| New v4-internal feature work | The carry-forward items are cleanup, separate from Distribution intent |
| Marketing site / `claudex.dev` domain | Distribution = make it installable; promotion is v4.2+ activity |
| Public benchmark gates (LongMemEval, LoCoMo, BENCH-09) | DROPPED at audit 2026-04-27; harness on disk only; archival vibe-check non-gating |

## Traceability

Updated 2026-04-30 during v4.1 roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| LIC-01 | Phase 12 | Done |
| LIC-02 | Phase 12 | Done |
| LIC-03 | Phase 12 | Done |
| DOC-01 | Phase 12 | Done |
| DOC-02 | Phase 12 | Done |
| DOC-03 | Phase 16 | Pending |
| DOC-04 | Phase 16 | Pending |
| DOC-05 | Phase 12 | Done |
| DOC-06 | Phase 12 | Done |
| PLAT-01 | Phase 13 | Done |
| PLAT-02 | Phase 13 | Done |
| PLAT-03 | Phase 13 | Done |
| PLAT-04 | Phase 13 | Done |
| PLAT-05 | Phase 13 | Done |
| PLAT-06 | Phase 16 | Pending (HITL — fresh macOS VM) |
| PLAT-07 | Phase 16 | Pending (HITL — fresh Ubuntu 24.04 VM) |
| PLAT-08 | Phase 16 | Pending (HITL — fresh Windows 11 VM) |
| INST-01 | Phase 14 | Pending |
| INST-02 | Phase 14 | Pending |
| INST-03 | Phase 14 | Pending |
| INST-04 | Phase 14 | Pending |
| INST-05 | Phase 14 | Pending |
| INST-06 | Phase 14 | Pending |
| INST-07 | Phase 14 | Pending |
| DIAG-01 | Phase 15 | Pending |
| DIAG-02 | Phase 15 | Pending |
| DIAG-03 | Phase 15 | Pending |
| DIAG-04 | Phase 15 | Pending |
| DIAG-05 | Phase 15 | Pending |
| DIAG-06 | Phase 15 | Pending |
| DIAG-07 | Phase 15 | Pending |
| DIAG-08 | Phase 15 | Pending |
| VER-01 | Phase 16 | Pending (HITL fixture — macOS) |
| VER-02 | Phase 16 | Pending (HITL fixture — Ubuntu 24.04) |
| VER-03 | Phase 16 | Pending (HITL fixture — Windows 11) |
| VER-04 | Phase 16 | Pending |
| VER-05 | Phase 16 | Pending (HITL — measured per platform) |
| REL-01 | Phase 17 | Pending |
| REL-02 | Phase 17 | Pending |
| REL-03 | Phase 17 | Pending |
| REL-04 | Phase 17 | Pending |
| REL-05 | Phase 17 | Pending |
| REL-06 | Phase 17 | Pending |
| REL-07 | Phase 17 | Pending (manual GitHub UI step from Phase 10 carry-forward) |

**Coverage:**
- v4.1 requirements: 44 total
- Mapped to phases: 44 ✓
- Unmapped: 0 ✓
- Phase distribution:
  - Phase 12: 7 reqs (LIC-01..03, DOC-01, DOC-02, DOC-05, DOC-06)
  - Phase 13: 5 reqs (PLAT-01..05)
  - Phase 14: 7 reqs (INST-01..07)
  - Phase 15: 8 reqs (DIAG-01..08)
  - Phase 16: 10 reqs (PLAT-06..08, VER-01..05, DOC-03, DOC-04)
  - Phase 17: 7 reqs (REL-01..07)

---
*Requirements defined: 2026-04-30 (v4.1 milestone kickoff)*
*Traceability mapped: 2026-04-30 (v4.1 roadmap creation)*
*Last updated: 2026-04-30*
