# .planning/aggregates/

Milestone-level event-sourced aggregators for empirical questions.

This directory aggregates bound-experience evidence across multiple phases. The pattern was introduced in Phase 2.1 and is intended to be replicated by future empirical phases.

## Pattern

Each empirical question that produces multiple bound experiences across phases gets:

- `<question-slug>.json` — strictly append-only event-sourced log of bound-experience entries.
- `<question-slug>.md` — human-readable projection over the JSON: chronological table + verdict-grouping summary + append-evolving dated interpretive paragraphs.

Current files:

- `multi-handle.json` + `multi-handle.md` — does multi-handle retrieval (semantic + non-semantic) improve recall over semantic-only at our scale?

Anticipated future files (per ROADMAP.md):

- `density-abstraction.json` + `density-abstraction.md` — Phase 5 empirical work: does retrieval-time density-clustering subsume `experience_patterns` injection at our scale?

## JSON event log discipline

```json
{
  "schema_version": 1,
  "question": "...",
  "bound_experiences": [
    {"phase": "...", "labeler": "...", "date": "...", "n": 0, "verdict": "...", "conditions": {}, "metrics": {}}
  ]
}
```

Rules:

- **Strictly append-only.** Existing entries are NEVER modified. Each phase appends exactly the entries it produced.
- **No `winning` / `current_consensus` / `primary` / `combined` key at any level.** Aggregate IS the array; consumers iterate.
- **Schema is forward-compatible**: adding new fields to `conditions` or `metrics` per-entry is fine; renaming/removing fields breaks the parable invariant (history must remain readable as written).
- **Idempotent re-runs**: append callers (currently `src/benchmark/episodic-density/aggregator.ts`'s `appendBoundExperiences`) must skip entries whose `(phase, labeler)` tuple already exists.

## Markdown projection discipline

The markdown file is regenerated from the JSON every render, EXCEPT for the dated interpretive paragraphs under `## Interpretive History`.

Rules:

- **Density-language only.** Permitted: "N bound experiences, M with verdict V"; "density of consistent X / mixed"; "no abstraction yet at this density of evidence"; "more measurements needed before milestone-level claim". Forbidden: any single-experience generalization that promotes a phase verdict to a milestone-level claim about whether the underlying engineering question is settled.
- **No action-conditional language.** The paragraph describes; it does not prescribe next steps. Decisions about what ships next live at the user-approval gate, informed by reading the aggregator.
- **Append-evolving interpretive history.** Each phase that closes PREPENDS a new dated section; prior content remains byte-identical. The history of how synthesis evolved is itself a bound experience.

The lint test at `src/tests/benchmark/episodic-density/density-language-lint.test.ts` enforces the forbidden-phrasing rule on the markdown file.

## Why this pattern, not "RESULTS-thesis.md"

Per the v5 framing doc (`.planning/research/2026-05-04-v5-bound-episodes-framing.md`), abstraction emerges from density of bound experiences, not from any single experience. Naming a file `RESULTS-thesis.md` implies a pass/fail framing the parable rejects — `aggregates/` is parable-aligned and the directory pattern is reusable.

The aggregator markdown's interpretive history is the human-readable projection of bound-experience density over time. Each new dated section is itself a bound experience (the synthesis state at that point in time); prior dated sections record how density looked previously. This matches the framing doc's "raw transcripts append-only; synthesis is a projection" principle applied to our engineering process.

## How a future empirical phase replicates this pattern

1. Pick a slug for the question (kebab-case, descriptive, e.g. `density-abstraction`).
2. In the phase's renderer module (analogous to `src/benchmark/episodic-density/aggregator.ts`):
   - Define the BoundExperience shape for this question's domain.
   - Implement `appendBoundExperiences(newEntries, opts)` with the same idempotent + append-only semantics.
3. In the phase's results renderer (analogous to `src/benchmark/episodic-density/aggregator-renderer.ts`):
   - Implement `renderAggregatorMarkdown(aggregator, priorMarkdown, newParagraph)`.
   - Implement `pickDensityLanguageTemplate` with question-domain-specific templates (still respecting density-language and no-action-conditional rules).
4. The phase runner appends + re-renders at close; the lint test guards forbidden phrasings.

A possible future extension is a generic GSD primitive (`gsd-tools.cjs aggregate-append <slug> <entry-json>`) — captured in CONTEXT.md decision `Deferred Ideas`. Until then, each empirical phase implements its own thin renderer module.
