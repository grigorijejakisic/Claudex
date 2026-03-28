---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-38
status: active
session_id: be1e3376-62a4-493b-b914-9ab3132afeca
created_at: 2026-03-28T18:45:00+01:00
---

## What's Left To Do

1. **Investigate Hindsight vs Claudex** — Deploy /team to do a deep comparison. Hindsight uses cross-encoder reranking, MPFP meta-path traversal, entity summaries, temporal decay — we implemented all 5 but need to verify our implementations match or exceed theirs. Focus on retrieval quality, not just feature parity.

2. **Test cross-session communication live** — Open 2 sessions simultaneously, send a message from one to the other, verify delivery + rendering + response. The infrastructure is built but hasn't been tested with real multi-session interaction.

3. **Entity summaries** — 10 candidates ready, Angel heartbeat wired, 0 generated. Needs Angel to complete a heartbeat cycle with LLM available. Verify summaries appear in assembly after generation.

4. **Angel pattern promotion** — 5 patterns ready for promotion to `always` retrieval_mode. Verify promotion happens on next consolidation cycle and that always-inject patterns appear in every turn's context.

## Context That Won't Be Obvious

- The CHECK constraint on session_messages required full table recreation in migration (SQLite can't ALTER CHECK). The V12 migration handles this but it's a one-time heavy operation.
- Cross-session message rendering resolves sender session_id to name+project from the sessions table — if a session has no name yet, it falls back to truncated UUID.
- The street knowledge research (5 layers, 36 sources) is in `context/research/session-communication-street-knowledge-2026-03-28.md` — essential reading before modifying the session communication architecture.
