# Claudex v3 — Unified Context Management System

**Date**: 2026-03-09
**Status**: Architecture Design (pre-implementation)
**Author**: Claude Opus 4.6 + Grigorije
**Predecessors**: Claudex v2 (hook-based), OpenClaw Context Manager (bridge-based)

---

## 1. Vision

Claudex v3 is a single context management system that replaces both Claudex v2 and OpenClaw's Context Manager plugin. It combines Claudex v2's storage layer (SQLite + FTS5 + observation extraction + priority-budgeted assembly) with the Context Manager's intelligence layer (decision heuristics + LLM enrichment + cross-session learnings + semantic dedup), running behind a unified core with swappable runtime adapters for Claude Code hooks and OpenClaw's Pi SDK bridge.

### 1.1 Why Merge

Both systems evolved independently to solve the same problem: giving an LLM persistent memory and context awareness across sessions and compaction events. They overlap on checkpoints, file tracking, thread tracking, compaction handling, and context injection. Running both requires a coordination contract (`~/.echo/coordination.json`) that adds complexity to manage fundamentally duplicated work. Merging eliminates the coordination problem entirely.

### 1.2 Design Principles

1. **One system, two deployment targets** — same core, different adapters for CC hooks vs OpenClaw bridge
2. **Boundary-only injection** — full context assembly at session-start and post-compaction only; most turns get zero injected context
3. **SQLite is the state bus** — ephemeral hook processes share state through the database, not files
4. **Mutual exclusion at deployment** — you deploy the CC adapter OR the OpenClaw adapter, never both simultaneously
5. **Enrichment is optional** — heuristic checkpoint data is high-quality; LLM refinement is a nice-to-have
6. **Defensive non-throwing** — every public function catches errors and returns safe defaults; hooks never crash the host
7. **Flat-file mirroring** — human is never locked out; every critical state has a readable file mirror

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Process                              │
│  (Claude Code CLI  OR  OpenClaw Pi Embedded Runner)              │
│                                                                  │
│  Lifecycle events:                                               │
│    session_start, prompt_submit, tool_use, compact, session_end  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Runtime Adapter Layer                         │
│                                                                  │
│  ┌─────────────────────┐    ┌──────────────────────────────┐    │
│  │  CC Hook Adapter     │    │  OpenClaw Bridge Adapter      │    │
│  │  (ephemeral process) │    │  (in-process, persistent)     │    │
│  │                      │    │                               │    │
│  │  stdin JSON →        │    │  globalThis Symbol →          │    │
│  │  core operations →   │    │  core operations →            │    │
│  │  stdout JSON         │    │  enqueueSystemEvent           │    │
│  └──────────┬───────────┘    └──────────────┬────────────────┘    │
│             │  implements                   │  implements          │
│             └──────────┬────────────────────┘                     │
│                        ▼                                          │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              RuntimeAdapter interface                      │    │
│  │                                                           │    │
│  │  sessionInit(context: SessionContext): InjectPayload      │    │
│  │  beforePrompt(prompt: string, ctx: PromptContext):        │    │
│  │      InjectPayload                                        │    │
│  │  afterTool(event: ToolEvent): void                        │    │
│  │  beforeCompact(ctx: CompactContext): void                 │    │
│  │  sessionEnd(reason: EndReason): void                      │    │
│  └──────────────────────────┬────────────────────────────────┘    │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Claudex v3 Core                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Storage      │  │  Extraction  │  │  Intelligence         │  │
│  │  Layer        │  │  Pipeline    │  │  Layer                │  │
│  │              │  │              │  │                       │  │
│  │  SQLite+WAL  │  │  Per-tool    │  │  Decision capture    │  │
│  │  FTS5 search │  │  extractors  │  │  Thread tracking     │  │
│  │  Observations│  │  Redaction   │  │  Semantic dedup      │  │
│  │  Learnings   │  │  Quality     │  │  LLM enrichment      │  │
│  │  Decisions   │  │  gates       │  │  Learnings promotion │  │
│  │  Pressure    │  │              │  │                       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Assembly     │  │  Checkpoint  │  │  Supporting           │  │
│  │  Pipeline     │  │  System      │  │  Subsystems           │  │
│  │              │  │              │  │                       │  │
│  │  Priority-   │  │  Schema v3   │  │  Token gauge          │  │
│  │  budgeted    │  │  Writer      │  │  Decay engine         │  │
│  │  Sections    │  │  Loader      │  │  GSD integration      │  │
│  │  Post-redact │  │  3-hop       │  │  Scope detection      │  │
│  │  reclaim     │  │  recovery    │  │  Config management    │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Runtime Adapter Layer

### 3.1 The RuntimeAdapter Interface

```typescript
interface RuntimeAdapter {
  // Called once when session begins
  sessionInit(ctx: SessionContext): Promise<InjectPayload>;

  // Called on each user prompt (CC) or context event (OpenClaw)
  beforePrompt(prompt: string, ctx: PromptContext): Promise<InjectPayload>;

  // Called after each tool completes
  afterTool(event: ToolEvent): Promise<void>;

  // Called before context compaction
  beforeCompact(ctx: CompactContext): Promise<void>;

  // Called when session ends
  sessionEnd(reason: EndReason): Promise<void>;
}

interface InjectPayload {
  content: string;       // Markdown to inject into context
  tokenEstimate: number; // Approximate token count
  sources: string[];     // Which data sources contributed
}

interface SessionContext {
  sessionId: string;
  cwd: string;
  source: 'startup' | 'resume' | 'clear' | 'bridge_init';
  transcriptPath?: string;   // CC only
  sessionKey?: string;       // OpenClaw only
}

interface PromptContext {
  sessionId: string;
  cwd: string;
  isPostCompaction: boolean;
  transcriptPath?: string;   // CC only — for token gauge
  contextUsage?: {           // OpenClaw only — from SDK
    inputTokens: number;
    outputTokens: number;
    contextWindowTokens: number;
  };
}

interface ToolEvent {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  cwd: string;
}

interface CompactContext {
  sessionId: string;
  cwd: string;
  trigger: 'auto' | 'manual';
  transcriptPath?: string;
  // OpenClaw-specific: access to messages being dropped
  messagesToSummarize?: Message[];
  turnPrefixMessages?: Message[];
}

type EndReason = 'clear' | 'logout' | 'prompt_input_exit' | 'bridge_end';
```

### 3.2 CC Hook Adapter

Maps Claude Code's 7 lifecycle hooks to the 5 RuntimeAdapter operations.

| CC Hook Event | Adapter Method | Notes |
|---|---|---|
| `SessionStart` | `sessionInit()` | Returns `additionalContext` via stdout |
| `UserPromptSubmit` | `beforePrompt()` | Returns `systemMessage` via stdout |
| `PostToolUse` | `afterTool()` | Returns `{}` (no injection) |
| `PreCompact` | `beforeCompact()` | Returns `{}` (no injection) |
| `SessionEnd` | `sessionEnd()` | Returns `{}` (no injection) |

**Dropped CC hooks** (compared to Claudex v2):
- `Stop` — decision nudge replaced by heuristic capture in `afterTool()`
- `PreFlush` — wrapper concept never materialized

**Ephemeral process lifecycle**:
```
CC fires hook
  → Node.js process starts
  → reads stdin JSON
  → opens SQLite (WAL mode, fast)
  → reads config from DB (cached by mtime)
  → calls RuntimeAdapter method
  → writes stdout JSON
  → process exits
```

Each invocation is ~50-100ms for non-injection hooks, ~200-500ms for injection hooks (FTS5 query + assembly).

**Implementation file**: `src/adapters/cc-hooks/index.ts`

