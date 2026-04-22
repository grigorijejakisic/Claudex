---
plan_id: 04-03
phase: 4
wave: 1
depends_on: []
files_modified:
  - src/adapters/shared/env-file.ts
  - src/adapters/cc-hooks/session-start.ts
  - src/core/memory-md-verify.ts
  - src/tests/adapters/cc-hooks/hooks.test.ts
  - src/tests/core/memory-md-verify.test.ts
autonomous: true
requirements:
  - CUR-03
---

# Plan 04-03: Auto-Dream Env-File Guard + Session-Start MEMORY.md Verifier

## Objective

Close the two non-writer halves of CUR-03: (1) teach `writeClaudeEnvFile` to emit the auto-dream disable flag so CC doesn't overwrite Angel's MEMORY.md, and (2) add a pure-read session-start verifier that logs `memory_md_invalid` when MEMORY.md's size/line/sentinel invariants are violated. Neither half touches the writer (Plan 04-01) or heartbeat (Plan 04-04).

## Must-haves (goal-backward)

- `src/adapters/shared/env-file.ts::writeClaudeEnvFile` emits `export CLAUDE_CODE_AUTO_DREAM_ENABLED=0` in addition to the existing two lines.
  - Note: the exact CC env-var name **must be verified** against `context/research/cc-source/06-dream-kairos.md` at implementation time. If that research names the var differently (e.g., `CLAUDE_CODE_DISABLE_AUTO_DREAM=1`), use that exact name. Task 04-03-01 makes this verification step explicit so it isn't lost.
