# INST-05 Callsite Audit — `~/Desktop/Projects/` references in src/

**Date:** 2026-05-01
**Phase:** 14
**Method:** four grep passes for hardcoded literal + path.join forms

## Greps used

```bash
grep -rn "Desktop/Projects" src/
grep -rn "'Desktop', 'Projects'" src/
grep -rn '"Desktop", "Projects"' src/
grep -rnE 'path\.join\(os\.homedir\(\),\s*['\''"]Desktop' src/
```

## Findings

| file:line | excerpt | classification | proposed_fix |
|-----------|---------|----------------|--------------|
| src/shared/scope-detector.ts:108 | ` * Checks projects.json first, then scans ~/Desktop/Projects/ for derived matches.` | comment-update | Replace with "the configured projects directory (CLAUDEX_PROJECTS_DIR, default ~/Projects/)" |
| src/shared/scope-detector.ts:132 | `// 2. Scan ~/Desktop/Projects/ for unregistered directories whose derived ID matches` | comment-update | Update inline comment to "Scan the configured projects directory" |
| src/shared/scope-detector.ts:133 | `const baseDir = path.join(os.homedir(), 'Desktop', 'Projects');` | code-fix | `const baseDir = getProjectsDir();` (import from `./projects-dir.js`) |
| src/shared/content-router.ts:9 | `* 2. ~/Desktop/Projects/ scan — unregistered project directories` | comment-update | "the configured projects directory (CLAUDEX_PROJECTS_DIR, default ~/Projects/) scan" |
| src/shared/content-router.ts:100 | `const baseDir = path.join(os.homedir(), 'Desktop', 'Projects');` | code-fix | `const baseDir = getProjectsDir();` (import from `./projects-dir.js`) |
| src/mcp/recall-server.ts:127 | ``All projects live in ~/Desktop/Projects/. The project registry is at ~/.claudex/projects.json.`` | string-text-fix | Refactor instructions string to be built at registration time via `buildClaudexInstructions()` that interpolates `${getProjectsDir()}` |
| src/assembly/sections.ts:71 | ``... All projects are in `~/Desktop/Projects/`.`` | string-text-fix | Generic phrasing: ``All projects are under your configured `CLAUDEX_PROJECTS_DIR` (default `~/Projects/`).`` |
| src/core/session-events.ts:332 | `// Simplify absolute paths: /c/Users/Grigorije/Desktop/Projects/CLAUDEXv3/... → <project>/...` | string-text-fix | Build regex from `getProjectsDir()` at call time OR alternation that matches both legacy `Desktop/Projects` and new bare `Projects` segments |
| src/angel/memory-md-writer.ts:94 | `* `~/Desktop/Projects/` for a directory whose derived ID matches.` | comment-update | "the configured projects directory (CLAUDEX_PROJECTS_DIR, default ~/Projects/)" |
| src/angel/curated-context-extractor.ts:119 | `- "workspace_map" — paths. "Code lives at ~/Desktop/Lacuna, docs at ~/Desktop/Projects/Lacuna-Betting."` | comment-update (illustrative example only) | Update example to use `~/Projects/Lacuna-Betting` to match new default; non-load-bearing |
| src/angel/llama-server-supervisor.ts:26 | `* ~/Desktop/Projects/holo3/run-gemma.sh — they can be overridden via` | keep-with-reason | Separate concern — llama-cpp env-overridable path defaults; not the projects scan. Leave as documented default. |
| src/angel/llama-server-supervisor.ts:46 | `/** Absolute path to llama-server.exe. Default: $LLAMA_SERVER_EXE or ~/Desktop/Projects/llama-cpp/llama-server.exe. */` | keep-with-reason | Same as above — env var has its own default; out of scope per CONTEXT.md INST-05 |
| src/angel/llama-server-supervisor.ts:48 | `/** Absolute path to the GGUF model file. Default: $LLAMA_MODEL_PATH or ~/Desktop/Projects/llama-cpp/models/...gguf. */` | keep-with-reason | Same as above |
| src/angel/llama-server-supervisor.ts:139 | `path.join(os.homedir(), 'Desktop', 'Projects', 'llama-cpp', 'llama-server.exe')` | keep-with-reason | Default value for llama-server binary location; honored only when LLAMA_SERVER_EXE is unset; separate concern |
| src/tests/angel/memory-md-writer.test.ts:660 | `const fakeProjectPath = path.join(tmpHome, 'Desktop', 'Projects', 'CLAUDEXv3');` | test-fixture | 14-02 will set `process.env.CLAUDEX_PROJECTS_DIR = path.join(tmpHome, 'Desktop', 'Projects')` in the test's beforeEach so fixture remains intact while routing through `getProjectsDir()` |
| src/tests/angel/memory-md-writer.test.ts:695 | `// No projects.json, no matching Desktop/Projects scan entry.` | comment-update | Test comment — update to "no matching projects-dir scan entry" |
| src/tests/core/memory-md-verify.test.ts:183 | `const cwd = 'C:/Users/Test/Desktop/Projects/alpha';` | test-fixture | 14-02 will inject `CLAUDEX_PROJECTS_DIR = 'C:/Users/Test/Desktop/Projects'` in beforeEach so the fixture's expectation continues to match |

