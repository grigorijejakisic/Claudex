# Claudex v3 — Unified Context Management System

**Date**: 2026-03-10
**Revision**: v1.2.1 (standalone-first, observability, embedding-enhanced intelligence, Ollama enrichment, checkpoint state-machine DDL)
**Status**: Architecture Design (implementation-ready)
**Author**: Claude Opus 4.6 + Grigorije
**Reviewer**: Codex GPT-5 (CODEX_REVIEW.md v1.0 B-, CODEX_REVIEW_V12.md v1.2 B+, v1.2.1 cleanup applied)
**Predecessors**: Claudex v2 (hook-based), OpenClaw Context Manager (bridge-based)

---

## 1. Vision

Claudex v3 is a single context management system that replaces both Claudex v2 and OpenClaw's Context Manager plugin. It combines Claudex v2's storage layer (SQLite + FTS5 + observation extraction + priority-budgeted assembly) with the Context Manager's intelligence layer (decision heuristics + LLM enrichment + cross-session learnings + semantic dedup), running behind a unified core with swappable runtime adapters for Claude Code hooks and OpenClaw's Pi SDK bridge.

### 1.1 Why Merge

Both systems evolved independently to solve the same problem: giving an LLM persistent memory and context awareness across sessions and compaction events. They overlap on checkpoints, file tracking, thread tracking, compaction handling, and context injection. Running both requires a coordination contract (`~/.echo/coordination.json`) that adds complexity to manage fundamentally duplicated work. Merging eliminates the coordination problem entirely.

### 1.2 Design Principles

1. **Standalone-first** — v3 works as a fresh install with zero prior state. No predecessor required. `claudex setup` creates everything from scratch. Migration from v2 is an optional one-time path for existing users.
2. **One system, two deployment targets** — same core, different adapters for CC hooks vs OpenClaw bridge
3. **Capability-aware adapters** — core receives host-neutral events; adapters declare their capabilities; intelligence modules check capabilities before using host-specific features
4. **Boundary-only injection with embedding-enhanced topic detection** — full assembly at session-start and post-compaction; embedding similarity detects mid-session topic shifts; small pivot blocks injected on shifts; most turns get zero injection
5. **SQLite is the state bus** — ephemeral hook processes share state through the database, not files; multi-step writes wrapped in explicit transactions
6. **Mutual exclusion at deployment** — you deploy the CC adapter OR the OpenClaw adapter, never both simultaneously
7. **Enrichment everywhere** — LLM enrichment runs on OpenClaw (in-process API access) AND on CC (via local Ollama, no deadlock). Quality parity across both adapters.
8. **Observability by design** — every subsystem emits structured telemetry. Injection audit trail, hook latency, dedup rates, checkpoint lifecycle — all queryable from SQLite.
9. **Model-agnostic intelligence** — decision capture and topic detection work across Claude, MiniMax, GLM, DeepSeek, and other model families. No patterns hardcoded to one model's voice.
10. **Defensive non-throwing** — every public function catches errors and returns safe defaults; hooks never crash the host
11. **Flat-file mirroring** — human is never locked out; every critical state has a readable file mirror
12. **One codebase, all platforms** — platform differences handled by `process.platform` checks in 2-3 locations, not separate codebases

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

### 3.1 Capability-Aware Event Model

> **v1.1 change**: Replaced host-leaking optional fields with explicit capability declaration.
> Adapters declare what they can provide; core intelligence modules check capabilities before
> using host-specific features. This keeps the core host-neutral while preserving full access
> to each host's strengths.

```typescript
// ============================================================
// Runtime Capabilities — declared once per adapter at init
// ============================================================
interface RuntimeCapabilities {
  hasFullMessageHistory: boolean;   // Can provide conversation messages (OpenClaw: yes, CC: no)
  hasNativeContextUsage: boolean;   // Can provide exact token counts from SDK (OpenClaw: yes, CC: no)
  hasTranscriptAccess: boolean;     // Can read transcript JSONL for gauge (CC: yes, OpenClaw: no)
  supportsSystemInjection: boolean; // Can inject system messages mid-turn (both: yes)
  supportsAsyncEnrichment: boolean; // Can call LLM API without deadlock (OpenClaw: yes, CC: yes via Ollama)
  hasLocalEmbeddings: boolean;      // Can compute embeddings locally (both: yes if Ollama + nomic available)
  supportsTurnEndEvent: boolean;    // Fires afterTurn at end of agent turn (OpenClaw: yes, CC: yes via Stop)
}

// CC Hook Adapter declares:
const CC_CAPABILITIES: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: true,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,   // v1.2: via local Ollama (localhost:11434), NOT CC's CLIProxyAPI
  hasLocalEmbeddings: true,        // v1.2: via Ollama nomic-embed-text (auto-detected at init)
  supportsTurnEndEvent: true,      // via Stop hook mapped to after_turn
};

// OpenClaw Bridge Adapter declares:
const OPENCLAW_CAPABILITIES: RuntimeCapabilities = {
  hasFullMessageHistory: true,
  hasNativeContextUsage: true,
  hasTranscriptAccess: false,
  supportsSystemInjection: true,
  supportsAsyncEnrichment: true,   // via in-process completeSimple OR local Ollama
  hasLocalEmbeddings: true,        // v1.2: via Ollama nomic-embed-text (auto-detected at init)
  supportsTurnEndEvent: true,
};

// ============================================================
// Runtime Events — host-neutral event envelope
// ============================================================
interface RuntimeEvent {
  kind: 'session_init' | 'before_prompt' | 'after_tool' | 'after_turn' | 'before_compact' | 'session_end';
  sessionId: string;
  cwd: string;
  timestamp: number;        // Unix epoch ms
  payload: EventPayload;    // Discriminated by kind
}

type EventPayload =
  | SessionInitPayload
  | BeforePromptPayload
  | AfterToolPayload
  | AfterTurnPayload
  | BeforeCompactPayload
  | SessionEndPayload;

interface SessionInitPayload {
  kind: 'session_init';
  source: 'startup' | 'resume' | 'clear' | 'bridge_init';
}

interface BeforePromptPayload {
  kind: 'before_prompt';
  prompt: string;
  isPostCompaction: boolean;
  // Provided by adapters that have the capability:
  tokenUsage?: TokenUsage;        // From hasNativeContextUsage OR hasTranscriptAccess
  messageHistory?: Message[];     // From hasFullMessageHistory (OpenClaw only)
}

interface AfterToolPayload {
  kind: 'after_tool';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
}

interface AfterTurnPayload {
  kind: 'after_turn';
  // Only fired by adapters with supportsTurnEndEvent
  // Used for thread tracking, decision capture from full turn
  lastAssistantText?: string;
  lastUserText?: string;
}

interface BeforeCompactPayload {
  kind: 'before_compact';
  trigger: 'auto' | 'manual';
  // Provided by adapters with hasFullMessageHistory:
  messagesToSummarize?: Message[];
  turnPrefixMessages?: Message[];
}

interface SessionEndPayload {
  kind: 'session_end';
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'bridge_end';
}

// Shared types
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
  utilization: number;  // 0.0 - 1.0
}

interface InjectPayload {
  content: string;       // Markdown to inject into context
  tokenEstimate: number; // Approximate token count
  sources: string[];     // Which data sources contributed
}

// ============================================================
// Core Engine — processes events, checks capabilities
// ============================================================
interface ClaudexCore {
  readonly capabilities: RuntimeCapabilities;

  // Process any runtime event — single dispatch point
  handleEvent(event: RuntimeEvent): Promise<InjectPayload | void>;

  // Lifecycle
  close(): void;
}

// Usage in core:
// if (this.capabilities.hasFullMessageHistory) {
//   // Use messageHistory for richer decision extraction
// } else {
//   // Fall back to heuristic extraction from prompt text only
// }
//
// if (this.capabilities.supportsAsyncEnrichment) {
//   // Run LLM enrichment during compaction
// } else {
//   // Skip — heuristic checkpoint is canonical
// }
```

**How capability checks work in practice:**

| Intelligence Feature | Required Capability | Fallback Without It |
|---|---|---|
| Rich decision extraction from full conversation | `hasFullMessageHistory` | Model-agnostic heuristics on prompt text only (v1.2: works across model families) |
| Exact token gauge | `hasNativeContextUsage` | Transcript JSONL parsing via `hasTranscriptAccess` |
| LLM checkpoint enrichment | `supportsAsyncEnrichment` | Heuristic-only checkpoint (v1.2: both adapters support enrichment — CC via Ollama, OpenClaw via native API or Ollama) |
| Embedding-based topic detection | `hasLocalEmbeddings` | Keyword Jaccard fallback (functional but less accurate) |
| Embedding-based decision classification | `hasLocalEmbeddings` | Regex-only heuristics (functional, model-agnostic patterns) |
| Turn-end thread tracking | `supportsTurnEndEvent` | Thread updated in `after_tool` cycle (slightly delayed, still accurate) |
| Full-context thread snapshot | `hasFullMessageHistory` | Rolling gist window from prompt + tool actions |

