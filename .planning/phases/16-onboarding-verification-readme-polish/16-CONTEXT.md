# Phase 16: Onboarding Verification + README Polish — Context

**Gathered:** 2026-05-02 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + Phase 14/15 outputs)
**Status:** Ready for planning
**Generative axiom:** Strangers picking up `git clone` on Mac, Linux, or Windows can install Claudex in <30 minutes following `README.md` alone, with `bun run doctor` confirming health when something's off. This phase closes the loop between Phase 14 (bootstrap built) + Phase 15 (doctor built) and the public ship in Phase 17.

---

<domain>
## Phase Boundary

This phase delivers ten requirements split between AUTONOMOUS work and HITL (operator-driven) work. The phase closes structurally with HITL-pending live trials — same pattern as Phase 11 SC#4 cold-start trials.

### AUTONOMOUS deliverables (this phase ships these to disk):

1. **DOC-03 (autonomous):** README Quick Start section walks through clone → `bun run setup` → working session in <30 minutes; references real commands shipped by Phase 14
2. **DOC-04 (autonomous):** README Troubleshooting section covers Ollama not running, port 7439 dead, Bun version mismatch, hook registration failure — references `bun run doctor` (Phase 15) as the first diagnostic step
3. **VER-01 (structural autonomous):** `docs/onboarding/macos.md` runbook — operator-runnable doc with step-by-step commands + sections for "expected output" and "[OPERATOR FILL-IN: friction encountered, elapsed time]"
4. **VER-02 (structural autonomous):** `docs/onboarding/linux.md` runbook — Ubuntu 24.04 LTS focus, same structure as macos.md
5. **VER-03 (structural autonomous):** `docs/onboarding/windows.md` runbook — Windows 11 focus, same structure (this is regression check on the platform we're already running, so could be filled in here)

### HITL deliverables (operator runs on real VMs; close conditional):

6. **PLAT-06 (HITL):** macOS install verified end-to-end on a fresh VM; runbook completed with friction + elapsed time
7. **PLAT-07 (HITL):** Ubuntu 24.04 LTS install verified end-to-end on a fresh VM; runbook completed
8. **PLAT-08 (HITL):** Windows 11 install verified on a fresh VM (regression check); runbook completed
9. **VER-04 (HITL-driven):** every friction surfaced in VER-01..03 fixtures resolved as code fix / doctor check / README troubleshooting entry — none open
10. **VER-05 (HITL-driven):** <30-minute install target measured + met on each platform OR documented gap with remediation plan

**Out of scope:**
- Public push → Phase 17
- New features
- Multi-harness adapters (Cursor/Zed) → v4.2+
- Hosted/SaaS variant → v4.2+

**Hard gates (autonomous half):**
- `bun run build` green throughout
- `bun run test` 3188 baseline + any new tests + 20 baseline llama failures unchanged from v4.0.0; anything beyond is regression
- `bun run vesna` 17/17 PASS at phase close (SC#1 holds)
- `bun run doctor` continues to exit 0 on this Windows machine
- DB schema unchanged
- Hook semantics unchanged
- README final length: full file as-shipped should remain reasonable (≤2000 lines incl. all sections); Quick Start + Troubleshooting must use the verbatim commands from Phase 14/15 (no fabrication of CLI shapes)

**HITL gates (deferred close):**
- Phase 16 closes STRUCTURALLY with autonomous deliverables on disk + runbook docs ready for operator use. The full close (PLAT-06..08 + VER-04/05 satisfied) waits on operator-driven VM trials.
- Pattern matches Phase 11 SC#4: synthetic Vesna 3/3 PASS shipped autonomously; live cold-start trials remained operator-runnable. v4.1 ships to GitHub with HITL-pending status preserved.

</domain>

<decisions>
## Implementation Decisions

### README Quick Start (DOC-03)
- **Location:** README section, between "Why Claudex" and "Troubleshooting"
- **Content shape (concrete, copy-paste-able):**
  1. Prereqs: Bun >=1.3, Ollama, Python 3.11+ (with one-line install link per OS)
  2. Clone: `git clone https://github.com/grigorijejakisic/Claudex.git && cd Claudex` (note: capital C in URL matches actual repo)
  3. Install: `./install.sh` (Mac/Linux) or `install.bat` (Windows) — single command
  4. Verify: `bun run doctor` — should exit 0 with all checks passing
  5. Use: open Claude Code in any project under `CLAUDEX_PROJECTS_DIR` (default `~/Projects`); first turn shows assembly pipeline working
- **Length target:** ≤80 lines (terse, action-first, no tutorials)
- **Tone:** direct technical-literate; no "in just minutes!" marketing
- **Honest gaps to document:** if `bun run setup` requires manual Ollama daemon start on first use (depends on platform), say so. Don't lie about smoothness.
- **What to AVOID:** referencing commands that don't exist yet, fabricating expected output without running locally, listing platform support beyond what we can claim

### README Troubleshooting (DOC-04)
- **Location:** README section, after Quick Start
- **Structure:** problem → diagnostic command → resolution
- **Topics required (from REQUIREMENTS.md):**
  - Ollama not running → `bun run doctor` (Ollama check); resolution: start `ollama serve`
  - Port 7439 dead → `bun run doctor` (Reranker check); resolution: re-run setup or check Python venv
  - Bun version mismatch → `bun run doctor` (Bun check); resolution: upgrade Bun
  - Hook registration failure → `bun run doctor` (CC hooks check); resolution: re-run `bun run setup`
- **Pattern:** "Symptom: X. Run: `bun run doctor`. If [check] reports Y: [fix]."
- **Length target:** ≤120 lines
- **Reference the doctor first:** doctor IS the diagnostic surface; troubleshooting docs should always start with "run doctor" before listing manual diagnostic commands

### Onboarding fixtures (VER-01..03)
- **Location:** `docs/onboarding/macos.md`, `docs/onboarding/linux.md`, `docs/onboarding/windows.md`
- **Shape per fixture:**
  ```markdown
  # Onboarding Fixture: <PLATFORM>
  
  **Status:** [HITL-PENDING / IN-PROGRESS / COMPLETE]
  **Operator:** [name]
  **Date:** [YYYY-MM-DD]
  **VM image:** [e.g., macOS 14 fresh, Ubuntu 24.04 LTS minimal, Windows 11 Pro fresh]
  **Elapsed time:** [HH:MM]
  
  ## Step-by-step (autonomous content; operator runs)
  
  ### 1. Install Bun
  Command: `curl -fsSL https://bun.sh/install | bash` (Mac/Linux) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows)
  Expected: `bun --version` returns >=1.3
  Friction: [OPERATOR FILL-IN]
  
  ### 2. Install Ollama
  ...
  
  ### 3. Clone repo
  ...
  
  ### 4. Run install
  Command: `./install.sh` (or `install.bat`)
  Expected output: setup steps complete, exit 0
  Friction: [OPERATOR FILL-IN]
  
  ### 5. Verify with doctor
  Command: `bun run doctor`
  Expected: 7 checks, all ✓
  Friction: [OPERATOR FILL-IN]
  
  ### 6. First session
  Open Claude Code in a project directory under CLAUDEX_PROJECTS_DIR.
  Expected: SessionStart hook injects context within 1 user turn.
  Friction: [OPERATOR FILL-IN]
  
  ## Friction summary
  
  [OPERATOR FILL-IN: list each friction; classify as code-fix-needed / doctor-check-needed / README-troubleshooting-needed / acceptable-as-is]
  
  ## Resolutions
  
  [OPERATOR FILL-IN: link to commit / PR / doctor check / README section that resolves each friction]
  ```
- **Windows fixture:** since the orchestrator IS running on Windows, this fixture can be partially filled in autonomously — known Windows install state matches reality. Steps 4-6 can be marked "verified on this machine" with current state. Steps 1-3 stay HITL-pending for genuine fresh-VM check.

### Phase close — partial-with-HITL pattern
- **Closes structurally:** README sections + 3 runbooks on disk; STATE/ROADMAP/REQUIREMENTS reflect HITL-pending status (NOT [x] for PLAT-06..08 / VER-04..05; mark as `[~]` or `[HITL]` in checklists)
- **REQUIREMENTS.md traceability:** PLAT-06..08 and VER-04..05 marked `Pending (HITL)` in status column
- **ROADMAP.md Phase 16 row:** `Structural complete, HITL-pending — 2026-05-02 (operator runs gate full close)`
- **STATE.md status:** notes Phase 16 structural close, Phase 17 unblocked for autonomous parts (push/tag/release/topics; branch protection remains HITL UI step)
- **What this enables:** v4.1 can ship to GitHub (Phase 17) with HITL items deferred — this is acceptable per the same pattern as Phase 11. The operator-driven VM trials become a follow-up that doesn't block public visibility.

### Tone & content rules
- No emoji unless authorized (default no)
- No fabricated expected output — if we don't know what `ollama pull` prints on Linux, say so
- No marketing language; technical-literate-but-direct
- Match user's voice in PROJECT.md and existing CHANGELOG.md
- Reference real artifacts: Phase 14 install.sh / install.bat, Phase 15 `bun run doctor`, Phase 12 README headline

</decisions>

<integration_points>
## Integration Points

- **Existing README.md:** Phase 12 shipped What+Why; Quick Start placeholder reads "Coming in v4.1" — this phase REPLACES that placeholder
- **Existing CHANGELOG.md:** Phase 12 shipped v4.0.0 release notes; Phase 16 should add `[Unreleased]` entry noting v4.1 onboarding work
- **Phase 14 outputs:** `install.sh`, `install.bat`, `bun run setup`, `CLAUDEX_PROJECTS_DIR` env var — README Quick Start uses these verbatim
- **Phase 15 outputs:** `bun run doctor`, the 7 checks — README Troubleshooting references these as the diagnostic surface
- **Phase 11 pattern:** `.planning/phases/11-p9-final-validation/11-03-cold-start-trial-{1,2,3}.md` — operator-runnable runbooks with HITL-pending status. Use this pattern for VER-01..03.
- **Existing CONTRIBUTING.md (Phase 12):** has `bun run test` warning + commit conventions. Cross-reference but don't duplicate.
- **`docs/` directory:** doesn't exist yet. Create at repo root for `docs/onboarding/`.

</integration_points>

<acceptance>
## Acceptance Criteria

**Structural close (this phase ships):**

1. README has Quick Start section between Why Claudex and Troubleshooting; <80 lines; references real Phase 14/15 commands
2. README has Troubleshooting section after Quick Start; <120 lines; pattern symptom → `bun run doctor` → resolution
3. `docs/onboarding/macos.md` exists with autonomous content + `[OPERATOR FILL-IN]` placeholders
4. `docs/onboarding/linux.md` exists with autonomous content + `[OPERATOR FILL-IN]` placeholders
5. `docs/onboarding/windows.md` exists with autonomous content; steps 4-6 (post-install verification) can be partially filled from current Windows state since v4 IS installed here
6. CHANGELOG.md `[Unreleased]` section notes v4.1 onboarding fixtures shipped
7. `bun run build` green; `bun run test` ≥3188 baseline + 20 llama unchanged; `bun run vesna` 17/17; `bun run doctor` exits 0
8. Atomic commits using `phase(16):` convention; SUMMARY.md per plan; phase-close commit at end with STATE/ROADMAP/REQUIREMENTS updates

**HITL-pending close (deferred to operator):**

9. PLAT-06..08 → operator-driven fresh-VM trials; runbooks completed
10. VER-04..05 → friction resolutions tracked
11. Operator returns when ready (any time, doesn't block Phase 17 ship)

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Decide structure of plans — likely 3-4 plans:
  - Plan 1: README Quick Start + Troubleshooting (DOC-03 + DOC-04)
  - Plan 2: 3 onboarding fixture runbooks (VER-01..03 structural)
  - Plan 3: Phase close + STATE/ROADMAP/REQUIREMENTS HITL-marking
  - Optional Plan: Windows fixture autonomous fill-in from current install state
- Determine the exact content shape of fixtures (template above is suggestive)
- Decide whether to fill in Windows fixture more deeply since v4 IS installed here, vs leaving it operator-pending for fresh-VM rigor
- Reference real shipped commands from Phase 14/15 outputs

The plan-phase agent does NOT have authority to:

- Attempt PLAT-06..08 fresh-VM installs autonomously (impossible — no Mac/Linux VM access)
- Skip the HITL-pending status for PLAT-06..08 / VER-04..05 (must be marked clearly)
- Fabricate expected output for commands not verifiable from this Windows machine
- Modify code (Phase 16 is docs-only beyond fixture authoring)

</plan_authorization>

<open_questions>
## Open Questions

None at phase-context creation time. The structural-close-with-HITL-pending pattern is well-established (Phase 11 SC#4 precedent).

If the plan-phase agent surfaces a question that genuinely needs operator input mid-flow (e.g., "Linux install path differs significantly from documented; need new bootstrap variant"), SendMessage team-lead. The bar is "this changes the deliverable shape," not "I want to confirm an obvious choice."

</open_questions>
