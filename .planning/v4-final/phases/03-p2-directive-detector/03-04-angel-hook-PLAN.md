---
plan_id: 03-04
phase: 3
wave: 2
depends_on:
  - 03-01
files_modified:
  - src/angel/heartbeat.ts
  - src/tests/intelligence/directive-detector-integration.test.ts
autonomous: true
requirements:
  - EXTR-03
---

# Plan 03-04: Wire Detector Into Angel Heartbeat (Before Generic Ingester)

## Objective

Call `extractDirectivesFromSession` inside `src/angel/heartbeat.ts`'s "Phase 2: Process completed sessions" loop, BEFORE `extractPatternsFromSession` runs for the same session. Ensure no benchmark regression and no injection-path change.

## Must-haves (goal-backward)

- `heartbeat.ts:219-261` loop calls `extractDirectivesFromSession(db, session.session_id, session.project)` before `extractPatternsFromSession`.
- Failure in directive extraction does NOT block pattern extraction for that session — existing try/catch pattern preserved.
- `TickResult` gains `directives_extracted?: number` and `directives_errors?: number` telemetry fields, populated from the accumulator.
- Session is NOT marked processed by the directive extractor — marking stays with the pattern-extractor post-condition (per RESEARCH §1.1).
- Integration test: seed a session with 2 user turns containing directives, run one heartbeat tick with a mocked LLM + mocked embedder, assert artifact rows with `kind='directive_rule'` exist and the pattern-extractor still ran.
- `bun run test` — all 2020 tests plus the new integration test pass.
- No modifications to `src/assembler/*`, `src/hooks/*`, or any injection surface.

## Tasks

<task id="03-04-01">
  <subject>Import + add extraction accumulator to TickResult</subject>
  <description>
In `src/angel/heartbeat.ts`:

1. Add import (near the top, grouped with the other `../intelligence/...` imports):
   ```ts
   import { extractDirectivesFromSession } from '../intelligence/directive-detector.js';
   ```
2. Add two optional fields to `TickResult` (grouped with other Phase-X counters):
   ```ts
   // Phase 2b: directive detection (P2)
   directives_extracted?: number;
   directives_errors?: number;
   ```
3. Initialize both to undefined — aggregated only when the detector runs.
  </description>
</task>

<task id="03-04-02">
  <subject>Call detector inside Phase-2 loop, before pattern-extractor</subject>
  <description>
Edit `heartbeat.ts` inside the existing `for (const session of unprocessed)` loop at lines ~228-261. Insert directive extraction in its own try/catch BEFORE the `extractPatternsFromSession` call:

```ts
for (const session of unprocessed) {
  // Phase 2a (NEW): Directive detection — runs BEFORE generic pattern extraction.
  // Failure here must not block pattern extraction for the same session.
  try {
    const dirResult = await extractDirectivesFromSession(
      ctx.db,
      session.session_id,
      session.project,
    );
    result.directives_extracted =
      (result.directives_extracted ?? 0) + dirResult.inserted + dirResult.updated;
    result.directives_errors =
      (result.directives_errors ?? 0) + dirResult.errors;
  } catch {
    // Directive extraction failure is non-fatal. The session is NOT marked
    // processed here — the existing pattern-extractor path owns that.
  }

  // Phase 2b (EXISTING): Generic pattern extraction — unchanged.
  try {
    const extraction = await extractPatternsFromSession(...);
    // … existing body …
  } catch {
    // … existing handler …
  }
}
```

IMPORTANT: the NEW try/catch wraps ONLY the directive call. The existing try/catch at line ~229 stays scoped to `extractPatternsFromSession` + `classifySessionDomains`. Do not widen it.