### 3.2 CC Hook Adapter

Maps Claude Code's lifecycle hooks to RuntimeEvents. Declares `CC_CAPABILITIES` at init.

| CC Hook Event | RuntimeEvent kind | Injection? | Notes |
|---|---|---|---|
| `SessionStart` | `session_init` | Yes (`additionalContext`) | Full assembly on cold start |
| `UserPromptSubmit` | `before_prompt` | Conditional (`systemMessage`) | Full assembly only if post-compaction or topic shift; gauge at >=70%; otherwise empty |
| `PostToolUse` | `after_tool` | No | Observation extraction, pressure accumulation, checkpoint threshold check |
| `Stop` | `after_turn` | No | Thread tracking, decision capture from turn summary. **v1.1: restored** (was dropped in v1.0, needed for turn-end signals on CC where bridge `message_end` isn't available) |
| `PreCompact` | `before_compact` | No | Checkpoint write, learning promotion |
| `SessionEnd` | `session_end` | No | Finalization, decay, cleanup |

**Dropped CC hooks** (compared to Claudex v2):
- `PreFlush` — wrapper concept never materialized

**Note on `Stop` hook (v1.1)**: Restored because CC has no `message_end` equivalent. The `Stop` hook fires at the end of each agent turn, providing the `after_turn` event needed for thread tracking and decision capture. Without it, CC's `supportsTurnEndEvent` would be false and thread quality would regress. With the Stop hook mapped, CC gets `supportsTurnEndEvent: true` in its capabilities.

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

**End-to-end latency budget per user turn** (CC adapter):

| Hook | Fires when | Target | What it does |
|---|---|---|---|
| `UserPromptSubmit` | Every turn | **< 100ms** (most turns), **< 500ms** (injection turns) | Topic-shift check + gauge, or full assembly if boundary/shift |
| `PostToolUse` | Each tool call | **< 100ms** per call | Observation extraction + pressure update + thread update |
| `Stop` | Turn end | **< 150ms** | Decision capture + thread snapshot + checkpoint threshold check |

**Aggregate SLA**: Total Claudex overhead per user turn must stay under **600ms** in the common case (no injection, 3-5 tool calls). Injection turns (session-start, post-compaction, topic-shift) are allowed up to **1000ms** since they carry 4000 tokens of context value. Compaction turns (PreCompact) are allowed up to **3000ms** due to checkpoint write + optional Ollama enrichment — this is acceptable because compaction itself takes 5-15 seconds.

**Monitoring**: Telemetry table tracks `latency_ms` per hook invocation. Aggregate SLA is verifiable via:
```sql
SELECT session_id,
  SUM(latency_ms) as turn_total_ms,
  COUNT(*) as hook_count
FROM telemetry
WHERE event_kind = 'hook_invocation' AND session_id = ?
GROUP BY json_extract(detail, '$.turn_id')
HAVING turn_total_ms > 600;
```

**Implementation file**: `src/adapters/cc-hooks/index.ts`

```typescript
// Pseudocode for CC hook adapter
import { readStdin, writeStdout } from './infrastructure';
import { createCore, CC_CAPABILITIES } from '../../core';

const hookToEventKind: Record<string, RuntimeEvent['kind']> = {
  SessionStart: 'session_init',
  UserPromptSubmit: 'before_prompt',
  PostToolUse: 'after_tool',
  Stop: 'after_turn',
  PreCompact: 'before_compact',
  SessionEnd: 'session_end',
};

async function main() {
  const input = await readStdin();
  const eventKind = hookToEventKind[input.hook_event_name];
  if (!eventKind) { writeStdout({}); return; }

  const core = createCore(CC_CAPABILITIES); // opens DB, loads config, sets capabilities

  try {
    const event: RuntimeEvent = {
      kind: eventKind,
      sessionId: input.session_id,
      cwd: input.cwd,
      timestamp: Date.now(),
      payload: buildPayload(eventKind, input), // maps CC stdin fields to event payload
    };

    const result = await core.handleEvent(event);
    writeStdout(mapResultToOutput(input.hook_event_name, result));
  } catch (e) {
    writeStdout({}); // never crash — defensive non-throwing
  } finally {
    core.close(); // close DB connection
  }
}
```

### 3.3 OpenClaw Bridge Adapter

Maps Pi SDK extension events to RuntimeEvents. Declares `OPENCLAW_CAPABILITIES` at init.

| Pi SDK Event | RuntimeEvent kind | Injection? | Notes |
|---|---|---|---|
| Bridge `onInit` | `session_init` | Yes (enqueueSystemEvent) | Full assembly for session restore |
| `context` event | `before_prompt` | Conditional | Full assembly if post-compaction; provides `messageHistory` + `tokenUsage` |
| `tool_result` event | `after_tool` | No | Tool output available directly from SDK |
| `message_end` event | `after_turn` | No | Thread tracking, decision capture from full turn |
| `session_before_compact` | `before_compact` | No | Checkpoint + enrichment (supportsAsyncEnrichment=true) |

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
import { createCore, OPENCLAW_CAPABILITIES } from 'claudex-v3/core';

const BRIDGE_KEY = Symbol.for('claudex.v3.bridge');

export function activate(api: OpenClawPluginApi) {
  const core = createCore(OPENCLAW_CAPABILITIES); // persistent mode, DB stays open

  (globalThis as any)[BRIDGE_KEY] = {
    onInit(ctx) {
      return core.handleEvent({
        kind: 'session_init', sessionId: ctx.sessionKey, cwd: ctx.cwd,
        timestamp: Date.now(), payload: { kind: 'session_init', source: 'bridge_init' },
      });
    },
    onContext(ctx) {
      return core.handleEvent({
        kind: 'before_prompt', sessionId: ctx.sessionKey, cwd: ctx.cwd,
        timestamp: Date.now(), payload: {
          kind: 'before_prompt',
          prompt: extractPrompt(ctx),
          isPostCompaction: ctx.isPostCompaction ?? false,
          tokenUsage: mapTokenUsage(ctx.getContextUsage()),
          messageHistory: ctx.messages,  // full history — hasFullMessageHistory
        },
      });
    },
    onToolResult(ctx) {
      return core.handleEvent({
        kind: 'after_tool', sessionId: ctx.sessionKey, cwd: ctx.cwd,
        timestamp: Date.now(), payload: {
          kind: 'after_tool', toolName: ctx.toolName,
          toolInput: ctx.toolInput, toolOutput: ctx.toolOutput,
        },
      });
    },
    onTurnEnd(ctx) {
      return core.handleEvent({
        kind: 'after_turn', sessionId: ctx.sessionKey, cwd: ctx.cwd,
        timestamp: Date.now(), payload: {
          kind: 'after_turn',
          lastAssistantText: ctx.lastAssistantText,
          lastUserText: ctx.lastUserText,
        },
      });
    },
    onCompact(ctx, prep, runtime) {
      return core.handleEvent({
        kind: 'before_compact', sessionId: ctx.sessionKey, cwd: ctx.cwd,
        timestamp: Date.now(), payload: {
          kind: 'before_compact', trigger: 'auto',
          messagesToSummarize: prep.messagesToSummarize,
          turnPrefixMessages: prep.turnPrefixMessages,
        },
      });
    },
  };

  api.registerHook('session_end', () =>
    core.handleEvent({
      kind: 'session_end', sessionId: 'current', cwd: process.cwd(),
      timestamp: Date.now(), payload: { kind: 'session_end', reason: 'bridge_end' },
    })
  );
}
```

**Key differences from v2 bridge**:
- Only 1 Symbol key, 6 callbacks (added `onTurnEnd`), 0 injected utilities
- Plugin imports from claudex-v3 package directly — no utility injection, explicit and type-safe
- Adapter declares `OPENCLAW_CAPABILITIES` at init; core checks capabilities before using host features
- `onCompact` passes `messagesToSummarize` + `turnPrefixMessages` because `hasFullMessageHistory` is true
- LLM enrichment runs during compaction because `supportsAsyncEnrichment` is true

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

#### Transaction Policy (v1.1)

Multi-step writes are wrapped in explicit transactions to guarantee all-or-nothing state transitions:

```typescript
// afterTool: observation + pressure + thread + checkpoint_tracking in one transaction
db.transaction(() => {
  insertObservation(obs);
  updatePressureScore(filePath, toolWeight);
  updateThreadState(sessionId, agentGist);
  updateCheckpointTracking(sessionId, observationCount);
})();

// beforeCompact: checkpoint + learnings + state reset in one transaction
db.transaction(() => {
  writeCheckpointMeta(checkpointId, sessionId);
  promoteLearnings(sessionLearnings);
  resetSessionDecisions(sessionId);
  resetThreadState(sessionId);
  markPostCompactPending(sessionId);
})();
```

This prevents partial state (e.g., observation stored but pressure not updated) on process crash or timeout.

### 4.2 Schema

```sql
-- ============================================================
-- TABLE: observations
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
  files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)),  -- JSON array of paths
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
-- TABLE: learnings
-- Purpose: Cross-session operational learnings with promotion
-- ============================================================
-- v1.1 fix: NULL doesn't participate in SQLite UNIQUE constraints.
-- Use COALESCE sentinel '__global__' to make global learnings deduplicate correctly.
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL DEFAULT '__global__', -- '__global__' for non-project-scoped
  agent_id TEXT NOT NULL DEFAULT 'default',   -- for multi-agent scoping
  fingerprint TEXT NOT NULL,                  -- normalized text for dedup
  content TEXT NOT NULL,                      -- the learning itself
  promotion_count INTEGER NOT NULL DEFAULT 1,
  first_seen_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_promoted_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, agent_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_learnings_promo
  ON learnings(project, agent_id, promotion_count DESC);

