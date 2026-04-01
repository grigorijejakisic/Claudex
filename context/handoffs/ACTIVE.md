---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-42b
status: active
session_id: 3af60620-a060-4646-9cc5-c07f60a15904
created_at: 2026-04-01T00:30:00+02:00
priority: medium
---

# Handoff: CC Source-Informed Claudex Upgrades (continued)

## Completed This Session
1. Memory search override (`sections.ts`) — Claudex semantic search overrides CC's grep
2. MEMORY.md budget alignment (`memory-monitor.ts`) — Angel enforces CC's 200-line/25KB caps
3. CC environment detection (`session-start.ts`) — logs CC version, memory mode, KAIROS status
4. watchPaths for ACTIVE.md + CLAUDE.md (`session-start.ts`) — CC notifies model on file changes
5. PreToolUse Agent injection (`pre-tool-use.ts`) — subagents learn about Claudex MCP tools

## Remaining Upgrades — Why Each Matters

### 1. `initialUserMessage` (SessionStart hook)
**What:** CC accepts `initialUserMessage` from SessionStart hooks and injects it as the first user message.
**Why it's an upgrade:** Claudex could auto-prime sessions with the handoff task list or pending work. Currently the model has to read the handoff manually or rely on injected context. An `initialUserMessage` like "Continue from handoff: fix the auth module, then run tests" would make the model start working immediately without the user repeating themselves. The difference: `additionalContext` is system-level (model reads it as background); `initialUserMessage` is user-level (model treats it as a direct instruction to act on).

### 2. `updatedInput` for Bash safety
**What:** PreToolUse can modify Bash command inputs before execution.
**Why it's an upgrade:** Claudex tracks behavioral patterns (file thrashing, repeated errors). When it detects a pattern like "user edited the same file 3 times" or "build failed twice," it could inject guardrails into Bash inputs — e.g., wrapping destructive commands with confirmation, or adding `--dry-run` flags. Currently Claudex only observes tool use after the fact (PostToolUse). PreToolUse lets it intervene before damage happens. The `matcher: "Bash"` pattern means zero overhead on non-Bash tools.

### 3. KAIROS daily-log alignment
**What:** CC's KAIROS mode switches memory from MEMORY.md index to append-only daily logs in `memory/logs/YYYY/MM/YYYY-MM-DD.md`, with a `/dream` skill that consolidates nightly.
**Why it's an upgrade:** Angel already does session-journal-based synthesis. If Anthropic ships KAIROS publicly, Angel and Dream will both try to consolidate memory — creating duplicates and conflicts. Pre-aligning means: Angel reads CC's daily logs as input instead of its own journal, or Claudex detects KAIROS and defers to CC's Dream for file-level memory while focusing on DB-level knowledge. Either way, avoiding the conflict requires code before the flag ships.

### 4. COMPACTION_REMINDERS deduplication
**What:** CC's `COMPACTION_REMINDERS` flag re-injects reminder attachments after compaction (attachments.ts:922).
**Why it's an upgrade:** Claudex already re-injects proven principles and experience patterns on post-compaction via full reassembly. When CC enables this flag, both systems will inject reminders — doubling context cost with redundant information. The fix: detect CC's reminder attachments in the post-compact message stream and skip Claudex's proven-principles injection if CC already covered them. Saves ~200 tokens per compaction event.

### 5. EXTRACT_MEMORIES conflict prevention
**What:** CC's `EXTRACT_MEMORIES` flag auto-extracts memories from conversation at session end (backgroundHousekeeping.ts, stopHooks.ts).
**Why it's an upgrade:** Angel already extracts observations, learnings, and experience patterns from every session. If CC also extracts memories, the same insight gets stored twice — once in CC's memory files (flat markdown) and once in Claudex's DB (structured, searchable). Worse, CC's extraction may create memory files that bloat MEMORY.md past the 200-line cap, triggering the truncation we just protected against. The fix: either set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` when Claudex is active, or have Angel ingest CC's extracted files and deduplicate against existing observations.

### 6. QueryEngine context assembly study
**What:** `QueryEngine.ts` (1,295 lines) drives the core LLM loop — streaming, tool dispatch, token tracking, context window management.
**Why it's an upgrade:** Understanding exactly how CC assembles the system prompt and user messages tells Claudex where its injected content lands relative to CLAUDE.md, memory, and tool results. Current hook injection works but is based on documentation and experimentation. Reading the source would confirm: does `additionalContext` go before or after CLAUDE.md? Before or after memory? This determines whether Claudex's instructions can override CC's or get overridden by them. The search override we implemented assumes Claudex content comes after CC's memory section — if that assumption is wrong, the override doesn't work.

### 7. Coordinator/remote mode study
**What:** `coordinator/coordinatorMode.ts` and `remote/` implement CC's native multi-agent coordination.
**Why it's an upgrade:** Claudex has cross-session messaging (signals, messages, transfers). CC has its own coordinator mode. If Anthropic ships coordinator mode publicly, Claudex's signals and CC's coordinator will be two parallel coordination systems running on the same machine. Understanding CC's approach lets Claudex either bridge into it (write Claudex signals as CC coordinator messages) or detect and defer (recognize when coordinator mode is active and reduce Claudex's coordination overhead).

## Context
- CC source repos: `~/Desktop/Projects/claude-code-buildable` (beita6969), `claude-code-free` (paoloanzn), `claude-code-leaked` (sanbuphy v2.1.88)
- Feature flag risk map, architecture constants, and response playbook stored in Claudex DB under `cc-internals/*` topic keys
- Strategy decision: study source, improve hooks — never fork (topic key: `claudex/upgrade-strategy`)
