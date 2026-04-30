# Phase 10: Vesna Probe Suite as Central Validation — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** Behavioral validation is a first-class deliverable, not a Phase 11 footnote. Benchmarks were dropped from v4 because green numbers feel like progress while artifacts regress (the audit's lesson). Vesna probes ARE the corrective — measure what you claim, on the surface that ships, against the behavior that matters.

---

<domain>
## Phase Boundary

This phase delivers five things and only these five things:

1. **Probe corpus mined from real session histories** across all active projects (claudex-v3, lacuna-betting, oracle, big-mozzy-v2, desktop-01dcc792, nexus). Each retrieval moment in real session history is a candidate probe.
2. **Curated suite of ~20 probes** (locked distribution from 2026-04-29 session):
   - Entity recall: 3 probes
   - Constraint recall: 3 probes
   - Handoff pickup: 3 probes
   - Cross-project: 3 probes
   - Lesson application: 3 probes
   - Self-instrumented gap detection: 2 probes
   - Buffer slots: 3 probes (unallocated; phases claim during their own probe authoring)
   - **Total: 17 core + 3 buffer = 20**
3. **CI integration** — probe suite runs on every PR via `bun run vesna` (or planner-equivalent). Pass rate ≥80% required to merge.
4. **Probes maintained alongside code** at `src/benchmark/vesna/probes/*.json`; harness at `src/benchmark/vesna/`.
5. **Probe authoring guide** documented at `src/benchmark/vesna/README.md` so phases authoring their own probes (e.g., 6.5's cross-project probes, 8.5's self-instrumented probes) follow conventions.

**Out of scope:**
- Replacing Phase 11's SC#1-#4 final validation (Phase 10 ships the *probe surface* that SC#1 measures against; Phase 11 *runs* the gate)
- Per-phase probe authoring (each phase authors its own probes following the guide; Phase 10 ships the guide and initial 17-probe corpus)
- Benchmark replacement (Vesna is behavioral, not benchmark-shaped — different surface, different question)
- Performance benchmarking of probes themselves (probes test recall behavior, not latency)

**Hard gates:**
- Probes mined from REAL session histories, not synthetic. Each probe has provenance: source session ID, source project, retrieval moment that inspired it.
- CI integration must run probes deterministically — same probe + same codebase = same pass/fail
- Pass rate ≥80% required to merge ANY PR (this is the central validation gate)
- Probe authoring guide must be clear enough that downstream phases (6.5, 8.5, etc.) author their own probes without ambiguity

</domain>

<decisions>
## Implementation Decisions

### Probe corpus mining methodology

**Source data:**
- Session history database (`conversation_turns`, `transcript_chunk`) across all active projects
- Manual curation with Angel's assistance: scan recent sessions for "retrieval moments" — points where past memory should have surfaced (sometimes did, sometimes didn't)
- Each candidate moment becomes a probe template

**Probe template:**
```json
{
  "id": "probe-001",
  "category": "entity-recall",
  "source_session_id": "session-abc123",
  "source_project": "lacuna-betting",
  "source_turn_idx": 42,
  "scenario": "After previous session noted 'Mozzart 429 is per-IP, 15-min auto-heal', user opens new session and says X",
  "user_prompt": "investigate another backend for intel gathering",
  "expected_recall": {
    "artifact_id_or_pattern": "project_mozzart_cloudflare_429.md",
    "must_surface_within_turns": 2,
    "must_contain_phrase_pattern": ["per-IP", "rate limit", "auto-heal"]
  },
  "lexical_exclusions": ["rate", "limit", "Mozzart", "429", "shadowban"],
  "evaluation": "auto"
}
```

**Curation principle:** prefer probes where the agent would benefit from organic recall but where the user prompt's lexical surface is DIFFERENT from the relevant memory's lexical surface. Probes that match on surface text are too easy.

### Distribution (LOCKED — 2026-04-29 session)

