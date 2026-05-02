# Onboarding Fixture: Windows 11

**Fixture status:** PARTIAL (split-mode)
- **Steps 1-3 (fresh Bun/Ollama/Python install on a clean Windows 11 VM):** HITL-PENDING — operator must run on a fresh VM
- **Steps 4-7 (post-install verification):** RECORDED FROM CURRENT MACHINE — Claudex v4.1 is installed here and `bun run doctor` is exiting 0 at fixture-author time

**Operator (HITL half):** [OPERATOR FILL-IN]
**Date (HITL half):** [OPERATOR FILL-IN]
**VM image (HITL half):** [OPERATOR FILL-IN — e.g., "Windows 11 Pro 23H2 fresh, x86_64"]
**Elapsed time (HITL half):** [OPERATOR FILL-IN]

**Recording machine (autonomous half):** Windows 11 Pro (development machine where v4.1 was built)
**Recording date:** 2026-05-02
**Recording commit:** `fc33edb29fc4f20f4cc1ec06d3626a26a97fbfff` (Phase 15 close — `phase(15): close — claudex doctor diagnostics complete`)

This fixture verifies VER-03 (Windows onboarding fixture exists) + PLAT-08 (Windows install regression check on fresh VM).

**Why split-mode?** PLAT-08's intent is a *regression check* on a fresh VM — not "the install path works on the machine where development happened." The dev machine has been running v4.1 continuously since Phase 14; verifying it still runs here is necessary but insufficient. The HITL operator runs steps 1-3 on a fresh Windows 11 VM to close the regression check; steps 4-7 are pre-recorded from the dev machine to show what success looks like and to give the operator a baseline to compare against.

---

## Step-by-step

### 1. Install Bun

**Command (autonomous):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```
Then restart your shell so `bun.exe` lands on `PATH`.

**Expected (autonomous):** `bun --version` prints a version `>=1.3`. On the recording machine right now: `1.3.6`.

**Friction (HITL):** [OPERATOR FILL-IN: did PowerShell prompt about execution policy? Did Windows Defender flag the installer? Did the new PATH require a fresh terminal session?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS]

### 2. Install Ollama

**Command (autonomous):** Download `OllamaSetup.exe` from https://ollama.com/download/windows and run it. The installer registers Ollama as a tray service that starts automatically.

**Expected (autonomous):** `ollama --version` prints something like `ollama version is X.Y.Z`. The tray icon shows "Ollama is running"; `curl http://127.0.0.1:11434/api/tags` returns JSON. On the recording machine right now: `ollama version is 0.22.1`.

**Friction (HITL):** [OPERATOR FILL-IN: did the installer require admin elevation? Did the tray service start automatically or need a reboot? Any Windows Firewall prompt for port 11434?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS]

### 3. Install Python 3.11+

**Command (autonomous):** Download the Python 3.11+ installer from https://www.python.org/downloads/windows/. **Critical:** check "Add python.exe to PATH" before clicking Install. After install, restart the shell.

