# Gemini Review — v6 P9 Binding-Measurement Harness Methodology

**Date:** 2026-05-09
**Reviewer:** Gemini (via gemini-cli)
**Scope:** `src/benchmark/deliberation-surfacing/*` + `src/tests/benchmark/deliberation-surfacing/*`
**Methodology grade:** **F**
**Verdict-defensibility grade:** **F**
**Trigger:** v6.0.0 pre-push consultation — explicitly asked whether the +0.0038 Wilson lower-bound bind that justified shipping v6.0.0 is methodologically defensible.

---

## Critical Summary

This review independently invalidates the v6.0.0 bind via three different findings, any one of which is sufficient to overturn the verdict. **Per the pre-committed v5/v6 methodology discipline, this is a structural verdict failure, not a "narrow but honest" bind.**

---

## Findings

### 1. JUDGE PROMPT — Prongs Independence & Rigging — CRITICAL

- **Files:** `src/benchmark/deliberation-surfacing/arm-summary.ts:98` and `.planning/phases/09-empirical-measurement/judge-prompt.md`
- **Finding:** The prongs are structurally biased to guarantee the A-arm fails. Prong 2 of the rubric requires the agent to *"cite specifically... with `session_id` + `turn_index`"*. The A-arm's prompt explicitly commands the agent to *"Cite specific session_ids and turn_indexes"* (line 98), but the context injected into A-arm is strictly `[ctx-${i+1}] ${summary}` (line 80). The A-arm is starved of the required metadata. Conversely, the B-arm is explicitly fed `[from session_id=..., turn_index=...]` (`arm-transcript.ts:160`).
- **Implication:** The Δ(transcript − summary) isn't measuring whether verbatim transcripts *surface deliberation*; it is measuring the fact that B-arm was handed the metadata required to pass Prong 2 while A-arm was not. **The joint pass rate is completely artificial.**

### 2. BI-ENCODER PATH IDENTITY — Harness vs. Production — CRITICAL

- **Files:** `src/benchmark/deliberation-surfacing/arm-transcript.ts:58-76` vs. `src/retrieval/transcript-routing.ts:98-100`
- **Finding:** The retrieval primitives do NOT match, completely invalidating the bind.
  - **Production (`transcript-routing.ts`):** Uses deterministic SQL hard-filtering on the exact session (`WHERE session_id = ? AND created_at_epoch_ms BETWEEN ? AND ?`) and then ranks candidates.
  - **Harness B-arm (`arm-transcript.ts`):** Embeds the query and uses dense vector KNN search (`WHERE v.embedding MATCH ? AND v.k = ?`) across the entire `vec_transcript_chunks_v6` substrate.
- **Implication:** The measurement benchmarked the performance of a semantic vector search, but production ships a temporal hard-join. **The empirical justification for v6.0.0 does not map to the shipped code.**

### 3. JUDGE CALIBRATION — The All-1.000 Fix — MEDIUM

- **File:** `src/benchmark/deliberation-surfacing/judge.ts:122`
- **Finding:** The undocumented fix that resolved the all-1.000 calibration error was hardcoding `options: { temperature: 0 }` into the Ollama payload. There are zero code comments explaining why this is crucial for the LLM-as-judge.
- **Implication:** Because it's undocumented, any future refactor of the Ollama client payload, or a switch to a different inference provider where temperature 0 behaves differently, risks silently reverting to broken 1.000-pass-rate calibration.

### 4. WILSON DELTA CI — Pseudoreplication / Invalid Pooling — CRITICAL

- **Files:** `src/benchmark/deliberation-surfacing/verdict.ts:47-48` and `wilson.ts:74`
- **Finding:** The math is fundamentally compromised by pseudoreplication. `poolReplications` sums the pass counts and total probe counts across replications (e.g., n=30 run twice becomes n=60). The 30 probes evaluated in replication 2 are the *exact same queries* evaluated in replication 1.
- **Implication:** Treating repeated measurements of identical queries as independent statistical samples artificially inflates n. This illegally shrinks the standard error, which is the only reason the Wilson CI lower bound cleared zero by a razor-thin +0.0038. **At a statistically valid n=30, the CI would easily bracket zero, resulting in an INCONCLUSIVE verdict.**

### 5. PROBE FIXTURES — Confounding Variables in A/C Kinds — HIGH

- **File:** `.planning/phases/09-empirical-measurement/probes/drift-c-01.json` (Pass Criterion)
- **Finding:** The probes are measuring general model competence, not retrieval drift. For `drift-c-01`, the pass criterion mandates that the agent *"identify v6 P10's expanded write/read surface (transcript_chunk_v6 etc.)"*. However, `transcript_chunk_v6` is mentioned nowhere in the B-arm transcript anchor (which is from a v5 hotfix) and nowhere in the probe prompt.
- **Implication:** For the agent to pass, it must rely on its parametric memory or latent system context regarding the v6 architecture. The benchmark conflates the model's inherent coding knowledge with the value of the retrieval substrate.

### 6. JUDGE-MODEL = AGENT-MODEL — Self-Grading Bias — HIGH

- **Files:** `src/benchmark/deliberation-surfacing/arm-summary.ts:6` and `judge.ts:7`
- **Finding:** `AGENT_MODEL` and `JUDGE_MODEL` are both `deepseek-coder-v2:16b`.
- **Implication:** LLMs suffer from severe self-preference bias when grading their own outputs. The judge is highly predisposed to map the agent's specific phrasing, tone, and logic mapping onto a "PASS" merely because it fits its own internal distribution of a "good" answer, blinding the rubric.

---

## Overall Grades

- **Methodology Grade: F.** The harness tests a completely different retrieval architecture than what is actually shipped in production (Vector KNN vs. Temporal SQL Join). Additionally, the evaluation rubric is structurally rigged against the baseline (Prong 2 metadata starvation).
- **Verdict-Defensibility Grade: F.** The "positive" result justifying the v6 ship is mathematically invalid. It relies entirely on inflating the sample size to n=60 via pseudoreplication over identical probes. The true independent-sample CI at n=30 is INCONCLUSIVE.

---

## Phase 11 Implications

This review's three CRITICAL findings each independently require remediation before any rebind can produce a defensible verdict:

1. **Replace harness B-arm retrieval with the production `routeFromArtifact` path.** Whatever ranks ships ranks.
2. **Either give A-arm metadata access, OR replace prong 2 with content-engagement criteria that don't require explicit metadata citations.** Otherwise the lift conflates retrieval value with metadata access.
3. **Replace pooling with paired McNemar's test on the 30-probe paired pass/fail patterns, OR run replications with disjoint probe pools (60 unique probes, 30 per replication).** The statistical design must be locked in CONTEXT before measurement.

Phase 11 W2 (methodology fix) addresses all three.
