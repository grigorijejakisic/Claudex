# Claudex v3 — Project CLAUDE.md

## What This Is

A persistent memory system with **one shared DB, two independent brains**. The SQLite DB at `~/.claudex/db/claudex.db` is the shared data layer — observations, learnings, artifacts are all there, scoped by `project` column. But the two hosts (Claude Code and OpenClaw) run completely separate adapters with their own process models, their own context assembly, and their own runtime identity.

- **CC Hooks adapter** (`src/adapters/cc-hooks/`): 6 Node.js scripts, fresh process per hook, DB-only state continuity, Ollama for enrichment (never call CC's own API from a hook — deadlock).
- **OpenClaw Bridge adapter** (`src/adapters/openclaw-bridge/`): long-lived process, in-memory + DB state, native LLM API via host.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): composable functions both adapters call. Fix here = both get it.

They read from the same DB. They do NOT share context, assembly, identity, or behavioral rules. The `adapter` column on sessions tracks which host produced what.

**Live stats**: 16K+ observations, 380+ artifacts, 10 cross-session learnings, 141 sessions across 7 projects. DB is 24 MB, stable growth ~80 KB/day with pruning.

## CC Hook Payload Truth

These field names are what Claude Code **actually sends**. Discovered by capturing real payloads — not from documentation. The codebase has fallback chains for all of them.

| Hook | Field | CC sends | Code assumed (wrong) |
|---|---|---|---|
| PostToolUse | tool output | `tool_response` | `tool_output` |
| UserPromptSubmit | user text | `prompt` | `user_prompt` |
| Stop | assistant text | `last_assistant_message` | `stop_assistant_turn` |
| PostToolUse (Glob) | file list | `filenames` | `files` |
| PostToolUse (Read) | file content | `file.content` (nested) | `content` |

**Lesson**: Never assume field names. Write a debug hook, dump the payload, compare against code.

## Data Flow — CC Hooks Per Turn

```
UserPromptSubmit (fresh process)
  → Read prompt from input.prompt
  → Check post-compact flag → if set, do full reassembly
  → Topic shift detection (Ollama if available, else keyword)
  → Ensure initial topic if none
  → Capture Tier 4 decisions from user text
  → Search artifacts by prompt → materialize matches
  → Assemble context (inject if threshold met or post-compact)

PostToolUse (fresh process, runs for EACH tool)
  → Extract observation from tool input/output
  → Update pressure scores for touched files
  → Create artifact if observation importance >= 3
  → TTL tick (project-scoped, 120s guard interval)
  → Track thread exchanges

Stop (fresh process)
  → Capture decisions (all 4 tiers, assistant text available)
  → Extract insights from assistant text → promote as learnings
  → Update thread state (topic, summary, key_exchanges)
  → Checkpoint if token threshold met
```

## Artifact Lifecycle

```
fresh (TTL 4-8 based on importance)
  ↓ TTL ticks at 120s intervals
packed (TTL=0, metadata only in reference layer)
  ↓ search match on user prompt
materialized (TTL=2, full content visible)
  ↓ TTL ticks
packed (back to reference layer)
```

Compaction packs ALL artifacts before creating fresh learning artifacts. Reference layer sorts by type priority: decision > learning > flow > milestone > observation.

## Quality Gates

| Boundary | Filter | Why it exists |
|---|---|---|
| Observation → Artifact | `importance >= 3` | Low-signal Read/Grep were flooding artifact table |
| Decision → Checkpoint | `isCheckpointWorthy()` | "yes please" and "Edit: foo.ts" were appearing as decisions |
| Decision → Verified Fact | Length + filler check | User confirmations ("ok", "yes") stored as "facts" |
| Decision/Discovery → Learning | `isPromotableContent()` | Tool titles and markdown fragments promoted as knowledge |
| Insight → Flow Entry | Strip existing `[marker]` | `[diagnosis] [diagnosis]` doubling from feedback loops |
| Bash → Importance | Capped at 4 | Test runner output with "error"/"fail" keywords hit importance 5 |
| Thread → Summary | `cleanGistForSummary()` | Raw markdown and newlines producing garbled summaries |

Every gate traces to a specific production failure. None are theoretical.

## Debugging This Codebase

- **Capture real CC payloads**: Temp hook that dumps `JSON.stringify(input)` to a file. Fastest way to verify assumptions.
- **Query the DB**: `node -e "const db = require('better-sqlite3')(homedir + '/.claudex/db/claudex.db', {readonly:true}); ..."` — verify pipeline output directly.
- **Check telemetry**: `SELECT * FROM telemetry WHERE session_id = '...' ORDER BY rowid` — which hooks fired, latency.
- **Run `claudex health`**: CLI health check for DB schema, table counts, orphaned records.
- **Read the assembly output**: If the injected context contains garbage, the system is failing. Unit tests won't catch this — live testing does.

## Build & Test

```bash
bun run build          # esbuild, ~30ms, outputs to dist/
bun run test           # vitest, 71 files, 1213+ tests
npx vitest run         # same thing, explicit
```

**Do NOT use `bun test`** — invokes Bun's native runner, not Vitest.

## What Needs Work

- **OpenClaw adapter**: Implemented, unit-tested, not production-validated. The bridge adapter has its own assembly path and capability declarations — it needs real usage to verify.
- **Enrichment**: Ollama-based LLM enrichment for checkpoints/decisions. Graceful degradation when Ollama isn't running. Most users won't have it.
- **Topic shift detection**: Embedding-based (Ollama nomic-embed-text) with keyword fallback. Keyword path always active.
