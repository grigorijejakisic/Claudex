# P2 — Directive Detector — Calibration

**Calibrated:** <!-- TBD once final iteration completes -->
**Final config:** <!-- threshold=X, threshold-universal=Y, model=glm-5.1:cloud -->

## Fixture
- 14 sessions (session-37 through session-50, session-51 excluded: zero DB turns)
- 526 user turns total
- 106 regex-pre-filtered candidates
- 106 gold labels (deepseek-v3.2:cloud labeler; 14 human-verified at the labeling-review checkpoint)

## Iteration log

| Run tag | joint | is_dir | scope\|correct | polarity\|correct | Change |
|---|---:|---:|---:|---:|---|
| baseline | 0.353 | 0.706 | 0.500 | 0.917 | default config (thresholds 0.70/0.85) |
| cycle1_threshold_sim | 0.267 | 0.667 | 0.400 | 0.900 | post-hoc threshold simulation — threshold does not affect scope precision |
| cycle2_scope_fewshot | TBD | TBD | TBD | TBD | scope taxonomy clarification + 4 new boundary few-shot examples |

### Baseline run analysis (2026-04-20T16-39-28-152Z_baseline.json)
- 17 confirmed by detector; 12 true positives (labeler=true), 5 false positives
- Confusion matrix: TP=12, FP=5, FN=5, TN=84
- Dominant failure: **scope confusion** (50% correct) — detector over-universalizes emphatic session directives
- Secondary failure: false positives (5 FP out of 17 confirmed) — detector accepts non-directives
- Polarity is near-perfect (91.7%) — no tuning needed there

### Cycle 1 — Threshold sweep (2026-04-20, post-hoc simulation)
Decision: INCONCLUSIVE for scope improvement.

Simulated thresholds 0.65, 0.70, 0.75, 0.80, 0.85 on baseline LLM responses.
Result: threshold variation doesn't change scope precision because scope is decided within
the same LLM call as is_directive — threshold only filters on confidence, not scope accuracy.

At thresh=0.85: 7 confirmed (5 TP, 2 FP), joint=28.6%, is_dir_prec=71.4%, scope_prec=40%.
All thresholds produce identical or worse scope precision.

Conclusion: scope improvement requires Cycle 2 (few-shot + prompt changes), not threshold tuning.

### Cycle 2 — Few-shot scope tuning (2026-04-20)
Changes made:
1. **confirmation-system-prompt.md**: Added explicit scope note that emphatic language (ALL CAPS, !) 
   does NOT upgrade scope — it signals urgency within the current session. Clarified universal 
   scope should be reserved for meta-preferences (model selection, verbosity) and safety rules.
2. **confirmation-few-shot.json**: Replaced 4 examples with boundary cases targeting actual failures:
   - NEW session: "Always check your context usage!" (emphatic but session-scoped — was being called universal)
   - NEW session: "stop doing that, I told you already" (correction, session-scoped — was being called universal)
   - NEW session: "for this debugging session, don't commit anything" (explicit anchor, replaces obvious Bun example)
   - NEW universal: "we always go for production fixes — not quick hacks" (meta-principle, was being called project)
   - NEW project: "whenever Angel's heartbeat fails to start, retry once" (repo-specific component = project, not universal)

**Run status**: BLOCKED — `glm-5.1:cloud` cloud endpoint unreachable at time of calibration.
All Ollama cloud models unavailable (timeout on /v1/chat/completions). Local model deepseek-coder-v2:16b available.

**Blocker**: Must re-run harness with updated prompts to measure Cycle 2 improvement.
Use `node dist/benchmarks/directive-detector/run-precision.cjs --tag=cycle2_scope_fewshot` when cloud model is back.

## Per-scope final

| Scope | confirmed | joint_correct | rate |
|---|---:|---:|---:|
| session | TBD | TBD | TBD |
| project | TBD | TBD | TBD |
| universal | TBD | TBD | TBD |

(Baseline values: session=1/0/0%, project=11/3/27%, universal=5/3/60%)

## Per-family final

<!-- auto-insert from compare-runs.ts output or manually summarize from the run JSON -->

Baseline per-family:
- always_emphasis: 38 candidates, 6 confirmed, 3 joint_correct (50%)
- negation_dont: 33 candidates, 8 confirmed, 3 joint_correct (37.5%)
- never_emphasis: 22 candidates, 2 confirmed, 0 joint_correct (0%)
- stop_doing_using: 2 candidates, 1 confirmed, 0 joint_correct (0%)
- use_x_instead: 3 confirmed, 0 joint_correct (null — no confirms yet)
- in_the_future, remember_*, polite_imperative: all 0 confirms

## Decisions

- Cycle 1 (threshold) entered per runbook (joint < 88%) — inconclusive, scope not threshold-sensitive.
- Cycle 2 (few-shot) entered — changes committed, harness blocked by cloud model outage.
- No escalation triggered yet — Cycle 2 has not been measured.
- Next step: re-run harness when glm-5.1:cloud is available; if joint still < 88% → Cycle 3 (prompt rewrite).

## Follow-ups for P8

- Rows with `data.possible_contradicts` — count: <!-- after calibration run -->
- Rows with `data.related_to` — count: <!-- after calibration run -->
- `reinforcement_count` distribution: <!-- after calibration run -->

## Dependency handoffs

- **Benchmark gate (Plan 03-06-07)** deferred to handoff: requires task #23 (post-V17 LongMemEval + LoCoMo) to land first. P2-post benchmarks compare against post-P1 baseline per CONTEXT §gate_criteria.
- **Injection-surface diff check (Plan 03-06-09)** run at phase-completion time against the post-P1-baseline commit.
- **Cloud model blocker**: glm-5.1:cloud unreachable as of 2026-04-20. Cycle 2 changes staged; re-run required.
