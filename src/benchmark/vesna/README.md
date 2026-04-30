# Vesna Probe Suite — Authoring Guide

Vesna is Claudex v4's central behavioral validation. Every probe traces to a
real retrieval moment in real session history. The discipline isn't "score
high on a fixed test set" — it's "behave correctly when prior context should
matter." Phase 11 runs the full ~20-probe suite as SC#1; CI runs it on every
PR with an aggregate ≥80% AND per-category ≥80% gate.

This README is for engineers authoring or updating probes.

## 1. How to Mine Candidate Probes from Session History

Probes are NOT synthetic. Each probe must trace to a real moment when prior
memory should have surfaced.

Suggested mining flow:

1. `claudex_events` — scan a recent session, find a turn where past context
   was relevant (or relevant-and-missing).
2. `claudex_search "<topic phrase>"` — confirm an artifact (decision,
   learning, observation) exists for the recall target. Capture its
   `provenance` field and the source session ID.
3. Construct a probe whose `user_prompt` mentions the entity-shaped concept
   WITHOUT naming it. The lexical surface of the prompt should be DIFFERENT
   from the lexical surface of the artifact's `summary`.

A "good" candidate is one where:
- A human reading the agent's first response would say *"the agent should
  surface the prior decision here."*
- The user_prompt doesn't trivially contain the entity name (lexical
  exclusions enforce this at load time).
- The behavior matters: a wrong-direction or empty response would mislead
  the user.

Avoid probes whose user_prompt verbatim names the artifact's keywords —
those test FTS5 keyword search, not memory.

## 2. Probe JSON Schema

Each probe is a single JSON file under `src/benchmark/vesna/probes/`. The
schema lives in `src/benchmark/vesna/types.ts` and is enforced at load time
by `loader.ts`:

```jsonc
{
  "id": "<category>-<3-digit>",
  "category": "entity-recall" | "constraint-recall" | "handoff-pickup"
            | "cross-project" | "lesson-application" | "self-instrumented"
            | "buffer",
  "source_session_id": "<real session id from claudex_search; or phase-<n>-design>",
  "source_project": "<project where the lesson lives>",
  "source_turn_idx": 0,                   // optional
  "scenario": "<human-readable description of the retrieval moment>",
  "user_prompt": "<exact text shown to the agent>",
  "expected_recall": {
    "artifact_id_or_pattern": "<reference id or pattern (used in diagnostics)>",
    "must_surface_within_turns": 1,       // 1 or 2 typically
    "must_contain_phrase_pattern": [
      "<regex>",                          // every entry must match (AND)
      "<regex with|alternation>"          // use alternation for OR-semantics
    ]
  },
  "lexical_exclusions": ["<token>", ...], // MUST NOT appear in user_prompt
  "evaluation": "auto",                   // "auto" | "semi-auto" (v4 is auto-only)
  "setup_steps": [                        // optional; see Section 5
    { "kind": "artifact",            "payload": { ... } },
    { "kind": "handoff",             "payload": { ... } },
    { "kind": "critical_rule",       "payload": { ... } },
    { "kind": "narration_directive", "payload": { ... } }
  ],
  "buffer_placeholder": false             // true for unallocated slots only
}
```

Required fields: `id`, `category`, `source_session_id`, `source_project`,
`scenario`, `user_prompt`, `expected_recall`, `lexical_exclusions`, `evaluation`.

## 3. Per-Category Authoring Conventions

### entity-recall (3 probes shipped)
- **Setup:** an artifact in DB referencing a named entity X (project, system,
  person, tool, library, port, model identifier).
- **Probe:** user_prompt mentions an entity-shaped concept WITHOUT naming X.
- **Pass:** agent surfaces X in the response within `must_surface_within_turns`.
- **Example:** `entity-001` (BGE-reranker on port 7439) — prompt says "local
  cross-encoder service for retrieval"; exclusions block `BGE`, `7439`,
  `bge-reranker`, `v2-m3`.

### constraint-recall (3 probes shipped)
- **Setup:** a row in `critical_rules` (use `setup_steps[].kind = critical_rule`).
- **Probe:** user_prompt is about to do something the rule applies to.
- **Pass:** agent surfaces the rule before acting.
- **Example:** `constraint-001` (no-bun-test rule) — prompt says "Run the
  test suite"; agent should surface `bun run test` / `vitest` / "native runner"
  language.

### handoff-pickup (3 probes shipped)
- **Setup:** `setup_steps[].kind = handoff` writes a fixture ACTIVE.md with
  `status`, `phase`, `topic`, `summary`, `body_what_next`.
- **Probe:** cold-start prompt that tests status-aware first-line surface.
- **Pass:** agent's response includes the status-aware line ("Active handoff
  at phase X: topic." / "Handoff paused at phase X." / "No active handoff.")
  without leaking body content for non-active states.

### cross-project (3 probes shipped)
- **Setup:** an artifact in project A AND a separate active-project marker
  for project B. The runner's `composeAgentText` calls retrieval with
  `globalScope: true`, so cross-project artifacts surface naturally.
- **Probe:** user_prompt is perceptually similar to project A's lesson but
  framed in project B's domain.
- **Pass:** project A's lesson surfaces in the response (the artifact's
  `(project: A)` annotation appears in the agent_text).

