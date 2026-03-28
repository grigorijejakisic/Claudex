# Spec: Agent-to-Agent Session Communication

Date: 2026-03-28 | Source: User idea + 5-layer street knowledge research
Research: `context/research/session-communication-street-knowledge-2026-03-28.md`

## Overview

Cross-session communication within Claudex — sessions on the same machine coordinate through a shared SQLite DB. Two coordination modes:

1. **Stigmergic** (primary) — sessions coordinate by modifying the shared environment. Lightweight signals with temporal decay. No direct communication needed.
2. **Explicit messaging** (secondary) — session-to-session request/response for cases that need direct interaction.

**Theoretical foundation:** Blackboard architecture (Hearsay-II, 1980), tuple spaces (Gelernter, 1985), cognitive stigmergy (Ricci, 2007), actor model mailboxes (Hewitt, 1973). See research doc for full citations.

**Competitive position:** Nobody has solved local-first, full-stack, multi-session coordination. Letta needs a server. CASS is fragmented. Engram has no multi-agent awareness. Claudex can own this space.

---

## Design Principles (from research)

1. **Stigmergy first, messaging second.** Sessions coordinate by reading the environment, not by talking to each other. Direct messaging is the fallback, not the default.
2. **Structured artifacts over free text.** All transfers use defined schemas (MetaGPT finding). No prose summaries.
3. **Transfer beliefs and desires, NOT intentions.** Handoffs describe state + goals, not prescribed actions. The receiving session forms its own plan (Wooldridge BDI).
4. **Commander's intent leads every handoff.** One sentence: the desired end state. If everything else is lost, intent survives (Military OPORD + Healthcare SBAR — 65% adverse event reduction).
5. **Budget-aware always.** Every transfer is token-budgeted. Context rot is real at 2% per reasoning step (MAST, ICLR 2025).
6. **Atomic coordination.** Every multi-step coordination operation is all-or-nothing. Non-atomic transitions are the #1 source of unrecoverable corruption across every framework studied.
7. **Receiver read-back.** The incoming session writes a "handoff acknowledged" confirming understanding. No system does this yet (I-PASS healthcare innovation).

### Anti-Patterns to Avoid

| Anti-Pattern | Source | Mitigation |
|---|---|---|
| Silent state corruption | MAST (41-87% failure rates) | Always fail-closed. Never resume partial state. |
| Unbounded context transfer | Context rot research (2%/step) | Greedy token-budgeted packing. |
| Free-form handoffs | Cognition blog (39% accuracy drop) | SBAR structure with mandatory intent. |
| Hub-and-spoke only | LbMAS paper (13-57% improvement) | Support volunteer task claiming. |
| Assuming real-time | All frameworks | Design for async, poll-on-next-turn. |

---

## Phase 1: Stigmergic Signals (Foundation)

Sessions coordinate by modifying the shared environment. No direct communication needed.

### Signal Types

| Signal | Purpose | Analogy | Decay |
|---|---|---|---|
| `wip` | "I'm working on file X" | Territory pheromone | 30 min |
| `failure` | "Approach Y failed for reason Z" | Alarm pheromone | 24 hours |
| `danger` | "File X is fragile, test before editing" | Danger marker | Manual clear |
| `claim` | "I claimed task T from the board" | Role claiming (UE5 game AI) | Until task completes |
| `discovery` | "Found that X is true about Y" | Cognitive artifact | 7 days |

### Schema

```sql
CREATE TABLE IF NOT EXISTS session_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('wip', 'failure', 'danger', 'claim', 'discovery')),
  target TEXT NOT NULL,        -- file path, task ID, or topic
  detail TEXT,                 -- context (reason for failure, danger description, etc.)
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at_epoch INTEGER,    -- NULL = manual clear only
  cleared_at_epoch INTEGER     -- set when explicitly cleared
);
CREATE INDEX IF NOT EXISTS idx_signals_project_type
  ON session_signals(project, signal_type, cleared_at_epoch);
```