## Code-fix summary (input for 14-02)

- `src/shared/scope-detector.ts:133` — replace `path.join(os.homedir(), 'Desktop', 'Projects')` with `getProjectsDir()`; add import from `./projects-dir.js`
- `src/shared/content-router.ts:100` — same; add import from `./projects-dir.js`

## String-text-fix summary

- `src/mcp/recall-server.ts:127` — wrap instructions block in a function `buildClaudexInstructions(): string` that calls `getProjectsDir()` at runtime. Existing `getClaudexInstructions()` (or whatever the registration path uses) returns the result. INST-06 acceptance: agent sees the user's configured directory, not a hardcoded one.
- `src/assembly/sections.ts:71` — replace literal `~/Desktop/Projects/` with the generic phrasing referenced above. Generic is safe here because the section is a system-reminder hint, not a load-bearing path the agent operates on.
- `src/core/session-events.ts:332` — comment + regex. Change comment to "Simplify absolute project paths to <project>/..." and update the regex (search for the actual implementation downstream of the comment) to match either the legacy Desktop-prefixed path or the configured projects dir. Recommended approach: build a regex from `getProjectsDir()` at call time; OR use alternation `(?:Desktop[\\/]+Projects|Projects)` if the existing regex is heavily integrated.

## Comment-update summary

- `src/shared/scope-detector.ts:108,132` — JSDoc + inline; update wording to "configured projects directory (CLAUDEX_PROJECTS_DIR, default ~/Projects/)"
- `src/shared/content-router.ts:9` — JSDoc; same wording
- `src/angel/memory-md-writer.ts:94` — JSDoc reference inside `getDerivedProjectId` chain; same wording
- `src/angel/curated-context-extractor.ts:119` — illustrative example string in a curated_context formatting docstring; update path in example from `~/Desktop/Projects/Lacuna-Betting` to `~/Projects/Lacuna-Betting`. Non-load-bearing.

## Test-fixture handling

- `src/tests/angel/memory-md-writer.test.ts:660,695` — fixture path + comment. Set `process.env.CLAUDEX_PROJECTS_DIR = path.join(tmpHome, 'Desktop', 'Projects')` in `beforeEach` so the fixture path remains and `getProjectsDir()` resolves to it. Update the comment on line 695.
- `src/tests/core/memory-md-verify.test.ts:183` — same approach; inject `CLAUDEX_PROJECTS_DIR = 'C:/Users/Test/Desktop/Projects'` so the existing `cwd` fixture continues to match.

## Keep-with-reason summary

- `src/angel/llama-server-supervisor.ts:26,46,48,139` — llama-cpp binary + GGUF model paths. These are governed by `LLAMA_SERVER_EXE` and `LLAMA_MODEL_PATH` env vars (separate from `CLAUDEX_PROJECTS_DIR`) and the hardcoded `~/Desktop/Projects/llama-cpp/...` is the documented default when those env vars are unset. Out of scope per CONTEXT.md `<execution_context>` — INST-05 is for the projects-scan base dir, not the llama-cpp binary location. Leave untouched.