| Category | Count | What it tests |
|---|---|---|
| Entity recall | 3 | Agent recalls a named entity (project, person, system) from prior context when asked |
| Constraint recall | 3 | Agent recalls a constraint or rule from prior context (e.g., "never use --no-verify") |
| Handoff pickup | 3 | Cold-start session picks up handoff topic without exploratory tool use |
| Cross-project | 3 | Lesson from one project surfaces in another (canonical: shadowban-from-Lacuna) |
| Lesson application | 3 | Past lesson influences current decision (e.g., past Mozzart 429 → choose lower parallelism) |
| Self-instrumented gap detection | 2 | Agent narrates "no prior experience" or "checking prior research" appropriately (Phase 8.5) |
| Buffer | 3 | Unallocated; phases claim during own probe authoring |
| **Total** | **20** | |

### Per-category probe authoring guide

**Entity recall probes:**
- Setup: artifact in DB referencing named entity X
- Probe: user prompt mentions entity-shaped concept WITHOUT naming X explicitly
- Pass: agent surfaces X in response within first 2 turns

**Constraint recall probes:**
- Setup: rule in `critical_rules` (e.g., "always check existing dependencies")
- Probe: user prompt is about to do something the rule applies to
- Pass: agent surfaces rule before acting

**Handoff pickup probes:**
- Setup: ACTIVE.md with `status: active`, specific phase
- Probe: cold-start session, user asks an open question
- Pass: agent first response addresses handoff topic; no exploratory `Glob`/`Grep`/`Bash`

**Cross-project probes:**
- Setup: relevant lesson exists in project A
- Probe: cold-start session in project B, user prompt perceptually-similar but lexically-different
- Pass: project A's lesson surfaces in B's session within first 2 turns; advisory voice; lexical exclusions hold

**Lesson application probes:**
- Setup: past lesson with concrete decision (e.g., "used WebSocket not polling — react in milliseconds")
- Probe: user prompt is about to make a similar decision
- Pass: agent's response cites the prior lesson and applies it

**Self-instrumented gap detection probes (Phase 8.5):**
- Setup: empty memory for the topic OR rich memory for the topic
- Probe: user asks about the topic
- Pass: agent narrates appropriately ("going in cold" vs "checking ... applying")

### CI integration

**Trigger:**
- Every PR run via GitHub Actions (or planner-picked CI tooling)
- Command: `bun run vesna` (canonical) or `node dist/benchmark/vesna/index.cjs`
- Output: per-probe pass/fail + aggregate pass rate + per-category pass rate

