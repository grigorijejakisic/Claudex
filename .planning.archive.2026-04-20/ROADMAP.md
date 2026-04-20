# ROADMAP: CC Source-Informed Upgrades

**Milestone:** CC Source Upgrades (81 items, 10 categories)
**Phases:** 12

---

## Phase 1 — Environment Flags & CLAUDE_ENV_FILE (7 items)
**Items:** X3, T1, T2, T8, C1, C2, B6
**Focus:** Establish CLAUDE_ENV_FILE injection in SessionStart hook. Disable CC auto-memory. Set transcript preservation. Add GrowthBook flag monitoring and auto-dream prevention. Work around session ID mismatch.

**Why first:** X3 (CLAUDE_ENV_FILE) is the delivery mechanism for T1, T2, T8. All are env var writes. C1/C2 are defensive checks that should activate at session start. B6 awareness prevents using broken env file session IDs.

**Deliverables:**
- SessionStart hook writes env vars to CLAUDE_ENV_FILE
- CC auto-memory disabled (T1/T2 — ~11K tokens/turn saved)
- GrowthBook flag detection (C1)
- Auto-dream guard (C2)
- Session ID sourced from hook payload, not env file (B6)
- Tests for all env injection paths

---

## Phase 2 — Critical Reminders Tier (1 spec = many items)
**Items:** T3 (partial — defines budgets), Critical Reminders spec (full implementation)
**Focus:** Build the Critical Reminders injection tier per `CRITICAL_REMINDERS_TIER.md` spec. New `critical_rules` table, decay-based TTL with jitter, activity-gated injection, first-encounter gating, varied phrasing renderer, 200-300 token cap.

**Why second:** Hard constraint on token optimization work. T3 (injection minimization) requires knowing the budget split: proven principles (500), critical reminders (300), experience patterns (500). Must be built before T3 restructuring.

**Deliverables:**
- `critical_rules` DDL + migration
- `assembleCriticalReminders()` function
- Decay trigger with variable-interval jitter
- Activity gate in PostToolUse (multi-file, git, agent spawning, topic shift)
- First-encounter gate (track seen tool domains per session)
- Phrasing variation renderer
- Integration in UserPromptSubmit assembly cascade (priority 4a.5)
- Deterministic meta-rule enforcement in Stop hook
- 6 success criteria from spec verified
- Tests for all trigger conditions and budget limits

---

## Phase 3 — Injection Architecture Restructure (5 items)
**Items:** T3, T5, T6, T7, I3
**Focus:** Move bulk context from UserPromptSubmit to SessionStart. Make all injected content cache-stable. Audit CLAUDE.md footprint. Add post-compact duplication avoidance. Create conditional rules in `.claude/rules/`.

**Why third:** With Critical Reminders tier built (Phase 2) and env flags set (Phase 1), we know the full budget structure. Now restructure the injection architecture for minimum token cost.

**Deliverables:**
- UserPromptSubmit payload under 1KB (dynamic content only)
- SessionStart carries bulk context (no truncation limit)
- All timestamps/counts/IDs removed from injected text (cache-stable)
- CLAUDE.md trimmed, conditional content in `.claude/rules/`
- Post-compact flag prevents double-injection on next UPS turn
- Cache hit rate measurement before/after

---

## Phase 4 — Core New Hooks: Compaction & Subagent Lifecycle (6 items)
**Items:** H1, H2, H3, H4, H13, H17
**Focus:** Register the highest-impact new hooks: SubagentStart/Stop, PreCompact/PostCompact, TaskCreated/Completed, SessionEnd. These are the lifecycle hooks that other features depend on.

**Why fourth:** H4 (PostCompact) is needed by T7 (Phase 3 wired it, this provides the signal). H1/H2 enable subagent tracking. H17 enables proper session cleanup. H13 enables task lifecycle analytics.

**Deliverables:**
- 6 new hook entry points registered in settings.json
- SubagentStart: injects Claudex awareness into subagent context
- SubagentStop: captures results, duration, success/failure to DB
- PreCompact: captures pre-compact state, injects preservation hints
- PostCompact: triggers full re-assembly, sets post-compact flag
- TaskCreated/TaskCompleted: logs to session_events
- SessionEnd: runs final cleanup, summary, handoff creation
- Tests for each hook's core behavior