-- ============================================================
-- TABLE: decisions
-- Purpose: Heuristically captured decisions within a session
-- ============================================================
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '__global__',
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'confirmation', 'direction', 'rejection', 'explicit'
  )),
  fingerprint TEXT NOT NULL,          -- for semantic dedup
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, fingerprint)     -- no dupes within a session
);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON decisions(session_id, timestamp_epoch DESC);

-- ============================================================
-- TABLE: thread_state
-- Purpose: Rolling conversation thread for checkpoint building
-- ============================================================
CREATE TABLE IF NOT EXISTS thread_state (
  session_id TEXT PRIMARY KEY,
  topic TEXT,                          -- current work topic
  summary TEXT,                        -- rolling summary
  key_exchanges TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(key_exchanges)), -- JSON array of {role, gist}
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- TABLE: checkpoint_tracking
-- Purpose: Track checkpoint state per session
-- ============================================================
CREATE TABLE IF NOT EXISTS checkpoint_tracking (
  session_id TEXT PRIMARY KEY,
  last_checkpoint_epoch INTEGER,
  thresholds_hit TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(thresholds_hit)),        -- JSON array of hit threshold values
  observation_count INTEGER NOT NULL DEFAULT 0,
  post_compact_pending INTEGER NOT NULL DEFAULT 0,  -- boolean flag
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- TABLE: schema_versions (migration tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- TABLE: checkpoint_meta (v1.2 — DB-first checkpoint lifecycle)
-- Purpose: Per-checkpoint state machine for write/recovery
-- ============================================================
CREATE TABLE IF NOT EXISTS checkpoint_meta (
  checkpoint_id TEXT PRIMARY KEY,         -- ULID (monotonic, sortable)
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'compaction', 'session_end')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'committed', 'mirrored')),
  data TEXT,                              -- checkpoint JSON (populated at 'committed')
  mirror_path TEXT,                       -- file path (populated at 'mirrored')
  error TEXT,                             -- error message if write failed
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_cpmeta_session
  ON checkpoint_meta(session_id, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_cpmeta_status
  ON checkpoint_meta(status, updated_at_epoch);
```

### 4.3 Database Initialization (v1.2 — standalone-first)

> **v1.2 change**: v3 is standalone-first. Fresh `claudex setup` creates the full schema from scratch — no predecessor required. Migration from Claudex v2 is an optional one-time path for existing users who want to preserve their observation history.

#### 4.3.1 Fresh Install (Primary Path)

```typescript
function initializeDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 10000');
  db.pragma('foreign_keys = ON');

  // Create all tables from Section 4.2 schema
  db.exec(SCHEMA_V3);

  // Create telemetry table from Section 10c
  db.exec(TELEMETRY_SCHEMA);

  // Record schema version
  db.exec(`INSERT OR IGNORE INTO schema_versions (version) VALUES (300)`);

  return db;
}
```

`claudex setup` detects no existing database → creates `~/.claudex/db/claudex.db` with the full v3 schema. No questions asked, no prior state required. The user is immediately operational.

#### 4.3.2 Migration from Claudex v2 (Optional)

If `claudex setup` detects an existing v2 database (`~/.claudex/claudex.db` or `~/.claudex/db/claudex.db` with schema version < 300), it offers migration:

```
Existing Claudex v2 database detected.
  Observations: 1,247 | Pressure scores: 83 | Sessions: 41
  Migrate v2 data into v3? [y/N]
```

If the user declines, v3 creates a fresh database alongside (the v2 database is untouched). If the user accepts:

```sql
-- Migration 100: v2 → v3 schema additions
-- Pre-condition: backup of claudex.db already created by setup CLI

-- 1. Add new tables (CREATE IF NOT EXISTS — safe to re-run)
-- learnings, decisions, thread_state, checkpoint_tracking, telemetry

