# Phase 13: Cross-Platform Code Audit — Context

**Gathered:** 2026-04-30 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + v4.1 milestone kickoff conversation)
**Status:** Ready for planning
**Generative axiom:** A reader on macOS or Linux can clone the repo, run `bun install` and `bun run test`, and have hooks/locks/subprocess/path handling work identically to how they work on Windows. This phase fixes the code itself; actual fresh-VM verification is Phase 16's territory.

---

<domain>
## Phase Boundary

This phase delivers five things and ONLY these five:

1. **PLAT-01:** All path handling in `src/` uses `path.join` / `path.resolve` (or POSIX `/` separators in literal contexts where safe — e.g., URL paths, glob patterns, internal IDs); no hardcoded `\\` separators
2. **PLAT-02:** Hook scripts in `src/adapters/cc-hooks/` run on Mac/Linux without modification (no PowerShell-only constructs; correct shebangs where applicable; file permissions preserved through git)
3. **PLAT-03:** File-lock teardown handles Mac/Linux via signal-based termination instead of `taskkill` (which is Windows-only); cross-platform abstraction in place
4. **PLAT-04:** Subprocess spawning uses Node `spawn` or Bun `$` portably; no `cmd /c` chains; no platform-specific shell constructs that would break on `sh`/`bash`/`zsh`
5. **PLAT-05:** `.gitattributes` at repo root normalizes line endings (LF for source files; CRLF allowed for `.bat` / `.cmd` Windows-specific scripts); existing files are normalized via `git add --renormalize` if needed

**Out of scope:**
- Fresh-VM verification on Mac/Linux/Windows — Phase 16's territory (operator-runnable HITL)
- Bootstrap install script — Phase 14's territory
- Doctor diagnostics — Phase 15's territory
- README/docs updates — Phase 12 closed; doc updates referencing platform support belong in Phase 16's polish
- New features or bug fixes unrelated to portability
- Refactoring beyond what's required for portability (don't expand scope mid-phase)

**Hard gates:**
- `bun run build` (esbuild) must remain green throughout
- `bun run test` (vitest) must keep passing the 3115 tests passing at end of Phase 12 (20 baseline llama-server-supervisor failures unchanged from v4.0.0; anything beyond is regression)
- No regression in Vesna SC#1 — `bun run vesna` must still pass 17/17 at phase close
- DB schema unchanged (no migrations in this phase)
- Hook semantics unchanged — hooks must do the same things they do today, just portably

</domain>

<decisions>
## Implementation Decisions

### PLAT-01 — Path handling audit method
- **Method:** Two-pass mechanical sweep, then targeted fix
  - Pass 1: `grep -rn` across `src/` for hardcoded backslashes in string literals (`'\\\\'`, `"\\\\"`, regex patterns containing `\\` for path matching)
  - Pass 2: Audit `path.normalize`, `path.win32`, `path.posix` callsites to confirm they're used intentionally (e.g., for normalization of mixed input) rather than as workarounds
  - Pass 3: Inspect string concatenation that builds paths (e.g., `dir + '\\' + file`) and replace with `path.join`
- **Acceptable patterns to KEEP:**
  - URL paths (forward slashes in HTTP URLs, MCP server endpoints)
  - Internal opaque identifiers that look like paths but aren't filesystem paths (e.g., `claudex_search`'s scoring keys)
  - Regex patterns for the `parseHandoffHeader` family that intentionally match POSIX-style paths in handoff body
  - Test fixtures that test platform-specific normalization
- **Replace patterns:**
  - `path.join(home, '.claudex', 'db', 'claudex.db')` instead of literal `~/.claudex/db/claudex.db` in code (literals are fine in docs/comments)
  - `path.resolve(__dirname, '..', 'config.json')` instead of `__dirname + '/../config.json'`

### PLAT-02 — Hook script portability
- **Method:** Audit `src/adapters/cc-hooks/` for:
  - PowerShell-only constructs (`Get-Process`, `Stop-Process`, `Test-Path`, etc.) — none expected since hooks are Node.js, but verify
  - `cmd /c` chains in spawned commands — replace with direct binary calls
  - File permissions: hooks are `.cjs` files invoked by `node`; CC handles the invocation. No shebangs needed since Node is invoked explicitly. But if any `.sh` files exist (likely none), they need executable bits.
