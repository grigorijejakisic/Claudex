# Phase 11: Angel Intelligence Integration — Plan

**Status:** Ready to implement
**Estimate:** ~250 lines across 7 files (1 new, 6 modified)

---

## Wave 1: Shared Utility (~30 lines)

### 1. `src/angel/skill-writer.ts` — `writeSkillFile()`
- New file. Shared by A8 (amend) and A10 (create).
- `writeSkillFile(skillDir, domain, content, mode: 'create' | 'amend')`:
  - Path: `.claude/skills/<domain>/SKILL.md`
  - `mkdirSync` with `recursive: true`
  - Create mode: dedup check (skip if file exists), write frontmatter + body
  - Amend mode: read existing, append new rule section
- `readSkillFile(path)`: parse frontmatter (`---` delimited) + body via regex split
- `findSkillByDomain(skillsDir, domain)`: scan subdirs for matching SKILL.md

## Wave 2: Core Implementations (~180 lines)

### 2. A8 — `bridgeCorrectionToSkill()` in `pattern-extractor.ts` (~50 lines)
- New function called after pattern creation in `extractPatternsFromSession()`
- Only for `pattern_type === 'correction'` patterns
- Scan `.claude/skills/*/SKILL.md` for domain keyword match in `when_to_use`
- Match: append correction as new rule via `writeSkillFile(amend)`
- No match: skip (A10 handles new skill creation)
- Record `session_event` with `event_type: 'skill_amended'`

### 3. A10 — `crystallizePatternToSkill()` in `pattern-extractor.ts` (~60 lines)
- New exported function called from heartbeat (new phase)
- Query: `maturity = 'proven' AND confidence >= 0.8`
- Dedup: exclude patterns with existing `skill_crystallized` session_event
- Generate SKILL.md from pattern fields (template-based, no LLM):
  - `when_to_use` = `trigger_context`
  - Steps from `lesson` + `generalized_rule`
  - Anti-patterns from `anti_pattern`
- Write via `writeSkillFile(create)`, domain from `source_project` + `extractDomain(trigger_context)`
- Record `session_event` with `event_type: 'skill_crystallized'`, entity = pattern ID
- Cap: 1 crystallization per call (heartbeat rate-limits)

### 4. A11 — `detectStuckSession()` in `session-monitor.ts` (~70 lines)
- New exported function
- Takes db + sessionId, returns `{ stuck: boolean; reason: string } | null`
- Signal 1: 3+ session_events with action containing 'error'/'fail' in last 20 min
- Signal 2: 3+ conversation_turns with same first 50 chars of user_text in last 10 turns
- Signal 3: Active session with 10+ turns but 0 file_edit/file_create events
- 10-minute debounce: check session_messages for recent stuck advisory
- Heartbeat integration: Phase 1c after Phase 1b, iterate active (non-idle) sessions

## Wave 3: Doc/Guard Items (~20 lines)

### 5. A6 — Doc comment in `entity-summarizer.ts`
- Note: CC Magic Docs uses `# MAGIC DOC:` header. Angel must check for this header before writing to any file and skip if present.

### 6. A7 — Doc comment in `session-monitor.ts`
- Note: CC AgentSummary lives in in-memory AppState (React). Angel cannot access. If CC exposes via SubagentStop hook or file, consume.

### 7. A14 — Doc + guard in `consolidator.ts`
- Doc: Dream symbiosis architecture (Angel curates, Dream consolidates)
- Guard: Check `~/.claude/config.json` for `autoDream` flag at import time. Log warning if detected.

### 8. A15 — Type addition in `message-sender.ts`
- Add `'buddy_notification'` to `MessageType` union
- Doc comment: architectural gap (Angel -> AppState bridge doesn't exist)

## Wave 4: Heartbeat Integration

### 9. Heartbeat changes in `heartbeat.ts`
- Add `stuck_detected` to `TickResult`
- Phase 1c: after Phase 1b, iterate active sessions, call `detectStuckSession()`, send intervention via `sendMessage()`
- Phase after 4f: call `crystallizePatternToSkill()` (rate-limited, 1 per tick)

---

## Verification

- [ ] `writeSkillFile()` handles create + amend modes with frontmatter
- [ ] A8 bridges corrections to existing skills, records `skill_amended` event
- [ ] A10 only crystallizes proven patterns with confidence >= 0.8, dedup check works
- [ ] A10 SKILL.md has correct frontmatter format
- [ ] A11 detects repeated failures, looping prompts, no-progress sessions
- [ ] A11 debounces at 10 minutes, sends advisory via sendMessage
- [ ] A6/A7/A14/A15 doc comments present
- [ ] A14 Dream detection guard present
- [ ] A15 `buddy_notification` in MessageType union
- [ ] `bun run build` passes
- [ ] `bun run test` passes
