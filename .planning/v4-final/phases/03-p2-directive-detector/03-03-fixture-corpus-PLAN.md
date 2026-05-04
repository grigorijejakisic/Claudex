---
plan_id: 03-03
phase: 3
wave: 1
depends_on: []
files_modified:
  - src/benchmarks/directive-detector/fixture-sessions.ts
  - src/benchmarks/directive-detector/build-candidates.ts
  - src/benchmarks/directive-detector/label-candidates.ts
  - src/tests/benchmarks/directive-detector-fixture.test.ts
  - .planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl
  - .planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl
autonomous: false
requirements:
  - EXTR-04
---

# Plan 03-03: Fixture Corpus + Labeling Harness

## Objective

Turn the session-log corpus (sessions 37-51 → 14 unique session_ids, 526 user turns — see RESEARCH §1.2) into two committed JSONL files:
1. `fixture-candidates.jsonl` — every user turn that matches the regex pre-filter; ~105 rows expected.
2. `gold-labels.jsonl` — each candidate labeled `{is_directive, scope, polarity, human_verified}`.

This plan ships the build tool + the labeler runner + the human-review pass. The labeler runs as a team-spawned sub-agent during P2 execution; this plan defines its contract and calls it.

**`autonomous: false`** — requires human review of ~30 candidates (labeler self-confidence <0.8 + detector/labeler disagreements + 10% spot-check) per CONTEXT §Area 4.

## Must-haves (goal-backward)

- `fixture-sessions.ts` exports `FIXTURE_SESSIONS: Array<{ordinal: number, session_id: string, user_turns: number}>` — the 14-row mapping from RESEARCH §1.2, hard-coded. session-51 excluded. session-38 appears once (dedup by session_id).
- `build-candidates.ts` CLI reads the DB, applies `DIRECTIVE_REGEX_FAMILIES` (from Plan 03-01) + `stripCodeBlocks`, writes `fixture-candidates.jsonl`. Deterministic given the DB state.
- `label-candidates.ts` CLI consumes `fixture-candidates.jsonl` and produces unverified labels using a main-Claude-class model (Sonnet via CLIProxy), NOT glm-5.1. Writes `gold-labels.jsonl` with `human_verified: false` for every row.
- A human-review section in the CLI that prompts for labels needing verification (confidence < 0.8 OR detector-disagreement OR random 10% spot-check), then rewrites the rows with `human_verified: true`. The non-reviewed rows stay `human_verified: false` but carry the labeler's label.
- Test: fixture file exists, has ≥ 90 candidate rows (sanity floor based on measured 105), schema-valid.
- `rg -c 'glm-5.1' src/benchmarks/directive-detector/label-candidates.ts` returns 0 — labeler uses a different model family.

## Tasks

<task id="03-03-01">
  <subject>Create fixture-sessions.ts</subject>
  <description>
Hard-code the 14-session mapping from RESEARCH §1.2:
```ts
export interface FixtureSession {
  ordinal: number;
  session_id: string;
  user_turns_at_build_time: number;  // informational, for drift detection
}

export const FIXTURE_SESSIONS: FixtureSession[] = [
  { ordinal: 37, session_id: 'ba9eeaf8-b666-41f9-8ce7-1a320e683a61', user_turns_at_build_time: 61 },
  { ordinal: 38, session_id: 'be1e3376-62a4-493b-...',              user_turns_at_build_time: 92 },
  // …14 rows total, one per unique session_id
  // session 51 EXCLUDED — 0 DB turns (log-only)
];
```

Use `node -e '...'` + `sqlite3` against `~/.claudex/db/claudex.db` to resolve the full UUID for each ordinal from the session log frontmatter. (The snippet in RESEARCH §1.2 is the reference implementation.)

Export also `resolveFixtureSession(ordinal): FixtureSession | undefined`.
  </description>
</task>

<task id="03-03-02">
  <subject>Create build-candidates.ts — regex pre-filter candidate builder</subject>
  <description>
CLI entry point:
```
bun run src/benchmarks/directive-detector/build-candidates.ts
  [--db=~/.claudex/db/claudex.db]
  [--output=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl]
```

Behavior:
1. Open DB readonly.
2. For each `FIXTURE_SESSIONS` entry:
   - SELECT `turn_number, user_text` FROM `conversation_turns` WHERE `session_id = ?` AND `user_text IS NOT NULL` ORDER BY `turn_number`.
   - Pre-filter: `stripCodeBlocks(user_text)`.
   - Match against `DIRECTIVE_REGEX_FAMILIES` (imported from `src/intelligence/directive-detector-regex.ts` — shared — see RESEARCH §2.3).
   - For every match, emit one JSONL row:
     ```json
     { "candidate_id": "<session_id>:<turn_number>:<regex_family>",
       "session_id": "<session_id>",
       "ordinal": <int>,
       "turn_idx": <int>,
       "raw_text": "<original user_text>",
       "stripped_text": "<after code strip>",
       "matched_families": ["<family_name>", …],
       "context_prev_2": [ {turn_idx, user_text, assistant_text}, … ],
       "context_next_2": [ {turn_idx, user_text, assistant_text}, … ] }
     ```
3. One row per `(session_id, turn_idx)` pair — multiple regex hits in the same turn go into `matched_families[]`, not multiple rows.
4. Atomic write: buffer to string, write with `fs.writeFileSync(..., 'utf8')`.

Determinism: sort output by `(ordinal, turn_idx)`. Committing a stable file enables diff-review across iteration cycles.

