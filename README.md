# Claudex

Persistent memory for LLM coding agents — they reach for it the way they reach for Grep.

> **Status:** v4.0 shipped (internal infrastructure). v4.1 — Distribution — is in flight to make Claudex installable by strangers. Until v4.1 lands, install paths are not yet stable; track [CHANGELOG.md](./CHANGELOG.md) for ship dates.

## What is Claudex?

Claudex is a persistent memory system that runs locally alongside Claude Code. It captures what happens during a session — observations, decisions, files edited, problems hit — and surfaces the relevant pieces on the next session, automatically. One SQLite database, one local vector index, no cloud service.

It is for people running long coding sessions across days or weeks who want the agent to actually remember context between resets, without manually re-priming each session. The agent reads from the same store you read from; the surfaces are the MCP tools `claudex_search`, `claudex_recall`, and `claudex_events`.

There is no hosted variant. The DB lives at `~/.claudex/db/claudex.db`; embeddings are computed by a local Ollama instance; reranking is a local Python service. Everything runs on the same machine as the editor.

## Why Claudex?

Existing memory systems make the agent FOLLOW INSTRUCTIONS to query memory ("remember to check past decisions before answering"). That fails because instructions decay — the agent stops querying when the prompt window stops nagging. v4's bet is the opposite: memory tools should be treated like file-reading tools, reached for as natural extensions of reasoning when the work shape calls for them.

**v4 makes the agent USE Claudex organically as part of how it works in Claude Code.** Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) get reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

**Canonical example:** if last session we discovered *"60 HTTP polls to backend X = 15-min IP shadowban"*, and this session the user says *"investigate another backend for intel gathering,"* the agent should automatically (1) recognize this is rate-limit-research-shaped work, (2) recall the shadowban finding, (3) apply it to scoping — all without being told to query memory.

This is the difference v4 measures. Behavioral probes verify the recall-and-apply pattern landed; the audit history behind that bet is in [CHANGELOG.md](./CHANGELOG.md).

## Installation

Coming in v4.1. Until then, this repository is internal infrastructure — the install path is not yet stable for strangers. Track [CHANGELOG.md](./CHANGELOG.md) for the v4.1 ship.

## Documentation

- [CHANGELOG.md](./CHANGELOG.md) — release history starting at v4.0.0
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup, test commands, commit convention, hook safety
- [`.claude/rules/`](./.claude/rules/) — architectural rules loaded conditionally during work
- [`.planning/PROJECT.md`](./.planning/PROJECT.md) — project intent and current milestone

## License

Claudex is MIT-licensed. See [LICENSE](./LICENSE).

Copyright (c) 2026 Grigorije Jakisic.
