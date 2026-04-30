# Phase 3: P2 + P8 merge — Context Amendment

**Amendment date:** 2026-04-29
**Original CONTEXT.md gathered:** 2026-04-20
**Reason for amendment:** v4 rebind 2026-04-27 merged old Phase 3 (P2 directive detector) with old Phase 10 (P8 rule lifecycle) into one shippable unit per cross-cutting principle 1 (writers ship with consumers — Phase 3's "2 rows zero consumers" was the canonical anti-pattern of the original architecture).

---

## What changed

The original `03-CONTEXT.md` scoped only the **detector** — write directives to `artifact(kind='directive_rule')`, no consumer surface, no lifecycle. That left "2 rows zero consumers" — directives accumulated with no surfacing mechanism, no supersession, no decay. The audit caught this as a structural gap, and the rebind merged P2 + P8 into one phase.

**This phase now also delivers** (in addition to the original detector scope):

1. **PreToolUse hook surface live in production** — surfaces relevant directive as system-role observation BEFORE the matching tool runs. Per ROADMAP SC#3:
   - `applies_to_paths` (glob) and `applies_to_commands` (regex) fields per directive
   - Relevance threshold: `helped/total ≥ 0.7` AND `total ≥ 10`
   - Max 1 surface per tool call (highest-relevance wins)
2. **Lifecycle (originally Phase 10/P8)**:
   - Scope detection at ingestion (already in original CONTEXT.md as Area 3)
   - **Supersession edges via LLM contradiction check** (NEW in scope)
   - **Confidence decay daily sweep** (NEW in scope)
   - **Auto-archive below threshold** (NEW in scope)
3. **Production consumer count > 0 verifiable in DB telemetry** — without this, Phase 3 is not "shipped" by definition (cross-cutting principle 1)
4. **Vesna probe coverage**: at least 2 probes verifying directive surfaces correctly at decision time (replaces original "joint precision ≥90% measured against fixture sessions" — fixture-session measurement is fine to retain alongside, but Vesna behavioral probes are the SC#1 gate)

## What no longer applies from the original CONTEXT.md

- **"No injection-path changes in this phase"** — superseded. PreToolUse hook surface IS the injection path for directives, and ships in this phase.
- **"Lifecycle (supersession, decay, contradiction resolution) is P8's job"** — superseded. Lifecycle is now part of this phase per the rebind merge.
- **"Detector is Angel-internal — no CC CLIProxy concern"** — still applies for the LLM confirmation layer (Area 2). The PreToolUse consumer surface uses different infrastructure (CC hooks).

## Updated dependencies and gates

- **Depends on**: Phase 2 (artifact table available) — unchanged
- **Phase ordering**: Phase 3 merge ships before Phase 4.1 per ROADMAP execution order (1 → 2 → 3 merge → 4 → 4.1 → ...)
- **Hard gate**: production consumer count > 0 (queryable in DB telemetry) — without this, Phase 3 is structurally incomplete
- **No benchmark gate** — the original CONTEXT.md said "no benchmark regression; 2020 tests pass." The "no benchmark regression" clause is dropped per v4 rebind (benchmarks not used in v4). "2020 tests pass" remains.

## New gates from rebind

- SC#1 alignment: Vesna probe coverage on directive surfacing (≥2 probes pass)
- SC#3 alignment: directives surfacing in MEMORY.md or Critical Reminders Tier (advisory voice — Phase 7)
- SC#4 alignment: directive-related handoff pickup if active

## What the planner should do

1. **Read original 03-CONTEXT.md** for detector design (Areas 1-5 still apply)
2. **Read this amendment** for the merge additions (PreToolUse + lifecycle + consumer count)
3. **Plan covers all merged plans**: 03-07 (PreToolUse hook design + impl), 03-08 (lifecycle: scope detection action + supersession + decay), 03-09 (held-out recall measurement + tune `negation_dont` family), 03-10 (merge ship — verify directive_rule production consumer count > 0)
4. **Old plans 03-01..03-06 are complete** (partial-B detector shipped 2026-04-22 per ROADMAP) — don't replan them; build on top

## Lifecycle implementation specifics (new scope)

### Supersession edges via LLM contradiction check

- When new directive is written, run LLM contradiction check against existing directives in same scope
- If contradiction detected: write supersession edge in `artifact_relations` table (or planner-equivalent); old directive deprecated, new one canonical
- LLM call uses Angel's existing Ollama Cloud client (same as original Area 2)

### Confidence decay daily sweep

- Heartbeat task runs daily (or planner-picked frequency)
- For each `directive_rule`: decay `confidence` by configurable rate (recommendation: -0.02/day, planner tunes)
- Reinforcement (re-detection of same directive in new session) resets decay clock and bumps `confidence` back up

### Auto-archive below threshold

- When `confidence < 0.4` (planner tunes threshold): mark directive `status='archived'`
- Archived directives don't surface via PreToolUse consumer, but stay in DB for audit
- User can manually un-archive if needed (rare)

## Vesna probe coverage (new requirement)

- **Probe 1: Directive surfaces at PreToolUse**: setup directive *"never use --no-verify"* in DB; probe runs Bash command with `--no-verify` argument; expected: directive surfaces as system observation BEFORE Bash runs
- **Probe 2: Supersession works**: setup directive A *"always commit small"*; later session writes contradiction-detected directive B *"prefer larger commits for refactors"*; probe verifies B supersedes A in scope match

These probes hand forward to Phase 10's central validation suite.

## Claude's Discretion (planner free to decide; merged)

Original Areas 1-5 discretion still applies. Plus:
- Exact `artifact_relations` schema for supersession edges
- Heartbeat sweep frequency for confidence decay
- Confidence decay rate (-0.02/day is starting recommendation)
- Auto-archive confidence threshold (0.4 is starting recommendation)
- LLM contradiction-check prompt template (planner picks; few-shot recommended)
- PreToolUse hook surface format (advisory voice — Phase 7 alignment)

---

*Amendment date: 2026-04-29*
*Reason: v4 rebind 2026-04-27 merged old P2 + P8 into single shippable unit*