Acceptance assertion at end of CLI run: log `emitted N rows across 14 sessions (expected ≥ 90)`. Exit non-zero if < 90 (catches regression from the 105 measured in RESEARCH §1.2).
  </description>
</task>

<task id="03-03-03">
  <subject>Create label-candidates.ts — LLM labeler with main-Claude</subject>
  <description>
CLI entry point:
```
bun run src/benchmarks/directive-detector/label-candidates.ts
  [--input=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl]
  [--output=.planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl]
  --labeler-model=claude-sonnet-4-6       # via CLIProxy (NOT glm-5.1)
```

Hard constraint: `--labeler-model` must NOT be `glm-5.1:cloud`. Detector uses glm; if labeler also uses glm, self-agreement bias inflates precision. Assert this at CLI startup; fail fast with a message.

Call path: CLIProxy exposes a Sonnet endpoint. If CLIProxy is not available on the host running the CLI, the CLI prints an instruction to spawn a labeler sub-agent via the `auto-gsd-pipeline` team and paste the JSONL back. Both paths must produce the same output schema.

Per-candidate prompt template (draft — finalized during execution; kept terse so Sonnet stays within context):
```
You are labeling candidates for a directive-detection eval set.

Directive: a standing rule the user states for future turns — not a task,
question, or one-off instruction.

Scope: session | project | universal
Polarity: prescriptive | prohibitive

Given the CANDIDATE turn and ±2 flanking user turns, output JSON:
{ "is_directive": bool,
  "scope": "session"|"project"|"universal"|null,
  "polarity": "prescriptive"|"prohibitive"|null,
  "self_confidence": number (0..1),
  "reasoning": string }

CONTEXT:
<prev_2 user turns>
--- CANDIDATE (turn N) ---
<candidate user turn>
<next_2 user turns>
```

Output JSONL row schema:
```json
{ "candidate_id": "…",
  "label": { "is_directive": …, "scope": …, "polarity": …, "self_confidence": …, "reasoning": "…" },
  "labeled_by": "claude-sonnet-4-6",
  "labeled_at_epoch": <int>,
  "human_verified": false }
```

Process in batches of 10 candidates per LLM call. `~105 candidates / 10 = ~11 calls`. Temperature 0.
  </description>
</task>

<task id="03-03-04">
  <subject>Human-review pass — update gold-labels.jsonl with human_verified flag</subject>
  <description>
Extend `label-candidates.ts` with a `--review` subcommand:
```
bun run src/benchmarks/directive-detector/label-candidates.ts review
  [--labels=.planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl]
  [--spot-check-rate=0.1]
```

Review logic:
1. Load `gold-labels.jsonl`.
2. Identify needs-review set:
   - `self_confidence < 0.8` (all)
   - random 10% of high-confidence rows (seed the RNG from a CLI flag so the review set is reproducible)
   - disagreement with detector output: requires a detector-run-output file passed via `--detector-run=<path>`; rows where `detector.is_directive != labeler.is_directive OR detector.scope != labeler.scope` go in. In the first run this is empty (no detector output yet) — pass no flag, skip.
3. For each row needing review: print the candidate context + labeler's label + self_confidence; prompt the reviewer for `[a]ccept / [o]verride / [s]kip`. On override: re-prompt for `{is_directive, scope, polarity}` via simple stdin.
4. Rewrite the row with `human_verified: true` (and `reviewer_override: {...}` if the label changed).
5. Atomic rewrite: write to `.tmp` + rename.

**~30 candidates needing review** (CONTEXT estimate: 30 min human time). Keep the CLI UX tight — no clever TUI, just `readline` prompts.

This task is the `autonomous: false` human-gate of the plan.
  </description>
</task>

<task id="03-03-05">
  <subject>Commit fixture-candidates.jsonl + gold-labels.jsonl</subject>
  <description>
Run `build-candidates` and `label-candidates` (with the review pass) in sequence. Commit the resulting files under `.planning/phases/03-p2-directive-detector/fixtures/`.

Rationale for committing: Plan 03-05's precision harness re-runs across iteration cycles need a stable gold set. Committing lets plan-checker verify; lets P2 completion commit snapshot the exact corpus used.

Estimated size: 105 rows × ~1-2KB = ~150-200KB per file. Well within commit-friendly range.

Git-ignore pattern: NOT ignored. These are first-class plan artifacts.
  </description>
</task>

<task id="03-03-06">
  <subject>Write fixture-schema test — directive-detector-fixture.test.ts</subject>
  <description>
- Asserts `fixture-candidates.jsonl` parses line-by-line as valid JSON.
- Asserts ≥ 90 rows (sanity floor).
- Asserts every row has `candidate_id`, `session_id`, `turn_idx`, `raw_text`, `stripped_text`, `matched_families[]`, `context_prev_2`, `context_next_2`.
- Asserts every `session_id` is in `FIXTURE_SESSIONS`.
- Asserts no duplicate `candidate_id`.
- Asserts `gold-labels.jsonl` has same row count as candidates.
- Asserts every `gold-labels.jsonl` row has a `label` with all 5 fields, and a boolean `human_verified`.
- Asserts `labeled_by` is never `'glm-5.1:cloud'` (self-agreement-bias protection).
  </description>
</task>

## Verification

- `ls .planning/phases/03-p2-directive-detector/fixtures/` — both JSONL files exist.
- `wc -l` on both files — equal row counts.
- `bun run test src/tests/benchmarks/directive-detector-fixture.test.ts` — all pass.
- Quick manual read of 5 rows — sanity-check the context/candidate alignment and labeler reasoning.
- Reviewer attestation: at least 25 rows have `human_verified: true` (covers self_conf<0.8 + spot-check).