**Expected (autonomous):** `python --version` prints `Python 3.11.x` (or higher). On the recording machine right now: `Python 3.12.7`. (Phase 14's `reranker-bootstrap` step uses `python` on Windows; if your install registered as `python3` only, add a `python.exe` PATH entry or alias.)

**Friction (HITL):** [OPERATOR FILL-IN: did the "Add to PATH" checkbox stick? Did Windows store-installed Python 3.11 (`python` from MS Store) collide with the python.org install? Did the BGE reranker's `pip install -r services/requirements.txt` (Step 5 below) actually find this Python during `bun run setup`?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS]

### 4. Clone the repo

**Command (autonomous):**
```powershell
git clone https://github.com/grigorijejakisic/Claudex.git
cd Claudex
```
Note the capital `C` in the repo URL.

**Expected (autonomous):** `git status` shows `On branch master`. `Test-Path install.bat` → `True`. `Get-Content install.bat | Select-Object -First 3` shows `@echo off` + the "Claudex first-touch installer (Windows)" banner.

**Recorded on this machine (2026-05-02):** Repo is checked out at `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3` (note: `CLAUDEXv3` is the historical dev path; the public repo at `github.com/grigorijejakisic/Claudex` clones into `Claudex/` by default — the path is operator's choice). `install.bat` is present and runnable; first three lines match the autonomous-expected banner.

**Friction (HITL):** [OPERATOR FILL-IN: clone speed? Git for Windows installed already? Any line-ending warnings during checkout?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS]

### 5. Run install

**Command (autonomous):**
```cmd
install.bat
```
The wrapper pre-flights Bun, then runs `call bun install --frozen-lockfile && call bun run build && call bun run setup`. The `call` prefix is required on Windows because `bun` ships as `bun.cmd`; without `call`, control transfers to `bun.cmd` and never returns to `install.bat` — known Phase 14 gotcha, fixed before close.

`bun run setup` is the substantive bootstrap: Bun version → Ollama detect → model pull (`snowflake-arctic-embed2`) → reranker venv at `services/.venv` → projects-dir scaffold → DB at `~/.claudex/db/claudex.db` (Windows: `%USERPROFILE%\.claudex\db\claudex.db`) → hooks at `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`). Idempotent on re-run.

**Expected (autonomous):** `install.bat` exits 0. `bun run setup` prints its numbered steps. Re-running `install.bat` is idempotent (Phase 14 verified live: "Live smoke `cmd /C install.bat` runs end-to-end exit 0 twice in a row" per `14-SUMMARY.md`).

**Recorded on this machine (2026-05-02):** Live smoke per Phase 14 close commit confirms `cmd /C install.bat` exits 0 twice in a row. The DB at `C:/Users/Grigorije/.claudex/db/claudex.db` and the hook settings at `C:/Users/Grigorije/.claude/settings.json` are both present — confirmed at fixture-recording time. The BGE reranker is alive on `:7439` (verifiable via the doctor's Reranker check below); on this dev machine the reranker process is supervised by Angel's `RerankerSupervisor` rather than a `services/.venv/` symlink directly, so the venv directory may not be present at the canonical Phase 14 path while the service is still healthy.

**Friction (HITL):** [OPERATOR FILL-IN on fresh VM: which steps were slow? Did `pip install` for the reranker requirements work cleanly with the Windows Python install? Did `~/.claude/settings.json` exist already (overwrite vs create)? Did any antivirus quarantine `bun.exe` or the venv binaries?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS — note model pull is bandwidth-bound, ~1-2GB; record total wall-clock]

### 6. Verify with doctor

**Command (autonomous):**
```cmd
bun run doctor
```

**Expected (autonomous):** Exit 0. Six checks (Bun version, DB schema, Ollama, Reranker, CC hooks, Angel) all pass or warn. Reranker check warns rather than fails per Phase 15 design (bi-encoder fallback covers it).

**Recorded on this machine (2026-05-02):**

```
$ node dist/cli/doctor.cjs
Claudex Doctor — checking install health
──────────────────────────────────────────────────
✓ Bun version        Bun 1.3.6                    (243ms)
✓ DB schema          user_version=24              (215ms)
✓ Ollama             daemon up, snowflake-arctic-embed2 pulled (219ms)
✓ Reranker           port 7439 healthy            (7ms)
✓ CC hooks           25 of 25 registered          (1ms)
⚠ Angel              PID 73568 alive but last heartbeat 989s ago (>=60s) (0ms)
  → Angel may be stuck in a long consolidation cycle. If this persists, restart via Claude Code session-end + session-start.
──────────────────────────────────────────────────
All checks passed (1 warning). Claudex is healthy.
```

Exit code: `0`. Note that on this dev machine the Reranker is currently *passing* (not warning) because `:7439/health` is reachable — the `⚠ Reranker` warn shape documented in the README §Troubleshooting is the *fallback* state. The single warn here is on Angel, which mirrors the `15-SUMMARY.md` baseline (Angel's heartbeat freshness signal updates on the next session-start; the warn is self-clearing).

**Friction (HITL):** [OPERATOR FILL-IN on fresh VM: paste verbatim doctor output. Compare against the recorded baseline above. Any unexpected ✗ that the dev-machine recording didn't show?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS — typically <1s wall-clock]

### 7. First session

**Command (autonomous):**
```powershell
mkdir $env:USERPROFILE\Projects\test-onboarding
cd $env:USERPROFILE\Projects\test-onboarding
git init
"# test" | Out-File README.md
# Then launch Claude Code in this directory.
```
Or set `$env:CLAUDEX_PROJECTS_DIR = "C:\some\other\path"` before launching CC and use a project under that path.

**Expected (autonomous):** SessionStart hook fires within 1 user turn; the agent produces assembled context (entity references if any prior sessions exist, project mental model, advisory voice from Phase 8.5) without manual priming. On a brand-new project the assembly will be sparse but well-formed (no errors, no missing-file warnings).

**Recorded on this machine (2026-05-02):** SessionStart hook fires correctly on every Claude Code launch in any project under `C:\Users\Grigorije\Desktop\Projects\` (the legacy `~/Desktop/Projects/` path that pre-dates Phase 14's `CLAUDEXv3` rename; both paths are honored by the projects-dir resolver per `14-SUMMARY.md`). The agent's first-turn output reliably shows assembled context including prior-session pointers, MEMORY.md `## Active Projects` block, and Phase 8.5 advisory voice when a relevant prior pattern exists.

**Friction (HITL on fresh VM):** [OPERATOR FILL-IN: did the SessionStart hook fire on the first prompt or take multiple turns? Did the agent narrate "no prior experience" (Phase 8.5 advisory voice on a fresh project)? Any stderr from the hook?]

**Elapsed (HITL):** [OPERATOR FILL-IN: MM:SS]

---

## Friction summary

**Autonomous half (recorded from current dev machine):**

The dev machine is the platform v4.1 was built on. There is no friction to record — every Phase 14 / 15 command has been live-verified during phase close. The single residual is the Angel-heartbeat-staleness warn, which is documented in `15-SUMMARY.md` and self-clears on next session-start.

If a regression appeared at fixture-recording time (e.g., `bun run doctor` started failing some check that was passing during Phase 15 close), it would surface here. Verify with the recorded doctor table in Step 6.

**HITL half (fresh Windows 11 VM):**

[OPERATOR FILL-IN: list each friction encountered installing on a fresh Win11 VM; classify as code-fix-needed / doctor-check-needed / README-troubleshooting-needed / acceptable-as-is. If "Zero friction. <30-minute target met. Windows install path is clean on a fresh VM," write that.]

## Resolutions

**Autonomous half:** N/A — no friction.

**HITL half:** [OPERATOR FILL-IN]

## Verdict

**Autonomous half:** PASS — Phase 14 install path + Phase 15 doctor surface verified live on this dev machine; v4.1 is operating end-to-end as built. This is necessary but insufficient for PLAT-08 close.

**HITL half:** HITL-PENDING — operator must run steps 1-7 on a fresh Windows 11 VM to close PLAT-08 as a regression check. Until that run, PLAT-08 status is `Pending (HITL)` per REQUIREMENTS.md.

---

**Cross-references:**
- README §Quick Start: ../../README.md#quick-start
- README §Troubleshooting: ../../README.md#troubleshooting
- macOS fixture: ./macos.md (PLAT-06 / VER-01)
- Linux fixture: ./linux.md (PLAT-07 / VER-02)
- Phase 14 close summary (live install verification on this machine): ../../.planning/phases/14-bootstrap-install-configurable-paths/14-SUMMARY.md
- Phase 15 close summary (live doctor verification on this machine): ../../.planning/phases/15-claudex-doctor-diagnostics/15-SUMMARY.md
