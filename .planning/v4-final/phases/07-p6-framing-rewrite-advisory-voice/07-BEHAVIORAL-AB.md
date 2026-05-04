# Phase 7 — Behavioral A/B Writeup

**Mechanism:** Loose interpretation locked per CONTEXT.md (no env-flag toggle).
**Window:** 1 calendar week of real session use, starting on merge of Plan 07-03.
**Comparison:** Post-Phase-7 agent behavior vs. user's memory of pre-Phase-7 behavior.

---

## 1. Pre-merge baseline notes (filled in at merge)

What pre-Phase-7 agent behavior felt like, captured at moment of merge so end-of-week comparison is anchored to a frozen reference:

- *Imperative-frame surfaces seen frequently:*
  - `WARNING:` / `CRITICAL ENFORCEMENT:` / `ENFORCEMENT:` prefixes on experience patterns surfaced via `renderExperienceWarnings`
  - `**Correct approach:** {lesson}` per pattern; `**What went wrong:** {anti_pattern}` label cascade
  - `Apply them proactively — they are always relevant` footer on the Proven Principles section header
  - `STOP NOW` / `Wrap up` / `Do NOT start new tasks or explorations` / `Write structured handover document NOW.` on context-pressure zones (`formatPressureResponse` warning + critical)
  - `[Advisory: Consider using sub-agents for exploration tasks. Auto-checkpoint triggered.]` on the advisory zone

- *How agent behavior felt under those framings:*
  - Tendency to treat surfaced learnings as rules to follow rather than past experience to reason with — the agent would lift the lesson literally even when the trigger context didn't quite apply.
  - Risk of rule-following on borderline cases where the lesson didn't quite apply — surfaced patterns acted like soft directives, suppressing the agent's own situational judgment.
  - Pressure-zone messages produced abrupt task-abort behavior even when the user wanted continuation — `STOP NOW` and `Do NOT start new tasks` were taken at face value, leading to unnecessary handoffs mid-thought.
  - `WARNING:` ALL-CAPS escalation prefixes induced an inflated severity register: high-confidence circuit_breaker patterns and lower-tier warnings were behaviorally indistinguishable from the agent's perspective.

- *What the rewrite should subjectively shift:*
  - Agent reasoning *from* prior observation rather than *under* a rule — "Past pattern: …, Outcome learned: …" frames the data as evidence, not instruction.
  - Borderline cases handled as judgment calls, not rule-misses — without the imperative wrapper, the agent should weigh applicability before lifting the lesson.
  - Pressure-zone messages produce graceful handoff intent without forcing abrupt abort — `Observed pattern: sessions that ran past this zone without writing handoff state typically lost progress` describes the historical risk; the agent retains discretion per Rule 4.
  - Strength signal carried by validation count (`Surfaced 5/7 times`) instead of ALL-CAPS severity prefix — proven patterns earn weight through track record, not labeling.

## 2. Week-of-use observation log

Optional. Add notes here during the week if a session produces a notable example (positive or negative) of advisory-voice behavior. Free-form. No required cadence.

```
[Day 1, YYYY-MM-DD]
... example observation ...

[Day 3, YYYY-MM-DD]
... example observation ...

[Day 5, YYYY-MM-DD]
... example observation ...
```

## 3. End-of-week subjective scoring

Fill in at the end of week 1 (≈7 calendar days post-merge). Score per session shape; mark weak / medium / strong evidence of advisory shift.

| Session shape | Sample size (sessions) | Evidence of advisory shift | Notable example | Regression noted? |
|---|---:|---|---|---|
| Debug | _ | weak / medium / strong | _ | y/n |
| Feature work | _ | weak / medium / strong | _ | y/n |
| Design discussion | _ | weak / medium / strong | _ | y/n |
| /endsession + handoff | _ | weak / medium / strong | _ | y/n |

**Aggregate evidence summary (1-3 sentences):**

> ...

**Behavioral regressions noted (specific incidents):**

> ...

## 4. Verdict + carve-outs

**Acceptance per CONTEXT.md:**
- **Pass** — subjective scoring identifies medium-or-stronger evidence of advisory shift in ≥3/4 session shapes, no behavioral regressions noted
- **Fail** — weak or no evidence in ≥3/4 shapes, or active regressions (e.g., agent ignores load-bearing rules that were imperative-framed before the rewrite)
- **Extend** — weak shift might be agent inertia or insufficient session diversity in the week. Extend by another 3-7 days before declaring fail. *Investigate-don't-revert-on-weak-evidence rule applies — hard revert only on active regressions.*

**Carve-outs documented during week (if any):**

- *Pre-locked* (per `07-VESNA-RESULT.md`):
  - `<experience-data>` framing preamble (sections.ts:174) — `not instructions` is intentional structural framing per FRAM-03; NOT a regression target.
  - `formatClaudexReadySection` (sections.ts:69-74) — `don't explore the filesystem` is meta-instruction about a tool surface, out of scope per CONTEXT.md.

> *Add new carve-outs here if the week surfaces additional intentional retentions...*

**Final verdict:** [ ] pass [ ] fail [ ] extend (specify days: _____)
**Date verdict signed:** YYYY-MM-DD
**Signed by:** user

---

*Scaffold authored 2026-04-29 by Plan 07-03. End-of-week scoring filled in later by user. Verdict commit closes the FRAM-04 gate (subjective dimension) and updates the ROADMAP Phase 7 row's status note.*