Do NOT add any `markSessionProcessed` call here. That responsibility stays with the existing path — if pattern extraction produces a definitive outcome (task 03-01-01 from Plan 02-x's file; pre-existing logic at heartbeat.ts:244-247), the session gets marked. Directive extraction is additive.
  </description>
</task>

<task id="03-04-03">
  <subject>Write directive-detector-integration.test.ts</subject>
  <description>
End-to-end test at `src/tests/intelligence/directive-detector-integration.test.ts`:

Setup:
1. Fresh in-memory DB + `applyV17DDL` + base schema.
2. Seed a `sessions` row with `status='completed'` and a session_id.
3. Seed 3 `conversation_turns` rows on that session:
   - turn 1 (user): "always use Bun for tests in this project"
   - turn 2 (user): "for this PR keep the refactor minimal"
   - turn 3 (user): "what does the build command do?"   ← question, not directive
4. Mock `callLocalLLM` via vitest:
   - turn 1 → `{is_directive: true, confidence: 0.92, polarity: 'prescriptive', scope: 'project', suggested_title: 'Use Bun for tests', normalized_text: 'Use Bun for tests in this project.', reasoning: 'explicit'}`
   - turn 2 → `{is_directive: true, confidence: 0.85, polarity: 'prescriptive', scope: 'session', suggested_title: 'Minimal refactor', normalized_text: 'Keep the refactor minimal in this PR.', reasoning: 'explicit'}`
   - turn 3 → `{is_directive: false, confidence: 0.90, ...nulls}`
5. Mock `embedText` to return a stable unit-normalized 1024d vector (different per call to avoid dedup collisions).

Action:
- Build a minimal `HeartbeatContext` (db, config with low thresholds) and call `heartbeatTick(ctx)` once.
- Also mock `extractPatternsFromSession` + `classifySessionDomains` to return `{patternsCreated: 0, summary: 'no patterns found'}` so the test is focused on directive extraction.

Assertions:
- Two rows exist in `artifact` with `kind='directive_rule'`, scopes `project` and `session`, correct `project_id` and `session_id`.
- No row for the question turn.
- `tickResult.directives_extracted` is 2.
- `kind_registry` now contains `directive_rule`.
- `artifact_embeddings` table has 2 rows with corresponding `embedding_ref` values set on the two artifact rows.

Second test: failure isolation.
- Set up so `extractDirectivesFromSession` throws (mock the import to reject).
- Assert pattern-extractor mock still runs (spy on the mock); tick completes without exception; `tickResult.directives_errors` is undefined OR 0; `tickResult.patterns_extracted` is still the mocked value.

Third test: detector runs BEFORE pattern-extractor — use vitest call-order assertions on the two mocked functions within a single tick.
  </description>
</task>

<task id="03-04-04">
  <subject>Injection-path isolation check</subject>
  <description>
Add a repo-scope assertion test at `src/tests/intelligence/directive-injection-isolation.test.ts`:

```ts
import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

it('directive-detector does not import from assembler or hooks', () => {
  const src = fs.readFileSync(
    path.resolve('src/intelligence/directive-detector.ts'),
    'utf8',
  );
  expect(src).not.toMatch(/from ['"].*\/assembler\//);
  expect(src).not.toMatch(/from ['"].*\/hooks\//);
  expect(src).not.toMatch(/from ['"].*\/sections/);
});

it('heartbeat diff does not touch assembler or sections.ts', () => {
  // Optional: git-diff check — run once at phase commit time, not as a running test.
  // Skipping from the test suite; checked in the phase-completion script.
});
```

The first `it` is a running test (cheap, fast). The second `it` is deliberately skipped — phase completion verifies via git diff against the post-P1 baseline (see CONTEXT §gate_criteria). Document that in a comment.
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/intelligence/directive-detector-integration.test.ts` — all pass.
- `bun run test src/tests/intelligence/directive-injection-isolation.test.ts` — all pass.
- `bun run test` — all pre-existing tests still pass.
- `git diff post-P1-baseline -- src/assembler/ src/hooks/ src/core/sections.ts` — empty (no assembler/hooks/sections changes in this phase).