```typescript
// Pseudocode for CC hook adapter
import { readStdin, writeStdout } from './infrastructure';
import { createCore } from '../../core';

const hookMap: Record<string, keyof RuntimeAdapter> = {
  SessionStart: 'sessionInit',
  UserPromptSubmit: 'beforePrompt',
  PostToolUse: 'afterTool',
  PreCompact: 'beforeCompact',
  SessionEnd: 'sessionEnd',
};

async function main() {
  const input = await readStdin();
  const core = createCore(); // opens DB, loads config
  const method = hookMap[input.hook_event_name];

  try {
    const result = await core[method](mapInputToContext(input));
    writeStdout(mapResultToOutput(input.hook_event_name, result));
  } catch (e) {
    writeStdout({}); // never crash — defensive non-throwing
  } finally {
    core.close(); // close DB connection
  }
}
```

### 3.3 OpenClaw Bridge Adapter

Maps Pi SDK extension events to the 5 RuntimeAdapter operations via globalThis Symbol bridge.

| Pi SDK Event | Adapter Method | Notes |
|---|---|---|
| Bridge `onInit` | `sessionInit()` | Registers runtime, returns checkpoint for injection |
| `context` event | `beforePrompt()` | Has full message history access |
| `tool_result` event | `afterTool()` | Tool output available directly |
| `session_before_compact` | `beforeCompact()` | Has messagesToSummarize + turnPrefixMessages |
| `message_end` event | (no direct map) | Used for thread tracking — folded into afterTool cycle |

**Bridge registration** (core-side, ~30 lines):

```typescript
// In OpenClaw's src/agents/pi-embedded-runner/extensions.ts
const BRIDGE_KEY = Symbol.for('claudex.v3.bridge');

function createClaudexExtension(sessionKey: string): PiExtension {
  const bridge = (globalThis as any)[BRIDGE_KEY];
  if (!bridge?.onInit) {
    // No Claudex v3 plugin — fall back to upstream compaction safeguard
    return compactionSafeguardExtension;
  }

  bridge.onInit({ sessionKey });

  return {
    name: 'claudex-v3',
    async context(ctx) { await bridge.onContext(ctx); },
    async tool_result(ctx) { await bridge.onToolResult(ctx); },
    async message_end(ctx) { await bridge.onMessageEnd(ctx); },
    async session_before_compact(ctx, prep, runtime) {
      await bridge.onCompact(ctx, prep, runtime);
    },
  };
}
```

**Plugin-side registration** (in `~/.openclaw/extensions/claudex-v3/index.ts`):

```typescript
import { createCore } from 'claudex-v3/core';

const BRIDGE_KEY = Symbol.for('claudex.v3.bridge');

export function activate(api: OpenClawPluginApi) {
  const core = createCore({ persistent: true }); // keeps DB open

  (globalThis as any)[BRIDGE_KEY] = {
    onInit: (ctx) => core.sessionInit(mapBridgeInit(ctx)),
    onContext: (ctx) => core.beforePrompt(extractPrompt(ctx), mapContext(ctx)),
    onToolResult: (ctx) => core.afterTool(mapToolEvent(ctx)),
    onMessageEnd: (ctx) => core.trackThread(ctx), // thread tracking only
    onCompact: (ctx, prep, runtime) => core.beforeCompact(mapCompact(ctx, prep, runtime)),
  };

  // Register cleanup
  api.registerHook('session_end', () => core.sessionEnd('bridge_end'));
}
```

**Key difference from v2 bridge**: Only 1 Symbol key, 5 callbacks, 0 injected utilities. The plugin imports from the claudex-v3 package directly instead of receiving 15 utilities via bridge.utils. This makes the contract explicit and type-safe.

### 3.4 Mutual Exclusion

The two adapters never run simultaneously for the same session:

- **CC standalone**: CC hooks adapter is active. No OpenClaw bridge exists.
- **OpenClaw standalone**: Bridge adapter is active. No CC hooks fire (OpenClaw manages its own agent lifecycle).
- **CC inside OpenClaw** (Echo scenario): OpenClaw spawns CC via `-p` mode. CC hooks fire for CC's session. The bridge adapter handles OpenClaw's own agent sessions. They operate on DIFFERENT sessions with DIFFERENT session IDs, sharing the same SQLite database. No conflict.

Detection is implicit: the bridge adapter only activates if the plugin is loaded by OpenClaw's plugin system. CC hooks only fire if registered in `~/.claude/settings.json`.

---

## 4. Storage Layer

### 4.1 SQLite Database

**Location**: `~/.claudex/db/claudex.db`
**Mode**: WAL (Write-Ahead Logging) for concurrent reads during hook execution
**PRAGMAs**: `synchronous=NORMAL`, `cache_size=10000`, `foreign_keys=ON`, `journal_mode=WAL`

### 4.2 Schema (v3 migration from v2)

```sql
-- ============================================================
-- TABLE: observations
-- Source: Claudex v2 (kept as-is, core value proposition)
-- Purpose: Structured tool use observations with FTS5 search
-- ============================================================
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'code', 'architecture', 'decision', 'error', 'test',
    'config', 'dependency', 'documentation', 'performance',
    'security', 'other'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  files_modified TEXT DEFAULT '',  -- comma-separated paths
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at_epoch INTEGER,
  deleted_at_epoch INTEGER DEFAULT NULL  -- soft delete
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content,
  content=observations,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted ON observations(deleted_at_epoch);

-- ============================================================
-- TABLE: sessions
-- Source: Claudex v2 (kept as-is)
-- Purpose: Session lifecycle tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  scope TEXT,
  project TEXT,
  cwd TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed')),
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at_epoch INTEGER
);

-- ============================================================
-- TABLE: pressure_scores
-- Source: Claudex v2 (simplified — no WARM tier)
-- Purpose: File attention scoring for HOT file surfacing
-- ============================================================
CREATE TABLE IF NOT EXISTS pressure_scores (
  file_path TEXT NOT NULL,
  project TEXT NOT NULL,
  raw_pressure REAL NOT NULL DEFAULT 0.0,
  temperature TEXT NOT NULL DEFAULT 'COLD'
    CHECK (temperature IN ('HOT', 'COLD')),
  last_touched_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  decay_rate REAL NOT NULL DEFAULT 0.1,
  PRIMARY KEY (file_path, project)
);

-- ============================================================
-- TABLE: learnings (NEW — replaces JSON files from OpenClaw CM)
-- Source: OpenClaw Context Manager context-learnings.ts
-- Purpose: Cross-session operational learnings with promotion
-- ============================================================
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,                            -- NULL = global
  agent_id TEXT NOT NULL DEFAULT 'default', -- for multi-agent scoping
  fingerprint TEXT NOT NULL,               -- normalized text for dedup
  content TEXT NOT NULL,                   -- the learning itself
  promotion_count INTEGER NOT NULL DEFAULT 1,
  first_seen_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_promoted_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, agent_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_learnings_promo
  ON learnings(project, agent_id, promotion_count DESC);

-- ============================================================
-- TABLE: decisions (NEW — replaces YAML incremental files)
-- Source: OpenClaw Context Manager context-state.ts
-- Purpose: Heuristically captured decisions within a session
-- ============================================================
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'confirmation', 'direction', 'rejection', 'explicit'
  )),
  fingerprint TEXT NOT NULL,          -- for semantic dedup
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, fingerprint)     -- no dupes within a session
);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON decisions(session_id, timestamp_epoch DESC);

-- ============================================================
-- TABLE: thread_state (NEW — replaces YAML thread files)
-- Source: Combined from both systems
-- Purpose: Rolling conversation thread for checkpoint building
-- ============================================================
CREATE TABLE IF NOT EXISTS thread_state (
  session_id TEXT PRIMARY KEY,
  topic TEXT,                          -- current work topic
  summary TEXT,                        -- rolling summary
  key_exchanges TEXT NOT NULL DEFAULT '[]', -- JSON array of {role, gist}
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- TABLE: checkpoint_tracking (NEW — replaces .incremental-cp.json)
-- Source: Claudex v2 checkpoint_state + OpenClaw threshold tracking
-- Purpose: Track checkpoint state per session
-- ============================================================
CREATE TABLE IF NOT EXISTS checkpoint_tracking (
  session_id TEXT PRIMARY KEY,
  last_checkpoint_epoch INTEGER,
  thresholds_hit TEXT NOT NULL DEFAULT '[]',  -- JSON array of hit thresholds
  observation_count INTEGER NOT NULL DEFAULT 0,
  post_compact_pending INTEGER NOT NULL DEFAULT 0  -- boolean flag
);

-- ============================================================
-- TABLE: schema_versions (migration tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 4.3 Migration from Claudex v2

```sql
-- Migration 100: Claudex v3 schema additions
-- Preserves all existing v2 data, adds new tables