---

## Phase 5 — Permission & Error Hooks (6 items)
**Items:** H5, H6, H7, H14, X8, B7
**Focus:** Permission lifecycle hooks (request/denied), elicitation hooks, failure hooks. Wire X8 (permissionDecision) into H5. Enforce command-type for stop events (B7).

**Deliverables:**
- PermissionRequest hook with behavioral pattern-based auto-allow/deny
- PermissionDenied hook with denial pattern tracking
- Elicitation/ElicitationResult hooks for MCP auto-response
- PostToolUseFailure/StopFailure hooks capture errors to DB
- X8 permissionDecision wired into PreToolUse
- All stop/end hooks use command type, not agent type (B7)
- Tests for permission flow and error capture

---

## Phase 6 — Environment & Config Hooks (5 items)
**Items:** H8, H9, H10, H15, H16
**Focus:** Configuration lifecycle hooks: ConfigChange, InstructionsLoaded, CwdChanged, Setup, WorktreeCreate/Remove.

**Deliverables:**
- ConfigChange: detects settings.json changes, logs and adapts
- InstructionsLoaded: detects CLAUDE.md reloads (with B3 awareness — not reliable post-compact)
- CwdChanged: detects project switches, reloads project context
- Setup: auto-configures Claudex on first-time CC setup
- WorktreeCreate/Remove: tracks worktrees for multi-workspace sessions
- Tests for each hook

---

## Phase 7 — Advanced Hook Execution (7 items)
**Items:** X1, X2, X4, X5, X6, X7, X9, X10
**Focus:** Advanced hook execution capabilities: async protocol, interactive prompts, once flag, agent/http/prompt execution types, MCP output rewriting, input modification with matchers.

**Deliverables:**
- X1: Async hook support (output `{"async": true}`, asyncRewake exit-code-2)
- X2: Interactive prompt protocol for user input during hooks
- X4: `once: true` flag support for one-time hooks
- X5/X6/X7: Agent, HTTP, prompt execution types (infrastructure awareness)
- X9: PostToolUse MCP output rewriting
- X10: PreToolUse input modification with matcher patterns
- Tests for async protocol, prompt protocol, output/input modification

---

## Phase 8 — Injection Points & MCP Upgrades (5 items)
**Items:** T4, I1, I2, I4, K1
**Focus:** MCP-level injection (system-prompt instructions, tool annotations, skills). Auto-priming via initialUserMessage. Measure MCP cache trade-off.

**Deliverables:**
- T4: Claudex MCP server `instructions` field for system-prompt injection
- I1: SessionStart returns `initialUserMessage` for auto-priming with handoff
- I2: MCP tool annotations (searchHint, alwaysLoad) on all 6 Claudex tools
- I4: MCP skills serving SKILL.md resources
- K1: Measured cache trade-off (global→org scope downgrade vs injection benefit)
- Tests for MCP injection and auto-priming

---

## Phase 9 — Bug Workarounds & Defensive Measures (10 items)
**Items:** B1, B2, B3, B4, B5, B8, C3, C4, C5, K4
**Focus:** All remaining bug workarounds and conflict prevention. KAIROS detection, compaction race awareness, VERIFICATION_AGENT readiness, billing sentinel guard.

**Deliverables:**
- B1: Documented — reinforces T1 (no MEMORY.md writes)
- B2: Resume cost awareness in session logging
- B3: PostCompact used instead of InstructionsLoaded for post-compact detection
- B4: Duplicate compaction agent detection + logging
- B5: Edit tracking + post-compact verification
- B8: chmod after plugin install
- C3: KAIROS mode detection
- C4: Lean post-compact injections (verified in Phase 3)
- C5: `solution_outcomes` ready for VERIFICATION_AGENT verdicts
- K4: `cch=` pattern guard in all hook output paths
- Tests for sentinel guard, edit tracking, KAIROS detection

---

## Phase 10 — Angel/CC Integration: Memory & Consolidation (8 items)
**Items:** A1, A2, A3, A4, A5, A9, A12, A13
**Focus:** Align Angel with CC memory features. Disable/bridge extractMemories, Dream consolidation, retention sweep. Dedup injection tracking. Race prevention. Transcript indexing window.

