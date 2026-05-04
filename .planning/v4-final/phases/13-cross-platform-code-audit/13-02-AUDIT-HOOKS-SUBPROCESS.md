# PLAT-02 + PLAT-04 Audit — Hook + Subprocess Portability

**Date:** 2026-04-30
**Phase:** 13 (cross-platform code audit)
**Method:** grep + per-callsite inspection per CONTEXT.md `<decisions>` PLAT-02 + PLAT-04
**Totals:**
  - PLAT-02 hits: **0** → 0 fix-needed → 0 keep (the `src/adapters/cc-hooks/` tree is fully Node-based, no PowerShell, no `.ps1`/`.bat`/`.cmd` files, no `chmod` calls)
  - PLAT-04 hits: **6 production subprocess callsites** → **1 fix-needed** → 5 already-portable; 0 `cmd /c` hits in `src/`; 0 `taskkill` hits in `src/`

## Grep commands used

```bash
# PLAT-02 — PowerShell-only cmdlets in hook code
grep -rn --include="*.{cjs,mjs,js,ts}" -E "Get-Process|Stop-Process|Test-Path|New-Item|Remove-Item|Set-Content|Get-Content|Out-File|powershell\.exe|powershell -|pwsh -" src/adapters/cc-hooks/

# PLAT-02 — .ps1 / .bat / .cmd invocations
grep -rn --include="*.{cjs,mjs,js,ts}" -E "\.ps1|\.bat|\.cmd" src/adapters/cc-hooks/

# PLAT-02 — cmd /c chains in hook code
grep -rn --include="*.{cjs,mjs,js,ts}" "cmd /c\|cmd \\/c" src/adapters/cc-hooks/

# PLAT-02 — chmod calls in hook code
grep -rn --include="*.{cjs,mjs,js,ts}" -E "fs\.chmod|chmodSync|0o7[0-7]{2}" src/adapters/cc-hooks/

# PLAT-02 — shell scripts in the hook tree
find src/adapters/cc-hooks/ -name "*.sh" -o -name "*.ps1" -o -name "*.bat" -o -name "*.cmd"

# PLAT-04 — taskkill literal across all src/
grep -rn --include="*.{cjs,mjs,js,ts}" "taskkill" src/

# PLAT-04 — cmd /c literal across all src/
grep -rn --include="*.{cjs,mjs,js,ts}" "cmd /c\|cmd \\/c" src/

# PLAT-04 — Windows-only utilities in spawn args
grep -rn --include="*.{cjs,mjs,js,ts}" -E "rmdir /s|del /q|tasklist|\bwmic\b" src/

# PLAT-04 — child_process imports + spawn callsites
grep -rn --include="*.{cjs,mjs,js,ts}" -E "from 'node:child_process'|from 'child_process'|require\('child_process'\)" src/
grep -rn --include="*.{cjs,mjs,js,ts}" -E "\bspawnSync\(|\bexecSync\(|\bexecFileSync\(|\bexecFile\(" src/

# PLAT-04 — Bun-shell idioms
grep -rn --include="*.{cjs,mjs,js,ts}" -E "Bun\.spawn|Bun\.\$|await \$\`" src/
```

## PLAT-02 findings — `src/adapters/cc-hooks/`

All grep passes returned **zero** hits:
- No PowerShell cmdlets (`Get-Process`, `Stop-Process`, `Test-Path`, etc.).
- No `.ps1` / `.bat` / `.cmd` invocations or files.
- No `cmd /c` chains.
- No `chmod` / `fs.chmod` / octal-mode literals.
- No `.sh` / `.ps1` / `.bat` / `.cmd` files in the hook tree.

The hook tree is entirely `.cjs`/`.ts` invoked by Node. CC handles invocation; no shebangs needed; file permissions are not relied on for execution.

**Conclusion:** No PowerShell-only constructs found in hooks. PLAT-02 acceptance is satisfied by the existing Node.cjs implementation; the audit confirms no fixes are required.

## PLAT-04 findings — `taskkill` callsites (input for 13-03)

Zero hits. `grep -rn 'taskkill' src/` returns no results.