- **Decision on `.sh` shebangs:** if any shell scripts exist (none expected), use `#!/usr/bin/env bash` not `#!/bin/bash` for portability across Mac/Linux/Git Bash on Windows
- **CR/LF in hooks:** `.gitattributes` will enforce LF on source; CC invokes Node which handles either, so hooks work on all platforms regardless

### PLAT-03 — File-lock teardown abstraction
- **Current state (Windows):** Some teardown paths use `taskkill /PID <pid> /F` to forcibly stop child processes that hold file locks (e.g., the Angel watchdog cleanup, possibly llama-server-supervisor)
- **Decision:** Wrap kill logic in a single helper module `src/shared/process-control.ts` (new) that exports `terminateProcess(pid: number, options?: { force?: boolean }): Promise<void>`
  - On Windows: continues to use `taskkill /PID <pid> /F` when `force: true`, `taskkill /PID <pid>` otherwise
  - On Mac/Linux: uses `process.kill(pid, 'SIGKILL')` when `force: true`, `process.kill(pid, 'SIGTERM')` otherwise
  - Detection via `process.platform === 'win32'`
- **Locate callsites:** grep for `taskkill` across `src/` and replace each with `terminateProcess(pid, { force: true })`
- **Lock-file cleanup (e.g., Angel PID file):** uses `fs.unlinkSync` already, which works cross-platform. No change.

### PLAT-04 — Subprocess spawning portability
- **Method:** grep `src/` for `spawn`, `exec`, `execSync`, `spawnSync`, `Bun.spawn`, `$\``, `cmd /c`, `&&` in shell strings
- **Decision pattern per finding:**
  - Direct binary call (e.g., `spawn('ollama', ['list'])`) — already portable, leave alone
  - Shell string with chaining (e.g., `exec('cd dir && command')`) — refactor to either: (a) use spawn options `cwd`, (b) use `execSync` with explicit shell selection, or (c) split into sequential steps
  - `cmd /c` chains — replace with direct binary call or platform-specific branching
  - Bun's `$` template (e.g., `await $\`bun run build\``) — already cross-platform but can be problematic with quoting; audit for embedded shell idioms
- **Shell selection:** When a shell is genuinely needed (e.g., for env var expansion), use `process.platform === 'win32' ? 'cmd' : 'sh'` explicitly rather than relying on default
- **Bun's `$` operator:** Bun handles cross-platform spawning under the hood; trust it but verify pipeline-style commands

### PLAT-05 — `.gitattributes` for line endings
- **File:** repo root `.gitattributes` (new file, may not exist)
- **Content:**
  ```
  # Default: text files use LF normalization
  * text=auto eol=lf
  
  # Source code (always LF)
  *.ts text eol=lf
  *.js text eol=lf
  *.cjs text eol=lf
  *.mjs text eol=lf
  *.json text eol=lf
  *.md text eol=lf
  *.yml text eol=lf
  *.yaml text eol=lf
  *.toml text eol=lf
  *.py text eol=lf
  *.sh text eol=lf
  
  # Windows-specific scripts (CRLF allowed)
  *.bat text eol=crlf
  *.cmd text eol=crlf
  *.ps1 text eol=crlf
  
  # Binary (no normalization)
  *.png binary
  *.jpg binary
  *.ico binary
  *.db binary
  *.sqlite binary
  ```
- **Renormalization:** after committing `.gitattributes`, run `git add --renormalize .` and commit any line-ending fixups as a separate commit so the diff is reviewable

### Verification approach
- **Static verification (this phase, autonomous):**
  - grep proves no remaining `taskkill`/`cmd /c`/hardcoded backslash callsites outside the abstraction module
  - `bun run build` green
  - `bun run test` 3115/3115 + 20 baseline llama failures (unchanged)
  - `bun run vesna` 17/17
- **Dynamic verification (deferred to Phase 16):**
  - Actual Mac/Linux execution of build + tests on a fresh VM — operator-runnable

