# Team Shared Memory — Claudex as the Shared Brain for Agent Teams

**Status:** Spec v1
**Date:** 2026-03-16
**Author:** Crux (Session 13)
**Research:** r-shared-memory, r-agent-knowledge (parallel research agents)

## Problem

When /team spawns workers, each starts blind. The main agent compensates with massive briefing prompts — 30-40% of each worker's context is manually explaining codebase conventions, patterns, and gotchas that Claudex already knows. Workers can't see each other's discoveries. Worker observations are lost when they finish. The system wastes tokens, workers repeat mistakes, and parallel agents operate on inconsistent views of the project.

## Prior Art (Verified)

| System | Key Pattern | Validated? | What We Take |
|---|---|---|---|
| **Aider** | PageRank repo map personalized by active files | Production | Pressure scores as personalization weights |
| **LbMAS** (arxiv) | Blackboard with capability self-selection | 13-57% over master-slave | Enhance agent_tasks with capability matching |
| **MCP Agent Mail** | Advisory file leases with TTL | Production | Conflict prevention for parallel writers |
| **Letta/MemGPT** | Three-tier write protocol (append/targeted/full) | Production | Workers append-only to shared state |
| **MetaGPT** | Publish-subscribe message routing | ICLR 2024 | Workers declare input/output artifact types |
| **INMS** | LLM quality scoring for pool admission | arxiv 2024 | Score worker observations before sharing |
| **Collaborative Memory** | Write-time LLM transformation | arxiv 2025 | Strip worker-specific reasoning on write |
| **Agent-Recall** | LLM-summarized briefing from DB facts | Production | Generated context packages per worker |
| **ADK** (Google) | Pre-processor similarity search before invocation | Production | Validates Claudex's hook-based injection |
| **Anthropic** | Sub-agents return 1-2K summaries, not full work | Official | Workers report concise, orchestrator synthesizes |
| **aistack** | Consensus checkpoints, drift detection | Production | Reconcile conflicting worker outputs |
| **Cord** | SQLite spawn/fork with dependency tracking | Production | Minimal coordination primitive |
| **CrewAI** | Cosine >= 0.98 dedup on write | Production | Prevent duplicate observations |
| **Three-tier** | Hot (200 lines) / Warm / Cold | Practitioner | Structure context packages by access frequency |
| **Claude Code** | .claude/agents/ with memory directories | Official | 200-line MEMORY.md auto-included |

## Production Failure Patterns (O'Reilly, Maxim — to avoid)

1. **Stale state propagation** — Agent B reads before Agent A's write flushes
2. **Race conditions on concurrent writes** — Multiple agents corrupt shared state
3. **Context bloat** — 2-5x token usage vs single-agent for equivalent tasks
4. **Duplicate work from retry ambiguity** — No idempotency on task operations
5. **Interagent misalignment (36.9% of failures)** — Inconsistent views of shared state

## Design

### 1. Worker Context Assembly

New function that queries Claudex DB and assembles a task-specific knowledge package for a spawned worker.

```typescript
interface WorkerContextPackage {
  primer: string;           // Project primer summary (conventions, patterns)
  relevantArtifacts: string; // FTS5-matched artifacts for this task
  experienceWarnings: string; // Experience patterns relevant to this task
  hotFiles: string;          // Files with high pressure scores related to task
  learnings: string;         // Cross-session knowledge relevant to task
  tokenBudget: number;       // Total tokens used by this package
}

async function assembleWorkerContext(
  db: Database,
  taskDescription: string,
  project: string,
  opts?: {
    maxTokens?: number;       // default 3000 — keep worker context lean
    includeExperience?: boolean; // default true
    fileScope?: string[];     // specific files the worker will touch
  }
): Promise<WorkerContextPackage>
```

**Assembly priority (hot/warm/cold model):**

| Tier | Content | Always? | Budget |
|---|---|---|---|
| Hot | Experience patterns (warnings) | Yes if matched | 500 tokens |
| Hot | Relevant learnings | Yes if matched | 500 tokens |
| Warm | Matched artifacts (summaries only) | If matches exist | 1000 tokens |
| Warm | Hot files with pressure context | If worker touches them | 500 tokens |
| Cold | Full artifact content | Only if budget remains | 500 tokens |

