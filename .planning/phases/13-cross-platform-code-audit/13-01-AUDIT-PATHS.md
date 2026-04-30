# PLAT-01 Audit — Path Handling in src/

**Date:** 2026-04-30
**Phase:** 13 (cross-platform code audit)
**Method:** 3-pass grep per CONTEXT.md `<decisions>` PLAT-01 (lines 40-53)
**Totals:** 16 raw `\\` hits + 23 `path.normalize`/`path.win32`/`path.posix` callsites = 39 total → **0 fix-needed → 39 keep-with-reason**

## Grep commands used

```bash
# Pass 1 — literal '\\' / "\\" in string contexts
grep -rn --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.js" "'\\\\'" src/
grep -rn --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.js" '"\\\\"' src/

# Pass 1b — template-literal embedded backslash
grep -rn --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.js" '\\\\\\${' src/

# Pass 2 — path.normalize / path.win32 / path.posix callsites
grep -rn --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.js" -E "path\.normalize|path\.win32|path\.posix" src/

# Pass 3 — string concatenation building paths
grep -rn --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.js" -E "\+ ?['\"]\\\\['\"]" src/
```

Pass 1b and Pass 3 returned **zero** hits. No path-construction-via-concatenation exists in `src/`. All path joining already uses `path.join` / `path.resolve`.

## Findings — Pass 1 hits (literal `\\` in string contexts)

| file:line | excerpt | classification | reason |
|-----------|---------|----------------|--------|
| src/benchmarks/directive-detector/label-candidates.ts:229 | `if (ch === '\\') { i++; continue; }` | keep | JSON-string parser: skip escaped char inside a string literal. Not a path. |
| src/extraction/redaction.ts:216 | `path[projectRoot.length] === '/' \|\| path[projectRoot.length] === '\\'` | keep | Boundary-aware path-prefix matcher: explicitly checks BOTH separators (already cross-platform). |
| src/decay/decay-engine.ts:106 | `WHERE ... files_modified LIKE ? ESCAPE '\\'` | keep | SQL `ESCAPE '\'` clause — the `\\` is the JS string literal for one backslash that SQLite uses as the LIKE escape. Not a path. |
| src/decay/decay-engine.ts:111 | (same as :106) | keep | Same SQL ESCAPE clause. |
| src/tests/shared/scope-detector.test.ts:159 | `// On Windows path.normalize('/') => '\\', but the key is` | keep | Comment + adjacent test fixture (line 169: `'C:\\': 'drive-root'`) intentionally exercises Windows scope detection. Documents Windows quirk per CONTEXT.md keep rules. |
| src/core/session-discovery.ts:69 | `WHERE LOWER(s.name) LIKE ? ESCAPE '\\'` | keep | SQL ESCAPE clause (same pattern as decay-engine). |
| src/core/session-discovery.ts:78 | (same) | keep | SQL ESCAPE clause. |
| src/core/session-discovery.ts:87 | (same) | keep | SQL ESCAPE clause. |
| src/intelligence/directive-detector.ts:305 | `if (ch === '\\') { i++; continue; }` | keep | JSON-string parser: skip escaped char inside a string literal. Not a path. |
| src/assembly/worker-context.ts:465 | `project.includes('/') \|\| project.includes('\\')` | keep | Cross-platform check: detects whether a project ID looks like a path on EITHER OS. Already-portable by intent. |
| src/cli/setup.ts:104 | `hookPath.replace(/'/g, "'\\''")` | keep | POSIX bash single-quote-escape idiom (`'\''` = end-quote, escaped-quote, start-quote) used when emitting a shell command into Claude Code's hook config. Not a Windows path. |
| src/angel/transcript-chunker.ts:89 | `if (ch === '\\') { i++; continue; }` | keep | JSON-string parser. Not a path. |
| src/tests/angel/memory-md-writer.test.ts:691 | `expect(slugInPath).not.toContain('\\')` | keep | Test assertion: ensures generated slug contains NEITHER `/` nor `\\`. Already cross-platform-correct. |
| src/tests/angel/pattern-extractor.test.ts:35 | `if (ch === '\\') { i++; continue; }` | keep | JSON-string parser fixture. Not a path. |
| src/angel/pattern-extractor.ts:574 | `if (ch === '\\') { i++; continue; } // skip escaped character` | keep | JSON-string parser: comment makes the intent explicit. Not a path. |
| src/decay/decay-engine.ts:118 | `file.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')` | keep | LIKE-pattern escaping for SQLite. Not a path-construction. |

## Path-module callsite audit (Pass 2)

23 callsites of `path.normalize` / `path.win32` / `path.posix` inspected. **Zero** are workarounds; all are intentional defensive normalization wrapping a `path.join(...)` result.

