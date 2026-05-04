# Plan 10-01 Summary — Vesna Harness Core

**Closed:** 2026-04-30
**Commit:** (this plan)
**Wave:** 1 (sequential, autonomous)
**Requirements satisfied (partial):** VESN-04 (harness; CI integration ships in Plan 10-05)

## Files Created

- `src/benchmark/vesna/types.ts` — canonical Probe / SetupStep / ProbeResult / SuiteReport schema; `LexicalLeakageError`, `ProbeSchemaError`
- `src/benchmark/vesna/loader.ts` — JSON probe loader; load-time schema validation; load-time lexical pre-flight
- `src/benchmark/vesna/setup.ts` — setup-step DSL (4 step kinds: artifact, handoff, critical_rule, narration_directive); test DB at `~/.claudex/db/claudex-vesna-test.db` (override via `CLAUDEX_VESNA_DB`); fixture files under `os.tmpdir()/claudex-vesna-fixtures/`
- `src/benchmark/vesna/evaluator.ts` — pattern-match evaluator; AND-semantics across phrase patterns (alternation for OR)
- `src/benchmark/vesna/runner.ts` — three-trial probe runner; agent_text composition over hybrid retrieval + critical rules + handoff render + narration directive
- `src/benchmark/vesna/index.ts` — `runVesnaSuite()` orchestrator; per-category + aggregate gate; flaky exclusion from denominator
- `src/benchmark/vesna/cli.ts` — `bun run vesna` entry; `--probes-dir`, `--trials`, `--strict`, `--json` flags; exit 0 iff `gated`
- `src/tests/unit/vesna-loader.test.ts` — 7 tests
- `src/tests/unit/vesna-evaluator.test.ts` — 6 tests
- `src/tests/unit/vesna-setup.test.ts` — 9 tests (covers production-data-safety, idempotency, isolation)

## Files Modified

- `package.json` — added `"vesna"` script
- `build.ts` — added `src/benchmark/vesna/cli.ts` to optional entry points

## Schema Decisions Ratified

Probe schema matches CONTEXT.md lines 53-70 field-by-field:

```
id              <category>-<3-digit>
category        entity-recall | constraint-recall | handoff-pickup |
                cross-project | lesson-application | self-instrumented | buffer
source_session_id   provenance — real session id (or phase-{n}-design fallback)
source_project      provenance — real project (or 'claudex-v3' for design probes)
source_turn_idx     optional turn within source session
scenario        human-readable description of the retrieval moment
user_prompt     exact text shown to the agent
expected_recall { artifact_id_or_pattern, must_surface_within_turns, must_contain_phrase_pattern[] }
lexical_exclusions  string[] — must NOT appear in user_prompt (load-time assertion)
evaluation      "auto" | "semi-auto" (v4 corpus is auto-only)
setup_steps     SetupStep[] — optional; 4 kinds
buffer_placeholder  optional bool — slots loaded but skipped at runtime
```

SetupStep kinds:
- `artifact` — INSERT INTO artifacts (kind: decision|learning|observation, summary, project, content?, tags?)
- `handoff` — write probe-scoped ACTIVE.md fixture (status, phase, summary, topic, body_what_next?)
- `critical_rule` — INSERT OR IGNORE INTO critical_rules (rule, project?)
- `narration_directive` — write probe-scoped narration.json flag

## Hard Gates Honored

- **Lexical pre-flight at LOAD time** (Phase 6.5 lock): `loadProbes` throws `LexicalLeakageError` synchronously before any probe reaches the runner. Buffer placeholders exempt by design.
- **Test DB isolation**: harness opens `~/.claudex/db/claudex-vesna-test.db` (or `CLAUDEX_VESNA_DB` override). Production `~/.claudex/db/claudex.db` is never opened by the harness. Setup writes are session-tagged so untagged ambient rows in the test DB survive `resetTestDb` — verified by a unit test.
- **3-trial majority** (CONTEXT line 134): `pass` = 3/3, `fail` = 0/3, `flaky` = 1/3 or 2/3. Flaky probes are reported but excluded from gate denominators. `--strict` flag promotes flaky to fail when an operator wants the stricter mode.
- **Per-category AND aggregate gate**: gate = aggregate ≥ 80% AND every NON-EMPTY non-buffer category ≥ 80%. Empty categories exempt so phased rollout doesn't fail before all categories are populated.
- **No LLM-judge**: pattern-match only. CONTEXT line 220 deferred LLM-judge to a post-v4 refinement.
- **No probe inheritance/templating**: CONTEXT line 222 deferred. Each probe is a flat JSON file.

## CLI Surface

```
bun run vesna                                 # default: probes-dir=src/benchmark/vesna/probes, trials=3
bun run vesna -- --probes-dir <path>          # override probe directory
bun run vesna -- --trials 5                   # override trial count
bun run vesna -- --strict                     # fail on flaky probes
bun run vesna -- --json                       # JSON-only stdout (CI-friendly)
bun run vesna -- --help                       # usage
```

Exit codes:
- `0` — `gated === true`
- `1` — gate failed (aggregate < 80% OR any non-empty category < 80% OR --strict and flaky present)
- `2` — harness error (parse, schema, lexical leakage thrown at load time)

## Hand-Verification

- `bun run build` — clean (~127ms), `dist/benchmark/vesna/cli.cjs` emitted
- `bunx vitest run src/tests/unit/vesna-*.test.ts` — 22/22 pass
- `bun run test` — pre-existing 20 failures in `llama-server-supervisor.test.ts` and `llama-client.test.ts` confirmed unrelated to Vesna (verified via `git stash` — same failures present without Vesna changes)
- `node dist/benchmark/vesna/cli.cjs --probes-dir /tmp/empty --json` — vacuous pass: `gated: true`, exit 0
- `node dist/benchmark/vesna/cli.cjs` against the existing pre-Plan-10-02 probes — `ProbeSchemaError` (correct: those probes use the old shape, Plan 10-02 migrates them)

## Deviations from CONTEXT.md

None.

## Hand-forward to Subsequent Plans

- **Plan 10-02** authors against `src/benchmark/vesna/types.ts` and migrates the 5 existing probes; the loader will reject any probe that doesn't match the canonical schema.
- **Plans 10-03 / 10-04** author new probes; lexical pre-flight will catch authoring leaks at load time, so authors get fast feedback.
- **Plan 10-05** wires `bun run vesna -- --json` into a GitHub Actions workflow; the JSON SuiteReport is parseable for `$GITHUB_STEP_SUMMARY`.