-- 1. Add new tables (learnings, decisions, thread_state, checkpoint_tracking)
-- (CREATE TABLE IF NOT EXISTS — safe to re-run)

-- 2. Drop unused tables
DROP TABLE IF EXISTS reasoning_chains;
DROP TABLE IF EXISTS reasoning_fts;
DROP TABLE IF EXISTS consensus_decisions;
DROP TABLE IF EXISTS consensus_fts;
DROP TABLE IF EXISTS audit_log;

-- 3. Simplify pressure_scores (remove WARM)
UPDATE pressure_scores
  SET temperature = 'COLD'
  WHERE temperature = 'WARM';

-- 4. Migrate checkpoint_state to checkpoint_tracking
INSERT INTO checkpoint_tracking (session_id, last_checkpoint_epoch, observation_count)
  SELECT session_id, last_epoch, 0
  FROM checkpoint_state
  WHERE NOT EXISTS (SELECT 1 FROM checkpoint_tracking WHERE checkpoint_tracking.session_id = checkpoint_state.session_id);
DROP TABLE IF EXISTS checkpoint_state;

-- 5. Record migration
INSERT INTO schema_versions (version) VALUES (100);
```

### 4.4 Flat-File Layout

```
~/.claudex/                              # Global Claudex home
  config.json                            # Configuration (replaces coordination.json)
  projects.json                          # Project registry
  identity/
    USER.md                              # User profile (loaded at session-start)
    BOOTSTRAP.md                         # First-run template
  memory/
    MEMORY.md                            # Curated global knowledge (< 200 lines)
    daily/YYYY-MM-DD.md                  # Daily session summaries
    topics/*.md                          # Topic files (on-demand loading)
  db/
    claudex.db                           # SQLite database (WAL mode)
    claudex.db-wal                       # WAL file
    claudex.db-shm                       # Shared memory file
  sessions/
    index.json                           # Session registry
  hooks/
    logs/*.log                           # Per-hook execution logs (5MB rotation)

{project}/context/                       # Per-project context (in project repo)
  checkpoints/
    latest.yaml                          # Reference to latest checkpoint
    YYYY-MM-DD_cpN.yaml                  # Checkpoint files (schema v3)
  handoffs/
    ACTIVE.md                            # Active work handoff
    auto_handoff_*.md                    # Failsafe auto-handoffs
  sessions/
    YYYY-MM-DD_session-N.md              # Session logs
```

**What's removed from v2 layout**:
- `~/.claudex/transcripts/` — CC manages its own transcripts; copying is redundant
- `~/.claudex/reasoning/` — dropped reasoning_chains table
- `~/.claudex/consensus/` — dropped consensus table
- `~/.claudex/pressure/` — pressure lives in DB only; HOT files surface in checkpoints
- `~/.claudex/db/hologram.port`, `hologram.pid` — no sidecar
- `~/.claudex/SIDECAR_STATUS.md` — no sidecar
- `~/.echo/` — no coordination contract needed
- `{project}/context/state/` — state lives in DB tables, not YAML files
- `{project}/context/observations/` — observations live in DB, daily summaries in `~/.claudex/memory/daily/`

---

## 5. Observation Extraction Pipeline

### 5.1 Overview

This is Claudex's core value proposition — converting raw tool I/O into structured, searchable, importance-scored observations. Kept from v2 with quality improvements.

```
Tool completes
  → afterTool(event) called
  → dispatch to per-tool extractor
  → quality gate (minimum content, non-trivial output)
  → three-layer redaction
  → importance scoring (1-5)
  → category classification
  → INSERT into observations table (FTS5 auto-synced)
  → pressure score accumulation
  → thread state update (agent action gist)
  → checkpoint threshold check
```

### 5.2 Per-Tool Extractors

Each tool type has a dedicated extractor that understands the tool's output format:

| Tool | Extractor Logic | Quality Gate |
|---|---|---|
| `Read` | Extracts file type, size, structural elements (classes, functions, exports) | Content >= 100 chars AND contains structural elements (not just "read file X") |
| `Edit` | Captures old/new text diff, file path, nature of change | Always passes (edits are always significant) |
| `Write` | Captures file path, content summary, whether new or overwrite | Always passes (writes are always significant) |
| `Bash` | Extracts command, exit code, output summary | Filters trivial: `ls`, `cd`, `pwd`, `echo`, `cat`, `which`, `type`. Requires output >= 20 chars or non-zero exit code |
| `Grep` | Captures pattern, match count, file list | Requires >= 1 match |
| `Glob` | Captures pattern, matched files | Requires >= 3 matches |
| `WebFetch` | Captures URL, status, content summary | Always passes |
| `WebSearch` | Captures query, result count, top results | Always passes |
| `Task` (agent) | Captures agent name, task summary, result | Always passes |
| `NotebookEdit` | Captures cell changes | Always passes |

### 5.3 Importance Scoring

| Score | Criteria | Half-life |
|---|---|---|
| 5 | Architecture decisions, security findings, breaking changes | 365 days |
| 4 | Configuration changes, dependency updates, test failures | 90 days |
| 3 | Significant code changes (Write/Edit), error resolutions | 60 days |
| 2 | Read operations with structural content, search results | 14 days |
| 1 | Trivial operations, status checks, routine reads | 7 days |

### 5.4 Redaction (Three-Layer)

Applied at observation creation time (ingestion boundary):

**Layer 1 — Pattern-based secrets**:
- API keys: `sk-[a-zA-Z0-9]{20,}`, `key-[a-zA-Z0-9]{20,}`
- AWS: `AKIA[A-Z0-9]{16}`, `aws_secret_access_key`
- GitHub: `ghp_[a-zA-Z0-9]{36}`, `github_pat_`
- JWT: `eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}`
- Generic: `Bearer [a-zA-Z0-9_-]{20,}`

**Layer 2 — PII patterns**:
- Email addresses (RFC 5322 simplified)
- Phone numbers (international + US/UK formats)
- SSN: `\d{3}-\d{2}-\d{4}`
- Credit cards: `\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}`
- Public IPs (not 10.x, 172.16-31.x, 192.168.x)
- UUID protection: UUIDs are NOT redacted (common in code)

**Layer 3 — Entropy-based**:
- Shannon entropy >= 4.5 on strings >= 20 chars
- Allowlist: file paths (`C:\`, `/`), URLs (`http://`, `https://`), hashes (hex strings), UUIDs, import paths, identifiers with dots/underscores

**Path sanitization**: `C:\Users\Grigorije\...` → `C:\Users\[USER]\...`; project-relative paths use `<project>/` prefix.

### 5.5 Quality Gate Improvements Over v2

Claudex v2 captured everything and 84% of observations never surfaced (access_count = 0). v3 adds stricter gates:

1. **Read observations**: Must contain structural content (function/class definitions, exports, type declarations). Pure "read file, it had 200 lines" observations are dropped.
2. **Bash observations**: Must have meaningful output (>= 20 chars) or indicate failure (non-zero exit). `git status` showing "nothing to commit" is dropped.
3. **Grep with zero context**: If grep found matches but the observation doesn't include any matched content, drop it.
4. **Duplicate detection**: If an observation with the same tool+file_path+category exists within the last 5 minutes, skip (prevents re-read spam).

---

## 6. Intelligence Layer

### 6.1 Decision Capture (from OpenClaw CM)

4-tier heuristic extraction from assistant messages, running during `afterTool()` when the tool is a text-producing action:

**Tier 1 — Explicit confirmation** (highest confidence):
- Pattern: User message matches `^(yes|yeah|ok|go|approved|confirmed|do it|proceed|looks good|lgtm|ship it)`
- Captures: The preceding assistant proposal as a confirmed decision
- Source tag: `confirmation`

**Tier 2 — Direction-setting** (high confidence):
- Pattern: Assistant message contains `we should`, `let's`, `the approach is`, `I'll`, `the plan is`, `going with`
- Quality gate: Must be >= 20 chars, not inside a code fence, not a filler phrase
- Source tag: `direction`

**Tier 3 — Rejection** (medium confidence):
- Pattern: User message contains `no,`, `don't`, `actually,`, `instead`, `not that`, `wrong`
- Captures: What was rejected + what was chosen instead (if stated)
- Source tag: `rejection`

**Tier 4 — Explicit decision markers** (highest confidence):
- Pattern: Message contains `DECISION:`, `decided:`, `we agreed`, `final answer`
- Source tag: `explicit`

**Filler rejection**: Drops decisions matching common non-decisions: "I'll read the file", "let me check", "looking at this", "I see", greetings, acknowledgments.

**Code fence skip**: Any decision candidate that's entirely within a code fence (``` blocks) is dropped.

**Semantic dedup before storage**: See Section 6.3.

### 6.2 Thread Tracking (combined from both systems)

Continuous thread state maintained in the `thread_state` table:

**Topic tracking**: Extracted from the first substantive user message each session. Updated when the user shifts topic (detected by low keyword overlap with current topic).

**Key exchanges**: Rolling window of 8 most recent user→agent exchange pairs:
```json
[
  {"role": "user", "gist": "Fix the auth token refresh bug"},
  {"role": "agent", "gist": "Found stale snapshot in runtimeAuthStoreSnapshots, fixed to read from disk inside lock"},
  {"role": "user", "gist": "Also need to handle the OAuth PKCE flow"},
  {"role": "agent", "gist": "Implemented PKCE parameters matching pi-ai: auth.openai.com/oauth/authorize, redirect localhost:1455"}
]
```

**Gist extraction**: Max 120 chars per gist. Sentence-boundary truncation. For agent gists: if assistant message is tool-calls only, extract tool names (`[called Read, Edit, Write]`).

**Thread summary**: Updated at each checkpoint write. Combines topic + key_exchanges into a 2-3 sentence narrative. Example: "Working on OAuth token refresh in OpenClaw gateway. Fixed stale auth profile snapshot bug. Now implementing PKCE flow for headless bootstrap."

### 6.3 Semantic Deduplication (from OpenClaw CM)

Applied to decisions and learnings before storage. 3-tier matching:

**Tier 1 — Normalized exact match**:
```typescript
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
// "We should use SQLite!" === "we should use sqlite"
```

**Tier 2 — Keyword Jaccard with stemming**:
```typescript
function keywordJaccard(a: string, b: string): number {
  const wordsA = new Set(extractKeywords(a).map(stem));
  const wordsB = new Set(extractKeywords(b).map(stem));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}
// Threshold: >= 0.5 is a duplicate
// "Use SQLite for storage" ≈ "SQLite should be the storage layer"
```

Stemming: Porter stemmer (same as FTS5 tokenizer for consistency).

Stop words filtered: the, a, an, is, are, was, were, be, been, being, have, has, had, do, does, did, will, would, could, should, may, might, shall, can, to, of, in, for, on, with, at, by, from, it, this, that, these, those, i, we, you, he, she, they.

**Tier 3 — Substring containment**:
```typescript
function isSubstring(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na.includes(nb) || nb.includes(na);
}
// "Use SQLite" is contained in "Use SQLite for the observation store"
```

If any tier matches, the newer entry is a duplicate and is skipped (for decisions) or promotes the existing entry (for learnings — increment promotion_count).

### 6.4 LLM Enrichment (from OpenClaw CM, optional)

Runs during `beforeCompact()` AFTER the mechanical checkpoint is built. Requires API access (CC's CLIProxyAPI at `http://127.0.0.1:8317/v1/messages` or OpenClaw's `completeSimple`).

**Input**: Mechanical checkpoint data (decisions, thread, open_items, learnings captured heuristically).

**Prompt** (~2.7k tokens input, 800 max output):
```
You are reviewing a session checkpoint. Refine the following heuristic data.
For each field, keep what's accurate, fix what's imprecise, remove what's noise.
Do NOT invent — only refine what's given.

Current checkpoint:
- Topic: {topic}
- Task: {task}
- Status: {status}
- Decisions: {decisions as JSON array}
- Open items: {open_items as JSON array}
- Learnings: {learnings as JSON array}
- Thread summary: {summary}
- Key exchanges: {key_exchanges as JSON array}

Return JSON with the same fields. Any field you don't want to change, return as-is.
```

**Safety-net merge** (the key pattern from OpenClaw CM):
```typescript
function mergeEnrichment(heuristic: Checkpoint, enriched: Partial<Checkpoint>): Checkpoint {
  const result = { ...heuristic };

  for (const field of ['decisions', 'open_items', 'learnings']) {
    if (enriched[field]?.length) {
      // Keep all enriched entries
      result[field] = enriched[field];

      // Safety net: find heuristic entries NOT covered by enrichment
      // (lowercase set-diff to catch paraphrasing)
      const enrichedSet = new Set(enriched[field].map(e => normalize(e)));
      const uncovered = heuristic[field].filter(h =>
        !enrichedSet.has(normalize(h)) &&
        !enriched[field].some(e => isSemanticDuplicate(h, e))
      );

      // Append uncovered heuristic entries (LLM missed them)
      result[field].push(...uncovered);
    }
  }

  // String fields: prefer enriched if non-empty
  if (enriched.topic) result.topic = enriched.topic;
  if (enriched.summary) result.summary = enriched.summary;
  if (enriched.task) result.task = enriched.task;

  return result;
}
```

**If API unavailable**: Skip enrichment entirely. The heuristic checkpoint is already high-quality after v2 tuning fixes. Enrichment is an optimization, not a requirement.

### 6.5 Cross-Session Learnings (from OpenClaw CM)

Learnings are operational patterns that recur across sessions. Unlike observations (what happened) or decisions (what was chosen), learnings capture HOW to do things.

**Promotion flow**:
```
Session captures learning heuristically (or via LLM enrichment)
  → fingerprint = normalize(content)
  → SELECT FROM learnings WHERE project=? AND fingerprint=?
  → If exists: UPDATE promotion_count = promotion_count + 1, last_promoted_epoch = now()
  → If not: INSERT new learning (promotion_count = 1)
  → If table count > 50 per (project, agent_id):
      DELETE the row with lowest promotion_count AND oldest last_promoted_epoch
```

**Surfacing**: At session-start and post-compaction, inject top 10 learnings by promotion_count for the current project. These are high-signal patterns that have recurred across multiple sessions.

**Examples of good learnings**:
- "OpenClaw's runtimeAuthStoreSnapshots Map caches auth at startup and NEVER refreshes — always loadAuthProfileStoreForRuntime inside locks"
- "Codex CLI reviews inflate severity — reclassify before acting"
- "Agent team context survives main agent compaction if workers still running — check git status to recover"

---

## 7. Context Assembly Pipeline

### 7.1 Assembly Strategy

**Boundary-only injection**: Full context assembly runs ONLY at:
1. **Session start** (`sessionInit`) — cold start, need full orientation
2. **Post-compaction** (`beforePrompt` with `isPostCompaction=true`) — memory wiped, need restoration

**Regular prompts** (`beforePrompt` with `isPostCompaction=false`):
- Token gauge injection at >= 70% utilization (compact text, ~50 tokens)
- Otherwise: return empty payload (zero injection)

This eliminates 90%+ of per-turn overhead. The LLM retains previous injections in its context window until compaction clears them.

### 7.2 Full Assembly (Session Start / Post-Compaction)

Priority-budgeted cascade with token budget (default 4000 tokens, configurable):

```
Budget: 4000 tokens (configurable in config.json)
Estimation: Math.ceil(text.length / 4)

Priority 1: Identity (USER.md)
  → ~100 tokens, always fits
  → Skip if missing

Priority 2: Project context (primer + active handoff)
  → ~200-500 tokens depending on primer size
  → Skip if global scope

Priority 3: Checkpoint resume data
  → Working state (task, status, next_action)
  → Active decisions (last 10)
  → Thread summary + key exchanges
  → Open items
  → ~300-600 tokens
  → Skip if no checkpoint exists

Priority 4: Cross-session learnings (top 10 by promotion count)
  → ~200-400 tokens
  → From SQLite learnings table

Priority 5: HOT files (pressure >= 0.851)
  → File paths + last action taken
  → ~100-300 tokens
  → From SQLite pressure_scores table

Priority 6: GSD phase state (if .planning/STATE.md exists)
  → Current phase, goal, success criteria, plan must-haves
  → ~200-400 tokens
  → Skip if no GSD active

Priority 7: FTS5 search results (prompt-relevant observations)
  → Keywords extracted from user's prompt (or checkpoint topic for session-start)
  → BM25-ranked with temporal re-rank (70% relevance + 30% recency)
  → Full content or reference mode depending on remaining budget
  → Up to remaining budget

Priority 8: Recent high-quality observations (importance >= 3, last 24h)
  → Only if budget remains after all above
  → Compact references (title + category + timestamp)
```

**Post-redaction reclaim** (from Claudex v2):
After redaction pass, if redacted content is shorter than pre-redaction, re-attempt previously-skipped lower-priority sections with the freed budget.

**Reference mode**: When remaining budget < 500 tokens after priority 5, all subsequent sections switch to compact references (one-line summaries) instead of full content.

### 7.3 Regular Prompt Assembly (Most Turns)

```typescript
async beforePrompt(prompt: string, ctx: PromptContext): Promise<InjectPayload> {
  // 1. Get token utilization
  const gauge = await this.getTokenGauge(ctx);

  // 2. Check if post-compaction
  if (ctx.isPostCompaction) {
    return this.fullAssembly(prompt, ctx, gauge);
  }

  // 3. Background work (no injection)
  await this.captureDecisions(prompt);         // heuristic decision extraction
  await this.updateThread(prompt);             // thread state update
  await this.checkCheckpointThreshold(gauge);  // write checkpoint if threshold hit

  // 4. Gauge injection at >= 70% only
  if (gauge.utilization >= 0.70) {
    return {
      content: `# Token Gauge\nUtilization: ${Math.round(gauge.utilization * 100)}% (${gauge.inputTokens.toLocaleString()} / ${gauge.windowSize.toLocaleString()})`,
      tokenEstimate: 50,
      sources: ['gauge'],
    };
  }

  // 5. Most turns: zero injection
  return { content: '', tokenEstimate: 0, sources: [] };
}
```

### 7.4 Token Gauge

**On CC**: Read transcript JSONL tail for `message.usage.input_tokens` from last assistant message. Auto-detect window size (200k default, 1M if model is claude-opus-4/claude-sonnet-4 AND observed tokens > 195k).

**On OpenClaw**: Use SDK's `ctx.getContextUsage()` which provides exact values from the API response.

**Gauge format** (injected as systemMessage):
```
# Token Gauge
Utilization: 73% (146,000 / 200,000)
```

---

## 8. Checkpoint System

### 8.1 Schema v3

```yaml
schema: claudex/checkpoint
version: 3
meta:
  checkpoint_id: "2026-03-09_cp4"    # Date + sequential counter
  session_id: "abc123..."
  scope: "project:openclaw-main"
  trigger: auto-threshold | compaction | session-end
  token_usage:
    input_tokens: 146000
    output_tokens: 12000
    window_size: 200000
    utilization: 0.73
  previous_checkpoint: "2026-03-09_cp3" | null  # basename only (security)

working:
  task: "Fix OAuth token refresh race condition"
  status: in_progress | blocked | paused
  next_action: "Wire applyMemoryDecay into cron timer"
  branch: "feature/memory-v2" | null

decisions:
  - content: "Use disk read inside lock, not stale snapshot"
    source: confirmation
    timestamp: 1741500000
  - content: "Claudex-Linux gets its own repo, not a branch"
    source: direction
    timestamp: 1741499000

files:
  hot:
    - path: "src/memory/store.ts"
      last_action: "Fixed stale snapshot read in updateAuthProfileStoreWithLock"
    - path: "src/agents/pi-embedded-runner/extensions.ts"
      last_action: "Read bridge initialization logic"
  read:
    - "src/config/types.agents.ts"
    - "src/plugins/loader.ts"

thread:
  topic: "OAuth token persistence and memory v2 cleanup"
  summary: "Fixed critical auth profile store bug where runtimeAuthStoreSnapshots cached at startup and never refreshed. Deployed mem0 agent isolation fix. Remaining: decay cron wiring, unit tests, dedup cleanup."
  key_exchanges:
    - role: user
      gist: "The auth keeps breaking on the laptop"
    - role: agent
      gist: "Found root cause: runtimeAuthStoreSnapshots Map caches at startup, never refreshes from disk"
    - role: user
      gist: "Fix it and make sure refresh tokens persist atomically"
    - role: agent
      gist: "Fixed: always loadAuthProfileStoreForRuntime inside locks, updateRuntimeAuthProfileCredential after refresh"

open_items:
  - "Wire applyMemoryDecay into cron timer service"
  - "Unit tests for contradiction.ts, decay.ts, extracted-memories.ts"
  - "~250-350 LOC deduplication cleanup across memory modules"

learnings:
  - "runtimeAuthStoreSnapshots is the root of all auth bugs — always read from disk inside locks"
  - "Mem0 plugin: always fix source then rebuild bundle, never patch bundle directly"

gsd: null  # or GSD state if active
```

### 8.2 Write Triggers

**Incremental thresholds** (window-size adaptive):
- 200k window: checkpoints at 75%, 90% utilization
- 1M window: checkpoints at 15%, 30%, 45%, 60%, 75%, 90% utilization

**Compaction**: Always write (this is the safety net — no dedup gate).

**Session-end**: Always write (finalization checkpoint).

**Debounce**: 60 seconds minimum between non-compaction checkpoint writes (prevents spam during rapid tool use).

### 8.3 Write Flow

```
Trigger fires (threshold / compaction / session-end)
  → Read current state from DB:
    - decisions: SELECT FROM decisions WHERE session_id=? ORDER BY timestamp DESC LIMIT 15
    - thread: SELECT FROM thread_state WHERE session_id=?
    - open_items: extracted from assistant messages (TODO/FIXME patterns)
    - learnings: session-local learnings from decisions/observations
    - files: HOT from pressure_scores, read from observation file touches
    - gsd: read .planning/STATE.md if exists
  → Build checkpoint YAML (mechanical, no LLM)
  → [If compaction trigger AND API available]: LLM enrichment + safety-net merge
  → atomicWriteFile to {project}/context/checkpoints/{id}.yaml
  → Update latest.yaml reference
  → [If compaction]: promote learnings to cross-session store
  → [If compaction]: reset session-scoped state (decisions, thread for fresh start)
  → Record threshold as hit in checkpoint_tracking
```

### 8.4 Recovery Chain (from Claudex v2)

3-hop maximum, cycle-safe:

```
loadCheckpoint(projectDir):
  1. Read latest.yaml → parse "ref: {filename}" → load that file
  2. If latest.yaml missing/corrupt: dir scan all *.yaml, sort by mtime desc, take first
  3. Follow previous_checkpoint links (basename only, max 3 hops, track seen set for cycles)
  4. Return first successfully parsed checkpoint, or null
```

### 8.5 Selective Loading

| Preset | Fields Loaded | Use Case |
|---|---|---|
| `ALWAYS` | meta, working, thread.topic | Every checkpoint read |
| `RESUME` | + decisions, files, thread.*, open_items, learnings | Session-start, post-compaction |
| `GSD` | + gsd | When .planning/ exists |

---

## 9. Decay Engine (from Claudex v2)

### 9.1 EI (Effective Importance) Formula

```
EI = baseWeight × accessFactor × decayFactor × connectivityBonus
```

**baseWeight**: Importance tier mapped to weight:
- 1 → 0.2, 2 → 0.4, 3 → 0.6, 4 → 0.8, 5 → 1.0

**accessFactor**: `1 + log2(1 + accessCount)` — diminishing returns on repeated access

**decayFactor**: `2^(-age / halfLife)` where halfLife varies by importance tier:
- Importance 1 → 7 days
- Importance 2 → 14 days
- Importance 3 → 60 days
- Importance 4 → 90 days
- Importance 5 → 365 days

Effective half-life extended by access: `effectiveHL = halfLife × (1 + 0.15 × accessCount)`

**connectivityBonus**: `1.0 + 0.1 × min(coOccurrences, 5)` where coOccurrences = count of other observations sharing the same files_modified value. 100ms query timeout guard.

### 9.2 Pruning

Runs at `sessionEnd()`:

1. Count non-deleted observations
2. If count > 1000: compute EI for all non-immune observations
3. Sort by EI ascending
4. Soft-delete (set deleted_at_epoch) lowest 50
5. Immune observations are never pruned:
   - importance >= 5
   - accessCount >= 3 AND lastAccessedAt within 180 days

### 9.3 Pressure Score Decay

Also runs at `sessionEnd()`:

Stratified half-life decay on all pressure_scores:
```sql
UPDATE pressure_scores
SET raw_pressure = raw_pressure * POWER(2, -1.0 / (CASE
  WHEN temperature = 'HOT' THEN 7
  ELSE 3
END)),
temperature = CASE
  WHEN raw_pressure * POWER(2, -1.0 / 7) >= 0.851 THEN 'HOT'
  ELSE 'COLD'
END;
```

Scores below 0.01 are deleted (cleanup).

### 9.4 Retention Policy

Hard delete observations older than `retention_days` (default 90, configurable):
```sql
DELETE FROM observations
WHERE deleted_at_epoch IS NOT NULL
  AND deleted_at_epoch < unixepoch() - (? * 86400);

DELETE FROM observations
WHERE timestamp_epoch < unixepoch() - (? * 86400)
  AND importance < 5;
```

---

## 10. GSD Integration (from Claudex v2)

Read-only integration with the GSD planning system:

**State reading** (`src/gsd/state-reader.ts`):
- `.planning/STATE.md` → current phase number, plan number, status
- `.planning/ROADMAP.md` → all phases with goals, success criteria, dependencies
- `.planning/phases/N/*.md` → plan files with YAML frontmatter (must-haves)
- Checkbox counting: `- [x]` vs `- [ ]` for requirement completion

**Phase boost**: When GSD is active, files mentioned in the current phase's plan get a +0.10 pressure boost, increasing their chance of surfacing as HOT.

**Checkpoint integration**: GSD state stored in checkpoint for post-compaction restoration. Structure:
```yaml
gsd:
  phase: 7
  plan: 1
  status: executing
  goal: "Bidirectional state sync between Claudex and GSD"
  success_criteria:
    - "Claudex metrics written to STATE.md"
    - "Phase transitions detected and tracked"
  completion: "4/6 requirements met"
```

---

## 11. Configuration

### 11.1 Config File (`~/.claudex/config.json`)

```json
{
  "schema": "claudex/config",
  "version": 3,
  "injection": {
    "budget_tokens": 4000,
    "boundary_only": true,
    "gauge_threshold": 0.70
  },
  "observations": {
    "enabled": true,
    "retention_days": 90,
    "prune_threshold": 1000,
    "prune_count": 50
  },
  "checkpoint": {
    "debounce_seconds": 60,
    "enrichment_enabled": false,
    "enrichment_api_url": "http://127.0.0.1:8317/v1/messages"
  },
  "learnings": {
    "max_per_project": 50,
    "surface_count": 10
  },
  "gsd": {
    "enabled": true,
    "phase_boost": 0.10
  },
  "adapter": "auto"
}
```

`adapter` values:
- `"auto"` — detect from environment (bridge exists → OpenClaw, else → CC hooks)
- `"cc-hooks"` — force CC hook adapter
- `"openclaw-bridge"` — force OpenClaw bridge adapter

### 11.2 Migration from Coordination Contract

The `~/.echo/coordination.json` is eliminated. Its fields map to config.json:

| coordination.json field | config.json equivalent | Notes |
|---|---|---|
| `checkpoint_primary` | N/A | Always Claudex (one system) |
| `injection_budget.claudex` | `injection.budget_tokens` | Single budget, no split |
| `injection_budget.context_manager` | N/A | Eliminated |
| `post_compact_restore` | N/A | Always Claudex (one system) |
| `tool_tracking` | `observations.enabled` | Boolean, not ownership |
| `thread_tracking` | Always on | Built-in, no gate needed |
| `learnings` | Always on | Built-in, no gate needed |
| `gauge_display` | `injection.gauge_threshold` | Threshold, not ownership |

---

## 12. File Structure

```
CLAUDEXv3/
  package.json
  tsconfig.json
  build.ts                              # esbuild bundler → dist/*.mjs

  src/
    core/                               # Storage and data access
      storage.ts                        # SQLite connection, WAL, PRAGMAs, close
      migrations.ts                     # Schema migrations (v2→v3 + fresh)
      observations.ts                   # Observation CRUD + FTS5 queries
      learnings.ts                      # Cross-session learnings CRUD
      decisions.ts                      # Decision CRUD
      thread.ts                         # Thread state CRUD
      pressure.ts                       # Pressure score accumulation + query
      sessions.ts                       # Session registration + status
      checkpoint-tracking.ts            # Checkpoint threshold tracking

    extraction/                         # Observation extraction pipeline
      extractor.ts                      # Dispatcher: tool name → per-tool extractor
      extractors/
        read.ts
        edit.ts
        write.ts
        bash.ts
        grep.ts
        glob.ts
        web-fetch.ts
        web-search.ts
        task.ts
        notebook-edit.ts
      redaction.ts                      # Three-layer redaction engine
      quality-gate.ts                   # Per-tool quality gates

    intelligence/                       # Heuristic intelligence (from OpenClaw CM)
      decision-capture.ts               # 4-tier heuristic decision extraction
      thread-tracker.ts                 # Continuous thread snapshot
      semantic-dedup.ts                 # 3-tier deduplication
      enrichment.ts                     # Optional LLM enrichment + safety-net merge
      learnings-promoter.ts             # Session → cross-session learning promotion

    assembly/                           # Context assembly pipeline
      assembler.ts                      # Priority-budgeted assembly orchestrator
      sections.ts                       # Section formatters (identity, project, checkpoint, etc.)
      token-estimator.ts                # Token count estimation

    checkpoint/                         # Checkpoint system
      writer.ts                         # v3 checkpoint writer (atomic writes)
      loader.ts                         # 3-hop recovery chain loader
      types.ts                          # Schema v3 types + trigger types
      inject.ts                         # Checkpoint → injection markdown renderer

    gauge/                              # Token utilization gauge
      token-gauge.ts                    # Transcript-derived (CC) or SDK-derived (OpenClaw)
      window-detector.ts                # Auto-detect 200k vs 1M context window

    decay/                              # Memory decay and pruning
      decay-engine.ts                   # EI formula + pruning logic
      pressure-decay.ts                 # Pressure score half-life decay

    gsd/                                # GSD integration (read-only)
      state-reader.ts                   # .planning/ filesystem reader
      types.ts                          # GSD state types

    shared/                             # Shared utilities
      types.ts                          # Core type system
      paths.ts                          # Runtime path helpers (os.homedir + path.join)
      scope-detector.ts                 # Project scope detection from projects.json
      config.ts                         # Config loading + validation + defaults
      fs-helpers.ts                     # atomicWriteFile, readJsonFile, writeJsonFile
      text-utils.ts                     # truncateText, normalize, stemmer
      constants.ts                      # Schema versions, default values

    index.ts                            # createCore() factory — main entry point

  adapters/
    cc-hooks/                           # Claude Code hook adapter
      infrastructure.ts                 # stdin/stdout JSON protocol, latency budget
      session-start.ts                  # SessionStart → sessionInit
      user-prompt-submit.ts             # UserPromptSubmit → beforePrompt
      post-tool-use.ts                  # PostToolUse → afterTool
      pre-compact.ts                    # PreCompact → beforeCompact
      session-end.ts                    # SessionEnd → sessionEnd

    openclaw-bridge/                    # OpenClaw Pi SDK bridge adapter
      bridge-adapter.ts                 # globalThis registration + callback mapping
      bridge-types.ts                   # Bridge contract types (Symbol key, callbacks)
      plugin-entry.ts                   # OpenClaw plugin activate() function

  cli/
    setup.ts                            # Setup CLI: patches ~/.claude/settings.json

  tests/                                # Test suite (vitest)
    core/
    extraction/
    intelligence/
    assembly/
    checkpoint/
    decay/
    adapters/
    integration/
```

**Module count**: ~45 source files (vs. Claudex v2's ~37 + OpenClaw CM's ~12 = 49 combined). Net reduction through deduplication.

**Dependencies**:
- `better-sqlite3` ^11.7.0 — native SQLite binding (external in esbuild)
- `js-yaml` ^4.1.1 — YAML parsing for checkpoints
- Dev: `vitest`, `esbuild`, `tsx`, `typescript`

**Build output**: `dist/` with 5 hook bundles (session-start.mjs, user-prompt-submit.mjs, post-tool-use.mjs, pre-compact.mjs, session-end.mjs) + setup.mjs + openclaw-plugin.mjs

---

## 13. What's Dropped (and Why)

| Component | Source | Reason |
|---|---|---|
| Hologram sidecar (Python TCP) | Claudex v2 | Returns empty arrays. Cognitive engine never materialized. Pressure scores from DB are sufficient. |
| WARM file tier | Claudex v2 | Low signal. Both systems independently removed it. |
| `~/.echo/` coordination contract | Claudex v2 | One system = nothing to coordinate. |
| CM adapter hooks (3 hooks) | Claudex v2 | No external CM to bridge to. |
| Pre-flush hook | Claudex v2 | Wrapper concept never materialized. |
| Stop decision nudge | Claudex v2 | Replaced by heuristic decision capture (more reliable, runs continuously). |
| Dual transcript snapshots | Claudex v2 | CC manages its own transcripts. One snapshot at session-end if needed. |
| reasoning_chains table | Claudex v2 | Never surfaced well in practice. Observations + decisions cover the same ground. |
| consensus_decisions table | Claudex v2 | Unused feature. |
| audit_log table | Claudex v2 | Hook logs serve the same purpose with less overhead. |
| globalThis bridge utilities (15) | OpenClaw CM | Plugin imports directly from claudex-v3 package. No utility injection needed. |
| WeakMap runtime state | OpenClaw CM | State lives in SQLite. Ephemeral hooks can't use WeakMap anyway. |
| Dual compaction safeguard | OpenClaw CM | One compaction handler in core. OpenClaw's upstream safeguard remains as fallback when plugin is absent. |
| YAML state files (decisions.yaml, thread.yaml, resources.yaml) | OpenClaw CM | Replaced by SQLite tables. Faster, queryable, no file proliferation. |
| Heuristic learnings capture (keyword regex) | OpenClaw CM | Disabled in production due to noise. LLM enrichment handles this better. |
| Background files section in checkpoint | OpenClaw CM | Low signal (0-115 tokens, same noise as WARM). |

---

## 14. Migration Plan

### Phase 0: Repository Setup
1. Create `CLAUDEXv3/` with package.json, tsconfig.json, build.ts
2. Copy shared utilities from Claudex v2: paths.ts, scope-detector.ts, fs-helpers.ts, text-utils.ts
3. Copy and adapt: config.ts (merge coordination fields), types.ts (unified type system)
4. Set up vitest

### Phase 1: Storage Layer
1. Implement storage.ts with WAL mode + PRAGMAs
2. Implement migrations.ts (fresh schema + v2→v3 migration path)
3. Implement all CRUD modules: observations.ts, learnings.ts, decisions.ts, thread.ts, pressure.ts, sessions.ts, checkpoint-tracking.ts
4. Port FTS5 queries from Claudex v2 (including temporal re-ranking)
5. Write tests for all CRUD operations

### Phase 2: Extraction Pipeline
1. Copy extractor.ts and all per-tool extractors from Claudex v2
2. Copy redaction.ts from Claudex v2
3. Implement quality-gate.ts (enhanced gates from Section 5.5)
4. Wire extractors to new observations.ts CRUD
5. Write tests

### Phase 3: Intelligence Layer
1. Port decision-capture.ts from OpenClaw CM's `context-state.ts` (decision extraction portion)
2. Port semantic-dedup.ts from OpenClaw CM's `context-dedup.ts`
3. Implement thread-tracker.ts (combined from both systems' thread tracking)
4. Port enrichment.ts from OpenClaw CM's `context-enrichment.ts`
5. Port learnings-promoter.ts from OpenClaw CM's `context-learnings.ts`
6. Write tests for each module

### Phase 4: Assembly Pipeline
1. Port assembler.ts from Claudex v2's `context-assembler.ts`
2. Rewrite sections.ts for v3 priorities (boundary-only injection)
3. Port token-estimator.ts
4. Implement boundary-only logic (full assembly vs gauge-only vs empty)
5. Write tests

### Phase 5: Checkpoint System
1. Define v3 schema types
2. Port writer.ts from Claudex v2 (adapted for v3 schema, pulling from DB instead of YAML state files)
3. Port loader.ts from Claudex v2 (3-hop recovery, adapted for v3)
4. Implement inject.ts (checkpoint → injection markdown)
5. Write tests

### Phase 6: Supporting Subsystems
1. Port token-gauge.ts from Claudex v2
2. Port decay-engine.ts from Claudex v2
3. Port state-reader.ts from Claudex v2 (GSD integration)
4. Write tests

### Phase 7: CC Hook Adapter
1. Port infrastructure.ts from Claudex v2's `_infrastructure.ts`
2. Implement 5 hook entry points mapping to RuntimeAdapter
3. Implement setup.ts CLI for settings.json patching
4. Build and test with real CC hooks

### Phase 8: OpenClaw Bridge Adapter
1. Implement bridge-adapter.ts (globalThis registration)
2. Implement plugin-entry.ts (OpenClaw plugin activate function)
3. Update OpenClaw's extensions.ts bridge (4 lines of changes)
4. Build and test with real OpenClaw gateway

### Phase 9: Integration Testing
1. End-to-end CC hook flow (session-start → prompts → tool-use → compact → session-end)
2. End-to-end OpenClaw bridge flow (init → context → tool_result → compact)
3. Cross-session learnings persistence
4. Checkpoint write → session restart → checkpoint restore
5. FTS5 search quality (BM25 + temporal re-ranking)
6. Pressure scoring and HOT file surfacing
7. Decay engine pruning behavior

### Phase 10: Deployment
1. Deploy CC hooks on Windows (replace Claudex v2)
2. Deploy OpenClaw plugin (replace openclaw-context extension)
3. Verify both adapters independently
4. Monitor for one week
5. Archive Claudex v2 and openclaw-context plugin

---

## 15. Preserved Patterns

These architectural patterns from the predecessors are preserved in v3:

### 15.1 Defensive Non-Throwing
Every public function catches errors and returns safe defaults. Hooks never crash the host. DB operations return empty arrays/null on failure. This is non-negotiable for a system that runs as lifecycle hooks.

### 15.2 Three-Tier Degradation
Now applied to the assembly pipeline instead of hologram:
1. Full assembly (DB + FTS5 + checkpoint + learnings) — normal path
2. Checkpoint-only assembly (if DB is unavailable) — reads YAML files
3. Identity-only assembly (if everything fails) — reads USER.md flat file

The human is never locked out: every critical state has a flat-file mirror.

### 15.3 Flat-File Mirroring
- Checkpoints: YAML files in `{project}/context/checkpoints/`
- Daily summaries: `~/.claudex/memory/daily/YYYY-MM-DD.md`
- Session logs: `{project}/context/sessions/`
- Handoffs: `{project}/context/handoffs/ACTIVE.md`

SQLite is authoritative, but the flat files ensure a human can always read the state without a database tool.

### 15.4 Boundary-Only Injection
Both predecessors independently converged on this pattern. Context is injected at session boundaries (start, post-compaction), not on every turn. Data capture runs every turn; injection does not.

### 15.5 Atomic Writes with Verification
Checkpoint and config writes use tmp-file + rename pattern. On Windows, includes copy+chmod+unlink fallback for EPERM. Session index uses file-level locking (openSync 'wx').

### 15.6 Scope-Aware Isolation
All operations scoped by project. Observations, decisions, learnings, pressure scores are project-associated. FTS5 queries filter by project. Case-insensitive path comparison on Windows.

### 15.7 Safety-Net Merge (LLM Enrichment)
When LLM refines heuristic data, uncovered heuristic entries are preserved via lowercase set-diff. The LLM can improve but never silently drop data.

---

## 16. Open Questions for Implementation

1. **OpenClaw plugin packaging**: Should the OpenClaw adapter be published as a separate npm package, or bundled as a build target from the same repo? Recommendation: same repo, separate build target (`dist/openclaw-plugin.mjs`).

2. **Enrichment API on CC**: CLIProxyAPI at `http://127.0.0.1:8317/v1/messages` requires CC to be running. During PreCompact, CC IS running (it fired the hook). But the hook process making an HTTP call back to CC while CC is waiting for the hook to complete — is this a deadlock? Need to verify CC's hook timeout behavior. Safe alternative: skip enrichment on CC, only enrich on OpenClaw (where the agent runtime has direct API access).

3. **better-sqlite3 on OpenClaw's jiti loader**: The jiti native module limitation means the OpenClaw plugin can't transitively load better-sqlite3 through jiti. Solution: pre-compile the plugin to .cjs (same workaround as the current mem0 plugin). The build.ts should produce `dist/openclaw-plugin.cjs` with better-sqlite3 marked external.

4. **Concurrent DB access**: CC hooks are ephemeral but could overlap (UserPromptSubmit fires while PostToolUse is still running). WAL mode handles this, but the session-index file lock (JSON file) might contend. Consider moving session tracking entirely to SQLite to eliminate the file lock.

5. **v2 data migration**: When v3 first opens a v2 database, it should run the migration automatically. All existing observations, pressure scores, and sessions should be preserved. The migration drops unused tables but never deletes user data.

---

## 17. Success Criteria

Claudex v3 is successful when:

1. **Feature parity**: Everything that worked in Claudex v2 + OpenClaw CM works in v3
2. **Single codebase**: No separate coordination contract, no dual checkpoints, no dual injection
3. **Both adapters work**: CC hooks on Windows, OpenClaw bridge on gateway, independently verified
4. **Boundary-only injection measurably faster**: Per-prompt overhead drops from ~200-500ms (v2) to near-zero on regular prompts
5. **Cross-session learnings surface**: Top learnings from previous sessions appear in session-start context
6. **Decision capture works**: Confirmed decisions appear in checkpoints without manual logging
7. **Tests pass**: Full test suite covering all core modules, adapters, and integration scenarios
8. **Human readable**: Checkpoints, daily logs, session logs, and handoffs remain human-readable flat files

---

## Appendix A: Comparison Table

| Capability | Claudex v2 | OpenClaw CM | Claudex v3 |
|---|---|---|---|
| Runtime model | Ephemeral hooks | In-process bridge | Both (adapter pattern) |
| Storage | SQLite + flat files | JSON/YAML files | SQLite + flat file mirrors |
| Search | FTS5 (BM25 + temporal) | None | FTS5 (BM25 + temporal) |
| Observation extraction | Yes (10 tool types) | No | Yes (10 tool types, improved gates) |
| Decision capture | Manual (nudge system) | Heuristic (4-tier) | Heuristic (4-tier) |
| Thread tracking | Per-tool gist rolling window | Per-context snapshot | Combined (continuous + snapshot) |
| Semantic dedup | None | 3-tier (normalize, Jaccard, substring) | 3-tier |
| LLM enrichment | None | Yes (completeSimple) | Optional (adapter-dependent) |
| Cross-session learnings | None | Promotion-count JSON | Promotion-count SQLite |
| Checkpoint schema | v2 (11 sections) | v2 (8 sections) | v3 (unified, 9 sections) |
| Checkpoint recovery | 3-hop chain | Single file | 3-hop chain |
| Context injection | Per-prompt (~4000 tokens) | Per-context (variable) | Boundary-only (session-start + post-compact) |
| Token gauge | Transcript-derived | SDK ctx.getContextUsage() | Both (adapter-dependent) |
| Decay engine | EI formula + co-occurrence | None | EI formula + co-occurrence |
| Pressure scoring | Hologram 3-tier → DB fallback | File access with recency decay | DB-only (tool-weighted) |
| GSD integration | Yes (read-only) | No | Yes (read-only) |
| Redaction | Three-layer | None | Three-layer |
| Coordination | ~/.echo/coordination.json | globalThis bridge | None needed (one system) |
| Flat-file human access | Yes | Partial (JSON/YAML) | Yes (YAML checkpoints, MD logs) |

---

## Appendix B: Key Source References

When implementing, refer to these specific files in the predecessors:

| v3 Module | Primary Source | Secondary Source |
|---|---|---|
| `core/storage.ts` | Claudex v2 `src/db/connection.ts` | — |
| `core/observations.ts` | Claudex v2 `src/db/observations.ts` | — |
| `core/learnings.ts` | OpenClaw CM `src/context-learnings.ts` | — |
| `core/decisions.ts` | OpenClaw CM `src/context-state.ts` (decision portion) | — |
| `core/thread.ts` | Claudex v2 `src/hooks/user-prompt-submit.ts` (thread capture) | OpenClaw CM `src/context-manager.ts` (buildKeyExchanges) |
| `core/pressure.ts` | Claudex v2 `src/db/pressure.ts` | — |
| `extraction/*` | Claudex v2 `src/lib/observation-extractor.ts` | — |
| `extraction/redaction.ts` | Claudex v2 `src/lib/redaction.ts` | — |
| `intelligence/decision-capture.ts` | OpenClaw CM `src/context-state.ts` | — |
| `intelligence/semantic-dedup.ts` | OpenClaw CM `src/context-dedup.ts` | — |
| `intelligence/enrichment.ts` | OpenClaw CM `src/context-enrichment.ts` | — |
| `intelligence/learnings-promoter.ts` | OpenClaw CM `src/context-learnings.ts` | — |
| `assembly/assembler.ts` | Claudex v2 `src/lib/context-assembler.ts` | — |
| `checkpoint/writer.ts` | Claudex v2 `src/checkpoint/writer.ts` | OpenClaw CM `src/context-checkpoint.ts` |
| `checkpoint/loader.ts` | Claudex v2 `src/checkpoint/loader.ts` | — |
| `checkpoint/inject.ts` | OpenClaw CM `src/context-checkpoint-inject.ts` | — |
| `gauge/token-gauge.ts` | Claudex v2 `src/lib/token-gauge.ts` | OpenClaw CM `src/context-gauge.ts` |
| `decay/decay-engine.ts` | Claudex v2 `src/lib/decay-engine.ts` | — |
| `gsd/state-reader.ts` | Claudex v2 `src/gsd/state-reader.ts` | — |
| `adapters/cc-hooks/infrastructure.ts` | Claudex v2 `src/hooks/_infrastructure.ts` | — |
| `adapters/openclaw-bridge/bridge-adapter.ts` | OpenClaw CM `index.ts` + `src/bridge-access.ts` | Core `src/agents/pi-extensions/context-manager-bridge.ts` |

---

*End of architecture document. This document is the authoritative reference for Claudex v3 implementation.*
