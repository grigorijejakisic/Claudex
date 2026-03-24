# Proactive Memory Research — Unified Synthesis
**Date:** 2026-03-24 | **Session:** 34
**Scope:** 21 parallel research agents across 3 domains
**Goal:** Validate or improve Phase A (Proactive Retrieval) plan

---

## Executive Summary

21 research agents explored cognitive science, existing systems, and frontier research on proactive AI memory. The findings converge on a clear picture:

**Our Phase A plan is validated but incomplete.** The 5 items are the right foundation, but the research reveals:
1. A missing metacognitive layer (System 3) that decides WHEN to act
2. Only 1 of 5 items is genuinely proactive — the rest are "better-reactive"
3. The single highest-impact change isn't any of the 5 items — it's write-time deduplication
4. RL-trained memory management is the dominant paradigm shift we should design toward

---

## The Cognitive Architecture

Every source — cognitive science, production systems, academic research — converges on a three-layer model:

| Layer | Cognitive Model | Claudex Component | Status |
|---|---|---|---|
| System 1 (reflexes) | Fast pattern matching | CC Hooks | Working |
| System 2 (deliberation) | Slow reflective reasoning | Angel | Working, needs prediction capability |
| System 3 (metacognition) | Monitoring + confidence + "know what you don't know" | **Missing** | Needs to be built |

**The metacognitive governor** monitors prediction confidence and decides:
- High confidence → proactive surface (broadcast)
- Low confidence → wait for explicit query
- Tracks accuracy of past predictions to calibrate thresholds

---

## Phase A Items — Validated, Revised, and Prioritized

### Item 1: Artifact Relationship Graph
**Status:** Validated. Approach is correct.
**Key refinements from research:**
- Two-stage linking (A-MEM): fast cosine similarity → LLM validation for meaningful connections
- Fan-effect normalization (ACT-R): divide link strength by `ln(fan + 1)` to prevent hub artifacts from dominating
- 2-3 hop walks are the sweet spot (graph research consensus)
- SQLite recursive CTEs are sufficient at our scale (<10ms at depth 2)
- Add temporal validity windows (Zep's bi-temporal model): `valid_at`/`invalid_at` on links
- Link-type-aware dampening: `caused_by` 2x, `supports` 1.5x, `contradicts` negative

### Item 2: Observation Consolidation
**Status:** Validated. Highest immediate impact.
**Key refinements from research:**
- Mem0's ADD/UPDATE/DELETE/NOOP is the industry standard consolidation model
- SimpleMem's entropy-aware pre-filter: score novelty before LLM processing (don't burn tokens on noise)
- Hindsight's fact/opinion/experience separation: different observation types need different curation rules
- CASS harmful multiplier: negative outcomes weighted 4x heavier than positive
- Maturity progression: candidate → established → proven
- Never delete originals — summaries are acceleration structures, not replacements
- Target: reduce 22K to ~5K high-density records