CONTEXT.md acceptance criterion 2 ("`grep -rn 'taskkill' src/` returns no hits outside `src/shared/process-control.ts`") is partially pre-satisfied: there are no callsites to migrate. PLAT-03 (13-03) still needs to introduce `src/shared/process-control.ts` + tests for forward-looking parity, but the migration step (13-03-04) is a **documented no-op**.

| file:line | excerpt | force flag | proposed replacement |
|-----------|---------|------------|----------------------|
| _(none)_ | — | — | — |

## PLAT-04 findings — `cmd /c` callsites

Zero hits in `src/`.

## PLAT-04 findings — Windows-only utilities (`rmdir /s`, `del /q`, `tasklist`, `wmic`)

| file:line | excerpt | classification | reason |
|-----------|---------|----------------|--------|
| src/benchmarks/directive-detector/run-precision.ts:272 | `// failure — observers must grep for the output JSON, not \`wmic\` the PID.` | keep | This is a comment in a docstring, not an invocation. The word `wmic` appears as English advice in a comment about how to observe the script's output. No Windows-only utility is actually invoked. |

## PLAT-04 findings — production subprocess callsites

Inspected via `grep -rn -E "from 'node:child_process'|from 'child_process'|require\('child_process'\)|\bspawnSync\(|\bexecSync\(|\bexecFile\(" src/` and per-callsite reading.

| file:line | excerpt | classification | reason / replacement |
|-----------|---------|----------------|----------------------|
| src/adapters/cc-hooks/angel-launcher.ts:94 | `spawn(process.execPath, [angelDist], { detached: true, stdio, env, cwd: os.homedir() })` | already-portable | Direct binary call (Node executable), array args, no shell. Cross-platform. |
| src/angel/llama-server-supervisor.ts:611 | `this.spawnFn(this.serverExePath, args, {...})` | keep-with-reason | The default `serverExePath` resolves to `~/Desktop/Projects/llama-cpp/llama-server.exe`. The `.exe` suffix makes Windows the default; Mac/Linux operators must supply `LLAMA_SERVER_EXE` (and likely `LLAMA_MODEL_PATH`) env vars. Phase 16 territory: cross-OS llama-server install strategy + `claudex doctor` advisory (DIAG phase). 20 baseline failures from this supervisor are pre-existing unchanged from v4.0.0; not regressed by this phase. |
| src/angel/reranker-supervisor.ts:338 | `this.spawnFn('python', [scriptPath], {...})` | already-portable | `python` resolves via PATH on all platforms (`python.exe` on Windows, `python` on Mac/Linux). Direct binary call, array args, no shell. |
| src/angel/heartbeat.ts:202 | `execSync('git add -A && git diff --cached --quiet \|\| git commit -m "session(auto-close): Angel auto-closed idle session"', {...})` | **fix-needed (refactor)** | Shell-string with `&&` and `\|\|` chaining + embedded double-quoted `git commit -m` arg. `&&`/`\|\|` work on both `cmd.exe` and `/bin/sh`, but the embedded `"..."` quoting is fragile across shells (cmd preserves outer quotes; sh strips them as part of word-splitting). Refactor to three sequential `execFileSync('git', [...])` calls or one helper that runs them in-process. Proposed replacement: split into `execFileSync('git', ['add', '-A'], opts)` → check exit of `execFileSync('git', ['diff', '--cached', '--quiet'], opts)` (exit 1 = staged changes exist, exit 0 = nothing to commit) → if exit 1, `execFileSync('git', ['commit', '-m', 'session(auto-close): Angel auto-closed idle session'], opts)`. Use `execFileSync` (no shell) instead of `execSync`. |
| build.ts:236 | `spawn('node', [hookPath], {...})` | already-portable | Direct binary call (Node), array args, no shell. Used in the smoke-test loop. |
| build.ts:3 | `import { spawn } from 'child_process'` | already-portable | Single spawn callsite at line 236, see above. |

### Test-only callsites (not production)

