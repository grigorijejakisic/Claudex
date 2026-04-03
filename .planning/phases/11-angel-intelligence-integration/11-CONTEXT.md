# Phase 11: Angel/CC Intelligence Integration - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Higher-level Angel/CC intelligence integration. Angel gains three new capabilities: correction-to-skill bridging (A8), pattern-to-skill crystallization (A10), and proactive stuck detection (A11). Four items are doc/guard only because the CC features they target are either ant-only, feature-flagged off, or architecturally inaccessible from Angel's separate process.

Key constraint: Angel runs as a separate Node.js process (different PID from CC). It cannot access CC's in-memory AppState, invoke CC skills, or use CC's forked-agent cache sharing. All communication flows through the shared SQLite DB (`session_messages`, `session_events`, `conversation_turns`) and the filesystem (`.claude/skills/`, memdir).

</domain>

<decisions>
## Implementation Decisions

### A6: Magic Docs Conflict Prevention (DOC-ONLY)
- CC's Magic Docs (`magicDocs.ts`) is `USER_TYPE === 'ant'` only — not available in external builds
- Magic Docs auto-updates files starting with `# MAGIC DOC: <title>` from conversation context
- If shipped externally, it could conflict with Angel's entity-summarizer writing to the same files
- Guard: Angel should check for `# MAGIC DOC:` header before writing to any file; skip if present
- **No code — doc comment in `entity-summarizer.ts` noting the potential conflict and guard rule**

### A7: Angel Consumes CC Agent Summaries (DOC-ONLY)
- CC's AgentSummary generates 3-5 word status strings every 30s via forked subagent
- These summaries live in CC's in-memory AppState (React component state) — not persisted to disk or DB
- Angel (separate process) cannot access them — no file, no DB row, no hook output
- Angel's existing `session_events` + `conversation_turns` + heartbeat provide adequate session awareness
- **No code — doc comment in `session-monitor.ts` noting the gap and future consumption path**
- If CC ever exposes agent summaries via a SubagentStop hook payload or file, Angel should consume them

### A8: Correction Detection → Skill Bridge (IMPLEMENT)
**File:** `src/angel/pattern-extractor.ts` (new function + integration)

Angel detects corrections via `correction-detection.ts` and stores them as experience patterns. CC's Skill Improvement (`skillImprovement.ts`) is feature-flagged (`SKILL_IMPROVEMENT` + `tengu_copper_panda`) and runs inside CC — Angel cannot trigger it.

**Bridge approach:** Angel writes to project SKILL.md files directly.
1. After Angel extracts a correction pattern, call `bridgeCorrectionToSkill()`
2. Scan `.claude/skills/*/SKILL.md` for existing skills whose `when_to_use` matches the correction domain
3. If matching skill found: use Ollama/CliProxy to generate a skill amendment (new rule/constraint) and append it
4. If no matching skill: skip (A10 handles creation of new skills from mature patterns)
5. Record `session_event` with type `skill_amended` for tracking

Shares `writeSkillFile()` utility with A10.

### A10: Pattern → Skill Crystallization (IMPLEMENT)
**File:** New utility + integration in `src/angel/pattern-extractor.ts`

When an experience pattern reaches high confidence, Angel generates a SKILL.md file using CC's skill format (frontmatter with `when_to_use`, steps, success criteria). Bypasses /skillify (ant-only, requires interactive interview).

**Crystallization criteria (conservative):**
- `maturity = 'proven'` (requires `times_triggered >= 5 AND helpful_count >= 3` per migration backfill logic)
- `confidence >= 0.8` (Bayesian: `(helpful_count + 1) / (helpful_count + harmful_count + 2)`)
- Pattern not already crystallized (track via `session_events` with type `skill_crystallized`)

**Pipeline:**
1. In heartbeat tick (low priority phase), query proven patterns not yet crystallized
2. For each, generate SKILL.md content using trigger_context, lesson, anti_pattern, generalized_rule
3. Write to `.claude/skills/<domain>/SKILL.md` via shared `writeSkillFile()` utility
4. Record `session_event` with type `skill_crystallized`, entity = pattern ID
5. Cap at 1 crystallization per heartbeat tick (rate limiting)