-- 2. Archive unused v2 tables (rename, don't drop — rollback safety)
ALTER TABLE reasoning_chains RENAME TO _archived_reasoning_chains;
ALTER TABLE reasoning_fts RENAME TO _archived_reasoning_fts;
ALTER TABLE consensus_decisions RENAME TO _archived_consensus_decisions;
ALTER TABLE consensus_fts RENAME TO _archived_consensus_fts;
ALTER TABLE audit_log RENAME TO _archived_audit_log;
-- Archived tables can be dropped after 30 days of stable v3 operation

-- 3. Simplify pressure_scores (remove WARM tier)
UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature = 'WARM';

-- 4. Migrate checkpoint_state → checkpoint_tracking
INSERT INTO checkpoint_tracking (session_id, last_checkpoint_epoch, observation_count)
  SELECT session_id, last_epoch, 0 FROM checkpoint_state
  WHERE NOT EXISTS (
    SELECT 1 FROM checkpoint_tracking
    WHERE checkpoint_tracking.session_id = checkpoint_state.session_id
  );
ALTER TABLE checkpoint_state RENAME TO _archived_checkpoint_state;

-- 5. Migrate files_modified from comma-separated to JSON array
UPDATE observations
  SET files_modified = '["' || REPLACE(files_modified, ',', '","') || '"]'
  WHERE files_modified != '' AND files_modified NOT LIKE '[%';
UPDATE observations SET files_modified = '[]' WHERE files_modified = '';

-- 6. Record migration
INSERT INTO schema_versions (version) VALUES (300);
```

**Rollback**: Swap back to v2 hooks in `~/.claude/settings.json`. v2 ignores `_archived_*` tables and new v3 tables. The only irreversible change is `files_modified` format — v2 would need a one-line change to parse JSON instead of comma-split. The setup CLI creates a backup before migrating.

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
    YYYY-MM-DD_{ulid}.yaml               # Checkpoint files (schema v3, ULID-based)
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

### 6.1 Decision Capture (model-agnostic, v1.2)

> **v1.2 change**: Decision heuristics redesigned to work across model families (Claude, MiniMax,
> GLM, DeepSeek, Qwen, etc.). Previous patterns were tuned for Claude's voice ("we should",
> "let's", "I'll") which other models may not use. v1.2 uses structural patterns that work
> regardless of phrasing, plus optional embedding classification when `hasLocalEmbeddings` is true.

**Trigger**: Primary capture runs during `after_turn` (full turn text available — best signal). Supplemental capture runs during `after_tool` for high-confidence Tier 1 (user confirmations) and Tier 4 (explicit markers) only, since these don't need full-turn context. `before_prompt` does NOT capture decisions — it consumes them for assembly.

**Two-stage extraction**:

#### Stage 1: Structural heuristics (always active, model-agnostic)

**Tier 1 — Explicit confirmation** (highest confidence):
- Pattern: User message matches `^(yes|yeah|yep|ok|go|approved|confirmed|do it|proceed|looks good|lgtm|ship it|agreed|correct|exactly|perfect|that works)`
- Captures: The preceding assistant proposal as a confirmed decision
- Source tag: `confirmation`
- Model-agnostic: user confirmations are human-generated, not model-dependent

**Tier 2 — Direction-setting** (high confidence):
- Structural patterns (work across all models):
  - Sentence starts with a verb in future/imperative: `^(use|implement|create|add|remove|replace|switch|migrate|keep|drop|split|merge|deploy|configure|set|enable|disable)\b`
  - Contains comparison resolution: `instead of`, `rather than`, `over`, `not .* but`
  - Contains commitment language: `will .* (use|implement|do|create|go with)`, `going to`, `the (plan|approach|strategy|design) is`
  - Contains recommendation: `(should|recommend|suggest|propose|best to|better to|prefer)`
- Quality gate: Must be >= 20 chars, not inside a code fence, not a filler phrase
- Source tag: `direction`

**Tier 3 — Rejection** (medium confidence):
- Pattern: User message contains `no,`, `don't`, `actually,`, `instead`, `not that`, `wrong`, `stop`, `revert`, `undo`, `that's not`, `scratch that`
- Captures: What was rejected + what was chosen instead (if stated)
- Source tag: `rejection`
- Model-agnostic: rejections are human-generated

**Tier 4 — Explicit decision markers** (highest confidence):
- Pattern: Message contains `DECISION:`, `decided:`, `we agreed`, `final answer`, `conclusion:`, `verdict:`, `going with:`, `chosen approach:`
- Source tag: `explicit`
- Model-agnostic: explicit markers are conventions, not model-specific

**Filler rejection** (expanded for multi-model compatibility):
Drops candidates matching: reading/checking actions ("let me read", "looking at", "checking", "I see", "examining"), navigation actions ("opening", "searching", "running"), greetings, acknowledgments, and any candidate under 15 chars.

**Code fence skip**: Any decision candidate entirely within a code fence is dropped.

#### Stage 2: Embedding classification (when `hasLocalEmbeddings` is true)

When local embeddings are available (Ollama + nomic-embed-text), Stage 1 candidates are validated:

```typescript
async classifyDecision(candidate: string, context: string): Promise<number> {
  // Embed the candidate
  const candidateEmb = await this.embed(candidate);

  // Compare against decision templates (precomputed at init)
  const templates = [
    "We decided to use X instead of Y",
    "The approach is to implement X",
    "Confirmed: we will proceed with X",
    "Rejected Y in favor of X",
    "Architecture decision: X for the storage layer",
  ];

  const similarities = templates.map(t => cosineSimilarity(candidateEmb, this.templateEmbeddings[t]));
  const maxSim = Math.max(...similarities);

  // Also compare against non-decision templates (negative examples)
  const antiTemplates = [
    "Let me read the file",
    "I'll check that for you",
    "Looking at the code now",
    "Running the tests",
  ];
  const antiSims = antiTemplates.map(t => cosineSimilarity(candidateEmb, this.templateEmbeddings[t]));
  const maxAntiSim = Math.max(...antiSims);

  // Return confidence: positive similarity minus negative similarity
  return maxSim - maxAntiSim;
}

// Usage: only store if confidence > 0.15 (tunable)
const confidence = await this.classifyDecision(candidate, context);
if (confidence > 0.15) {
  await this.storeDecision(candidate, source, confidence);
}
```

**Why two stages**: Stage 1 (regex) is fast and free — runs on every turn. Stage 2 (embeddings) costs ~5ms per candidate via local Ollama. Stage 1 generates candidates; Stage 2 filters false positives. When embeddings aren't available, Stage 1 alone is still functional.

**Semantic dedup before storage**: See Section 6.3.

### 6.2 Thread Tracking

Continuous thread state maintained in the `thread_state` table. Thread tracking builds the "what's happening" narrative used by checkpoints and topic-shift detection.

#### Trigger Points

| Event | What happens | Data source |
|---|---|---|
| `after_tool` | Accumulate user prompt + tool action into pending exchange buffer | `AfterToolPayload.toolName`, `AfterToolPayload.toolInput` |
| `after_turn` | Flush buffer: extract gists, append to key_exchanges, update topic if shifted, update summary | `AfterTurnPayload.lastAssistantText`, `AfterTurnPayload.lastUserText` |
| Checkpoint write | Snapshot current thread state into checkpoint YAML | `thread_state` table |

The split matters: `after_tool` fires multiple times per turn (once per tool call), accumulating raw data. `after_turn` fires once at turn end with full text available, which is when gists are extracted and the thread is updated. This avoids partial-turn updates that would produce incoherent summaries.

#### Topic Tracking

Extracted from the first substantive user message each session (skip greetings, short confirmations). Updated when topic-shift detection fires (Section 7.3.1). Topic is a short phrase (5-15 words) summarizing the current work focus.

**Extraction method**: When `hasLocalEmbeddings` is true, topic is inferred by finding the most salient noun phrase in the prompt. When embeddings are unavailable, falls back to first sentence extraction with stop-word removal.

#### Key Exchanges

Rolling window of 8 most recent user→agent exchange pairs:
```json
[
  {"role": "user", "gist": "Fix the auth token refresh bug"},
  {"role": "agent", "gist": "Found stale snapshot in runtimeAuthStoreSnapshots, fixed to read from disk inside lock"},
  {"role": "user", "gist": "Also need to handle the OAuth PKCE flow"},
  {"role": "agent", "gist": "Implemented PKCE parameters matching pi-ai: auth.openai.com/oauth/authorize, redirect localhost:1455"}
]
```

**When gists vs full text**: Gists are always used in `key_exchanges` (120 char max). Full text is never stored in thread state — it would bloat the checkpoint. The gist is the thread's representation; the full text lives in the host's conversation history (accessible via `hasFullMessageHistory` on OpenClaw, or in CC's transcript JSONL).

#### Gist Extraction Rules

| Source | Method | Example |
|---|---|---|
| User message (< 120 chars) | Use as-is | "Fix the auth token refresh bug" |
| User message (> 120 chars) | Sentence-boundary truncation, keep first complete sentence | "I need you to fix the auth..." → "I need you to fix the auth token refresh bug." |
| Agent message (has prose) | First sentence extraction, max 120 chars | "Found root cause: runtimeAuthStoreSnapshots Map caches at startup..." |
| Agent message (tool-calls only) | Tool name list | "[called Read, Edit, Write on src/auth.ts]" |
| Agent message (mixed) | First prose sentence, ignore tool calls | "Fixed the stale snapshot bug." (tools omitted) |

#### Thread Summary

Updated at each checkpoint write (not every turn — too expensive for a narrative). Combines topic + key_exchanges into a 2-3 sentence narrative.

**Construction**: Mechanical concatenation, not LLM-generated. Format: `"{topic}. {last 2-3 agent gists joined}. {open items if any}."`

Example: "Working on OAuth token refresh in OpenClaw gateway. Fixed stale auth profile snapshot bug. Now implementing PKCE flow for headless bootstrap."

If enrichment is available, the LLM may refine this summary during checkpoint enrichment (Section 6.4). The mechanical version is the baseline; the enriched version is best-effort improvement.

### 6.3 Semantic Deduplication

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

### 6.4 LLM Enrichment (v1.2 — both adapters)

Runs during `beforeCompact()` AFTER the mechanical checkpoint is built. Uses local Ollama (CC adapter) or native API / Ollama (OpenClaw adapter). See "Enrichment everywhere" below for provider selection.

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

**Safety-net merge**:
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

**Enrichment everywhere (v1.2)**:

> **v1.2 change**: CC enrichment is no longer disabled. The deadlock was caused by calling CC's
> own CLIProxyAPI (`http://127.0.0.1:8317`) from inside a hook CC is waiting on. The fix: use
> local Ollama (`http://localhost:11434`) instead — it's a completely separate process, zero
> deadlock risk. Both adapters now have `supportsAsyncEnrichment: true`.

- **OpenClaw adapter**: Enrichment via `completeSimple` (in-process API) or Ollama (fallback). Runs during compaction.
- **CC hook adapter**: Enrichment via **local Ollama** (`localhost:11434/v1/chat/completions`). The hook calls Ollama, not CC. No deadlock. Runs during PreCompact hook.
- **Ollama model selection**: When `ollama_model` is `"auto"`, selects the smallest available local model (enrichment is structured data refinement, not code generation — even `glm-4.7-flash:q4_K_M` is sufficient). Users can override via `enrichment.ollama_model` in config to target a specific model.
- **Provider preference on OpenClaw**: When both native API and Ollama are available, OpenClaw prefers native API (higher quality, already in-process) and uses Ollama only as offline/fallback. Configurable via `enrichment.provider`: `"auto"` (native > Ollama), `"ollama"` (force local), `"native"` (force API).
- **Fallback**: If Ollama is not running or no model is loaded, enrichment silently skips. Heuristic checkpoint is still valid. Enrichment is best-effort enhancement, never a hard dependency.

```typescript
// Enrichment provider selection (in core init)
async function detectEnrichmentProvider(): Promise<EnrichmentProvider | null> {
  // 1. Try Ollama (works for both CC and OpenClaw)
  try {
    const resp = await fetch('http://localhost:11434/api/tags');
    const { models } = await resp.json();
    if (models.length > 0) {
      // Prefer smallest loaded model — enrichment doesn't need quality
      const model = models.sort((a, b) => a.size - b.size)[0];
      return { type: 'ollama', model: model.name, baseUrl: 'http://localhost:11434' };
    }
  } catch { /* Ollama not running — continue */ }

  // 2. Try OpenClaw's completeSimple (only available in bridge adapter)
  if (this.capabilities.hasFullMessageHistory) {
    return { type: 'openclaw-native' };
  }

  // 3. No enrichment available — heuristic checkpoint is canonical
  return null;
}
```

- Core checks `this.capabilities.supportsAsyncEnrichment` AND `enrichmentProvider !== null`. Both must be true.
- Quality parity: CC and OpenClaw users get the same enriched checkpoints. No more second-class CC experience.

### 6.5 Cross-Session Learnings

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

**Post-redaction reclaim**:
After redaction pass, if redacted content is shorter than pre-redaction, re-attempt previously-skipped lower-priority sections with the freed budget.

**Reference mode**: When remaining budget < 500 tokens after priority 5, all subsequent sections switch to compact references (one-line summaries) instead of full content.

### 7.3 Regular Prompt Assembly (Most Turns)

```typescript
async handleBeforePrompt(event: RuntimeEvent): Promise<InjectPayload> {
  const payload = event.payload as BeforePromptPayload;

  // 1. Get token utilization (capability-aware)
  const gauge = await this.getTokenGauge(event, payload);

  // 2. Check if post-compaction → full assembly
  if (payload.isPostCompaction) {
    return this.fullAssembly(payload.prompt, event, gauge);
  }

  // 3. Background work (no injection, inside transaction)
  this.db.transaction(() => {
    this.captureDecisions(payload.prompt, payload.messageHistory);
    this.updateThread(payload.prompt);
    this.checkCheckpointThreshold(event.sessionId, gauge);
  })();

  // 4. Topic-shift detection → micro-injection (v1.1)
  const topicShift = await this.detectTopicShift(payload.prompt, event.sessionId);
  if (topicShift.shifted) {
    // Small "context pivot" block — NOT full 4k assembly
    // Injects: new topic acknowledgment + relevant learnings + hot files for new topic
    const pivot = await this.buildTopicPivot(topicShift.newTopic, event);
    // Budget: max 800 tokens for pivot block
    if (pivot.tokenEstimate <= 800) {
      return pivot;
    }
  }

  // 5. Gauge injection at >= 70% only
  if (gauge.utilization >= 0.70) {
    return {
      content: `# Token Gauge\nUtilization: ${Math.round(gauge.utilization * 100)}% (${gauge.inputTokens.toLocaleString()} / ${gauge.windowSize.toLocaleString()})`,
      tokenEstimate: 50,
      sources: ['gauge'],
    };
  }

  // 6. Most turns: zero injection
  return { content: '', tokenEstimate: 0, sources: [] };
}
```

### 7.3.1 Topic-Shift Detection (v1.2 — embedding-enhanced)

> **v1.2 change**: Topic-shift detection upgraded from keyword Jaccard (crude, high false-positive
> rate) to embedding cosine similarity when `hasLocalEmbeddings` is true. Embeddings capture
> semantic similarity — "fix the auth bug" and "OAuth token refresh" register as the same topic
> even though they share zero keywords. Jaccard remains as fallback when embeddings are unavailable.

Detects when the user pivots to a different task mid-session:

```typescript
async detectTopicShift(prompt: string, sessionId: string): Promise<TopicShiftResult> {
  const thread = await this.db.getThreadState(sessionId);
  if (!thread?.topic) return { shifted: false };

  // 1. Explicit pivot signals (always checked first — cheapest, highest precision)
  const explicitPivot = /^(now let's|next[,:]|switch to|moving on|let's work on|different topic|new task|back to|forget that|actually[,:]? (?:let's|can we|I need))/i.test(prompt.trim());
  if (explicitPivot) {
    const newTopic = await this.inferTopic(prompt);
    return { shifted: true, newTopic, previousTopic: thread.topic, confidence: 1.0, method: 'explicit' };
  }

  // 2. Embedding similarity (preferred — semantic understanding)
  if (this.capabilities.hasLocalEmbeddings && this.embeddingProvider) {
    const topicEmb = await this.embedWithCache(thread.topic);    // cached per session
    const promptEmb = await this.embed(prompt);                   // ~5ms via Ollama
    const similarity = cosineSimilarity(topicEmb, promptEmb);

    // Sliding window: also compare against last 3 user prompts (smooths noise)
    const recentSimilarities = await this.getRecentPromptSimilarities(promptEmb, sessionId, 3);
    const avgRecent = recentSimilarities.length > 0
      ? recentSimilarities.reduce((a, b) => a + b, 0) / recentSimilarities.length
      : similarity;

    // Topic shift if both current topic AND recent conversation are dissimilar
    if (similarity < 0.35 && avgRecent < 0.40) {
      const newTopic = await this.inferTopic(prompt);
      return { shifted: true, newTopic, previousTopic: thread.topic, confidence: 1.0 - similarity, method: 'embedding' };
    }

    return { shifted: false };
  }

  // 3. Keyword Jaccard fallback (when no embeddings available)
  const currentKeywords = extractKeywords(thread.topic);
  const promptKeywords = extractKeywords(prompt);
  const overlap = keywordJaccard(currentKeywords, promptKeywords);

  if (overlap < 0.15) {
    const newTopic = await this.inferTopic(prompt);
    return { shifted: true, newTopic, previousTopic: thread.topic, confidence: 1.0 - overlap, method: 'jaccard' };
  }

  return { shifted: false };
}
```

**Why embedding similarity > keyword Jaccard:**

| Scenario | Jaccard | Embedding |
|---|---|---|
| "Fix the auth bug" vs "OAuth token refresh" | 0.0 (no shared keywords) → **false positive shift** | 0.72 (semantically similar) → **correctly: no shift** |
| "Deploy to production" vs "Write unit tests for auth" | 0.0 → **correct shift** | 0.18 → **correct shift** |
| "Implement the parser" vs "Now implement the parser tests" | 0.67 → **correctly: no shift** | 0.81 → **correctly: no shift** |
| "Debug memory leak" vs "What's for lunch?" | 0.0 → **correct shift** | 0.05 → **correct shift** |

**Embedding cache**: Topic embedding is computed once per topic change and cached in memory. Prompt embeddings cost ~5ms each via local Ollama (nomic-embed-text). No external API calls.

**Sliding window**: Comparing against the last 3 user prompts prevents single-message noise (e.g., user asks a quick tangential question then continues the main topic). Shift only triggers when the conversation has actually moved.

**Topic pivot injection content** (max 800 tokens):
1. Topic transition marker: "Switching context: {oldTopic} → {newTopic}"
2. Top 3 learnings relevant to new topic (by FTS5 match against learnings table)
3. HOT files relevant to new topic (by FTS5 match against observation file paths)
4. Last checkpoint's relevant decisions (if any match new topic)

This is NOT a full assembly — it's a lightweight context pivot that costs ~200-400 tokens on average.

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
  checkpoint_id: "2026-03-09_01JQXYZ..."  # Date prefix + ULID (generated in code, not dir scan)
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

### 8.3 Write Flow (v1.2 — ULID + DB-first state machine)

> **v1.2 change**: Checkpoint IDs are now ULIDs generated in code, not sequential counters from
> directory scan. This eliminates race conditions under concurrent writers. The checkpoint lifecycle
> follows a DB-first state machine: `pending → committed → mirrored`. The file is written AFTER
> the DB records the checkpoint, ensuring recovery is always possible even if the file write fails.

```
Trigger fires (threshold / compaction / session-end)
  → Generate ULID for checkpoint_id (monotonic, sortable, no directory scan)
  → INSERT into checkpoint_meta: status='pending', checkpoint_id, session_id, trigger
  → Read current state from DB (inside transaction):
    - decisions: SELECT FROM decisions WHERE session_id=? ORDER BY timestamp DESC LIMIT 15
    - thread: SELECT FROM thread_state WHERE session_id=?
    - open_items: extracted from assistant messages (TODO/FIXME patterns)
    - learnings: session-local learnings from decisions/observations
    - files: HOT from pressure_scores, read from observation file touches
    - gsd: read .planning/STATE.md if exists
  → Build checkpoint YAML (mechanical, no LLM)
  → UPDATE checkpoint_meta: status='committed', data=checkpoint_json
  → [If enrichment available]: LLM enrichment (Ollama or native API) + safety-net merge
  → [If enrichment succeeded]: UPDATE checkpoint_meta: data=enriched_json
  → atomicWriteFile to {project}/context/checkpoints/{date}_{ulid}.yaml
  → Update latest.yaml reference
  → UPDATE checkpoint_meta: status='mirrored'
  → [If compaction]: promote learnings to cross-session store
  → [If compaction]: reset session-scoped state (decisions, thread for fresh start)
  → Record threshold as hit in checkpoint_tracking
  → Emit telemetry: checkpoint_write event (see Section 10c)
```

**State machine guarantees:**
- `pending` → write started but not complete. On crash recovery: discard.
- `committed` → data is in SQLite. File may not exist yet. On recovery: re-mirror from DB.
- `mirrored` → file exists, DB and file are consistent. Normal state.

**ULID benefits:**
- Monotonically sortable (replaces mtime-based dir scan)
- No collision under concurrent writers (128-bit, 48-bit timestamp + 80-bit random)
- Human-readable file names: `2026-03-09_01JQXYZ4K9BPGF.yaml`
- Tiny dependency: `ulid` package is 1.2KB, zero dependencies

### 8.4 Recovery Chain

Two-layer recovery: DB-first, file fallback.

```
loadCheckpoint(projectDir):
  1. DB recovery (v1.2): query checkpoint_meta for latest 'committed' or 'mirrored' row
     - If 'committed' but not 'mirrored': re-mirror from data column → atomicWriteFile → update to 'mirrored'
     - If 'mirrored': read from mirror_path (fast path)
     - If 'pending': discard (incomplete write)
  2. File fallback (if DB unavailable or empty):
     a. Read latest.yaml → parse "ref: {filename}" → load that file
     b. If latest.yaml missing/corrupt: dir scan all *.yaml, sort by mtime desc, take first
     c. Follow previous_checkpoint links (basename only, max 3 hops, track seen set for cycles)
  3. Return first successfully parsed checkpoint, or null
```

DB recovery runs at `sessionInit()` — any `committed` rows left from a crash are re-mirrored before the session starts. File fallback exists for the case where the DB itself is corrupted or unavailable (three-tier degradation principle).

### 8.5 Selective Loading

| Preset | Fields Loaded | Use Case |
|---|---|---|
| `ALWAYS` | meta, working, thread.topic | Every checkpoint read |
| `RESUME` | + decisions, files, thread.*, open_items, learnings | Session-start, post-compaction |
| `GSD` | + gsd | When .planning/ exists |

---

## 9. Decay Engine

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

## 10. GSD Integration

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

## 10b. Claude Code Native Auto-Memory Interaction (v1.1)

> **v1.1 addition**: Explicit policy for how Claudex v3 interacts with CC's built-in
> auto-memory (`~/.claude/projects/.../memory/MEMORY.md`).

### Policy: Claudex v3 is authoritative operational memory; CC auto-memory is model-managed

| Aspect | Policy |
|---|---|
| **Reading MEMORY.md** | v3 MAY read MEMORY.md as a context source during full assembly (Priority 2, project context). It treats MEMORY.md content as user-curated instructions, not as a competing memory store. |
| **Writing MEMORY.md** | v3 NEVER writes to MEMORY.md directly. The model manages its own auto-memory. v3 injects context via hook `systemMessage`/`additionalContext` only. |
| **Publishing learnings** | Optionally, v3 can surface top cross-session learnings in a `systemMessage` that suggests the model save them to MEMORY.md. The model decides whether to act on this. v3 never forces writes. |
| **Conflict resolution** | If MEMORY.md contains information that contradicts v3's stored observations/learnings, v3 defers to MEMORY.md (user-curated > auto-captured). v3's observations are supplementary context, not corrections. |
| **Future-proofing** | When CC adds stronger native context management (richer hooks, built-in checkpoints, native memory API), v3 should degrade gracefully: disable redundant subsystems via feature flags, retain only genuinely novel capabilities (observation extraction, FTS5 search, cross-session learnings, decision capture). |

### Feature Flags for Graceful Degradation

```json
{
  "features": {
    "observation_capture": true,    // Disable if CC adds native observation tracking
    "checkpoint_system": true,      // Disable if CC adds native checkpoints
    "token_gauge": true,            // Disable if CC exposes utilization API
    "fts5_search": true,            // Disable if CC adds native memory search
    "decision_capture": true,       // Probably never redundant — CC-unique
    "learnings_promotion": true     // Probably never redundant — CC-unique
  }
}
```

This ensures v3 degrades into "high-signal memory compiler + checkpoint mirror + analytics" rather than breaking when CC evolves.

---

## 10c. Observability Subsystem (v1.2)

> **v1.2 addition**: Every subsystem emits structured telemetry to a dedicated SQLite table.
> This replaces ad-hoc logging with queryable, auditable data that answers "what did Claudex do
> on this turn and why?"

### Telemetry Table

```sql
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation',      -- adapter received a host event
    'injection',            -- context was injected (or skipped)
    'observation_capture',  -- observation extracted and stored (or filtered)
    'decision_capture',     -- decision candidate detected (stored or rejected)
    'checkpoint_write',     -- checkpoint lifecycle event
    'enrichment',           -- LLM enrichment attempted
    'topic_shift',          -- topic shift detected (or not)
    'dedup',                -- semantic dedup match (or miss)
    'decay_prune',          -- observation pruned by decay engine
    'error'                 -- any caught error
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),  -- event-specific JSON payload
  latency_ms REAL,                    -- wall-clock time for this operation
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch DESC);
```

### Event Detail Schemas

```typescript
// hook_invocation: every adapter event
{ hook: 'UserPromptSubmit', duration_ms: 142, result: 'inject' | 'skip' | 'error' }