**Gate:**
- Aggregate ≥80% required to merge
- Per-category ≥80% required (no masking — one weak category fails the gate)
- Failures: probe ID logged with diagnostic (which artifact didn't surface, why)

**Determinism:**
- Probes run with fixed model temperature, fixed seed where possible, fixed prompt formatting
- Acceptable variance: 3-trial run, take majority outcome
- If trials disagree (1/3 or 2/3): probe is "flaky" — tag and investigate; don't gate on flaky probe

### Harness architecture

**Core loop:**
```
for probe in probes:
  setup_db(probe.setup_steps)        # populate DB with required artifacts
  result = run_session(probe.user_prompt, model_config)
  passed = evaluate(result, probe.expected_recall, probe.lexical_exclusions)
  log(probe.id, passed)
report_aggregate()
```

**Setup steps:**
- Populate test DB with required artifacts (deterministic, idempotent)
- Optionally simulate prior session state (e.g., active handoff)
- Reset between probes — probe N's state must not leak into probe N+1

**Evaluation:**
- Auto-evaluation where deterministic: pattern-match agent output for required phrases, check tool call sequence
- Semi-auto for behavioral nuance: agent's first 2 turns logged for human review on borderline cases
- Probe definition specifies which evaluation mode

### Probe authoring guide (`README.md` content)

Documents:
1. How to mine candidate probes from session history
2. Probe JSON schema
3. Per-category authoring conventions (above)
4. Lexical exclusion rules (probes must test perceptual recall, not text overlap)
5. Setup-step DSL (how to populate DB for a probe)
6. Evaluation mode selection
7. Adding a probe to CI

### Hand-forward to other phases

- **Phase 6.5** authors 3 cross-project probes per the guide
- **Phase 8.5** authors 2 self-instrumented gap-detection probes
- **Phase 11** runs full ~20-probe suite as SC#1 final validation
- **Each future phase** that ships a behavioral change SHOULD author probes for it (encouraged in CLAUDE.md guidance, not enforced as a gate)

### Migration from existing Vesna scaffolding

- Existing Vesna code may be at `src/benchmark/vesna/` or similar; planner audits and refactors
- Existing probes (if any from prior phases) reviewed and either retained or replaced based on per-category coverage
- ~20 probes is a target; if existing scaffolding has 5 good probes, augment to reach 17 core + 3 buffer

### Claude's Discretion (planner free to decide)

- Exact CI tooling (GitHub Actions, custom CI, etc.)
- Per-probe trial count beyond 3 (recommendation: 3 for production gating, more for flaky-probe investigation)
- Whether to support probe inheritance (e.g., probe B = probe A with one variation) — recommendation: not needed for v4 corpus
- Specific evaluation library (regex, LLM-judge, hybrid) for borderline cases
- Probe ID convention (sequential vs categorical) — recommendation: `<category>-<3-digit>`, e.g., `entity-001`
- Whether to track probe authoring lineage (who added which probe when) — recommendation: yes, lightweight, helps debug regressions

</decisions>

<specifics>
## Specific Ideas

### Vesna ≠ benchmark
- Benchmarks ask: "does the system score well on a fixed test set?"
- Vesna asks: "does the system behave correctly in real-world-shaped scenarios?"
- The audit's diagnosis: benchmarks slipped from instruments to product values. Vesna doesn't repeat the failure mode because every probe traces to a real retrieval moment in real session history.

### Behavioral validation is first-class
- Phase 10 was promoted from "smoke check" to "central validation" in the v4 rebind because every other phase's SC#1 gate references the Vesna pass rate. If Vesna isn't first-class, none of the phase gates have teeth.

### Per-category gating prevents masking
- Aggregate 80% is the floor; per-category 80% is the discipline. A system passing aggregate while one category bombs is hiding a real regression.

### Lexical exclusion is the rigor
- Probes whose user prompts share text with the expected recall are testing keyword search, not memory.
- Phase 6.5's HYBRID equivalence is what makes lexical-exclusion probes pass — telemetry-handle overlap + shape vocabulary fire on perceptual similarity.

### Real session history is the source
- Synthetic probes are too clean. Real sessions have noise, ambiguity, partial context — the production reality the system has to handle.
- Each probe's provenance (source session ID, source project) makes it auditable: "this probe represents a real moment when memory mattered."

</specifics>

<deferred>
## Deferred Ideas

- **LLM-judge for evaluation** (rather than pattern-match) — adds dependency + cost; pattern-match is enough for 17 of the initial probes. LLM-judge is a 6.5+ refinement if borderline cases need it.
- **Probe inheritance / templating** — over-engineering for 20-probe corpus
- **Per-user probe corpora** (different probes for different users) — Claudex is single-user; not relevant
- **Probes for performance** (latency, throughput) — Vesna tests recall behavior, not performance
- **Continuous probe authoring from production telemetry** (auto-mine new probes from recent sessions) — interesting future but not 10's scope; corpus is curated for v4

</deferred>

<artifacts>
## Reference Artifacts

- `src/benchmark/vesna/` — existing Vesna scaffolding (planner audits)
- `src/benchmark/vesna/probes/` — probe JSON files (Phase 10 ships 17 core + 3 buffer slots)
- `src/benchmark/vesna/README.md` — authoring guide (Phase 10 ships)
- `conversation_turns` and `transcript_chunk` tables — source data for probe mining
- Active projects' session histories — corpus for probe mining
- `.planning/audits/2026-04-27-v4-trajectory-audit.md` — audit findings (probes should NOT replicate the failure mode of measuring-the-wrong-thing)
- `.planning/PROJECT.md` Q1-Q12 — locked decisions Vesna probes verify

</artifacts>

---

*Phase: 10-vesna-probe-suite-central-validation*
*Context gathered: 2026-04-29*
*Probe distribution locked: 3/3/3/3/3/2 = 17 core + 3 buffer = 20 total*