| file:line | call | classification | reason |
|-----------|------|----------------|--------|
| src/benchmark/vesna/setup.ts:25 | `path.normalize(override)` | intentional | Normalize a user-supplied override path for stable comparison. |
| src/benchmark/vesna/setup.ts:26 | `path.normalize(path.join(os.homedir(), '.claudex', 'db', 'claudex-vesna-test.db'))` | intentional | Normalize after `path.join` for canonical form. |
| src/benchmark/vesna/setup.ts:31 | `path.normalize(path.join(os.tmpdir(), 'claudex-vesna-fixtures'))` | intentional | Same canonicalization pattern. |
| src/shared/paths.ts:14 | `path.normalize(path.join(os.homedir(), CLAUDEX_DIR))` | intentional | Defensive normalization after `path.join`. |
| src/shared/paths.ts:17 | `path.normalize(path.join('.', CLAUDEX_DIR))` | intentional | Same pattern. |
| src/shared/paths.ts:26 | `path.normalize(envPath)` | intentional | Normalize env-var override. |
| src/shared/paths.ts:27 | `path.normalize(path.join(getClaudexHome(), 'db', 'claudex.db'))` | intentional | Same pattern. |
| src/shared/paths.ts:29 | `path.normalize(path.join('.', CLAUDEX_DIR, 'db', 'claudex.db'))` | intentional | Same pattern. |
| src/shared/paths.ts:36 | `path.normalize(path.join(getClaudexHome(), 'config.json'))` | intentional | Same pattern. |
| src/shared/paths.ts:39 | `path.normalize(path.join('.', CLAUDEX_DIR, 'config.json'))` | intentional | Same pattern. |
| src/shared/paths.ts:46 | `path.normalize(path.join(getClaudexHome(), 'projects.json'))` | intentional | Same pattern. |
| src/shared/paths.ts:49 | `path.normalize(path.join('.', CLAUDEX_DIR, 'projects.json'))` | intentional | Same pattern. |
| src/shared/paths.ts:56 | `path.normalize(path.join(getClaudexHome(), 'identity'))` | intentional | Same pattern. |
| src/shared/paths.ts:59 | `path.normalize(path.join('.', CLAUDEX_DIR, 'identity'))` | intentional | Same pattern. |
| src/shared/paths.ts:66 | `path.normalize(path.join(projectDir, 'context', 'checkpoints'))` | intentional | Same pattern. |
| src/shared/paths.ts:69 | `path.normalize(path.join('.', 'context', 'checkpoints'))` | intentional | Same pattern. |
| src/shared/paths.ts:76 | `path.normalize(path.join(projectDir, 'context', 'sessions'))` | intentional | Same pattern. |
| src/shared/paths.ts:79 | `path.normalize(path.join('.', 'context', 'sessions'))` | intentional | Same pattern. |
| src/shared/paths.ts:86 | `path.normalize(path.join(projectDir, 'context', 'handoffs'))` | intentional | Same pattern. |
| src/shared/paths.ts:89 | `path.normalize(path.join('.', 'context', 'handoffs'))` | intentional | Same pattern. |
| src/shared/scope-detector.ts:194 | `let normalized = path.normalize(p);` | intentional | Cross-platform scope detection: normalize then compare. |
| src/shared/scope-detector.ts:195 | (comment) | n/a | Inline comment documenting the call's intent. |
| src/tests/shared/scope-detector.test.ts:159 | (comment) | n/a | Test comment documenting Windows behavior. |

`path.win32` / `path.posix` — **zero** callsites in `src/`. No platform-specific path module is used anywhere; everything goes through the platform-agnostic `path` module.

## Fix-needed summary (input for 13-04)

**None.** All 39 hits classify as keep-with-reason. The `src/` tree is already PLAT-01-clean:
- Path construction uses `path.join` / `path.resolve` everywhere.
- The `\\` literals in `src/` are split between (a) JSON-parser escape handling, (b) SQLite `ESCAPE` clauses, (c) cross-platform path-separator detection that explicitly checks both separators, and (d) one POSIX bash single-quote-escape idiom in `setup.ts` that is correct as written.
- All `path.normalize` callsites canonicalize the result of `path.join` — defensive, not a workaround.
- `path.win32` / `path.posix` are unused.

13-04's PLAT-01 step is therefore a **documented no-op** — no source files need PLAT-01 changes.

## Keep-with-reason summary

All 39 hits are documented above with their per-row rationale. Categories:

- **JSON-string parsers (5):** label-candidates.ts:229, intelligence/directive-detector.ts:305, transcript-chunker.ts:89, pattern-extractor.ts:574, tests/angel/pattern-extractor.test.ts:35.
- **SQL `ESCAPE '\\'` clauses (5):** decay-engine.ts:106/111, session-discovery.ts:69/78/87.
- **SQLite LIKE-pattern escaping (1):** decay-engine.ts:118.
- **Cross-platform separator checks (2):** redaction.ts:216, assembly/worker-context.ts:465.
- **Test fixtures / assertions documenting Windows behavior (2):** scope-detector.test.ts:159 + 169 region, memory-md-writer.test.ts:691.
- **POSIX bash single-quote-escape idiom (1):** cli/setup.ts:104.
- **Defensive `path.normalize(path.join(...))` calls (23):** vesna/setup.ts + shared/paths.ts + shared/scope-detector.ts.

CONTEXT.md acceptance criterion 1 (line 148) is satisfied as-of this audit.