**Deliverables:**
- A1: Angel adopts Dream's 4-phase structure or disables Dream (sole consolidator decision)
- A2: CC extractMemories disabled (aligns with T1). Angel adopts forked-agent pattern awareness
- A3: Angel retention sweep enhanced with /remember taxonomy
- A4: Angel reads CC session memory summaries as input
- A5: Angel session monitor consumes CC away summaries
- A9: Deduplication tracking — what's been surfaced, avoid re-injection
- A12: File race prevention (with T1, races eliminated; defensive guard remains)
- A13: Angel indexes within 30-day cleanup window
- Tests for dedup tracking, retention sweep enhancements

---

## Phase 11 — Angel/CC Integration: Skills & Intelligence (7 items)
**Items:** A6, A7, A8, A10, A11, A14, A15
**Focus:** Higher-level Angel/CC intelligence integration. Magic Docs awareness, agent summary consumption, skill improvement bridge, /skillify pipeline, /stuck auto-trigger, Angel-Dream symbiosis, Buddy notification UI.

**Deliverables:**
- A6: Magic Docs conflict prevention (different output targets)
- A7: Angel consumes CC agent summaries for cross-session state
- A8: Angel correction detection → CC skill rewrite trigger
- A10: Angel pattern → /skillify pipeline
- A11: Angel stuck detection → /stuck auto-trigger
- A14: Angel-Dream symbiosis architecture (Angel curates input, Dream consolidates, Angel consumes output)
- A15: Buddy companionReaction for Angel notifications, transfers, signals
- Tests for pipeline connections, Buddy integration

---

## Phase 12 — Engineering Patterns, Extension Surfaces & Cache Polish (11 items)
**Items:** P1, P2, P3, P4, P5, P6, E1, E2, E3, K2, K3, H11, H12
**Focus:** Angel engineering pattern adoption, Claudex plugin packaging, channel MCP, remaining cache and hook items.

**Deliverables:**
- P1: Forked agent with cache sharing pattern documented + infrastructure
- P2: Cursor-based incremental extraction in Angel pattern extractor
- P3: Pre-injected manifests for Angel LLM reasoning
- P4: 10-minute debounce on Angel monitoring loops
- P5: Hard 5-turn cap on Angel background processes
- P6: Mutual exclusion skip logic for Angel/CC shared writes
- E1: Claudex plugin manifest (hooks, MCP, skills, config)
- E2: Channel MCP server for cross-session messaging
- E3: searchHint/alwaysLoad annotations (supplements I2)
- K2: TTL awareness in session management
- K3: Latched header awareness documented
- H11: Extended file watching via watchPaths
- H12: TeammateIdle detection
- Tests for cursor extraction, throttling, plugin manifest

---

## Phase Summary

| Phase | Items | Count | Focus |
|-------|-------|-------|-------|
| 1 | X3, T1, T2, T8, C1, C2, B6 | 7 | Environment flags |
| 2 | Critical Reminders spec | ~8* | Critical Reminders tier |
| 3 | T3, T5, T6, T7, I3 | 5 | Injection restructure |
| 4 | H1, H2, H3, H4, H13, H17 | 6 | Core lifecycle hooks |
| 5 | H5, H6, H7, H14, X8, B7 | 6 | Permission & error hooks |
| 6 | H8, H9, H10, H15, H16 | 5 | Config & environment hooks |
| 7 | X1, X2, X4, X5, X6, X7, X9, X10 | 8 | Advanced hook execution |
| 8 | T4, I1, I2, I4, K1 | 5 | MCP & injection points |
| 9 | B1-B5, B8, C3, C4, C5, K4 | 10 | Bug workarounds & defense |
| 10 | A1-A5, A9, A12, A13 | 8 | Angel memory integration |
| 11 | A6-A8, A10, A11, A14, A15 | 7 | Angel intelligence integration |
| 12 | P1-P6, E1-E3, K2, K3, H11, H12 | 12 | Patterns, extensions, polish |

*Phase 2 implements the Critical Reminders spec which touches T3 budget definition and multiple new subsystems. The spec itself is counted as a unit.

**Total: 81 items across 12 phases.**
