# Plan 10-04 Summary — 6 new probes (cross-project + lesson-application)

**Closed:** 2026-04-30
**Wave:** 2 (parallel-able with 10-02 / 10-03)
**Requirements satisfied:** VESN-01 / VESN-02 (final 6 of 17 core slots filled — corpus complete at 20)

## cross-project (3 probes)

| id | Source project | Target project | Lesson tested | Perceptual signal |
|---|---|---|---|---|
| cross-project-001 | lacuna-betting | big-mozzy-v2 | Mozzart 429 = per-IP, 15-min auto-heal — back off, rotate exit IP | "bookmaker source returning 429s — how to back off" |
| cross-project-002 | lacuna-betting | claudex-v3 | Use percentiles (p50/p90/p99), not median, for latency | "How should I report latency numbers for retrieval pipeline?" |
| cross-project-003 | claudex-v3 | oracle | OAuth alongside API keys for production auth | "wiring auth on this new endpoint — is a single key enough?" |

Distribution: source projects = lacuna-betting × 2 + claudex-v3 × 1 (≥2 distinct sources per Plan 10-04 PLAN). Each probe writes both the source-project lesson AND a target-project active marker, so the agent_text composition shows the cross-project surface honestly.

The runner's `composeAgentText` calls `hybridSearchSync(db, prompt, source_project, { globalScope: true })` — globalScope=true is the path Phase 6.5's HYBRID equivalence ships through. The artifact's `(project: lacuna-betting)` annotation in the agent_text is what the evaluator's regex matches against, proving the lesson surfaces with source-project provenance intact.

## lesson-application (3 probes)

| id | Past decision | New decision agent must apply it to | Direction agent must take |
|---|---|---|---|
| lesson-application-001 | Qdrant removed → sqlite-vec single-store (session 47) | "Should we add Pinecone/Qdrant for the new feature?" | Stay single-store; cite migration |
| lesson-application-002 | Hook deadlock — never call CLIProxyAPI from a hook; use Ollama | "Wire an LLM call into post-tool hook" | Use Ollama, cite deadlock |
| lesson-application-003 | No quick fixes — root cause over symptom suppression | "Should I wrap this in try/catch and move on?" | Find root cause, cite engineering discipline |

Each probe has a CONCRETE directional decision, not just an entity to name (Plan 10-04 PLAN's hard discriminator). The agent_text from retrieval contains the decision summary; the evaluator's pattern matches on the directional language ("sqlite-vec/single-store/vec0", "Ollama/deadlock/CLIProxy", "root cause/proper fix/symptom") which the artifact's summary contains.

## Hand-Verification — Full 20-Probe Corpus

```
bun run vesna  →
  entity-recall:    3/3 (100%) flaky=0
  constraint-recall:3/3 (100%) flaky=0
  handoff-pickup:   3/3 (100%) flaky=0
  cross-project:    3/3 (100%) flaky=0
  lesson-application:3/3 (100%) flaky=0
  self-instrumented:2/2 (100%) flaky=0
  AGGREGATE: 17/17 (100%) — GATED PASS
```

Buffer-001/002/003 loaded and skipped (per Plan 01 spec). Total probe corpus = 20 (matches CONTEXT.md lines 76-85 lock: 17 core + 3 buffer).

## Final 20-Probe Corpus Distribution

| Category | Count | Probes |
|---|---|---|
| entity-recall | 3 | entity-001/002/003 |
| constraint-recall | 3 | constraint-001/002/003 |
| handoff-pickup | 3 | handoff-001/002/003 |
| cross-project | 3 | cross-project-001/002/003 |
| lesson-application | 3 | lesson-application-001/002/003 |
| self-instrumented | 2 | self-instrumented-001/002 |
| buffer (unallocated) | 3 | buffer-001/002/003 |
| **Total** | **20** | matches CONTEXT lock |

## Hand-forward

Plan 10-05 ships:
- `.github/workflows/vesna.yml` — PR gate
- `src/benchmark/vesna/README.md` — authoring guide
- 10-CLOSE-SUMMARY.md and REQUIREMENTS / ROADMAP / STATE updates

Phase 11 runs the full 20-probe suite as SC#1 final validation.