### lesson-application (3 probes shipped)
- **Setup:** an artifact carrying a CONCRETE directional decision (not just
  an entity to name).
- **Probe:** user_prompt is about to make a similar decision.
- **Pass:** agent's response cites the lesson AND applies its direction.
- **Discriminator vs entity-recall:** if removing the directional language
  from the artifact makes the probe still pass, the probe is really
  entity-recall in disguise — rewrite or recategorize.

### self-instrumented (2 probes shipped)
- **Setup:** `narration_directive { silent: false }` plus either rich memory
  (gold-result branch) or empty memory (empty-surface branch).
- **Probe:** user_prompt about a topic.
- **Pass:** agent narrates appropriately ("checking ... applying" for gold;
  "no prior experience" / "going in cold" for empty).

### buffer (3 slots reserved)
Unallocated. `buffer_placeholder: true` skips them at runtime and excludes
them from the gate. Future phases (6.5+, 8.5+, etc.) claim a slot by
replacing its file with a real probe and setting `buffer_placeholder: false`
(or removing the field).

## 4. Lexical Exclusion Rules — The Rigor

Probes whose user_prompt shares text with the expected memory are testing
keyword search, not memory. The loader enforces this at LOAD time by
throwing `LexicalLeakageError` when any `lexical_exclusions` token appears
(case-insensitive substring) in `user_prompt`.

How to author exclusions:
1. List the most specific tokens from the artifact's `summary` field that an
   agent would "leak" through if memory weren't doing real work — proper
   nouns (`Mozzart`, `BGE`), magic numbers (`7439`, `1024`), distinctive
   compound terms (`per-IP`, `auto-heal`).
2. Verify by hand: every word in `lexical_exclusions` must NOT appear
   (case-insensitive) in `user_prompt`.
3. Run `bun run vesna --probes-dir src/benchmark/vesna/probes/<your-new-probe>.json`
   to confirm the loader accepts it (or `bun run vesna` for the full suite).

Generic concept words (`rate-limit`, `auth`, `latency`, `vector`) are
allowed in the user_prompt — those are the perceptual signals that should
let retrieval find the lesson. Block only the lesson's distinctive surface.

`self-instrumented-002` ships with `lexical_exclusions: []` by design: it
tests narration of ABSENCE; there is no memory text to lexically diverge
from. Empty exclusions are valid in this special case — document the reason
in `scenario`.

## 5. Setup-Step DSL

Setup steps populate the test DB and fixture files between probes. Four
kinds, all idempotent:

```jsonc
{ "kind": "artifact", "payload": {
    "kind": "decision" | "learning" | "observation",
    "summary": "<text the runner pattern-matches against>",
    "content": "<optional longer body>",
    "project": "<project the artifact belongs to>",
    "tags": ["optional", "tags"]
}}

{ "kind": "handoff", "payload": {
    "status": "active" | "paused" | "archived",
    "phase": "<string>",
    "summary": "<text>",
    "topic": "<topic-slug>",
    "body_what_next": "<optional what's next prose>"
}}

{ "kind": "critical_rule", "payload": {
    "rule": "<rule text — what the runner pattern-matches against>",
    "project": "<optional; defaults to vesna-test>"
}}

{ "kind": "narration_directive", "payload": {
    "silent": true | false
}}
```

**Test DB isolation:** the harness opens
`~/.claudex/db/claudex-vesna-test.db` (override via `CLAUDEX_VESNA_DB` env).
Production `~/.claudex/db/claudex.db` is **never** opened by the harness.
Setup writes are session-tagged (`vesna-probe-{id}-t{trial}`) so untagged
ambient rows in the test DB survive `resetTestDb` between probes — verified
by a unit test in `src/tests/unit/vesna-setup.test.ts`.

## 6. Evaluation Mode Selection

`"evaluation": "auto"` — pattern-match evaluator runs without human review.
v4 corpus is auto-only.

`"evaluation": "semi-auto"` — first 2 turns logged for human review.
RESERVED for future probes; not implemented in v4. CONTEXT.md line 156.

## 7. Adding a Probe to CI

1. Drop a `*.json` file into `src/benchmark/vesna/probes/`.
2. Run `bun run vesna` locally — verify it loads, runs, and passes.
3. Commit. CI picks it up on the next PR via `.github/workflows/vesna.yml`.
4. If you're claiming a buffer slot, just replace the buffer file's contents
   in place; rename only if the new probe carries a non-buffer category id.

## Hand-forward to Other Phases

- **Phase 6.5** ships 3 cross-project probes; if 6.5 wants its own canonical
  probe, claim a buffer slot (`buffer-001/002/003`).
- **Phase 8.5** ships 2 self-instrumented probes (`self-instrumented-001/002`),
  migrated to canonical schema in Plan 10-02.
- **Phase 11** runs the full 20-probe suite as SC#1 final validation.
- Future phases authoring own probes: follow Section 7. Probe authoring is
  encouraged for any phase that ships behavioral change — not enforced as a
  gate (CONTEXT.md line 174).

See `.planning/phases/10-vesna-probe-suite-central-validation/10-CLOSE-SUMMARY.md`
for the v4 corpus distribution and harness architecture details.