**Query formation:** The task description IS the query (validated by Agno, ExpeL, every framework). FTS5 MATCH against artifacts, learnings, experience patterns using existing `tokenizeQuery`.

**Integration with /team:** The main agent calls `assembleWorkerContext()` before spawning each worker and appends the result to the worker's prompt. The only channel is the Agent tool's prompt string — this is a CC constraint (confirmed by docs).

### 2. Worker Observation Write-Back

Workers write discoveries back to Claudex so parallel and future agents benefit.

```typescript
interface WorkerObservation {
  worker_id: string;
  task_description: string;
  observation: string;        // What the worker discovered
  files_involved: string[];
  importance: number;         // Self-assessed 1-5
  session_id: string;
}

function ingestWorkerObservation(
  db: Database,
  obs: WorkerObservation,
  project: string
): string  // returns observation ID or '' if rejected
```

**Quality gates (layered):**
1. **Importance threshold**: `importance >= 3` (existing Claudex gate)
2. **Dedup check**: Cosine similarity >= 0.98 against existing observations → skip (CrewAI pattern)
3. **Write-time transformation**: Strip worker-specific reasoning, keep transferable facts (Collaborative Memory pattern). Use existing `redactContent` for secrets.
4. **Idempotency**: Hash of (worker_id + observation text) prevents duplicate writes on retry

**How workers write back:** Workers can't call Claudex hooks directly (they're fresh subprocesses). Two options:
- **Option A (simple):** Worker includes observations in its final report to PM/main agent. Main agent calls `ingestWorkerObservation()` for each. This is the Anthropic-recommended pattern (sub-agents return summaries, parent processes them).
- **Option B (real-time):** Workers write to a staging table or temp file. Main agent polls and ingests periodically. More complex but enables real-time cross-worker discovery.

**Recommendation:** Option A for now. Option B when Paperclip provides persistent agent coordination.

### 3. Retrieved-Set Coordination

Prevent parallel workers from retrieving identical artifacts and doing duplicate work.

```typescript
interface ArtifactClaim {
  artifact_id: string;
  worker_id: string;
  claimed_at_epoch: number;
  ttl_seconds: number;        // default 300 — 5 minutes
}

function claimArtifacts(
  db: Database,
  artifactIds: string[],
  workerId: string
): string[]  // returns IDs successfully claimed

function getUnclaimedArtifacts(
  db: Database,
  query: string,
  project: string,
  excludeWorker?: string
): Artifact[]
```

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS artifact_claims (
  artifact_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 300,
  PRIMARY KEY (artifact_id, worker_id)
);
```

**How it works:**
1. Main agent calls `assembleWorkerContext()` for Worker A → claims artifacts matched
2. Main agent calls `assembleWorkerContext()` for Worker B → gets DIFFERENT artifacts (claimed ones excluded)
3. Claims expire after TTL (5 min) — stale claims auto-clear
4. Workers touching different knowledge reduces overlap, increases coverage

### 4. File Lease System

Advisory locks preventing parallel workers from editing the same files simultaneously.

```typescript
interface FileLease {
  file_path: string;
  worker_id: string;
  granted_at_epoch: number;
  ttl_seconds: number;        // default 600 — 10 minutes
}

function requestLease(db: Database, filePath: string, workerId: string): boolean;
function releaseLease(db: Database, filePath: string, workerId: string): void;
function getLeaseHolder(db: Database, filePath: string): string | null;
function expireStaleLeases(db: Database): number;
```

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS file_leases (
  file_path TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  granted_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 600
);
```

**Integration with /team:**
- When designing wave structure, check for file overlaps
- Workers in the same wave should have non-overlapping file sets
- If overlap is unavoidable, the PM mediates via leases
- Leases are advisory — workers can proceed without a lease but risk conflicts

### 5. Consensus Checkpoints

When multiple workers produce conflicting outputs, reconcile before committing to shared state.

