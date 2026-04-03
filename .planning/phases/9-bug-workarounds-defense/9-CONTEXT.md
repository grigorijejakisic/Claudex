# Phase 9: Bug Workarounds & Defensive Measures - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Defensive hardening against known CC bugs, conflict prevention for future CC features, and cache safety guards. All items are either log-only awareness, centralized guards, or document-readiness. No new user-facing features.

</domain>

<decisions>
## Implementation Decisions

### Already Addressed (4 items — no work needed)

| Item | Status | Covered By |
|------|--------|------------|
| **B1** (attachment accumulation) | DOCUMENTED | T1 disabled auto-memory writes, T3 minimized UPS injection. CC's lack of dedup is architectural. |
| **B3** (InstructionsLoaded not firing post-compact) | DONE | Phase 4 built PostCompact hook (H4) as replacement. Working. |
| **B6** (session ID mismatch on resume) | DONE | Phase 1 — session ID sourced from hook payload, not env file. |
| **C4** (lean post-compact injections) | DONE | Phase 3 restructured injection. PostCompact hook is lean (42 lines). |

### B2: Resume Cost Awareness (IMPLEMENT — log-only)
- Log `resume_cost_warning` event in session-start when session type is `resume`
- Record to `session_events` table only — do NOT surface to user via assembly
- Include CC version in event metadata (regression is since v2.1.69)
- Rationale: User can't act on this. It's telemetry for Claudex to understand token budget drain.

### B4: Duplicate Compaction Agent Detection (IMPLEMENT — log-only)
- Detect in Stop hook via token usage spikes (compaction agents consume up to 65% of session quota)
- Log `duplicate_compaction_detected` event when anomalous token usage is observed
- Do NOT surface to user — noise they can't act on
- Detection heuristic: if `cache_creation_input_tokens` spikes dramatically between consecutive Stop events within a short window, likely duplicate compaction

### B5: Edit Tracking + Post-Compact Verification (IMPLEMENT — Claudex-relevant files only)
- Track edits ONLY for Claudex-relevant files: `src/`, `CLAUDE.md`, `.claude/rules/`, `context/`
- Record edit events in PostToolUse when Edit/Write tools touch tracked paths
- In PostCompact, log whether tracked edits survived (check via git status or file mtime)
- Log to `session_events` — do NOT alert user
- Rationale: If edits are reverted, the next session catches it via git status. Silent logging is sufficient.

### B8: Plugin Permissions (DOCUMENT ONLY)
- We're on Windows — chmod is irrelevant
- Add a note in `hooks-safety.md` conditional rule: "On Linux/macOS, hook scripts installed by plugins may lose execute permissions (#40050, #40187). Run `chmod +x` after plugin install."
- No code changes needed

### C3: KAIROS Mode Detection (IMPLEMENT — log + warn only)
- Current state: session-start already checks for `~/.claude/projects/<slug>/memory/logs/` directory existence and logs `kairos_mode: true/false` in `cc_environment` event
- Enhancement: Record a dedicated `kairos_detected` event when detected
- Inject ONE LINE in session-start additionalContext: "KAIROS mode active -- Angel consolidation may conflict"
- Do NOT disable Angel or switch memory format — KAIROS is rare and experimental
- Rationale: Defensive awareness, not behavioral adaptation. If KAIROS ships widely, we'll build Phase-level adaptation.

### C5: VERIFICATION_AGENT Readiness (DOCUMENT ONLY)
- `solution_outcomes` table already exists in V12 schema
- Infrastructure is ready to receive structured PASS/FAIL/PARTIAL verdicts
- When CC ships VERIFICATION_AGENT, wire its output into `solution_outcomes` via PostToolUse or a dedicated hook
- No code changes now — document the wiring plan

### K4: `cch=` Billing Sentinel Guard (IMPLEMENT — centralized)
- CC's standalone binary performs global string substitution of `cch=XXXXX` patterns across ALL historical tool results, permanently breaking prompt cache
- Centralize guard in `infrastructure.ts` `writeStdout()` function
- Replace any `cch=XXXXX` pattern (regex: `/cch=[a-f0-9]{3,}/gi`) with `cch_XXXXX` (underscore instead of equals sign)
- One place, all hooks protected — every hook output flows through `writeStdout()`
- This is a cache safety measure, not a security measure

### Claude's Discretion
- B4 detection heuristic thresholds (what constitutes "anomalous" token usage) — researcher/planner can determine reasonable values
- B5 file mtime vs git status for verification method — use whichever is simpler in the PostCompact hook context
- K4 regex specificity — whether to guard against `cch=` followed by exactly 5 hex chars or be more permissive

</decisions>

<specifics>
## Specific Ideas

- K4 guard placement in `writeStdout()` is critical — this is the single chokepoint for all hook JSON output. The `wrapHook` infrastructure already channels all output through this path.
- B5 edit tracking should use PostToolUse's existing `tool_name` field to filter for Edit/Write tools, then check the file path against the tracked directories.
- C3 KAIROS warning should be conditional — only inject when `kairos_mode` is actually true, not on every session start.
- B2/B4 are pure telemetry — they feed into Claudex's understanding of token economics but produce no user-visible output.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/adapters/cc-hooks/infrastructure.ts` | K4: Add `cch=` pattern sanitizer in `writeStdout()` |
| `src/adapters/cc-hooks/session-start.ts` | B2: Log resume cost warning. C3: Inject KAIROS warning line. |
| `src/adapters/cc-hooks/post-tool-use.ts` | B5: Track edits to Claudex-relevant files |
| `src/adapters/cc-hooks/post-compact.ts` | B5: Verify tracked edits survived compaction |
| `src/adapters/cc-hooks/stop.ts` | B4: Detect duplicate compaction via token usage spikes |
| `.claude/rules/hooks-safety.md` | B8: Add chmod note for Linux/macOS plugin installs |

## Files to Create

None.

---

## CC Source References

| Source | Item |
|--------|------|
| `cc-community/05-github-issues.md` #34629 | B2: Resume cache regression since v2.1.69 |
| `cc-community/05-github-issues.md` #41607 | B4: Duplicate compaction agents consuming 65% quota |
| `cc-community/05-github-issues.md` #34674 | B5: Edit tool changes reverted during compaction |
| `cc-community/05-github-issues.md` #40050, #40187 | B8: Plugin hook scripts lose execute permissions |
| `cc-source/06-dream-kairos.md` | C3: KAIROS mode architecture, activation paths, daily log format |
| `cc-source/13-new-features-buildable.md` | C5: VERIFICATION_AGENT structured verdicts |
| `cc-source/08-cache-system.md` | K4: Cache key composition, billing hash substitution |
| SYNTHESIS.md B1-B8, C3-C5, K4 | All items — master reference |

---

*Phase: 09-bug-workarounds-defense*
*Context gathered: 2026-04-03*
