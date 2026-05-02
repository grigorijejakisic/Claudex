# Onboarding Fixture: macOS

**Status:** HITL-PENDING (operator must run this fixture on a fresh macOS VM)
**Operator:** [OPERATOR FILL-IN]
**Date:** [OPERATOR FILL-IN]
**VM image:** [OPERATOR FILL-IN — e.g., "macOS 14.5 Sonoma fresh, Apple Silicon" or "macOS 14.5 Sonoma fresh, Intel"]
**Elapsed time:** [OPERATOR FILL-IN: HH:MM, start = first command, end = first user turn produces assembled context]
**Commit pinned:** [OPERATOR FILL-IN: git rev-parse HEAD at start of fixture run]

This fixture verifies VER-01 (macOS onboarding fixture exists) + PLAT-06 (macOS install end-to-end on fresh VM) + the macOS slice of VER-04 / VER-05 (friction resolved + <30 minute target). It is operator-runnable because PLAT-06 cannot be verified from the Windows development machine.

If you are reading this AS the operator running it, run each step in order, paste verbatim output where indicated, and fill the friction blocks honestly. The structural author left every fact-checkable detail in place; you are filling in what only a real Mac VM can tell us.

---

## Step-by-step

### 1. Install Bun

**Command (autonomous):**
```bash
curl -fsSL https://bun.sh/install | bash
```
Then restart your shell or `source ~/.zshrc` (or `~/.bash_profile`) so `bun` lands on `PATH`.

**Expected (autonomous):** `bun --version` prints a version `>=1.3`.

**Friction:** [OPERATOR FILL-IN: any prompts, PATH issues, certificate errors, did you have to install Xcode CLI tools first?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS]

### 2. Install Ollama

**Command (autonomous):**
Download the `Ollama-darwin.zip` from https://ollama.com/download/mac, unzip, drag `Ollama.app` to `/Applications`, launch once. The app runs as a menu-bar agent and starts the daemon automatically. CLI alternative:
```bash
brew install ollama
brew services start ollama
```

**Expected (autonomous):** `ollama --version` prints something like `ollama version is X.Y.Z`. `curl -s http://127.0.0.1:11434/api/tags` returns JSON (the model list, possibly empty).

**Friction:** [OPERATOR FILL-IN: did the daemon start automatically? Any firewall prompt for port 11434? Did you need to grant the app accessibility permissions?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS]

### 3. Install Python 3.11+

**Command (autonomous):**
```bash
brew install python@3.11
```
Verify the binary is on PATH: `python3.11 --version` should print `Python 3.11.x`.

