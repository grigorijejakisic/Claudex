# Q2 — 60-probe disjoint-pool authoring rules (POLISH-14)

**Status:** Authoring rules locked at Plan 11-07 commit time. Probe authoring itself is **user-pair work** per `11-CONTEXT.md` line 108 — orchestrator cannot author drift fixtures alone.

**Trigger:** Q2 only authors probes when `q1-verdict.json` exists AND `verdict === 'BIND_POSITIVE'`. Plan 11-07's `readQ1Gate` confirms; on early-fail, `q2-skipped.json` is emitted and authoring is not started.

**Output:** `.planning/phases/11-polish-land-v6-properly/q2-locked-probes.json` (one JSON file containing an array of 60 probe objects, locked byte-immutable from authoring time forward).

---

## Selection criteria

The 60 probes split as **30 per replication** (no overlap between r1's 30 and r2's 30 within Q2 itself). All 60 are **disjoint from the P9 locked 30** — no probe ID, no anchor session/turn, no canonical question text overlaps.

### Hard disjointness constraints (validator enforces)

1. **Probe IDs:** Q2 probes use ID prefix `q2-{kind}-{NN}` to make disjointness lexically obvious (vs. P9's `drift-{kind}-{NN}`). No `drift-` prefix on any Q2 probe.
2. **Anchor session_id:** No Q2 probe's `transcript_anchor.session_id` may equal any P9 probe's `transcript_anchor.session_id`. Validator reads P9's 30 fixtures and computes the disjointness set.
3. **Anchor turn_index_range:** Even if a Q2 probe shares a `session_id` with a P9 probe (which item 2 already forbids), no overlap of `turn_index_range` is allowed. (Defensive belt-and-suspenders.)
4. **Question canonicalization:** Q2 probes' `prompt` strings normalized (lowercase, whitespace-collapsed, punctuation-stripped) must not equal any P9 probe's normalized prompt. Verbatim duplication is forbidden; near-duplicates are allowed if anchor + condition_shift differ materially.

### Kind-balance constraint

Q2 distributes evenly across the five P9 kinds:
- 12 probes of kind `a` (sample-size shift)
- 12 probes of kind `b` (threshold-source drift)
- 12 probes of kind `c` (scope-change drift)
- 12 probes of kind `d` (dependency-change drift)
- 12 probes of kind `e` (assumption drift)

Per-replication breakdown:
- r1's 30 probes: 6 of each kind (a/b/c/d/e × 6 each)
- r2's 30 probes: 6 of each kind (different probes from r1 within Q2)

**Rationale:** Same per-kind balance as P9 (6 probes per kind × 5 kinds = 30 per replication) preserves comparability; r1 + r2 disjoint within Q2 captures the disjoint-rebind signal that motivated Q2 in the first place.

### Parametric-knowledge avoidance criteria

Q2's whole purpose is to rule out P9-specific fixture overfit. The W2 audit at `11-PROBE-AUDIT.md` classified all 30 P9 probes (none were `parametric-likely`, mostly `parametric-unlikely`). Q2 must structurally avoid the parametric-knowledge confound — not by accident but by authoring discipline:

5. **No probe text may mention popular frontier-LLM-training-data terms** (heuristic from `scripts/audit-probes-parametric.cjs` — react / vue / angular / express / django / flask / spring / http / https / json / yaml / xml / github / stackoverflow / npm / pypi / canonical sorting/hashing algorithms / kubernetes / docker / terraform / aws / gcp / azure / oauth / jwt / saml). If a probe authentically requires one of these terms (e.g., the deliberation actually concerned a webpack bundle), the authoring pair MUST flag it as `parametric_risk: 'mentioned'` in the probe metadata so the audit script counts it; preferably re-author the probe.
6. **All 60 probes anchor on project-internal deliberation traces** — the `transcript_anchor` MUST point at a real session-internal decision moment in claudex-v3's history (not a hypothetical or third-party-standard scenario).
7. **The probe's `condition_shift.past_state`, `current_state`, and `delta` MUST be claudex-v3-specific** — schema versions, phase numbers, our specific architectural choices, etc. Generic SQL-best-practices comparisons are forbidden.

### Source distribution

8. **At least 70% of Q2 probes must be `source: 'real'`** (drawn from real claudex-v3 history). The remaining ≤30% may be `source: 'synthetic'` (constructed by the authoring pair to fill a gap), matching the existing P9 schema constraint.

### Anchor freshness

9. **Q2 anchors should sample from a different session-time-window than P9.** If P9's 30 anchors cluster around session 47 (Qdrant removal) and session 55 (V31 hot-fix), Q2 should preferentially anchor on later sessions (Phase 8/9/10 work) so the rebind tests substrate state the agent could not have memorized at P9 authoring time.

---

## Authoring workflow

This is **user-pair work**. The orchestrator (or the operator's LLM session) does NOT author Q2 probes alone. The pair workflow:

1. Operator picks a candidate session window (later than P9's clustering, per item 9).
2. Together: identify a deliberation moment in that session worth probing.
3. Operator authors `prompt` + `pass_criterion` candidate; LLM checks against rules 1-9 above.
4. Operator validates `transcript_anchor` against the real session JSONL — confirms `session_id` exists, `turn_index_range` covers the right turns.
5. Operator approves the candidate or rewrites.
6. Cycle 60 times (12 per kind × 5 kinds), maintaining r1/r2 disjointness within Q2.
7. Emit `q2-locked-probes.json`. Run the validator.
8. If validator passes: lock the file (commit + checksum).

**Estimated time:** 30 min – 2h per probe (highly variable depending on session-archive familiarity); 30-120h total. This is why the plan calls it user-pair work — orchestrator cannot do it alone in single-context execution.

---

## Validator

`scripts/validate-q2-probes.cjs` (engineering-shipped at Plan 11-07 close) reads `q2-locked-probes.json` and asserts every constraint above. Exit codes:

- `0` — all 60 probes pass; pool is locked-eligible.
- `1` — at least one constraint violated; emits per-probe failure list. Operator must rewrite or ship 11-07 incomplete.
- `2` — file shape error (not 60 probes; not parseable; etc.).

Validator MUST run as a CI gate before `q2-locked-probes.json` is committed. The validator is engineering-shipped; the probe pool itself is operator-shipped.