```typescript
interface ConsensusCheck {
  topic: string;
  contributions: Array<{
    worker_id: string;
    content: string;
    confidence: number;
  }>;
}

async function resolveConsensus(
  contributions: ConsensusCheck,
  enrichmentProvider?: EnrichmentProvider
): Promise<string>  // resolved content
```

**When consensus is needed:**
- Two workers write artifacts with overlapping `trigger_context`
- Two workers modify the same section of a shared document
- Workers report contradictory findings about the same topic

**Resolution (tiered):**
1. **Automatic**: If contributions are semantically identical (cosine >= 0.95) → take either
2. **LLM-mediated** (Ollama): Send both to LLM with "which is more accurate?" prompt
3. **Escalate**: If LLM can't resolve → flag for PM/main agent/user

### 6. Enhanced Blackboard (agent_tasks upgrade)

Upgrade the existing `agent_tasks` table with capability matching.

```sql
ALTER TABLE agent_tasks ADD COLUMN required_capabilities TEXT; -- JSON array
ALTER TABLE agent_tasks ADD COLUMN worker_capabilities TEXT;   -- JSON array (set by worker on claim)
```

**Capability-based self-selection (LbMAS pattern):**
- Tasks declare required capabilities: `["typescript", "testing", "fts5"]`
- Workers declare their strengths when spawned
- Matching workers pick up matching tasks first
- Reduces misassignment without central routing

## Integration Points

| Component | What Changes |
|---|---|
| `/team` skill | Calls `assembleWorkerContext()` before spawning each worker |
| Worker briefing template | Appended with context package (artifacts, warnings, learnings) |
| PM role | Processes worker observations → calls `ingestWorkerObservation()` |
| Main agent | Claims artifacts per worker, manages leases, runs consensus |
| `assembler.ts` | New `assembleWorkerContext()` function (lighter than full assembly) |
| `experience-patterns.ts` | Already does trigger matching — reused for worker warnings |
| `artifacts.ts` | Claim/unclaim functions added |
| `migrations.ts` | New tables: `artifact_claims`, `file_leases` |

## Implementation Order

| Phase | What | Why First |
|---|---|---|
| 1 | Worker Context Assembly | Highest immediate impact — every /team spawn gets smarter |
| 2 | Worker Observation Write-Back | Enables knowledge accumulation from team work |
| 3 | File Leases | Prevents the most common parallel worker failure |
| 4 | Retrieved-Set Coordination | Reduces duplicate work |
| 5 | Consensus Checkpoints | Handles edge case conflicts |
| 6 | Enhanced Blackboard | Requires Paperclip integration |

## Latency Budget

| Operation | Target | Notes |
|---|---|---|
| `assembleWorkerContext()` | <50ms | FTS5 queries + token estimation |
| `ingestWorkerObservation()` | <10ms | Insert + dedup check |
| `requestLease()` | <5ms | Single INSERT OR IGNORE |
| `claimArtifacts()` | <10ms | Batch INSERT |
| `resolveConsensus()` (LLM) | <5000ms | Only when conflicts detected |

## Success Criteria

1. Workers spawned with context packages make fewer mistakes (measurable: reduced correction signals)
2. Worker observations persist and appear in future sessions (measurable: observation count growth)
3. Parallel workers on overlapping files don't produce merge conflicts (measurable: zero file conflicts)
4. Context packages stay under 3000 tokens per worker (measurable: token count in spawn prompts)
5. Total latency added to /team spawn: <100ms per worker
6. Experience patterns from this session surface as warnings when spawning workers on similar tasks

## What This Doesn't Do (Explicit Non-Goals)

- **Real-time inter-worker messaging** — Workers communicate via PM/main agent, not directly. Real-time is a Paperclip feature.
- **Worker-to-worker artifact sharing during execution** — Workers write back to main agent who ingests. Real-time sharing needs persistent coordination (Paperclip).
- **Automatic task decomposition** — /team skill handles decomposition. This spec provides the knowledge layer, not the planning layer.
- **Replace /team's briefing template** — This augments it. The briefing template remains the structural framework; context packages add project-specific knowledge.