- New module `src/core/memory-md-verify.ts` exports `verifyMemoryMd(db, project, sessionId): VerifyResult` — pure read; records a `session_events` row when invariants fail; never mutates the file.
- Session-start integration: `src/adapters/cc-hooks/session-start.ts` invokes the verifier once per session start, after file-artifact ingestion (around line 206), inside a runHookStep-style try/catch that isolates errors per the existing adapter pattern.
- Verifier invariants:
  - File size > 25,000 bytes → flag.
  - File line count > 200 → flag.
  - File contains `<!-- USER EDITABLE -->` marker → first line MUST parse as `<!-- CLAUDEX-MANAGED: ... hash=<64 hex chars> -->`; otherwise flag `sentinel_missing`.
  - File contains `<!-- USER EDITABLE -->` AND first-line sentinel is present BUT hash is not 64 hex chars → flag `sentinel_invalid`.
  - File does not exist → no flag (cold-start is normal; Plan 04-04 triggers creation).
  - File exists and has no `<!-- USER EDITABLE -->` marker → no flag (pre-managed file; Plan 04-04's writer will adopt it on next curation).
- Verifier records session_events row with `event_type='memory_md_invalid'`, `entity=<path>`, `action='verify'`, `detail=<JSON: {reason, bytes, lines}>`. Uses existing `recordEvent` helper.
- Verifier is READ-ONLY — must not call any writer, must not modify the file, must not delete it.
- Env-file test at `src/tests/adapters/cc-hooks/hooks.test.ts:626-680` extended to assert the new auto-dream export line; existing B6 session-agnostic assertion continues to hold.
- Verifier unit tests cover: size exceed, line exceed, sentinel missing when marker present, sentinel invalid hex, cold-start silent, non-Angel-owned file silent.
- `bun run build` succeeds; full `bun run test` passes.
- No edits to `src/angel/*`, `src/assembly/*`. No writer calls. No env-file changes outside the new export line.

## Tasks

<task id="04-03-01">
  <subject>Verify CC auto-dream env var name and emit in writeClaudeEnvFile</subject>
  <description>
Step 1 — NAME VERIFICATION. Open `context/research/cc-source/06-dream-kairos.md` and locate the exact env var CC uses to disable auto-dream. Record the exact name at the top of this task's commit message. Expected candidates:
- `CLAUDE_CODE_AUTO_DREAM_ENABLED=0`
- `CLAUDE_CODE_DISABLE_AUTO_DREAM=1`
- some GrowthBook-flag-override form

If the research file does not confirm an exact name, check `context/research/cc-source/13-new-features-buildable.md` which indexes CC v2.1.88 leaks. If still ambiguous, the planner default is `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` (matches the T1/T2 pattern already used for `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`); document the choice in the commit message as provisional.

Step 2 — Edit `src/adapters/shared/env-file.ts::writeClaudeEnvFile` body:

```ts
fs.writeFileSync(envFilePath, [
  'export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
  'export CLAUDE_CODE_DISABLE_AUTO_DREAM=1',   // NEW (CUR-03 - verify exact name)
  'export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1',
  '',
].join('\n'));
```

Keep the B6 invariant intact: every line must be session-agnostic (no session_id, no dynamic values).

Step 3 — Extend the test at `src/tests/adapters/cc-hooks/hooks.test.ts:638-650` ("writes correct exports when CLAUDE_ENV_FILE is set") to include:
```ts
expect(content).toContain('export CLAUDE_CODE_DISABLE_AUTO_DREAM=1');
```
(using whichever name task step 1 verified). The B6 assertion at line 667 should continue to pass (no session_id / SESSION_ID tokens in the emitted file).

Also extend `src/tests/adapters/cc-hooks/cwd-changed.test.ts:56-` ("writeClaudeEnvFile writes env flags when CLAUDE_ENV_FILE is set") with the same new assertion — cwd-changed calls the same function.
  </description>
</task>

<task id="04-03-02">
  <subject>Create memory-md-verify module</subject>
  <description>
Create `src/core/memory-md-verify.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { recordEvent } from './session-events.js';
import { pathToSlug } from '../shared/cc-slug.js'; // lifted in Plan 04-01 task 04-01-01

export type VerifyReason =
  | 'ok'
  | 'file_missing'
  | 'not_angel_managed'
  | 'size_exceeded'
  | 'lines_exceeded'
  | 'sentinel_missing'
  | 'sentinel_invalid';

export interface VerifyResult {
  path: string;
  reason: VerifyReason;
  bytes: number;
  lines: number;
  hash: string | null;
}

export function verifyMemoryMd(
  db: Database,
  project: string,
  sessionId: string,
  opts: { scope?: string; cwd?: string } = {},
): VerifyResult {
  try {
    const slug = opts.scope ?? pathToSlug(opts.cwd ?? '');
    const memoryMdPath = path.join(
      os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md',
    );

    if (!fs.existsSync(memoryMdPath)) {
      return { path: memoryMdPath, reason: 'file_missing', bytes: 0, lines: 0, hash: null };
    }

    const content = fs.readFileSync(memoryMdPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const lines = content.split('\n').length;
    const firstLine = content.split('\n', 1)[0];
    const sentinelMatch = firstLine.match(
      /^<!-- CLAUDEX-MANAGED: do not edit above user section\. hash=([0-9a-f]+) -->$/
    );
    const hasMarker = content.includes('<!-- USER EDITABLE -->');

    // Non-Angel-managed file — never curated; not our problem.
    if (!hasMarker && !sentinelMatch) {
      return { path: memoryMdPath, reason: 'not_angel_managed', bytes, lines, hash: null };
    }

    // Size / line invariants — flag regardless of sentinel state.
    if (bytes > 25_000) {
      return flag(db, project, sessionId, memoryMdPath, 'size_exceeded', bytes, lines, null);
    }
    if (lines > 200) {
      return flag(db, project, sessionId, memoryMdPath, 'lines_exceeded', bytes, lines, null);
    }

    // Sentinel presence check only when marker is present (CUR-03 semantics).
    if (hasMarker && !sentinelMatch) {
      return flag(db, project, sessionId, memoryMdPath, 'sentinel_missing', bytes, lines, null);
    }
    if (hasMarker && sentinelMatch && sentinelMatch[1].length !== 64) {
      return flag(db, project, sessionId, memoryMdPath, 'sentinel_invalid', bytes, lines, sentinelMatch[1]);
    }

    return {
      path: memoryMdPath, reason: 'ok', bytes, lines,
      hash: sentinelMatch ? sentinelMatch[1] : null,
    };
  } catch {
    return { path: '', reason: 'ok', bytes: 0, lines: 0, hash: null }; // non-throwing; silent on IO errors
  }
}

function flag(
  db: Database, project: string, sessionId: string,
  p: string, reason: VerifyReason, bytes: number, lines: number, hash: string | null,
): VerifyResult {
  try {
    recordEvent(db, sessionId, project, 'memory_md_invalid', p, 'verify',
      JSON.stringify({ reason, bytes, lines }));
  } catch { /* telemetry failure is non-fatal */ }
  return { path: p, reason, bytes, lines, hash };
}
```

Dependency note: this file imports `pathToSlug` from the shared helper `src/shared/cc-slug.ts` created in Plan 04-01 task 04-01-01. If Plan 04-01 merges first, this import works; otherwise the implementer of 04-03 creates the shared helper with just the `pathToSlug` function. The two plans coordinate via that one helper.
  </description>
</task>

<task id="04-03-03">
  <subject>Wire verifier into session-start hook</subject>
  <description>
Edit `src/adapters/cc-hooks/session-start.ts`. After the `ingestFileArtifacts` block (around line 206) and before `seedCriticalRules` (around line 208), insert:

```ts
// MEMORY.md verification — read-only invariant check. Writes to session_events
// if MEMORY.md is oversize, missing sentinel, or malformed. Non-mutating.
try {
  const { verifyMemoryMd } = await import('../../core/memory-md-verify.js');
  verifyMemoryMd(ctx.db, ctx.project, input.session_id, {
    scope: ctx.scope ?? undefined,
    cwd: input.cwd,
  });
} catch (e) {
  emitErrorTelemetry(ctx.db, input.session_id, 'session_start/memory_md_verify', e);
}
```

Use dynamic import to mirror the pattern used elsewhere in session-start.ts for optional modules; direct import is also acceptable if the implementer prefers consistency. Placement rationale: file-ingester already read the same MEMORY.md into retrieval corpus, so cache is hot; verifier is a cheap extra pass.

Do NOT call any writer. Do NOT return a systemMessage based on the verify result — the event is the contract for Phase 4; P3+ formatters are separate phases.
  </description>
</task>

<task id="04-03-04">
  <subject>Verifier unit tests</subject>
  <description>
Create `src/tests/core/memory-md-verify.test.ts`:

- Setup: temp HOME; helper `makeMemoryMd(scope, content)` writes the file at `~/.claude/projects/<scope>/memory/MEMORY.md` within tempdir.
- Spy/stub `recordEvent` via vi.mock to observe flag() calls without actually inserting.

Cases:
1. **file_missing** — tempdir with no file → `reason='file_missing'`, no recordEvent call.
2. **not_angel_managed** — file exists with arbitrary content, no sentinel + no marker → `reason='not_angel_managed'`, no recordEvent.
3. **size_exceeded** — Angel-owned file with valid sentinel but body padded to 26KB → `reason='size_exceeded'`, recordEvent called with correct JSON detail.
4. **lines_exceeded** — file with valid sentinel but 210 lines → `reason='lines_exceeded'`, recordEvent called.
5. **sentinel_missing** — file contains `<!-- USER EDITABLE -->` marker but first line is not a sentinel → `reason='sentinel_missing'`, recordEvent called.
6. **sentinel_invalid** — first line matches sentinel regex but hash is `'abc123'` (6 chars) → `reason='sentinel_invalid'`, recordEvent called with hash in result.
7. **ok** — valid file (sentinel with 64-char hex, marker present, <25KB, <200 lines) → `reason='ok'`, no recordEvent call, `hash` returned.
8. **non-throwing** — simulate fs.readFileSync throw (readonly path) → returns `reason='ok'` without throwing (the silent IO-error fallback). Documented behavior: IO errors are swallowed at this level — session-start telemetry catches the outer throw via its own try/catch.
  </description>
</task>

<task id="04-03-05">
  <subject>Integration smoke test for session-start wiring</subject>
  <description>
Extend `src/tests/adapters/cc-hooks/hooks.test.ts` (the existing session-start suite) with one integration case:

- Pre-populate tempdir HOME with an oversize MEMORY.md for the test project.
- Invoke the session-start hook end-to-end (existing test harness has a helper — mirror the style).
- After the hook returns, query `session_events WHERE event_type='memory_md_invalid'` for the session_id → assert exactly one row, `detail` JSON has `reason='size_exceeded'`.

Do NOT re-test all the verifier logic here — it's covered by task 04-03-04. This single case confirms wiring only.
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/core/memory-md-verify.test.ts` — 8 cases pass.
- `bun run test src/tests/adapters/cc-hooks/hooks.test.ts` — extended env-file test + new integration case pass.
- `bun run test` — full suite green (2020 + new).
- Manual smoke: delete the MEMORY.md under `~/.claude/projects/<claudexv3-slug>/memory/`, start a session → no verify event recorded (file_missing is silent).
- Manual smoke 2: truncate a valid MEMORY.md to remove the sentinel line but keep the marker; start a session → `session_events` has `event_type='memory_md_invalid', detail=... "sentinel_missing"`.
- Diff restricted to `src/adapters/shared/env-file.ts`, `src/core/memory-md-verify.ts`, `src/adapters/cc-hooks/session-start.ts`, `src/shared/cc-slug.ts` (if not already created by Plan 04-01), and the two test files listed in frontmatter.