### Item 3: Intent Prediction at Session-Start
**Status:** The only genuinely proactive item. Highest risk, highest potential.
**Key refinements from research:**
- **Layered prediction** (Dubois's strong/weak anticipation):
  - Layer 0 (strong, no model): thread_state + handoff naturally provide continuation context (~70% of sessions)
  - Layer 1 (weak, simple features): time_since_last_session + hour + day + checkpoint_state
  - Layer 2 (weak, patterns): cross-session Markov transitions + experience pattern triggers
- Temporal signals are disproportionately powerful (Netflix finding)
- Session intent predictable from first 3-5 actions with F1 >60%
- Precision over recall: a wrong prediction is worse than no prediction
- Add prediction accuracy tracking as first-class metric: >70% target

### Item 4: Intent Classification at Prompt-Submit
**Status:** Validated. Better-reactive, not proactive, but high-value.
**Key refinements from research:**
- SimpleMem's intent-aware retrieval planning: infer what the query needs before searching
- Different intents need different retrieval strategies (validated by 20-point accuracy spread)
- Session types to classify: implementation, investigation, verification, planning, maintenance, continuation
- First 3-5 actions are diagnostic (w20 finding)

### Item 5: Negative Retrieval Learning
**Status:** Validated. Our most original feature — virtually nobody else does this.
**Key refinements from research:**
- Retrieval-induced suppression (psychology): non-selected candidates should be actively demoted
- Track both positive (referenced) and negative (surfaced but ignored) signals
- Ori-Mnemos Q-value approach: "Dead end (top-3, retrieved but no follow-up) = -0.15"
- Decay weight for items surfaced N times but referenced 0 times
- Don't zero-out any type entirely — keep a floor

---

## New Items Discovered (Not in Original Plan)

### Item 6: Write-Time Deduplication (HIGHEST IMPACT)
Before inserting any observation, query Qdrant for cosine similarity >0.85. If near-duplicate exists: same session → SKIP, different session + same content → MERGE, contradicting → REPLACE. This single change prevents bloat at the source.

### Item 7: Category-Aware Half-Lives
Error observations: 3-day half-life. Architecture decisions: never-expire. Current flat half-lives are wrong.

### Item 8: Confidence Scores on Artifacts
Add `confidence REAL` to artifacts and patterns. Decays over time without corroboration. Enables abstention: "Low confidence — this information may be incomplete."

### Item 9: Known Unknowns Register
`knowledge_gaps` table: what the system knows it doesn't know. Angel populates when it detects topics mentioned but never explained. Surface in retrieval: "Note: our knowledge on X is thin."

### Item 10: Dream Phase (Cross-Domain Connection Discovery)
Angel periodically samples random pairs of high-activation memories from DIFFERENT domains. LLM evaluates potential connections. 42% puzzle-solving success rate for dreamed-about problems (neuroscience).

---

## The Proactivity Spectrum

Formal definition (Robert Rosen, 1985): An anticipatory system contains a predictive model that runs *faster than real time*. Present behavior is determined by predictions about *future* states.

| Level | Name | Our Items |
|---|---|---|
| 0-3 | Reactive (fast/persistent/scheduled) | Current system |
| 4 | Event-driven reactive | Items 1, 2, 4, 5 (better-reactive) |
| **5-6** | **Predictive/proactive** | **Item 3 (genuinely proactive)** |
| 7 | Fully anticipatory | Phase C (PA) |

**Honest assessment:** Phase A should be renamed "Smart Retrieval + Intent Prediction" — 4 of 5 items make the reactive path smarter, only item 3 crosses the proactive boundary.

---

## Key Formulas and Models to Implement

### ACT-R Base-Level Learning (replace current simplified activation)
```
Bi = ln(Σ tj^(-d))  for j = 1..n access timestamps
```
Requires `artifact_access_log(artifact_id, accessed_at_epoch)` table.

### Spreading Activation with Fan-Effect
```
boost = SPREAD_FACTOR × link.strength × sourceActivation / ln(fan + 1)
```

### Habit Detection (Klein et al.)
```
HS(t+1) = HS(t) - HS(t)*HDP + (1-HS(t))*Beh(t)*Cue(t)*HGP
```
Where HDP=0.15, HGP=0.25, tracked per (action, context) pair.

### Consolidation Affinity (SimpleMem)
```
omega_ij = beta * cos(vi, vj) + (1-beta) * e^(-lambda * |ti-tj|)
```
Cluster observations by semantic similarity weighted by temporal proximity.

### Forgetting with Reinforcement
```
strength = importance * e^(-lambda * days) * (1 + recall_count * 0.2)
```

---

## Anti-Patterns to Avoid

| Anti-Pattern | Risk to Us | Defense |
|---|---|---|
| Clippy (interruptive help) | Item 3 — HIGH | Never interrupt. Pre-materialize, don't notify. |
| Memory Poisoning | Item 2 — HIGH | Provenance on everything. Never delete originals. |
| Stale Model | Item 1 — MODERATE | Temporal decay on link strength. Re-evaluate periodically. |
| Context Collapse | Item 1 — MODERATE | Scope links by project. |
| Engagement Trap | Item 5 — LOW | Measure reference rate, not prediction rate. |
| Compression Failure | Item 2 — HIGH | Tiered compression ratios by observation type. |

---

## The 70/30 Rule

GitHub Copilot's 30% acceptance rate drives massive productivity gains. We should aim for 30%+ of proactive retrievals being referenced, with 70% being ignorable noise that costs nothing. Not 100% accuracy. The cost of rejection must approach zero.

---

## Implementation Priority (Research-Informed)

1. **Write-time deduplication** (new item 6) — highest immediate impact, prevents future bloat
2. **Observation consolidation** (item 2) — Mem0 ADD/UPDATE/DELETE/NOOP model, reduces 22K to ~5K
3. **Category-aware half-lives** (new item 7) — low effort, immediate retrieval quality improvement
4. **Negative retrieval learning** (item 5) — low implementation cost, enables everything else to improve
5. **Artifact relationship graph** (item 1) — two-stage linking, 2-hop walks
6. **Intent classification at prompt-submit** (item 4) — different retrieval strategies per intent
7. **Intent prediction at session-start** (item 3) — the proactive leap, highest complexity
8. **Confidence scores** (new item 8) — enables abstention and trust calibration
9. **Known unknowns register** (new item 9) — Angel detects and tracks knowledge gaps
10. **Dream phase** (new item 10) — cross-domain connection discovery

---

## Paradigm Watch (Longer Term)

- **RL-trained memory management** — the dominant research direction. Design trigger engine as pluggable policy.
- **ALMA meta-learning** — memory architecture search could auto-discover optimal schemas.
- **Sleep-time compute** — validates Angel; study Letta's `rethink_memory` for refinement.
- **Continuum Memory Architecture** — formal vocabulary for what Claudex already does.
- **Latent token memory** (MemGen) — future possibility if LLMs expose latent space access.

---

## Key People to Follow

| Researcher | Affiliation | Relevance |
|---|---|---|
| Joon Sung Park | Stanford/Simile | Invented the reflection+memory architecture |
| Yu Su | OSU (Sloan Fellow) | HippoRAG — hippocampus-inspired memory |
| Andrew Lampinen | DeepMind | Latent learning — episodic memory theory |
| Charles Packer | Berkeley/Letta | LLM-as-OS, sleep-time compute implementation |
| Daniel Chalef | Zep AI | Temporal knowledge graphs |
| Yongfeng Zhang | Rutgers | A-MEM Zettelkasten-inspired memory |

---

## Must-Read Papers

1. "Memory in the Age of AI Agents: A Survey" (Dec 2025) — arxiv:2512.13564
2. "Cognitive Architectures for Language Agents" (CoALA) — arxiv:2309.02427
3. "Diagnosing Retrieval vs Utilization Bottlenecks" (Mar 2026) — arxiv:2603.02473
4. "From RAG to Memory" (HippoRAG 2, ICML 2025) — arxiv:2502.14802
5. "Adaptive Memory Admission Control" (A-MAC, Mar 2026) — arxiv:2603.04549
6. "Sleep-Time Compute" (Apr 2025) — arxiv:2504.13171
7. "ALMA: Meta-Learning Memory Architectures" (Feb 2026) — arxiv:2602.07755

---

## Verdict

Our Phase A plan is **validated and strengthened**. The research confirms:
- Our architecture (hooks → Angel → retrieval) maps to established cognitive models
- Dual-write (SQLite + Qdrant) is the consensus approach
- Hybrid retrieval with RRF is state-of-the-art
- The 5 items are the right foundation

But it also reveals:
- We need write-time deduplication before anything else
- We need a metacognitive layer (System 3) for confidence-gated proactivity
- Only intent prediction (item 3) is genuinely proactive — be honest about this
- RL-trained policies are where the field is heading — design for pluggability
- The 70/30 rule: aim for useful, not perfect
