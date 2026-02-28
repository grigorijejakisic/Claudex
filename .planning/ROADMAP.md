# Roadmap: Unified Code Review Skill

**Milestone:** Unified Review v1
**Created:** 2026-02-28

## Phases

### Phase 1: Skill Core -- Complete (2026-02-28)
**Goal:** Create the complete unified-review skill — SKILL.md with orchestration logic and prompts.md with the 4 perspective-specific prompt templates.

**Requirements:** REV-01, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07, REV-08, REV-09, REV-10, REV-11

**Progress:** 1/1 plans complete

**Success Criteria:**
1. SKILL.md exists at ~/.claude/skills/unified-review/SKILL.md with complete orchestration flow
2. prompts.md exists with 4 structured prompt templates (quality, acceptance, security, general)
3. Skill handles scope resolution (uncommitted/branch/commit)
4. Synthesis produces 3-tier severity report with grade and perspective tags
5. Quality output matches desloppify review --import JSON format exactly
6. Graceful degradation handles individual Codex failures

### Phase 2: Live Validation
**Goal:** Run the skill against real diffs to validate prompt quality, Codex output parsing, and end-to-end flow. Adjust prompts based on actual results.

**Requirements:** (validation of all REV-* requirements)

**Success Criteria:**
1. Skill invoked successfully on a real uncommitted diff
2. All 4 Codex perspectives return usable output
3. Synthesis correctly deduplicates and severity-ranks
4. Report is readable and actionable
5. Quality JSON imports successfully into desloppify
6. Any prompt adjustments from live testing applied

## Phase Dependencies

```
Phase 1 (Skill Core) --> Phase 2 (Live Validation)
```

Sequential — Phase 2 cannot start until Phase 1 deliverables exist.

---
*Roadmap created: 2026-02-28*