### Assembly Integration

The `UserPromptSubmit` hook queries active signals for the current project and injects them:

```
## Active Signals
- [wip] Session "nexus-auth" is editing src/auth/google-oauth.ts (12 min ago)
- [failure] Session "oracle-test" reports: entity extraction fails on GLM-4.7-flash output (2h ago)
- [claim] Session "nexus-auth" claimed task "implement device flow" (5 min ago)
```

### Automatic Signal Lifecycle

- **wip signals**: Created when a session edits a file (PostToolUse hook). Cleared on session end.
- **failure signals**: Created when a session detects a failed approach. Cleared when the failure is resolved.
- **claim signals**: Created when a session picks a task. Cleared when task completes or session ends.
- **danger/discovery signals**: Created explicitly by the agent. Decay or manual clear.

**Files to change:**
| File | Change | Lines |
|---|---|---|
| `src/core/schema.ts` | Add `session_signals` DDL | ~15 |
| `src/core/migration-steps.ts` | Migration for new table | ~10 |
| `src/core/session-signals.ts` | **New:** CRUD for signals + decay sweep | ~80 |
| `src/adapters/cc-hooks/user-prompt-submit.ts` | Query and inject active signals | ~25 |
| `src/adapters/cc-hooks/post-tool-use.ts` | Auto-create wip signals on file edits | ~15 |
| `src/adapters/cc-hooks/stop.ts` | Clear wip signals on session end | ~10 |

**Total Phase 1: ~155 lines across 6 files (1 new)**

---

## Phase 2: Session Identity

### Session Naming

**Schema change:**
```sql
ALTER TABLE sessions ADD COLUMN name TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
```

**Naming flow:**
- Auto-name from thread topic: "nexus-auth-debug", "oracle-review", "claudex-review"
- User override: `/name my-auth-fix`
- Slug generation: sanitize topic → lowercase, replace spaces with hyphens, truncate to 40 chars

### Session Discovery

**Resolution order:**
1. Exact name match: `WHERE name = ?`
2. Fuzzy name match: `WHERE name LIKE '%' || ? || '%'`
3. Topic match: `WHERE topic LIKE '%' || ? || '%'` on `thread_state`
4. Project match: `WHERE project = ?` on `sessions` + recency

**Active session = `ended_at_epoch IS NULL`.**

### Auto-Naming

Angel heartbeat or session-start hook generates names:
1. Thread topic → slug: "debugging nexus auth" → "nexus-auth-debug"
2. Project + counter fallback: "claudex-v3-s42"

**Files to change:**
| File | Change | Lines |
|---|---|---|
| `src/core/schema.ts` | Add `name` to sessions DDL | ~2 |
| `src/core/migration-steps.ts` | Migration for name column | ~5 |
| `src/core/session-discovery.ts` | **New:** resolve session by name/topic/project | ~80 |
| `src/adapters/cc-hooks/session-start.ts` | Auto-name from topic on first turn | ~15 |
| `src/angel/heartbeat.ts` | Update session names when topics change | ~15 |

**Total Phase 2: ~117 lines across 5 files (1 new)**

---

## Phase 3: Explicit Messaging

For cases where stigmergic signals aren't enough — direct request/response between sessions.

### Schema Extension

```sql
ALTER TABLE session_messages ADD COLUMN sender_type TEXT DEFAULT 'angel'
  CHECK (sender_type IN ('angel', 'session', 'system'));
ALTER TABLE session_messages ADD COLUMN request_id TEXT;  -- links response to request
```

### Message Types

| Type | Semantics | Response Expected |
|---|---|---|
| `request` | "I need X from you" | Yes — target session responds |
| `response` | "Here's what you asked for" | No — completes a request |
| `notify` | "FYI, I just changed X" | No |
| `transfer` | "Take over this work" | Acknowledged via read-back |

