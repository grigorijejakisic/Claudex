# Plan 10-03 Summary — 6 new probes (entity-recall + constraint-recall)

**Closed:** 2026-04-30
**Wave:** 2 (parallel-able with 10-02 / 10-04)
**Requirements satisfied (partial):** VESN-01 / VESN-02 (6 more core slots filled, 11/17 total)

## entity-recall (3 probes)

| id | source_session_id | source_project | Entity tested | Perceptual signal in prompt |
|---|---|---|---|---|
| entity-001 | decision:bge-cross-encoder-port-7439 | claudex-v3 | BGE-reranker-v2-m3 on port 7439 | "local cross-encoder service for retrieval" |
| entity-002 | decision:embedding-model-snowflake-arctic | claudex-v3 | snowflake-arctic-embed2 (1024d) via Ollama | "local embedding model" |
| entity-003 | lacuna-betting:bookmaker-monitoring-scope | lacuna-betting | All sports / all settlement moments (lacuna-betting scope rule) | "Which sports does the betting monitor cover?" |

Distribution: 2 distinct projects (claudex-v3 ×2 + lacuna-betting ×1) — meets VESN-01 ≥2 distinct project requirement.

Each probe's `lexical_exclusions` block all entity-specific tokens (BGE/7439, snowflake/arctic/1024, tennis/basketball/all-sports) so the agent must surface the entity from MEMORY rather than from text overlap. Pre-flight passes for all 3.

## constraint-recall (3 probes)

| id | source_session_id | Rule type | Rule text |
|---|---|---|---|
| constraint-001 | claude-md:no-bun-test-rule | tooling | Do NOT use `bun test` — use `bun run test` |
| constraint-002 | claude-md:never-no-verify | git-safety | Never use --no-verify when committing |
| constraint-003 | claude-md:verify-before-claiming-done | process | Verify before claiming done — re-read original request |

Variety covered: 1 tooling rule, 1 git-safety rule, 1 process rule (matches Plan 10-03 PLAN spec).

Each rule is set up via `setup_steps[].kind = critical_rule` so the runner pulls it from the `critical_rules` table during agent_text composition. The runner's surface includes `## Critical Rules` lines so the evaluator's regex matches against the rule text.

## Hand-Verification

```
bun run vesna  →  11/11 (100%) GATED PASS
  entity-recall:    3/3 (100%) flaky=0
  constraint-recall:3/3 (100%) flaky=0
  handoff-pickup:   3/3 (100%) flaky=0
  self-instrumented:2/2 (100%) flaky=0
```

All 6 new probes pass; corpus now 14 probes (5 migrated + 3 buffer + 6 new). Plan 10-04 adds the final 6 (cross-project + lesson-application) to reach the 20-probe lock.

## Hand-forward

Plan 10-04 authors against the same canonical schema. Cross-project probes test Phase 6.5's HYBRID equivalence — the runner's `globalScope: true` flag in `composeAgentText` lets artifacts from a `source_project` other than the current project surface during retrieval.
