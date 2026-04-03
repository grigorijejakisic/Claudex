---
paths:
  - "src/adapters/cc-hooks/**"
  - "src/adapters/shared/**"
---

# Hook Safety Rules

## Critical: Hook Deadlock Prevention
Never call CC's CLIProxyAPI from a hook. CC hooks run inside CC's event loop — calling back into CC causes deadlock. Use Ollama for any LLM calls needed inside hooks.

## Critical: Fire-and-Forget Dies
CC hooks are ephemeral Node.js processes — always `await` async operations. Only Angel and OpenClaw (long-lived processes) can fire-and-forget.

## CC Hook Payload Truth

| Hook | Field | CC sends | Code assumed (wrong) |
|---|---|---|---|
| PostToolUse | tool output | `tool_response` | `tool_output` |
| UserPromptSubmit | user text | `prompt` | `user_prompt` |
| Stop | assistant text | `last_assistant_message` | `stop_assistant_turn` |

Never assume field names. Capture real payloads to verify.

## Hook/Angel Responsibility Split

**Hooks** (fast, mechanical, ephemeral): decision capture, thread tracking, conversation turn storage, checkpoint, retrieval feedback, activation decay, pattern verification + helpful scoring, session summary, stigmergic signal creation (wip on file edits), cross-session message delivery, auto-session naming, outcome inference, contradiction detection.

**Angel** (reflective, holistic, persistent): pattern extraction from full conversations, CARA opinion formation, domain classification, session monitoring, idle warnings, inter-session messaging, entity summary generation, cross-agent session indexing (Codex/Gemini/Aider), pattern promotion to always-inject, retention sweep with observation pruning.

## Plugin Permissions (Linux/macOS)

On Linux/macOS, hook scripts installed by plugins may lose execute permissions after install or update (CC #40050, #40187). After installing a plugin that registers hooks, run:

```bash
chmod +x ~/.claude/hooks/*
```

This is not relevant on Windows where execute permissions are not enforced.