### MCP Tool

```typescript
// Extension to existing MCP recall server
claudex_message({
  target: "nexus-session",     // name, topic fragment, or session_id
  content: "What auth approach did you settle on?",
  type: "request",             // request | notify | transfer
})
```

### Delivery Flow

1. Sender resolves target via session discovery
2. Message written to `session_messages` with `sender_type='session'`
3. Target's `UserPromptSubmit` hook delivers on next turn
4. Target's agent reads, formulates response, writes response message back
5. Sender receives response on their next turn

### UX Flow
```
Session A (Claudex):
  User: "Ask the Nexus session what auth approach they're using"
  Agent: [resolves → session_id abc123]
        [writes request to session_messages]
        "Asked. You'll see their response on your next turn after they reply."

Session B (Nexus):
  [injected: "Session 'claudex-review' asks: What auth approach did you settle on?"]
  Agent: [formulates answer, writes response back]
        "Replied to claudex-review."

Session A (next turn):
  [injected: "Reply from 'nexus-auth': We're using Google OAuth device flow..."]
```

**Files to change:**
| File | Change | Lines |
|---|---|---|
| `src/core/migration-steps.ts` | Migration for sender_type + request_id | ~10 |
| `src/mcp/recall-server.ts` | Add `claudex_message` tool | ~60 |
| `src/adapters/cc-hooks/user-prompt-submit.ts` | Render session messages with sender context | ~20 |

**Total Phase 3: ~90 lines across 3 files**

---

## Phase 4: Context Transfer

### Structured Transfer Package (SBAR-inspired)

Every transfer follows the SBAR structure with mandatory intent:

```typescript
interface SessionTransferPackage {
  // MANDATORY — the one thing that must survive
  intent: string;                    // "The goal is X because Y"

  // Situation — current state
  situation: {
    project: string;
    topic: string;
    activeFiles: string[];           // hot files with pressure scores
    activeSignals: SessionSignal[];  // wip, claim, failure signals
  };

  // Background — what led here
  background: {
    recentDecisions: Decision[];     // last 5 decisions
    recentTurns: ConversationTurn[]; // last N turns, token-budgeted
    keyLearnings: string[];          // session-specific learnings
  };

  // Assessment — what I believe + what's uncertain
  assessment: {
    beliefs: string[];               // "I believe X is true"
    uncertainties: string[];         // "I'm unsure about Y"
    failedApproaches: string[];      // "Tried Z, failed because W"
  };

  // Recommendation — what to do next (desires, not intentions)
  recommendation: {
    nextSteps: string[];             // ordered priority
    constraints: string[];           // "Don't modify X until Y"
    blockers: string[];              // "Blocked on Z"
  };

  // Metadata
  tokenBudget: number;               // how many tokens this package consumed
  sourceSession: string;             // session ID
  sourceSessionName: string;         // human-readable name
  timestamp: number;
}
```

### Transfer Modes

**Pull ("continue from X session"):**
```
User in new session: "Continue from my Oracle session"
Agent: [resolves Oracle session → session_id xyz789]
      [packages xyz789's state into SBAR transfer]
      [injects as session-start context]
      [writes read-back acknowledgment to DB]
      "Picked up from Oracle. Intent: [intent]. Here's what I understand: [synthesis]"
```

**Push ("transfer this to a new session"):**
```
User: "/transfer"
Agent: [packages current state into SBAR transfer]
      [writes transfer message to session_messages]
      [marks session as transferred]
      "Transferred. Open a new session and say 'pick up the transfer.'"
```

### Receiver Read-Back (I-PASS innovation)

After receiving a transfer, the incoming session writes:
```sql
INSERT INTO session_messages (target_session, sender, sender_type, message_type, content)
VALUES (?, current_session_id, 'session', 'acknowledge',
  'Understood intent: [intent]. Taking over: [next_steps]. Uncertain about: [uncertainties].');
```