// injection: what was injected and why
{ trigger: 'session_start' | 'post_compaction' | 'topic_shift' | 'gauge',
  sections_included: ['identity', 'checkpoint', 'learnings', 'fts5'],
  sections_skipped: ['gsd'],        // and why
  total_tokens: 3200,
  budget_remaining: 800 }

// observation_capture: observation stored or filtered
{ tool: 'Edit', category: 'code', importance: 3, stored: true }
{ tool: 'Read', filtered_reason: 'below_quality_gate', stored: false }

// decision_capture: decision detected
{ content: "Use ULID for checkpoint IDs", source: 'direction',
  stage1_match: true, stage2_confidence: 0.72, stored: true }
{ content: "Let me read the file", stage1_match: true,
  stage2_confidence: -0.3, stored: false, reason: 'filler_rejected' }

// checkpoint_write: lifecycle tracking
{ checkpoint_id: '01JQXYZ...', trigger: 'compaction',
  state: 'pending' | 'committed' | 'mirrored',
  enrichment_attempted: true, enrichment_succeeded: true,
  enrichment_provider: 'ollama:glm-4.7-flash:q4_K_M',
  write_duration_ms: 85 }

// topic_shift: detection result
{ method: 'embedding' | 'jaccard' | 'explicit', similarity: 0.12,
  shifted: true, old_topic: 'auth bug', new_topic: 'deploy pipeline',
  pivot_tokens: 340 }