**SKILL.md format** (from CC's /skillify output format):
```markdown
---
when_to_use: "<trigger_context as natural language>"
---

# <domain> — <lesson summary>

## Steps
1. <lesson as imperative instruction>

## Anti-patterns
- <anti_pattern if present>

## Success criteria
- Pattern is applied and no re-correction follows
```

### A11: Stuck Detection → Proactive Intervention (IMPLEMENT)
**File:** `src/angel/session-monitor.ts` (new function + heartbeat integration)

Angel already detects idle sessions (heartbeat timeout). "Stuck" is different from "idle" — stuck means the session is *active* but making no progress (repeated errors, looping behavior).

**Detection signals (session_events + conversation_turns only, no OS process inspection):**
1. **Repeated tool failures:** 3+ `session_events` with same `event_type` and action containing 'error'/'fail' within last 10 minutes
2. **Looping prompts:** 3+ `conversation_turns` with highly similar `user_text` (simple substring check — same first 50 chars) in last 10 turns
3. **No file progress:** Active session with 10+ turns but 0 `file_edit`/`file_create` events (all talk, no work)

**Intervention:** When stuck pattern detected, `sendMessage()` with:
- `message_type: 'advisory'`, `priority: 'urgent'`
- Content: diagnostic summary + suggested approach change
- 10-minute debounce per session (align with existing Angel debounce pattern)
- Only intervene once per stuck episode — if user doesn't respond, don't spam

**Integration point:** After Phase 1 idle detection in `heartbeatTick()`, add Phase 1c for stuck detection on active (non-idle) sessions.

### A14: Angel-Dream Symbiosis (DOC + GUARD)
**File:** `src/angel/consolidator.ts`

Dream is disabled (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, Phase 1). Angel is sole consolidator (A1, Phase 10). The symbiosis architecture (Angel curates input, Dream consolidates, Angel consumes output) cannot be tested.

**Guard:** Add detection for Dream re-activation. If `autoDreamEnabled` becomes true (detectable via CC config file scan or env), Angel should log a warning and document the intended mode switch:
- **Current mode (Dream off):** Angel does full consolidation via `consolidator.ts` + `pattern-extractor.ts`
- **Symbiosis mode (Dream on):** Angel switches to "curator mode" — deposits structured markdown observations to memdir for Dream to consolidate, then reads Dream's consolidated output back into Claudex DB

Implementation: Check for `.claude/config.json` containing `autoDream` or the `tengu_onyx_plover` flag in Angel's startup. If detected, log warning.

### A15: Buddy companionReaction for Notifications (TYPE + DOC)
**File:** `src/angel/message-sender.ts`

Buddy's `companionReaction` is an in-memory AppState field in CC's React render tree. Angel (separate process) cannot write to it. Hooks are ephemeral Node.js scripts that cannot access React state. The observer (`observer.ts`) runs after each query turn, not on hook output.

**Architectural gap:** No bridge exists from Angel → AppState. True Buddy integration requires CC-side changes (hook→AppState bridge) or a novel approach via MCP instructions.

**What we can do now:**
1. Add `'buddy_notification'` to the `MessageType` union in message-sender.ts
2. Document the intended flow: Angel sends buddy_notification → UPS hook detects it → formats as `<companion-notification>` tag → model's companion_intro prompt handles it
3. This establishes the contract — the UPS hook side can be wired when CC provides a mechanism

### Shared Utility: writeSkillFile()
**File:** New utility, location TBD (likely `src/angel/skill-writer.ts` or inline in pattern-extractor.ts)

Shared between A8 (amend) and A10 (create). Handles:
- Reading existing SKILL.md with frontmatter parsing
- Writing new SKILL.md with proper format
- Path resolution: `.claude/skills/<domain>/SKILL.md`
- Dedup check: don't create a skill if one already exists for the same domain
- Filesystem safety: `mkdirSync` with `recursive: true`

### Claude's Discretion
- A8: How to match correction domain to existing skill `when_to_use` (semantic similarity vs keyword match — keyword is simpler and sufficient)
- A10: Whether to use Ollama/CliProxy for SKILL.md generation or template-based (template is simpler, LLM is more natural)
- A11: Exact similarity threshold for "looping prompts" detection (first 50 chars substring match is a reasonable heuristic)
- A11: Whether to add `stuck_detected` to TickResult (yes, for telemetry)

</decisions>

<specifics>
## Specific Ideas

- A8/A10 shared utility should handle frontmatter parsing carefully — SKILL.md frontmatter uses `---` delimiters with YAML content. Use simple regex split, not a YAML parser dependency
- A10 crystallization should extract `domain` from the pattern's `source_project` and `trigger_context` — the pattern's existing domain classification (from `capability-tracker.ts:extractDomain()`) maps well to skill directory names
- A11 stuck detection query should be bounded to last 20 minutes of events to avoid false positives from old failures that were resolved
- A11 intervention message should include: (1) what Angel detected, (2) how many errors/loops, (3) a generic suggestion ("consider a different approach" or "try reading the error message carefully")
- A14 Dream detection: scan `~/.claude/config.json` for `autoDream: true` or `autoDreamEnabled: true` — this is CC's config location for autoDream settings
- A15 `buddy_notification` type should be distinct from existing `'event' | 'command' | 'query' | 'advisory'` types so the UPS hook can filter for it specifically

</specifics>

<deferred>
## Deferred Ideas

- A15 full Buddy integration — requires CC-side hook→AppState bridge or MCP instructions approach. Revisit when CC provides a mechanism.
- A14 full symbiosis mode — cannot test with Dream disabled. The guard detects re-activation; actual mode switch is future work.
- A10 LLM-generated skill content — start with template-based generation; upgrade to LLM when template output quality is validated.
- OS process inspection for stuck detection — CC's `/stuck` inspects CPU/RSS/process state. Could be added later if session_events-based detection proves insufficient.
- Skill quality feedback loop — track whether crystallized skills get used and whether they cause corrections. Feeds back into experience pattern scoring.

</deferred>

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/angel/pattern-extractor.ts` | A8: `bridgeCorrectionToSkill()` call after pattern extraction |
| `src/angel/session-monitor.ts` | A7: Doc comment. A11: `detectStuckSession()` function |
| `src/angel/heartbeat.ts` | A11: Phase 1c stuck detection after idle detection |
| `src/angel/message-sender.ts` | A15: Add `'buddy_notification'` to `MessageType` union + doc comment |
| `src/angel/consolidator.ts` | A14: Doc comment + Dream re-activation detection guard |
| `src/angel/entity-summarizer.ts` | A6: Doc comment about Magic Docs conflict |

## Files to Create

| File | Purpose |
|------|---------|
| `src/angel/skill-writer.ts` | Shared SKILL.md read/write utility for A8 and A10 |

---

## CC Source References

| Source | Item |
|--------|------|
| `cc-source/18-skills-angel-overlap.md` §3.6 | A6: Magic Docs — ant-only, `# MAGIC DOC:` header, auto-update pattern |
| `cc-source/18-skills-angel-overlap.md` §3.7 | A7: AgentSummary — 30s forked agent, in-memory AppState |
| `cc-source/18-skills-angel-overlap.md` §3.8 | A8: Skill Improvement — post-sampling hook, SKILL.md rewrite |
| `cc-source/18-skills-angel-overlap.md` §2.6 | A10: /skillify — ant-only, interactive interview, SKILL.md format |
| `cc-source/18-skills-angel-overlap.md` §2.10 | A11: /stuck — ant-only, diagnostic, process state inspection |
| `cc-source/18-skills-angel-overlap.md` §2.11 | A14: /dream — KAIROS consolidation, 4-phase prompt, autoDream |
| `cc-source/19-buddy-system.md` §Observer | A15: companionReaction AppState field, fireCompanionObserver callback |
| `cc-source/19-buddy-system.md` §Integration | A15: Architectural gaps, hook→AppState bridge needed |
| SYNTHESIS.md A6-A8, A10, A11, A14, A15 | All items — master reference |

---

## Verification Checklist

- [ ] A6: Doc comment in `entity-summarizer.ts` about Magic Docs `# MAGIC DOC:` header check
- [ ] A7: Doc comment in `session-monitor.ts` about AgentSummary inaccessibility
- [ ] A8: `bridgeCorrectionToSkill()` scans `.claude/skills/` for matching skills
- [ ] A8: Matching skill found → amendment appended; no match → skip
- [ ] A8: `skill_amended` session_event recorded on successful amendment
- [ ] A10: Only proven patterns with confidence >= 0.8 are crystallized
- [ ] A10: Dedup check prevents re-crystallizing already-crystallized patterns
- [ ] A10: SKILL.md written with correct frontmatter format (`when_to_use`)
- [ ] A10: `skill_crystallized` session_event recorded
- [ ] A10: Rate limited to 1 crystallization per heartbeat tick
- [ ] A11: Detects repeated tool failures (3+ same error in 10 min)
- [ ] A11: Detects looping prompts (3+ similar user_text in last 10 turns)
- [ ] A11: 10-minute debounce per session (no spam)
- [ ] A11: Intervention message sent via `sendMessage()` with `priority: 'urgent'`
- [ ] A14: Doc comment about Dream symbiosis in `consolidator.ts`
- [ ] A14: Dream re-activation detection guard (config scan + log warning)
- [ ] A15: `'buddy_notification'` added to `MessageType` union
- [ ] A15: Doc comment about architectural gap in `message-sender.ts`
- [ ] Shared `writeSkillFile()` utility handles frontmatter, paths, dedup
- [ ] All tests pass (`bun run test`)
- [ ] Build passes (`bun run build`)

---

*Phase: 11-angel-intelligence-integration*
*Context gathered: 2026-04-03*