This closes the communication loop. If the source session is still active, it sees the acknowledgment and can correct misunderstandings.

### Budget-Aware Packing

The transfer package is greedy-packed:
1. Intent (mandatory, ~20 tokens)
2. Situation (mandatory, ~100 tokens)
3. Assessment.failedApproaches (high value, prevents re-trying dead ends)
4. Recommendation.nextSteps + constraints
5. Background.recentDecisions (last 5)
6. Background.recentTurns (fill remaining budget)

Stop when budget exhausted. Default budget: 4000 tokens.

**Files to change:**
| File | Change | Lines |
|---|---|---|
| `src/core/session-transfer.ts` | **New:** package + inject + read-back | ~150 |
| `src/adapters/cc-hooks/session-start.ts` | Detect and inject pending transfers | ~20 |

**Total Phase 4: ~170 lines across 2 files (1 new)**

---

## Phase 5: Skills + UX

| Skill | Purpose |
|---|---|
| `/name <alias>` | Name the current session |
| `/sessions` | List active sessions with names, topics, projects, signals |
| `/ask <session> <question>` | Send a request to another session |
| `/transfer [target]` | Package and transfer current context |
| `/pickup` | Receive a pending transfer |
| `/signal <type> <target> [detail]` | Manually create a signal |

**Total Phase 5: ~60 lines across skill definitions**

---

## Build Order

| Phase | What | Lines | Dependencies | Unlocks |
|---|---|---|---|---|
| 1 | Stigmergic signals | ~155 | None | Cross-session awareness without messaging |
| 2 | Session identity | ~117 | None (parallel with Phase 1) | Human-friendly session references |
| 3 | Explicit messaging | ~90 | Phase 2 (discovery) | Direct request/response |
| 4 | Context transfer | ~170 | Phase 2 + 3 | Session handoff, "continue from X" |
| 5 | Skills + UX | ~60 | Phase 1-4 | User-facing commands |
| **Total** | | **~592** | | |

**Phases 1 and 2 can be built in parallel.** Phase 3 needs Phase 2. Phase 4 needs Phase 2+3. Phase 5 is the UX layer on top.

---

## Open Questions (Resolved)

| Question | Resolution |
|---|---|
| Should transferred sessions stop accepting messages? | **Yes.** Mark as `transferred_to` in sessions table. Messages to transferred sessions get bounced with a redirect. |
| Permission model? | **No for v1.** Solo users don't need it. All sessions on the same machine share the same DB. Local-only is a feature, not a bug. |
| Real-time notifications? | **No for v1.** Async poll-on-next-turn is correct for human-paced interaction. Real-time adds complexity for minimal gain. |
| Volunteer task claiming? | **Yes.** Phase 1 `claim` signals enable this naturally. Workers self-select by writing claim signals. |

## Theoretical Backing

| Design Choice | Theory | Source |
|---|---|---|
| SQLite as shared blackboard | Blackboard architecture | Hearsay-II (Erman, 1980), 3500+ citations |
| Stigmergic signals with decay | Cognitive stigmergy | Ricci 2007, ant colony optimization |
| session_messages as mailbox | Actor model | Hewitt 1973, Erlang/OTP |
| SBAR transfer structure | Healthcare shift handoff | US Navy/SBAR, 65% adverse event reduction |
| Intent-first handoffs | Military OPORD | Commander's intent doctrine |
| Budget-aware transfer | Context rot | MAST (ICLR 2025), 2% degradation per step |
| Receiver read-back | I-PASS protocol | Healthcare, 11% mortality reduction |
| Volunteer task claiming | Decentralized coordination | LbMAS blackboard paper, 13-57% improvement |
| Append-only shared state | CRDT theory | Shapiro 2011, conflict-free by construction |
| Activation decay | ACT-R cognitive architecture | Anderson & Lebiere, CMU |
