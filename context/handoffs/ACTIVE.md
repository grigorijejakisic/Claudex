---
schema: claudex/handoff
version: 2
handoff_id: claudex-v3-handoff-36
session_id: 2f154a09-38dd-4eb2-85d9-3ca1b65f5831
created_at: 2026-03-28T02:50:00Z
scope: project:claudex-v3
---

## What's Left To Do

1. **Commit everything** — large changeset: 5 new files, ~15 modified files. Full review + Guardian of All Memory + budget fix + adaptive heartbeat.
2. **Angel test coverage for review findings** — Codex/Gemini both flagged zero test coverage for guardian modules. Tests written (51 tests in guardian.test.ts) but review reports should be re-run to confirm grade improvement.
3. **Monitor Angel backlog processing** — 65 sessions queued, processing at ~5/tick with Opus via CliProxy. Check experience_patterns count after backlog clears.

## Context That Won't Be Obvious

- CliProxy must be running for Angel to use Opus — auto-started by session-start hook but killed on reboot. The Angel falls back to GLM-5 (free, decent) if CliProxy is down.
- The `grigorije-0759758a` project (home directory sessions) has 336 sessions with 0 observations — this is a project detection issue, not a hook failure. Hooks run but assign the wrong project scope. Separate investigation needed.
- Health report rate limit is now DB-persisted (telemetry table, event_kind='health_report') — won't spam on Angel restart.
