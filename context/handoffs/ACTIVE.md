---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-42
status: active
session_id: 3af60620-a060-4646-9cc5-c07f60a15904
created_at: 2026-03-31T15:30:00+02:00
priority: medium
---

# Handoff: CC Source-Informed Claudex Upgrades

## What's Left To Do
1. **Test the 3 upgrades in a fresh session** — search override, budget alignment, env detection are built but untested in practice
2. **Study more CC internals** — key files not yet analyzed: `QueryEngine.ts` (context assembly loop), `skills/bundledSkills.ts` (skill loading), `coordinator/coordinatorMode.ts` (cross-session)
3. **KAIROS alignment** — CC's daily-log mode (`/dream` distillation) mirrors what Angel does. If Anthropic ships it publicly, Claudex should detect and align rather than conflict
4. **COMPACTION_REMINDERS flag** — when CC enables this, it'll re-inject its own reminders post-compaction. Claudex should detect to avoid duplication

## Context That Won't Be Obvious
- CC source repos: `~/Desktop/Projects/claude-code-buildable` (beita6969 — can build+run), `claude-code-free` (paoloanzn — all 45 flags unlocked), `claude-code-leaked` (sanbuphy — raw v2.1.88)
- Decision stored in Claudex DB: `claudex/upgrade-strategy` — study source, don't fork
- The search override text in `sections.ts:formatClaudexReadySection()` explicitly references CC's "Searching past context" grep instruction