// dedup: semantic dedup outcome
{ type: 'decision' | 'learning', tier: 'exact' | 'jaccard' | 'substring',
  similarity: 0.85, action: 'skip' | 'promote' }

// error: caught errors (never thrown, always logged)
{ subsystem: 'enrichment', error: 'Ollama connection refused', fallback: 'heuristic_only' }
```

### Querying Telemetry

```sql
-- Why was this injected on the last prompt?
SELECT detail FROM telemetry
WHERE session_id = ? AND event_kind = 'injection'
ORDER BY timestamp_epoch DESC LIMIT 1;

-- Hook latency stats for this session (avg, max, count)
SELECT
  json_extract(detail, '$.hook') as hook,
  COUNT(*) as count,
  ROUND(AVG(latency_ms), 1) as avg_ms,
  ROUND(MAX(latency_ms), 1) as max_ms
FROM telemetry
WHERE session_id = ? AND event_kind = 'hook_invocation'
GROUP BY json_extract(detail, '$.hook');

-- Decision capture precision (how many candidates were stored vs rejected?)
SELECT
  json_extract(detail, '$.stored') as stored,
  COUNT(*) as count
FROM telemetry
WHERE event_kind = 'decision_capture' AND session_id = ?
GROUP BY stored;

-- Checkpoint lifecycle (any stuck in non-mirrored state?)
SELECT
  json_extract(detail, '$.checkpoint_id') as checkpoint_id,
  json_extract(detail, '$.state') as state,
  timestamp_epoch