</decisions>

<integration_points>
## Integration Points

- **Existing platform-specific code:** likely concentrated in:
  - `src/adapters/cc-hooks/` (26 hooks; Node-based, mostly portable already)
  - `src/angel/` (RerankerSupervisor, llama-server-supervisor, watchdog) — has subprocess management
  - `src/core/` (DB initialization, migrations — sqlite cross-platform via Bun)
  - `src/mcp/recall-server.ts` (MCP server — Node-based)
  - `services/reranker.py` (Python; out of scope for this phase — Python is portable when run on each platform's interpreter)
  - `build.ts` and `package.json` scripts — may have platform-specific shell idioms
- **Test files:** `src/tests/` may have platform-specific assertions (e.g., expecting Windows-style paths in MEMORY.md fixtures); audit test fixtures and update if any contain hardcoded `\\` separators
- **`build.ts`:** esbuild config; may have platform-specific output paths or copy steps
- **`package.json` scripts:** any `"prebuild": "rmdir /s /q dist"` or similar Windows-only scripts must use cross-platform alternatives (e.g., the `rimraf` package or Bun's `--rm` flag)
- **`.claude/rules/`:** loaded conditionally; rule files may reference Windows paths in examples — leave alone (these are docs, not code)

</integration_points>

<acceptance>
## Acceptance Criteria

The phase is closed when:

1. `grep -rn '\\\\' src/` returns no path-construction hits (only test fixtures or comments documenting Windows quirks); audit reasoning per kept finding documented in SUMMARY.md
2. `grep -rn 'taskkill' src/` returns no hits outside `src/shared/process-control.ts` (the new abstraction module)
3. `grep -rn 'cmd /c' src/` returns no hits
4. `src/shared/process-control.ts` exists with `terminateProcess(pid, options)` function and unit tests covering both Windows and Unix code paths (mocked `child_process.execSync` and `process.kill`)
5. `.gitattributes` exists at repo root with the content above; `git check-attr -a <file>` returns expected attributes for sample files
6. Build green: `bun run build` exits 0
7. Tests green: `bun run test` exits 0 with 3115 passes + 20 baseline llama failures (no regression)
8. Vesna green: `bun run vesna` exits 0 at 17/17 PASS
9. Atomic per-task commits using `phase(13):` convention; SUMMARY.md per plan; phase-close commit at end with STATE/ROADMAP/REQUIREMENTS updates marking Phase 13 [x] and PLAT-01..05 [x] in traceability
10. Phase 16's HITL fresh-VM tests are explicitly NOT attempted in this phase (handoff to Phase 16's runbooks instead)

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Choose between split (one plan per req) and grouped (e.g., PLAT-01 + PLAT-04 together since they touch overlapping code) plans — bisectability favors split, throughput favors grouped; either works for ~5 reqs
- Decide whether the new `src/shared/process-control.ts` module gets dedicated unit tests in the same plan as PLAT-03 or as a separate test plan
- Run `git add --renormalize .` as a separate commit if `.gitattributes` changes existing file line endings
- Skip files that grep finds but inspection proves are intentional (URL paths, regex patterns, etc.) — document the audit reasoning per file
- Defer truly cross-platform-untestable items (e.g., "does PowerShell-style command actually fail on Mac") to Phase 16 with a HITL flag

The plan-phase agent does NOT have authority to:

- Add new features or behavioral changes beyond portability fixes
- Touch `services/reranker.py` (Python) — that's a separate concern
- Modify build/test scripts beyond the portability minimum
- Refactor unrelated code "while we're here" — scope lock per global rule

</plan_authorization>

<open_questions>
## Open Questions

None at phase-context creation time. The portability domain is well-understood:
- Path normalization → `path` module
- Process control → platform branching in a single helper
- Subprocess → Node spawn / Bun $ / shell selection
- Line endings → `.gitattributes`

If the plan-phase or executor surfaces a finding that genuinely needs operator input (e.g., "this file-lock pattern requires a fundamentally different approach on Mac"), SendMessage team-lead. The bar is "this changes the deliverable shape," not "I want to confirm an obvious choice."

</open_questions>