**Expected (autonomous):** `python3.11 --version` prints `Python 3.11.x` (or higher minor — Phase 14's `reranker-bootstrap` step accepts 3.11+, so 3.12 / 3.13 are fine).

**Friction:** [OPERATOR FILL-IN: was Homebrew already installed? Did you need to add Apple Silicon Homebrew prefix to PATH? Did `python3.11` collide with an existing system Python?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS]

### 4. Clone the repo

**Command (autonomous):**
```bash
git clone https://github.com/grigorijejakisic/Claudex.git
cd Claudex
```
Note the capital `C` in the repo URL.

**Expected (autonomous):** `git status` shows `On branch master`, working tree clean. `ls install.sh` resolves; `head -3 install.sh` shows the POSIX shebang and "Claudex first-touch installer" banner.

**Friction:** [OPERATOR FILL-IN: clone speed? Any LFS prompts? Did `install.sh` arrive with execute permission? (It should — Phase 14 set the bit via `git update-index --chmod=+x`.)]

**Elapsed:** [OPERATOR FILL-IN: MM:SS]

### 5. Run install

**Command (autonomous):**
```bash
./install.sh
```
The wrapper pre-flights Bun, then runs `bun install --frozen-lockfile && bun run build && bun run setup`. The `bun run setup` step is the substantive bootstrap (Phase 14): Bun version → Ollama detect → model pull (`snowflake-arctic-embed2`) → reranker venv at `services/.venv` → projects-dir scaffold → DB at `~/.claudex/db/claudex.db` → hooks at `~/.claude/settings.json`.

**Expected (autonomous):** `install.sh` exits 0. `bun run setup` prints its numbered steps; idempotent on re-run.

**Friction:** [OPERATOR FILL-IN: which steps were slow (model pull is usually the longest — ~1-2GB download)? Did the BGE reranker venv install cleanly via `pip install -r services/requirements.txt`? Did Ollama prompt for any permission? Did `~/.claude/settings.json` exist already (overwrite vs create)?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS — note the model pull is bandwidth-bound; record total wall-clock]

**If anything failed:** see [README §Troubleshooting](../../README.md#troubleshooting) for the four canonical install failures. If the failure isn't covered there, classify it in §Friction summary below as `code-fix-needed` / `doctor-check-needed` / `README-troubleshooting-needed`.

### 6. Verify with doctor

**Command (autonomous):**
```bash
bun run doctor
```

**Expected (autonomous):** Exit 0. Six checks (Bun version, DB schema, Ollama, Reranker, CC hooks, Angel) all pass or warn. The Reranker check warns rather than fails; everything else should pass on a fresh successful install.

**Friction:** [OPERATOR FILL-IN: paste the doctor table verbatim. Any unexpected ✗ or ⚠? Did Angel report a stale heartbeat (warn) or alive PID (pass)?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS — typically <1s wall-clock]

### 7. First session

**Command (autonomous):**
```bash
mkdir -p ~/Projects/test-onboarding
cd ~/Projects/test-onboarding
git init
echo "# test" > README.md
# Then launch Claude Code in this directory.
```
(Or set `CLAUDEX_PROJECTS_DIR=/some/other/path` and use that.)

**Expected (autonomous):** SessionStart hook fires within 1 user turn. Type `/starthere` (or just send any prompt); the agent should produce assembled context — entity references, prior-session pointers if any, project mental model — without any manual priming. On a brand new project the assembly will be sparse but well-formed (no errors, no missing-file warnings).

**Friction:** [OPERATOR FILL-IN: did the SessionStart hook fire on the first prompt or take multiple turns? Did the agent narrate "no prior experience" (Phase 8.5 advisory voice) on a fresh project? Any stderr from the hook?]

**Elapsed:** [OPERATOR FILL-IN: MM:SS]

---

## Friction summary

[OPERATOR FILL-IN: list each friction encountered above; classify each as one of:
- **code-fix-needed** — Claudex source needs a change (open a PR or file an issue)
- **doctor-check-needed** — `bun run doctor` should have caught this but didn't (extend Phase 15's check set)
- **README-troubleshooting-needed** — symptom should be added to README §Troubleshooting (extend Plan 16-01's section)
- **acceptable-as-is** — friction is upstream (Homebrew prompts, Ollama install UX) and not Claudex's responsibility

If no friction was encountered, write "Zero friction. <30-minute target met. macOS install path is clean."]

## Resolutions

[OPERATOR FILL-IN: for each friction item, link to the commit / PR / doctor check / README section that resolves it. Format:
- Friction X: [link to commit/PR or "deferred — see issue #N"]
- Friction Y: [link to README §Troubleshooting → entry name]

If "Zero friction" above, write "N/A — no resolutions needed."]

## Verdict

[OPERATOR FILL-IN: one of:
- **PASS** — install completed in <30 minutes; all friction resolved; ready to mark PLAT-06 [x]
- **PASS-with-residuals** — install completed but ≥1 friction items remain unresolved; document residuals; still mark PLAT-06 [x] with note
- **FAIL** — install did not complete or took >30 minutes with no clear path to remediation; PLAT-06 stays [~] HITL with documented blocker]

---

**Cross-references:**
- README §Quick Start: ../../README.md#quick-start (the autonomous walk-through this fixture executes)
- README §Troubleshooting: ../../README.md#troubleshooting (Ollama / port 7439 / Bun / hooks failures)
- Linux fixture: ./linux.md (Ubuntu 24.04 LTS counterpart)
- Windows fixture: ./windows.md (Windows 11 regression check; partially auto-filled — see file)
- Phase 11 SC#4 precedent: ../../.planning/phases/11-p9-final-validation/11-03-cold-start-trial-1.md (and -2, -3)
