# 03 — Per-candidate diff: pre-relabel vs post-relabel Cycle 3

Date: 2026-04-22. Author: debug-1 teammate (Phase 3 harness debugging session).

Compares two runs of the Phase 3 precision harness, identical configuration
(`glm-5.1:cloud` at `temperature=0`, `thresh=0.7/0.85`), differing only in
the 12-row user re-label of `gold-labels.jsonl` (commit `72833f6`):

- **Pre-relabel:**  `.planning/phases/03-p2-directive-detector/fixtures/runs/2026-04-20T23-54-58-598Z_cycle3_prompt_rewrite.json`
- **Post-relabel:** `.planning/phases/03-p2-directive-detector/fixtures/runs/2026-04-22T15-48-01-273Z_cycle3_diag.json`

Purpose: provide the evidence the user needs to make the ship / partial-ship / tune
branch decision on 03-06. This note is descriptive only — CALIBRATION.md and
the SUMMARY are not written until the user chooses a branch.

## Headline deltas (from `compare-runs.cjs`)

| Metric | pre-relabel | post-relabel | Δ (pp) |
|---|---:|---:|---:|
| joint_precision | 45.5% | 50.0% | +4.5 |
| is_directive_precision | 81.8% | 75.0% | -6.8 |
| scope_precision_given_correct | 66.7% | 88.9% | +22.2 |
| polarity_precision_given_correct | 88.9% | 66.7% | -22.2 |
| confirmed_by_detector | 11 | 12 | +1 |

Per-scope (post-relabel confirmed rate):

| Scope | pre-relabel | post-relabel | Δ (pp) |
|---|---:|---:|---:|
| project | 37.5% | 55.6% | +18.1 |
| session | 100.0% | 100.0% | 0.0 |
| universal | 0.0% | 0.0% | 0.0 |

## The 12 confirmed candidates (post-relabel)

Dump of all candidates the detector confirmed in the post-relabel run, with
(label vs detector) for each field. `fams` = regex families that triggered
the pre-filter.

```
a320e683a61:53  joint=True   isdir=T/T  scope=session/session        pol=presc/presc     fams=always_emphasis,negation_dont
a320e683a61:56  joint=False  isdir=T/T  scope=universal/universal    pol=prohib/presc    fams=always_emphasis,never_emphasis,negation_dont  ← POLARITY MISS
a320e683a61:59  joint=False  isdir=T/T  scope=universal/project      pol=prohib/presc    fams=never_emphasis                                  ← POLARITY + SCOPE MISS
ab3132afeca:11  joint=True   isdir=T/T  scope=project/project        pol=presc/presc     fams=negation_dont
f4120e8dc096:4  joint=True   isdir=T/T  scope=project/project        pol=presc/presc     fams=always_emphasis
4120e8dc096:39  joint=False  isdir=T/T  scope=universal/universal    pol=prohib/presc    fams=negation_dont                                    ← POLARITY MISS (new confirmation)
4120e8dc096:41  joint=False  isdir=F/T  scope=None/project           pol=None/presc      fams=negation_dont                                    ← is_directive MISS (false positive)
088ceea77dc9:2  joint=True   isdir=T/T  scope=project/project        pol=presc/presc     fams=negation_dont
088ceea77dc9:9  joint=False  isdir=F/T  scope=None/project           pol=None/presc      fams=negation_dont                                    ← is_directive MISS (false positive)
88ceea77dc9:44  joint=False  isdir=F/T  scope=None/project           pol=None/presc      fams=negation_dont                                    ← is_directive MISS (false positive, new confirmation post-relabel)
88ceea77dc9:46  joint=True   isdir=T/T  scope=project/project        pol=presc/presc     fams=always_emphasis,negation_dont
57518ad35f9:43  joint=True   isdir=T/T  scope=project/project        pol=presc/presc     fams=always_emphasis
```

Six correct (joint=True), six wrong — split by failure mode:
- **3 × is_directive miss** (false positives): `4120e8dc096:41`, `088ceea77dc9:9`, `88ceea77dc9:44`
- **3 × polarity miss** (right is_directive + right scope, wrong polarity): `a320e683a61:56`, `a320e683a61:59`, `4120e8dc096:39`
- **0 × pure scope miss** (scope-only fails all happen to also have polarity wrong)
- **1 × combined scope + polarity** (`a320e683a61:59` — counted under polarity miss above)

## Detector-level flips between pre and post runs

Of the 12 post-confirmed candidates, only **two** had the detector itself
change its mind between the runs — everything else is identical detector
output, measured against a changed label set.

```
4120e8dc096:39  detector changed: conf False->True; scope None->universal; pol None->prescriptive; isdir False->True
88ceea77dc9:44  detector changed: conf False->True; scope None->project;   pol None->prescriptive; isdir False->True
```

Both are **new confirmations** (pre: rejected_confirm; post: inserted). Because
`glm-5.1:cloud` at temp=0 is near-deterministic for the same input, and the
fixture context is identical, this LLM-instability is rare but real (the
same model at temp=0 across cloud infrastructure can return slightly
different continuations).

One detector-flip went the other direction:

```
1455d9c74:24    detector changed: conf True->False
```

(`1455d9c74:24` is a non-post-confirmed candidate — dropped below the
confidence gate in the post run.)