| file:line | excerpt | classification | reason |
|-----------|---------|----------------|--------|
| src/tests/cli/list-session-pointers.test.ts:40 | `spawnSync('node', [CLI, sessionId], {...})` | already-portable | Direct binary call. |
| src/tests/cli/list-session-pointers.test.ts:106 | `spawnSync('node', [CLI], {...})` | already-portable | Same. |
| src/tests/cli/mark-pointers-helpful.test.ts:39 | `spawnSync('node', [CLI, ...args], {...})` | already-portable | Same. |
| src/tests/adapters/cc-hooks/ensure-angel-running.test.ts:22-23 | `vi.mock('child_process', ...)` | already-portable | Test mock, not an invocation. |
| src/tests/angel/heartbeat-regression.test.ts:70 | `// Replicate the logic from heartbeat.ts without actually calling execSync` | already-portable | Comment in a test that does NOT call execSync. |

`Bun.spawn` / `Bun.$` / `await $\`...\`` — **zero** hits in `src/`. The repo does not use Bun's shell wrapper anywhere.

## `build.ts` audit

- `spawn('node', [hookPath], { stdio, timeout })` at line 236 — already-portable, no shell.
- `rmSync(tmpDir, { recursive: true, force: true })` at line 225 — Node fs API, cross-platform.
- `mkdtempSync(join(tmpdir(), 'claudex-smoke-'))` at line 170 — Node fs+os APIs, cross-platform.
- esbuild config — pure Node API, no platform-specific paths.

**No fix-needed entries from `build.ts`.**

## `package.json` scripts audit

```json
"build": "bun run build.ts",
"test": "vitest run",
"setup": "node dist/cli/setup.cjs",
"health": "node dist/cli/health.cjs",
"projects-touched": "node dist/cli/projects-touched.cjs",
"recall": "node dist/cli/recall.cjs",
"bench:longmemeval": "node dist/benchmark/longmemeval-harness.cjs",
"bench:locomo": "node dist/benchmark/locomo-harness.cjs",
"bench:analyze": "node dist/benchmark/analyze-results.cjs",
"vesna": "node dist/benchmark/vesna/cli.cjs",
"sc3": "node dist/benchmark/memory-quality/cli.cjs"
```

Every script is `bun run X` or `node dist/X.cjs` or `vitest run`. No `rmdir /s`, `del /q`, `copy`, `xcopy`, `cmd /c`, or any other Windows-only construct. Scripts are already cross-platform.

**No fix-needed entries from `package.json`.**

## Fix-needed summary

### For 13-03 (taskkill → terminateProcess)

**None to migrate.** No `taskkill` callsites exist in `src/` today. 13-03 still creates `src/shared/process-control.ts` + tests as scaffolding; the migration step (13-03-04) is a documented no-op against current source.

### For 13-04 (other fixes)

- **src/angel/heartbeat.ts:202** — refactor `execSync('git add -A && git diff --cached --quiet || git commit -m "..."', opts)` to three sequential `execFileSync('git', [...], opts)` calls (no shell). This removes the embedded-quoting fragility that risks breaking on `/bin/sh`. Wrap each call's failure path appropriately: `git add -A` failure is an early-return; `git diff --cached --quiet` exit code 1 means "staged changes exist, proceed to commit"; `git commit` failure is the existing non-fatal `catch`.

That's the single fix-needed entry for 13-04. PLAT-02 is a no-op. Path-handling fixes are 13-01's no-op.

## Already-portable callsites (no action)

- src/adapters/cc-hooks/angel-launcher.ts:94 — `spawn(process.execPath, [angelDist], {...})`
- src/angel/reranker-supervisor.ts:338 — `this.spawnFn('python', [scriptPath], {...})`
- build.ts:236 — `spawn('node', [hookPath], {...})`
- All test-file `spawnSync('node', ...)` callsites.

## Keep-with-reason

- **src/angel/llama-server-supervisor.ts:611** — Default `serverExePath` is Windows-targeted (`llama-server.exe`); Mac/Linux operators override via `LLAMA_SERVER_EXE` env var. Phase 16 territory for cross-OS install strategy. Pre-existing 20 supervisor test failures unchanged from v4.0.0 baseline are tracked separately and not regressed by this phase.
- **src/benchmarks/directive-detector/run-precision.ts:272** — `wmic` appears in a docstring comment as English prose advice, not an invocation.