FROM telemetry
WHERE event_kind = 'checkpoint_write'
  AND json_extract(detail, '$.state') != 'mirrored'
ORDER BY timestamp_epoch DESC;
```

### Retention

Telemetry rows are pruned at `sessionEnd()` AND at `sessionInit()` (catches growth from crashes where `sessionEnd` never fired):
- Keep last 7 days of telemetry
- Keep last 1000 error events regardless of age
- Telemetry table is excluded from flat-file mirroring (it's diagnostic, not user-facing)

### Implementation

Every subsystem calls `this.telemetry.emit(kind, detail, latency)` at its natural completion point. The `emit` method is non-throwing and non-blocking (INSERT is fast in WAL mode). This is ~1 line of code per call site, not a framework.

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
    "gauge_threshold": 0.70,
    "topic_shift_budget": 800
  },
  "observations": {
    "enabled": true,
    "retention_days": 90,
    "prune_threshold": 1000,
    "prune_count": 50
  },
  "checkpoint": {
    "debounce_seconds": 60
  },
  "learnings": {
    "max_per_project": 50,
    "surface_count": 10,
    "publish_to_memory_md": false
  },
  "enrichment": {
    "enabled": true,
    "provider": "auto",
    "ollama_base_url": "http://localhost:11434",
    "ollama_model": "auto",
    "timeout_ms": 10000
  },
  "embeddings": {
    "enabled": true,
    "provider": "ollama",
    "model": "nomic-embed-text",
    "ollama_base_url": "http://localhost:11434",
    "topic_shift_threshold": 0.35,
    "topic_shift_window": 3,
    "decision_confidence_threshold": 0.15
  },
  "observability": {
    "enabled": true,
    "retention_days": 7,
    "retain_error_count": 1000
  },
  "gsd": {
    "enabled": true,
    "phase_boost": 0.10
  },
  "features": {
    "observation_capture": true,
    "checkpoint_system": true,
    "token_gauge": true,
    "fts5_search": true,
    "decision_capture": true,
    "learnings_promotion": true,
    "telemetry": true
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
      migrations.ts                     # Schema creation (fresh install) + optional v2 migration
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

    intelligence/                       # Heuristic intelligence
      decision-capture.ts               # Model-agnostic 2-stage decision extraction (v1.2)
      thread-tracker.ts                 # Continuous thread snapshot
      semantic-dedup.ts                 # 3-tier deduplication
      enrichment.ts                     # LLM enrichment via Ollama or native API (v1.2)
      learnings-promoter.ts             # Session → cross-session learning promotion
      topic-shift.ts                    # Embedding-enhanced topic detection (v1.2)

    embeddings/                         # Local embedding support (v1.2)
      embedding-provider.ts             # Ollama nomic-embed-text client
      cosine.ts                         # Cosine similarity + sliding window
      templates.ts                      # Decision/non-decision classification templates

    observability/                      # Structured telemetry (v1.2)
      telemetry.ts                      # Emit + query + prune interface
      types.ts                          # Event detail type definitions

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
      stop.ts                           # Stop → afterTurn
      pre-compact.ts                    # PreCompact → beforeCompact
      session-end.ts                    # SessionEnd → sessionEnd

    openclaw-bridge/                    # OpenClaw Pi SDK bridge adapter
      bridge-adapter.ts                 # globalThis registration + callback mapping
      bridge-types.ts                   # Bridge contract types (Symbol key, callbacks)
      plugin-entry.ts                   # OpenClaw plugin activate() function

  cli/
    setup.ts                            # Setup CLI: creates DB, patches settings.json, optional v2 migration

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

**Module count**: ~52 source files (vs. Claudex v2's ~37 + OpenClaw CM's ~12 = 49 combined). Slight increase from v1.2 additions (embeddings, observability, topic-shift), but no duplication — each module is a distinct concern.

**Dependencies**:
- `better-sqlite3` ^11.7.0 — native SQLite binding (external in esbuild)
- `js-yaml` ^4.1.1 — YAML parsing for checkpoints
- Dev: `vitest`, `esbuild`, `tsx`, `typescript`

**Build output**: `dist/` with 6 hook bundles (session-start.mjs, user-prompt-submit.mjs, post-tool-use.mjs, stop.mjs, pre-compact.mjs, session-end.mjs) + setup.mjs + openclaw-plugin.mjs

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

## 14. Implementation Plan (v1.2 — standalone-first)

> **v1.2 change**: Rewritten from "migration plan" to "implementation plan." v3 is built as a standalone system. Predecessor code is referenced for design patterns and logic, not copied wholesale. The optional v2 migration path is a single task in Phase 1, not the plan's organizing principle.

### Phase 0: Repository Setup
1. Create `CLAUDEXv3/` with package.json, tsconfig.json, build.ts
2. Implement shared utilities: paths.ts, scope-detector.ts, fs-helpers.ts, text-utils.ts, constants.ts (reference Claudex v2 for proven patterns)
3. Implement config.ts (v3 config schema with enrichment, embeddings, observability settings)
4. Implement types.ts (unified type system: RuntimeEvent, RuntimeCapabilities, InjectPayload, etc.)
5. Set up vitest + TypeScript strict mode

### Phase 1: Storage Layer
1. Implement storage.ts — WAL mode, PRAGMAs, connection lifecycle
2. Implement migrations.ts — fresh v3 schema creation (primary path) + optional v2→v3 migration (Section 4.3)
3. Implement all CRUD modules: observations.ts, learnings.ts, decisions.ts, thread.ts, pressure.ts, sessions.ts, checkpoint-tracking.ts
4. Implement FTS5 queries (BM25 + temporal re-ranking)
5. Implement telemetry.ts (observability subsystem from Section 10c)
6. Write tests for all CRUD operations + fresh install + v2 migration

### Phase 2: Extraction Pipeline
1. Implement extractor.ts dispatcher and all per-tool extractors (reference Claudex v2's proven extraction logic)
2. Implement redaction.ts (three-layer engine)
3. Implement quality-gate.ts (enhanced gates from Section 5.5)
4. Wire extractors to observations.ts CRUD + telemetry
5. Write tests

### Phase 3: Intelligence Layer — Core
1. Implement decision-capture.ts — model-agnostic 2-stage extraction (Section 6.1: regex patterns + embedding classification)
2. Implement semantic-dedup.ts — 3-tier dedup (reference OpenClaw CM's `context-dedup.ts`)
3. Implement thread-tracker.ts — combined rolling gist + snapshot (reference both systems)
4. Implement learnings-promoter.ts — session → cross-session promotion with dedup (reference OpenClaw CM)
5. Write tests for each module

### Phase 4: Intelligence Layer — v1.2 Additions
1. Implement embedding-provider.ts — Ollama nomic-embed-text client with graceful fallback
2. Implement cosine.ts — cosine similarity + sliding window comparisons
3. Implement templates.ts — decision/non-decision classification template embeddings
4. Implement topic-shift.ts — embedding-enhanced detection with Jaccard fallback (Section 7.3.1)
5. Implement enrichment.ts — auto-detect Ollama, CC-safe enrichment, safety-net merge (Section 6.4)
6. Write tests (with and without Ollama available)

### Phase 5: Assembly Pipeline
1. Implement assembler.ts — priority-budgeted section assembly
2. Implement sections.ts — v3 section priorities (boundary-only injection)
3. Implement token-estimator.ts
4. Implement boundary-only logic (full assembly vs topic-shift micro-injection vs gauge-only vs empty)
5. Write tests

### Phase 6: Checkpoint System
1. Define v3 schema types (ULID-based IDs)
2. Implement writer.ts — DB-first state machine: pending → committed → mirrored (Section 8.3)
3. Implement loader.ts — 3-hop recovery chain
4. Implement inject.ts — checkpoint → injection markdown renderer
5. Write tests

### Phase 7: Supporting Subsystems
1. Implement token-gauge.ts — transcript-derived (CC) or SDK-derived (OpenClaw), capability-aware
2. Implement decay-engine.ts — EI formula + co-occurrence + pruning
3. Implement state-reader.ts — GSD .planning/ filesystem reader
4. Write tests

### Phase 8: CC Hook Adapter
1. Implement infrastructure.ts — stdin/stdout JSON protocol, latency budget
2. Implement 6 hook entry points (session-start, user-prompt-submit, post-tool-use, stop, pre-compact, session-end) mapping to RuntimeAdapter
3. Implement setup.ts CLI — `claudex setup` creates DB, patches `~/.claude/settings.json`, optional v2 migration
4. Build and test with real CC hooks

### Phase 9: OpenClaw Bridge Adapter
1. Implement bridge-adapter.ts — globalThis registration + callback mapping
2. Implement plugin-entry.ts — OpenClaw plugin `activate()` function
3. Update OpenClaw's `extensions.ts` bridge (minimal changes)
4. Build and test with real OpenClaw gateway

### Phase 10: Integration Testing
1. End-to-end CC hook flow (session-start → prompts → tool-use → compact → session-end)
2. End-to-end OpenClaw bridge flow (init → context → tool_result → compact)
3. Fresh install flow (`claudex setup` on clean machine → fully operational)
4. Cross-session learnings persistence across sessions
5. Checkpoint write → session restart → checkpoint restore (3-hop recovery)
6. Topic-shift detection (embedding + fallback) producing correct micro-injections
7. Enrichment via Ollama on CC adapter (no deadlock, correct fallback)
8. FTS5 search quality (BM25 + temporal re-ranking)
9. Observability queries (telemetry table populated, queryable)
10. Pressure scoring and HOT file surfacing
11. Decay engine pruning behavior

### Phase 11: Deployment
1. Deploy CC hooks on Windows (`claudex setup` — fresh install)
2. Deploy OpenClaw plugin (plugin install — fresh install)
3. Verify both adapters independently on fresh installs
4. Optionally run v2 migration for existing Claudex users
5. Monitor for one week
6. Archive Claudex v2 and openclaw-context plugin

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

### Resolved in v1.1

1. ~~**Enrichment API on CC**~~: **RESOLVED v1.1** — Initially disabled on CC. **RESOLVED v1.2** — CC enrichment enabled via local Ollama (Section 6.4). No CLIProxyAPI call = no deadlock.

2. ~~**Concurrent DB access**~~: **RESOLVED** — Multi-step writes wrapped in explicit transactions (Section 4.1). Session tracking moved to SQLite `sessions` table. File-based `index.json` kept as flat-file mirror only (written after DB commit, not used for coordination).

3. ~~**CC native auto-memory interaction**~~: **RESOLVED** — Explicit policy in Section 10b. v3 reads but never writes MEMORY.md. Feature flags for graceful degradation.

### Resolved in v1.2

4. ~~**v2 data migration**~~: **RESOLVED** — v3 is standalone-first. Fresh install creates full schema from scratch. v2 migration is optional, user-prompted, with backup. See Section 4.3.

5. ~~**Topic-shift false positives**~~: **RESOLVED** — Embedding cosine similarity via nomic-embed-text replaces keyword-only Jaccard. Sliding window smoothing prevents single-message noise. Jaccard retained as fallback. See Section 7.3.1.

6. ~~**Checkpoint ID races**~~: **RESOLVED** — ULID replaces directory-scan sequential counter. Monotonic, collision-free under concurrent writers. DB-first state machine guarantees recovery. See Section 8.3.

7. ~~**Decision capture model dependency**~~: **RESOLVED** — Two-stage extraction with structural regex patterns (model-agnostic) + embedding classification. Works across Claude, MiniMax, GLM, DeepSeek. See Section 6.1.

### Still Open

8. **OpenClaw plugin packaging**: Same repo, separate build target (`dist/openclaw-plugin.cjs`). Pre-compile with esbuild, better-sqlite3 marked external. Same workaround as current mem0 plugin. **Decision: confirmed, implement as described.**

9. **better-sqlite3 on OpenClaw's jiti loader**: Pre-compile to `.cjs` with `createRequire()` for native module resolution. Proven pattern (mem0 plugin uses it). **Decision: confirmed.**

10. **Session index contention**: If multiple CC instances start simultaneously, the file-locked `index.json` append could contend. v3 mitigates by making SQLite the primary session store and `index.json` a best-effort mirror. If the mirror write fails, the session is still registered in SQLite.

11. **Ollama availability on CI**: Embedding and enrichment tests need Ollama. Options: mock the HTTP client in unit tests, run Ollama in CI for integration tests, or accept that embedding/enrichment integration tests are manual-only. **Leaning: mock in unit tests, manual integration.**

---

## 17. Success Criteria

Claudex v3 is successful when:

1. **Fresh install works**: `claudex setup` on a clean machine creates a fully operational system — no predecessor required
2. **Feature parity**: Everything that worked in Claudex v2 + OpenClaw CM works in v3
3. **Single codebase**: No coordination contract, no dual checkpoints, no dual injection. One repo, both platforms.
4. **Both adapters work**: CC hooks on Windows/Linux, OpenClaw bridge on gateway, independently verified
5. **Boundary-only injection measurably faster**: Per-prompt overhead drops from ~200-500ms (v2) to near-zero on regular prompts
6. **Topic-shift detection works**: Mid-session topic changes produce correct context pivots (< 800 tokens), embedding-enhanced when Ollama available, Jaccard fallback otherwise
7. **Enrichment on both adapters**: CC enriches via Ollama, OpenClaw enriches via native API or Ollama — quality parity, no deadlocks
8. **Cross-session learnings surface**: Top learnings from previous sessions appear in session-start context
9. **Decision capture is model-agnostic**: Confirmed decisions captured across Claude, MiniMax, GLM, DeepSeek without model-specific patterns
10. **Capability-aware adapters**: Core intelligence degrades gracefully based on declared capabilities, not host-specific branching
11. **Observability is queryable**: Telemetry table answers "what did Claudex do on this turn?" with structured data
12. **Transactions guarantee consistency**: No partial state from interrupted multi-step writes
13. **Tests pass**: Full test suite covering all core modules, adapters, and integration scenarios
14. **Human readable**: Checkpoints, daily logs, session logs, and handoffs remain human-readable flat files
15. **Optional v2 migration works**: Existing Claudex users can migrate data, or start fresh — their choice

---

## Appendix A: Comparison Table

| Capability | Claudex v2 | OpenClaw CM | Claudex v3 (v1.2) |
|---|---|---|---|
| Install model | Requires v1 history | Requires OpenClaw | **Standalone-first** — `claudex setup` on clean machine, optional v2 migration |
| Runtime model | Ephemeral hooks | In-process bridge | Both (capability-aware adapter pattern) |
| Adapter contract | Host-specific hook handlers | globalThis bridge + 15 injected utils | Host-neutral RuntimeEvent + RuntimeCapabilities |
| Storage | SQLite + flat files | JSON/YAML files | SQLite + flat file mirrors + explicit transactions |
| Search | FTS5 (BM25 + temporal) | None | FTS5 (BM25 + temporal) |
| Observation extraction | Yes (10 tool types) | No | Yes (10 tool types, improved quality gates) |
| Decision capture | Manual (nudge system) | Heuristic (4-tier, Claude-tuned) | **Model-agnostic 2-stage** (regex + embedding classification) |
| Thread tracking | Per-tool gist rolling window | Per-context snapshot | Combined (continuous + snapshot + afterTurn) |
| Semantic dedup | None | 3-tier (normalize, Jaccard, substring) | 3-tier |
| LLM enrichment | None | Yes (completeSimple) | **Both adapters** — CC via Ollama, OpenClaw via native API or Ollama |
| Cross-session learnings | None | Promotion-count JSON | Promotion-count SQLite |
| Checkpoint IDs | Sequential (directory scan) | Single file | **ULID** (monotonic, collision-free) |
| Checkpoint lifecycle | Write-and-hope | Write-and-hope | **DB-first state machine** (pending → committed → mirrored) |
| Checkpoint recovery | 3-hop chain | Single file | 3-hop chain |
| Context injection | Per-prompt (~4000 tokens) | Per-context (variable) | Boundary-only + topic-shift micro-injection |
| Topic-shift detection | None | None | **Embedding cosine similarity** + Jaccard fallback |
| Local embeddings | None | None | **Ollama nomic-embed-text** (topic detection + decision classification) |
| Token gauge | Transcript-derived | SDK ctx.getContextUsage() | Capability-aware (transcript OR SDK) |
| Observability | Ad-hoc logging | None | **Structured telemetry** (SQLite, queryable, retention-managed) |
| Decay engine | EI formula + co-occurrence | None | EI formula + co-occurrence |
| Pressure scoring | Hologram 3-tier → DB fallback | File access with recency decay | DB-only (tool-weighted, no sidecar) |
| GSD integration | Yes (read-only) | No | Yes (read-only) |
| Redaction | Three-layer | None | Three-layer |
| Coordination | ~/.echo/coordination.json | globalThis bridge | None needed (one system) |
| CC auto-memory | Not addressed | Not addressed | Explicit policy (read, never write, feature flags) |
| Platform support | Windows (Linux fork separate) | Linux/Windows | One codebase, all platforms |
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