## Polarity misses: are they tunable or idiosyncratic?

All 3 polarity misses share a **consistent shape**: user uses a *negation / prohibition form*
that the detector reads as **prescriptive** instead of **prohibitive**.

- `a320e683a61:56`: (fams include `never_emphasis`, `negation_dont`) — labeler says prohibitive, detector says prescriptive.
- `a320e683a61:59`: (fam `never_emphasis`) — labeler says prohibitive, detector says prescriptive.
- `4120e8dc096:39`: (fam `negation_dont`) — labeler says prohibitive, detector says prescriptive.

That is not idiosyncratic noise — it is a **prompt-tunable regression**.
The pattern is consistent: when the regex pre-filter matches a
negation-family (`never_*`, `negation_dont`), the confirmation prompt
is over-biased toward prescriptive-polarity output. A one-shot or few-shot
example in the confirmation-prompt system message demonstrating "never X"
→ prohibitive would likely close this gap at near-zero LLM cost. Prompt
file: `src/intelligence/directive-detector-config.ts` (`confirmationSystem`).

Not a blocker for shipping. Gated behind the user's branch call.

## Scope misses

Only 1 of the 12 confirmed candidates has a pure scope disagreement:

- `a320e683a61:59`: labeler says `universal`, detector says `project`. This
  is the *opposite* of the over-universalization failure mode that dominated
  earlier cycles — the detector here is being *more* conservative than the
  user. This is harder to tune because the `universal` threshold
  (`thresholdUniversal=0.85`) is deliberately stricter, and bumping the
  detector toward universal risks re-introducing the false positives the
  user re-labeled away.

The +22.2 pp scope-precision gain came from the 12 re-labels themselves,
not from detector improvements — 3 of the 12 re-labels corrected gold
scopes that the detector had been predicting correctly all along
(`8ceea77dc9:2`, `ceea77dc9:46`, `20e683a61:34`). Cleaner gold, same
detector, better measured precision.

## is_directive misses (false positives)

The -6.8 pp drop on `is_directive_precision` is driven by 3 cases where
the detector confirms but the re-labeled gold now says `is_directive=False`:

- `4120e8dc096:41`: `negation_dont`-family, detector inserted; gold post-relabel says not-a-directive.
- `088ceea77dc9:9`: `negation_dont`-family, detector inserted; gold post-relabel says not-a-directive.
- `88ceea77dc9:44`: `negation_dont`-family, detector inserted; gold post-relabel says not-a-directive. (This is one of the two detector-flips above — detector upgraded it in the post run *and* the label says it's spurious. Unfortunate timing.)

All 3 false positives are `negation_dont` family. Same tunable surface
as the polarity misses: the `negation_dont` family is over-triggering
the confirmation prompt. A pre-filter tightening (e.g., require a
forward-looking word like "always/never/in the future" AND a negation,
not just a negation alone) would filter these out cheaply. Tracked as
possible follow-up; not a blocker.

## Interpretation for the branch call

- **+4.5 pp joint**: genuine improvement, driven mostly by label-quality
  corrections on scope, not by detector improvements. The detector's
  underlying decision quality is approximately unchanged.
- **+22.2 pp scope**: the headline win. The re-label concentrated fixes
  on scope, so scope_precision_given_correct leapt. Over 0.88 is now
  solidly in the "good enough to ship" zone for this metric alone.
- **-22.2 pp polarity**: real, tunable. 3 polarity misses out of 12 is
  noisy but the failure mode is consistent (negation→prescriptive
  regression). A single few-shot example in the confirmation prompt
  system message would likely fix 2-3 of these.
- **-6.8 pp is_directive**: 3 false positives, all `negation_dont`-family.
  Same tunable surface.

The post-relabel run lands at **joint=0.50** — 0.05 below the handoff's
`joint < 0.55` "regression path C" threshold and 0.25 below the
0.75 ship gate in `03-06-calibration-and-ship-PLAN.md` (gate lowered
in commit `72833f6`).

Three plausible branches:

1. **Ship as-is (partial-ship B):** scope precision at 0.89 is strong.
   Polarity and is_directive regressions are tunable follow-ups.
   Document caveats in CALIBRATION.md. Let Phase 3 actually land.
2. **One tuning cycle first:** add 1-2 few-shot examples to
   `confirmationSystem` targeting `negation_dont`/`never_emphasis` →
   prohibitive polarity + spurious-directive rejection. Re-run. Expect
   joint to move into 0.55-0.65 range at low LLM cost.
3. **Hold for larger corpus:** n=12 confirmations is a fragile
   denominator. ~20-30 confirmations would make the metric stable.
   Requires expanding the candidate set (cheap regex work) or lowering
   thresholds (risks re-inflating FPs).

User's call.

## Appendix: run configuration

```
model:                  glm-5.1:cloud
temperature:            0
threshold_general:      0.70
threshold_universal:    0.85
dedupCosineThreshold:   (config default)
corpus:                 106 candidates
labels:                 106 gold rows (12 rows changed between pre and post)
harness:                src/benchmarks/directive-detector/run-precision.ts
build:                  commit bdca0a3 (per-candidate error isolation; zero ERROR lines fired in either run)
```
