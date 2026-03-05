[![License: MIT + Commons Clause](https://img.shields.io/badge/License-MIT%20%2B%20Commons%20Clause-blue.svg)](LICENSE)

# Claudex

> Persistent memory, incremental checkpointing, and context-aware intelligence for Claude Code.

## What is Claudex?

Claudex is a hook-based memory and context system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It intercepts every session lifecycle event -- session start, prompt submission, tool use, compaction, and session end -- to automatically capture observations, preserve reasoning chains, and inject relevant context back into the conversation. The result is persistent memory across sessions: Claude Code gains awareness of past decisions, recently touched files, and project-specific knowledge, even after context compaction wipes the conversation window.

The system operates entirely through Claude Code's hook protocol. Six hooks feed into a SQLite database with FTS5 full-text search, a Python TCP sidecar for pressure-based attention routing, and a flat-file mirror that keeps all data human-readable. When any component is unavailable, the system degrades gracefully through three tiers -- never crashing, never blocking the user.

For 1M context window users, incremental checkpointing captures progressive snapshots throughout the session, preventing catastrophic context loss during auto-compaction.

**Highlights:**
- Incremental checkpointing for 1M+ context windows
- GSD phase-aware context injection
- Memory system with stratified decay and quality gating
- 1200+ tests passing

## Quick Start

```bash
git clone https://github.com/Corleanus/Claudex.git
cd Claudex
npm install
npx claudex setup
```

That's it. The setup command creates `~/.claudex/`, writes default config, and registers all hooks with Claude Code. Start a new Claude Code session and Claudex is active.

## Architecture

```
Claude Code ──stdin/stdout──> Hook Processes (Node.js, ephemeral)
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
              SQLite DB     Hologram Sidecar   Flat-File Mirror
           (better-sqlite3)   (Python TCP)    (~/.claudex/memory/)
              │                   │
         FTS5 Search        Pressure Scoring
         (observations,     (HOT/WARM/COLD
          reasoning,         file attention)
          consensus)
```

**Components:**

- **6 Hook Entry Points** -- one per Claude Code lifecycle event, bundled as standalone `.mjs` files via esbuild
- **SQLite Storage** with WAL mode -- observations, sessions, reasoning chains, consensus decisions, pressure scores
- **FTS5 Full-Text Search** across all tables with auto-sync triggers and BM25 ranking
- **Hologram Sidecar** -- a long-lived Python TCP server communicating via NDJSON protocol for pressure-based file attention scoring
- **Three-Tier Degradation** -- hologram -> DB pressure scores -> recency fallback (system never crashes)
- **Flat-File Mirroring** -- every DB record mirrored to human-readable markdown files
- **Context Assembler** -- priority-ranked, token-budgeted context injection into Claude's input
- **Wrapper Layer** -- context window monitoring with configurable warn/flush thresholds
- **Incremental Checkpointing** -- progressive context snapshots at configurable thresholds (2 for 200k, 6 for 1M windows) with conservative window detection
- **GSD Phase Awareness** -- reads `.planning/` state to inject phase-relevant context (active plan, requirements, progress)

## Prerequisites

- **Node.js** >= 20.0.0
- **C++ Build Tools** (required for better-sqlite3 native module):
  - **Windows:** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload, or run `npm install -g windows-build-tools` from an admin terminal
  - **macOS:** `xcode-select --install`
  - **Linux:** `sudo apt-get install build-essential` (Debian/Ubuntu) or equivalent
- **Python 3.x** (optional — only needed for the hologram pressure-scoring sidecar)

## Manual Setup

> **Prefer the automated setup:** `npx claudex setup` handles everything below automatically. Use manual setup only if you need custom configuration.

### Installation

```bash
cd Claudex
npm install
npm run build
```

This produces 6 `.mjs` hook bundles in `dist/`:

| Hook                 | File                           | Trigger                          |
|----------------------|--------------------------------|----------------------------------|
| SessionStart         | `dist/session-start.mjs`       | Session begins (startup/resume)  |
| SessionEnd           | `dist/session-end.mjs`         | Session ends                     |
| UserPromptSubmit     | `dist/user-prompt-submit.mjs`  | User submits a prompt            |
| PostToolUse          | `dist/post-tool-use.mjs`       | After a tool call completes      |
| PreCompact           | `dist/pre-compact.mjs`         | Before context compaction        |
| UserPromptSubmit (2) | `dist/pre-flush.mjs`           | Context window monitoring        |

### Hook Registration

Add the following to your Claude Code `settings.json` (typically `~/.claude/settings.json`).

**Windows** -- the `hooks/` directory contains `.cmd` wrappers:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\session-start.cmd" }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\session-end.cmd" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\user-prompt-submit.cmd" },
          { "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\pre-flush.cmd" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\post-tool-use.cmd" }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "C:\\path\\to\\Claudex\\hooks\\pre-compact.cmd" }]
      }
    ]
  }
}
```

Replace `C:\path\to\Claudex` with the actual path to the `Claudex/` directory.

**Unix / macOS** -- the `hooks/` directory contains `.sh` wrappers. Make them executable first:

```bash
chmod +x hooks/*.sh
```

Then register in `settings.json` using the same structure, replacing `.cmd` paths with `.sh`:

```
/path/to/Claudex/hooks/session-start.sh
```

## Configuration

### ~/.claudex/config.json

All configuration is optional. Missing keys fall back to defaults. A missing or corrupt file uses all defaults.

```json
{
  "hologram": {
    "enabled": true,
    "python_path": "python",
    "sidecar_path": "/path/to/Claudex/sidecar/main.py",
    "timeout_ms": 2000,
    "health_interval_ms": 30000
  },
  "database": {
    "path": "~/.claudex/db/claudex.db",
    "wal_mode": true
  },
  "hooks": {
    "latency_budget_ms": 3000
  },
  "observation": {
    "enabled": true,
    "redact_secrets": true,
    "retention_days": 90
  },
  "wrapper": {
    "enabled": true,
    "warnThreshold": 0.70,
    "flushThreshold": 0.80,
    "cooldownMs": 30000
  },
  "vector": {
    "enabled": false,
    "provider": "fts5"
  }
}
```

| Section        | Key                  | Default   | Description                                                    |
|----------------|----------------------|-----------|----------------------------------------------------------------|
| `hologram`     | `enabled`            | `true`    | Enable hologram sidecar for pressure scoring                   |
| `hologram`     | `python_path`        | `python`  | Python executable path                                         |
| `hologram`     | `sidecar_path`       | --        | Path to `sidecar/main.py` (required if hologram enabled)       |
| `hologram`     | `timeout_ms`         | `2000`    | Timeout for sidecar TCP requests                               |
| `hologram`     | `health_interval_ms` | `30000`   | Health check interval                                          |
| `database`     | `path`               | `~/.claudex/db/claudex.db` | SQLite database file path                       |
| `database`     | `wal_mode`           | `true`    | Enable WAL journal mode for concurrent reads                   |
| `hooks`        | `latency_budget_ms`  | `3000`    | Warn when a hook exceeds this duration                         |
| `observation`  | `enabled`            | `true`    | Enable automatic observation capture from tool use             |
| `observation`  | `redact_secrets`     | `true`    | Redact API keys, tokens, and credentials from observations     |
| `observation`  | `retention_days`     | `90`      | Days to retain observations before cleanup                     |
| `wrapper`      | `enabled`            | `true`    | Enable pre-flush context monitoring                            |
| `wrapper`      | `warnThreshold`      | `0.70`    | Context utilization ratio to emit warning                      |
| `wrapper`      | `flushThreshold`     | `0.80`    | Context utilization ratio to trigger memory flush              |
| `wrapper`      | `cooldownMs`         | `30000`   | Minimum time (ms) between consecutive flushes                  |
| `vector`       | `enabled`            | `false`   | Enable vector search (currently uses FTS5 as backend)          |
| `vector`       | `provider`           | `fts5`    | Search provider (`fts5`, `openai`, `local`)                    |

### ~/.claudex/projects.json

The project registry maps working directories to named projects. Claudex uses this to scope observations, pressure scores, and context injection per project.

```json
{
  "projects": {
    "my-project": {
      "path": "C:\\Users\\me\\Projects\\my-project",
      "status": "active"
    },
    "another-project": {
      "path": "/home/me/projects/another-project",
      "status": "active"
    }
  }
}
```

When `cwd` falls within a registered project path, Claudex enters project scope -- observations are tagged with the project name, search results are filtered by project, and flat-file mirrors write into `<project_path>/context/`. If `cwd` doesn't match any registered project, Claudex operates in global scope.

## Hooks

### 1. session-start

**Trigger:** Session begins (startup, resume, or clear).

- Bootstraps the `~/.claudex/` directory tree (idempotent)
- Detects scope via `projects.json` lookup
- Registers the session in `sessions/index.json` and SQLite
- Restores context from prior sessions: queries observations, reasoning chains, consensus decisions, and pressure scores from DB
- Queries the hologram sidecar for live pressure scores (falls back to DB scores, then empty)
- Assembles and injects restored context via `additionalContext`

### 2. session-end

**Trigger:** Session ends (clear, logout, or prompt exit).

Five independent sections, each with isolated error handling:

- Captures a final transcript snapshot to `~/.claudex/transcripts/<session_id>/`
- Checks for a completion marker (`.completed-<session_id>`) to distinguish clean vs. unclean exits
- Writes a fail-safe auto-handoff file if no completion marker exists and scope is project
- Updates session status in `sessions/index.json` and SQLite
- Persists hologram pressure scores to DB for cross-session continuity
- Writes a session summary markdown file

### 3. user-prompt-submit

**Trigger:** User submits a prompt.

- Skips injection for short prompts (< 10 characters)
- Detects scope and retrieves recent observations from DB
- Queries the hologram sidecar for pressure-scored file context (with resilient retry and three-tier degradation)
- Queries FTS5 for observations matching prompt keywords (auto-extracted, stop words filtered)
- Assembles context from all sources within a 4000-token budget
- Injects assembled context via `additionalContext`

### 4. post-tool-use

**Trigger:** After every tool call completes.

- Respects `observation.enabled` config gate
- Extracts structured observations from tool I/O (Read, Edit, Write, Bash, Grep, Glob, WebFetch)
- Applies secret redaction (API keys, tokens, JWTs, AWS keys)
- Filters trivial operations (e.g., `ls`, `cd`, `pwd`)
- Stores observations in SQLite and mirrors to flat-file daily markdown
- Returns empty output (never injects context)

### 5. pre-compact

**Trigger:** Before context compaction (auto or manual).

- Copies the transcript file to `~/.claudex/transcripts/<session_id>/` with SHA256 checksum and metadata
- Captures the tail of the transcript as a reasoning chain and stores it in SQLite
- Writes a flat-file mirror of the reasoning chain markdown

### 6. pre-flush

**Trigger:** Runs on every UserPromptSubmit (piggybacks as a second hook on the same event).

- Gated behind `wrapper.enabled` config
- Reads token counts from hook input
- Assesses utilization against warn/flush thresholds
- Respects file-based cooldown (survives across ephemeral hook processes)
- Executes the flush sequence: persist pressure scores, write flat-file mirrors, request hologram re-score

## Degradation Tiers

The system is designed to never crash, regardless of which components are available:

| Tier | Name             | Condition                              | Behavior                                                       |
|------|------------------|----------------------------------------|----------------------------------------------------------------|
| 1    | Full Stack       | Hologram sidecar running + responsive  | Live pressure-scored context (HOT/WARM/COLD file classification) |
| 2    | DB Pressure      | Hologram unavailable, DB has scores    | Uses persisted pressure scores from previous hologram queries  |
| 3    | Recency Fallback | No hologram + no DB scores             | Recently-touched files from observations, classified as WARM   |

The `ResilientHologramClient` implements this chain: attempt query, retry once, fall back to DB pressure scores, fall back to recency. Every DB function catches errors internally and returns empty results. Every hook exits 0 regardless of internal failures.

## Storage

### SQLite Database (~/.claudex/db/claudex.db)

The database uses WAL mode for concurrent reads, with 4 sequential migrations applied automatically on every connection:

**Tables:**

| Table                 | Migration | Purpose                                          |
|-----------------------|-----------|--------------------------------------------------|
| `observations`        | 1         | Auto-captured tool use observations              |
| `sessions`            | 1         | Session lifecycle tracking                       |
| `reasoning_chains`    | 3         | Flow reasoning snapshots preserved across compaction |
| `consensus_decisions` | 3         | Three-way (Claude/Codex/human) agreement records |
| `pressure_scores`     | 3         | Hologram attention scores with decay             |
| `observations_fts`    | 2         | FTS5 virtual table for observation search        |
| `reasoning_fts`       | 4         | FTS5 virtual table for reasoning search          |
| `consensus_fts`       | 4         | FTS5 virtual table for consensus search          |
| `schema_versions`     | --        | Migration tracking                               |

FTS5 tables use content-sync mode with auto-sync triggers (INSERT, UPDATE, DELETE). All tables support BM25-ranked search with snippet extraction. A unified `searchAll()` function merges results across all three FTS5 tables.

Pressure scores use a `UNIQUE(file_path, project)` index with a `__global__` sentinel for global scope (avoids NULL uniqueness issues in SQLite).

### Vector Search Abstraction

The `FTS5VectorStore` class wraps FTS5 search behind a `VectorStore` interface (`search`, `searchByTable`). This abstraction layer allows future replacement with real vector search providers (OpenAI embeddings, local models) without changing consumer code. Currently FTS5 is the only implemented backend.

### Flat-File Mirrors

Every record stored in SQLite is also mirrored to human-readable markdown files. The human is never locked out of their own data.

| Data Type           | Global Scope Path                                        | Project Scope Path                                      |
|---------------------|----------------------------------------------------------|---------------------------------------------------------|
| Observations        | `~/.claudex/memory/daily/YYYY-MM-DD.md`                 | `<project>/context/observations/YYYY-MM-DD.md`          |
| Reasoning Chains    | `~/.claudex/reasoning/<session_id>/<timestamp>.md`       | `<project>/context/reasoning/<session_id>/<timestamp>.md`|
| Consensus Decisions | `~/.claudex/consensus/<session_id>/<timestamp>.md`       | `<project>/context/consensus/<session_id>/<timestamp>.md`|
| Pressure Scores     | `~/.claudex/pressure/scores.md`                         | `<project>/context/pressure/scores.md`                   |
| Transcripts         | `~/.claudex/transcripts/<session_id>/<timestamp>.jsonl`  | (same)                                                   |
| Session Summaries   | `~/.claudex/sessions/<session_id>/summary.md`            | (same)                                                   |

Observations are append-only. Pressure scores are snapshot (overwritten each time). Reasoning and consensus are written as individual files.

## Hologram Sidecar

The hologram sidecar is a long-lived Python TCP server (`sidecar/server.py`) that communicates with hooks via NDJSON over localhost TCP. It is designed to outlive individual hook processes (hooks are ephemeral -- one process per event).

**Protocol:** Each TCP connection carries one request/response pair as newline-delimited JSON:

| Request Type | Purpose                                  |
|--------------|------------------------------------------|
| `query`      | Get pressure-scored file context         |
| `ping`       | Health check (returns `pong`)            |
| `update`     | Notify file changes for recalculation    |
| `shutdown`   | Graceful shutdown                        |

**Lifecycle management** (`SidecarManager`):
- Lazy-starts the sidecar on first query
- Detects and reuses existing sidecar processes via PID/port files
- Cleans up orphaned processes and stale port files
- Verifies sidecar identity via NDJSON ping (distinguishes from foreign processes on the same port)
- Port file: `~/.claudex/db/hologram.port`; PID file: `~/.claudex/db/hologram.pid`

**Current state:** The sidecar server is operational and responds to all protocol messages. The hologram-cognitive pressure engine is not yet integrated -- queries return empty pressure arrays, causing the system to degrade to Tier 2 (DB pressure) or Tier 3 (recency fallback) as designed.

## Context Assembly

The context assembler (`src/lib/context-assembler.ts`) builds injection payloads from multiple sources into a token-budgeted markdown string. Sections are appended in priority order, each only if it fits within the remaining budget:

1. **Identity** (agent/user context)
2. **Project** (primer, handoff)
3. **HOT files** (pressure >= 0.851)
4. **Flow Reasoning** (reasoning chains from prior compactions)
5. **Related Observations** (FTS5 search results ranked by BM25)
6. **Consensus Decisions** (three-way agreement records)
7. **Session Continuity** (post-compaction marker)
8. **WARM files** (pressure >= 0.426)
9. **Recent Activity** (fallback when no hologram and no FTS5 results)

Token estimation uses a simple `ceil(length / 4)` heuristic. The default budget is 4000 tokens.

## Observation Extraction

The observation extractor (`src/lib/observation-extractor.ts`) transforms raw tool I/O into structured `Observation` objects. Each observation includes a category, importance score (1-5), file references, and content.

**Handled tools:** Read, Edit, Write, Bash, Grep, Glob, WebFetch.

**Secret redaction** is applied to all observation titles and content, matching:
- API keys, tokens, passwords, credentials
- Stripe/service keys (`sk-*`, `pk-*`, etc.)
- GitHub personal access tokens (`ghp_*`, `gho_*`, etc.)
- JWT tokens
- AWS access key IDs

**Filtering:** Trivial bash commands (`ls`, `cd`, `pwd`) are silently dropped. Glob results with fewer than 3 matches are dropped.

## Development

### Commands

```bash
npm run build        # Build 6 hook bundles via esbuild to dist/
npm run typecheck    # TypeScript strict check (noUnusedLocals, noUncheckedIndexedAccess)
npm test             # Run vitest test suite
npm run test:watch   # Watch mode
```

### Project Structure

```
Claudex/
  src/
    shared/              # Foundation layer
      types.ts             # All type definitions and interfaces (contract between modules)
      config.ts            # Config loading with deep-merge over defaults
      paths.ts             # All ~/.claudex/ path constants
      logger.ts            # Per-hook file logging to ~/.claudex/hooks/logs/
      metrics.ts           # In-memory metrics collector (count, totalMs, errors)
      health.ts            # System health check (DB, hologram, wrapper)
      errors.ts            # Typed error hierarchy (ClaudexError -> Database/Hologram/Hook/Config)
      scope-detector.ts    # Scope detection from projects.json
    hooks/               # Hook entry points (6 hooks + infrastructure)
      _infrastructure.ts   # readStdin, writeStdout, runHook harness, logToFile
      session-start.ts     # Bootstrap, scope detect, register, context restore
      session-end.ts       # Transcript, fail-safe handoff, status update, pressure capture
      user-prompt-submit.ts # Hologram query, FTS5 search, context injection
      post-tool-use.ts     # Observation extraction and storage
      pre-compact.ts       # Transcript snapshot + reasoning chain capture
      pre-flush.ts         # Context monitoring, flush orchestration
    db/                  # Database layer
      connection.ts        # Connection factory with WAL mode + migrations
      schema.ts            # Migration 1: observations + sessions tables
      schema-phase2.ts     # Migration 3: reasoning, consensus, pressure tables
      search.ts            # Migrations 2+4: FTS5 virtual tables + search functions
      migrations.ts        # Sequential idempotent migration runner
      observations.ts      # Observation CRUD (store, query by session, recent, delete old)
      sessions.ts          # Session CRUD (create, update status, get active, increment count)
      reasoning.ts         # Reasoning chain CRUD (insert, query, search)
      consensus.ts         # Consensus decision CRUD (insert, update status, query)
      pressure.ts          # Pressure score CRUD (upsert, query by temperature, decay all)
      vectors.ts           # FTS5VectorStore: VectorStore interface wrapping FTS5 search
    hologram/            # Sidecar communication
      protocol.ts          # TCP/NDJSON transport (connect, send, receive, close)
      launcher.ts          # Sidecar process manager (spawn, stop, orphan cleanup)
      client.ts            # High-level API (query, ping, rescore, persist scores)
      degradation.ts       # ResilientHologramClient (3-tier fallback chain)
    lib/                 # Business logic
      context-assembler.ts # Token-budgeted context assembly from all sources
      observation-extractor.ts # Tool I/O -> Observation with secret redaction
      flat-file-mirror.ts  # Markdown mirrors for observations, reasoning, consensus, pressure
    wrapper/             # Context window management
      context-monitor.ts   # Pure utilization assessment (detect, don't act)
      flush-trigger.ts     # Flush orchestration (reasoning + pressure + hologram rescore)
  hooks/                 # Shell wrappers
    *.cmd                  # Windows wrappers (node %~dp0..\dist\<hook>.mjs)
    *.sh                   # Unix wrappers (exec node "$DIR/../dist/<hook>.mjs")
  sidecar/               # Python hologram sidecar
    main.py                # Entry point (argparse, signal handlers, port/PID files)
    server.py              # Asyncio TCP server with NDJSON protocol routing
  dist/                  # Built .mjs bundles (generated by npm run build)
  tests/                 # Vitest test suite
```

### Key Design Principles

- **Never throw from hooks.** Every hook exits 0 and returns valid JSON to stdout, regardless of internal errors. Logging captures failures for debugging.
- **Never throw from DB functions.** All database operations catch errors internally and return empty/default results. Errors are logged, not propagated.
- **Fail open.** If the hologram is down, use DB scores. If the DB is down, use recency. If everything is down, return empty context and let Claude work normally.
- **Hooks are ephemeral.** Each hook invocation is a fresh Node.js process. Module-level state resets every time. Cross-invocation state uses the filesystem (cooldown files, port/PID files) or SQLite.
- **The sidecar is long-lived.** Spawned detached, outlives hook processes. Port/PID files coordinate discovery. Orphan detection cleans up stale state.
- **Timestamps are always milliseconds.** `timestamp_epoch` fields throughout the codebase are epoch milliseconds, not seconds.

## License

This project is licensed under the MIT License with Commons Clause — see the [LICENSE](LICENSE) file for details. You are free to use, copy, modify, and distribute this software. You may not sell it as a standalone product or service.
