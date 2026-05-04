# Phase 1: Episode substrate - Research

**Researched:** 2026-05-04
**Domain:** SQLite schema migration + CC-hook write-path instrumentation (internal)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Event row shape** — `episodic_events` columns:
`id INTEGER PK, session_id TEXT NOT NULL, project TEXT NOT NULL, ts_epoch INTEGER NOT NULL, turn_number INTEGER NULL, type TEXT NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL, provenance TEXT NOT NULL, parent_event_id INTEGER NULL FK→episodic_events.id, content_hash TEXT NOT NULL, metadata_json TEXT NULL, schema_version SMALLINT NOT NULL`. Indexes: PK; `(session_id, turn_number, ts_epoch)`; `(project, ts_epoch)`; `(provenance)`; `(parent_event_id)`. Phase 1 ships `schema_version=1`.

**Taxonomy:**
- `provenance` is a **closed enum**: `organic | injected | tool_result | environmental` — locked. Readers MUST filter by it; this is the structural lever against the Mem0 trap.
- `type` is **open** with documented well-knowns for v5.0: `user_prompt | assistant_message | tool_call | tool_result | hook_injection | environmental_event | session_boundary`.
- `source` is open string (hook script name, tool name, adapter name).

**Provenance write semantics — split per provenance, not structured spans inside one row:**
- One UserPromptSubmit firing → 1 organic row (user text after wrappers stripped) + N injected rows (one per stripped wrapper block: `<system-reminder>`, `<experience-data>`, `<file-content>`, `<task-notification>`, ...). All N+1 share `(session_id, turn_number)`; injected rows set `parent_event_id` to the organic row's id.
- Tool results that surface recalled content → one `provenance='tool_result'` row. NO sub-row decomposition; tool boundary is the natural split.
- Stop hook (assistant turn) → one `provenance='organic'`, `type='assistant_message'` row. Tool calls inside the message become their own `tool_call` rows with `parent_event_id` = assistant_message id.
- Environmental events (Angel heartbeats, session-start markers, hook errors) → `provenance='environmental'`, `turn_number=NULL`.

**Dual-write contract:**
- **Order**: legacy `conversation_turns` write FIRST (preserves v4), `episodic_events` writes SECOND.
- **Transactionality**: single SQLite transaction, always — `BEGIN; INSERT conversation_turns; INSERT episodic_events × N; COMMIT`. On any insert failure → ROLLBACK + one row to existing `telemetry` table outside the transaction (`event_kind='episodic_write_failure'`, `detail` JSON includes hook name, attempted row count, error message).
- **Awaited, not fire-and-forget** — same pattern as existing `conversation_turns` writes. Ephemeral hooks die after return.
- **Phase 1 readers: NONE.** Pure write path. Angel does NOT read. Assembly does NOT. CARA does NOT. Hybrid-retrieval does NOT.
- **No backfill** from `conversation_turns` — legacy rows stay legacy.

**Episode binding:** No `episode_id` column in Phase 1. Phase 6 decides episode unit and adds via migration.

**Embedding / index timing:** Phase 1 does NOT embed and does NOT enqueue embeddings. No synchronous index updates. Phase 2 builds first index AND backfills from rows accumulated since Phase 1 ship.

### Claude's Discretion

The planner has flexibility on:
- Migration mechanics — single migration file vs split, naming, whether to use the existing migration runner.
- Test layout — how to extend the existing vitest harness to cover hook-level dual-write assertions.
- Telemetry detail JSON shape — exact fields inside `detail` for `episodic_write_failure` (must be enough to debug; exact set is operational judgment).
- Which existing helper module hosts the dual-write logic (`src/adapters/shared/lifecycle.ts` is the obvious candidate; planner may justify splitting).
- Wrapper-stripping regex / parser shared with assembly's existing strip logic (reuse vs duplicate-with-tests).

### Deferred Ideas (OUT OF SCOPE)

- Episode boundary detection (`episode_id` column) → Phase 6
- Multi-modal indexes (error-fingerprint, affect, structural shape) → Phase 2
- Retrieval cutover (`hybrid-retrieval.ts` rewrite) → Phase 3
- Pattern-extractor reduction → Phase 4
- Density-based abstraction at retrieval time → Phase 5
- Crash-resilient session-end (fsnotify + heartbeat) → Phase 6
- v4 storage decisions (retire `experience_patterns`, etc.) → Phase 7
- Backfill of legacy `conversation_turns` into `episodic_events` — explicitly REJECTED for Phase 1.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EPI-01 | New `episodic_events` table with structured row schema | Schema design locked in CONTEXT.md (column set, indexes). V25 migration follows the V24 pattern in `src/core/migration-steps.ts`. |
| EPI-02 | Provenance enum: `organic \| injected \| tool_result \| environmental` | CHECK constraint in DDL enforces enum at DB level. Locked taxonomy. |
| EPI-03 | Write path from existing hooks (UserPromptSubmit, Stop, PostToolUse) populates `episodic_events` parallel to `conversation_turns` | Dual-write helpers in `src/adapters/shared/lifecycle.ts` — extend `storeConversationTurnUserText`, `updateConversationTurnAssistant`, `storeConversationTurn`, plus a new tool-result writer. Both writes inside one SQLite transaction. |
| EPI-04 | Hook-injected wrapper blocks write as separate rows with `provenance='injected'` rather than concatenated into user_text | Reuse existing strip regex from `src/adapters/cc-hooks/user-prompt-submit.ts:266`: `/<(?:task-notification\|system-reminder\|experience-data\|local-command-caveat\|command-message\|command-name\|command-args\|local-command-stdout\|file-content)[^>]*>[\s\S]*?<\/...>/gi`. Lift into a shared parser that returns `{ organic: string, injected: { tag, content }[] }`. |
| EPI-05 | Tool results write with `provenance='tool_result'` and a typed source identifier | PostToolUse hook (`src/adapters/cc-hooks/post-tool-use.ts`) already has access to `tool_name` and `tool_response` (per CC payload truth doc). Add an episodic write that records source=tool_name, type='tool_result', metadata_json={tool_input}. |
| EPI-06 | Schema migration is forward-only; legacy `conversation_turns` remain readable | V25 migration in `src/core/migration-steps.ts` exporting `migrateV24toV25`, registered in `src/core/migrations.ts`. `SCHEMA_VERSION` constant in `src/shared/constants.ts` bumps 24 → 25. No mutation of existing `conversation_turns` rows. |
| EPI-07 | Tests assert that injecting an `<experience-data>` block into a prompt produces a single `provenance='injected'` event row, not part of the organic user turn | Vitest under `src/tests/`. Pattern: instantiate hook with synthesized payload via existing test scaffolding (see `src/tests/angel/heartbeat.test.ts` for in-memory DB fixture style), assert row counts and provenance values via direct SQL. The "structural Mem0 impossibility" test is the canonical proof of EPI-04. |

</phase_requirements>

## Summary

Phase 1 is a contained schema-and-write-path change inside an internal codebase with established conventions. The CONTEXT.md locks the column set, the provenance enum, the dual-write contract, and the ban on backfill — these are non-negotiable. The planner's job is to package the locked decisions into 3-4 executable plans across 2-3 waves and verify them with vitest.

This is **Discovery Level 0** for the engineering problem (no new external dependencies, no library evaluation) and **Discovery Level 1** for the codebase shape (single Context7-style verification: confirm the migration runner accepts a new V24→V25 step in the existing pattern). All conventions are derivable from the codebase — `src/core/migrations.ts`, `src/core/migration-steps.ts`, `src/core/schema.ts`, `src/adapters/shared/lifecycle.ts`, and `src/adapters/cc-hooks/{user-prompt-submit,stop,post-tool-use}.ts`.

**Primary recommendation:** Three vertical-slice plans plus one verification plan. Plan 01 lands the schema migration (V25 + DDL + constants bump + structural unit tests). Plan 02 lands the wrapper parser and the UserPromptSubmit + Stop dual-write paths (the trap-defeating provenance split). Plan 03 lands the PostToolUse + environmental dual-write paths. Plan 04 is the structural-impossibility integration test plus telemetry-on-rollback verification. Waves: 01 alone in Wave 1; 02 and 03 parallel in Wave 2 (file-disjoint); 04 in Wave 3.

## Standard Stack

### Core (already in project — no installs)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | already in `package.json` | Synchronous SQLite driver used everywhere via `Database.Database` | Single-process synchronous semantics make the dual-write transaction trivial. `BEGIN/COMMIT` over the same handle is atomic and free. |
| `vitest` | already in `package.json` | Test runner | Existing 3000+-test suite. Use in-memory `:memory:` DB fixtures (see `src/tests/angel/heartbeat.test.ts`). |
| `cachedPrepare` from `src/core/stmt-cache.ts` | internal | Prepared-statement reuse | Every existing write path uses it. Episodic writes MUST use it for consistency. |
| `emitTelemetry` from `src/observability/telemetry.js` | internal | Telemetry row writer | Used by every existing failure-path. `event_kind='episodic_write_failure'` follows the same convention as `event_kind='reranker_fallback'` (see CLAUDE.md). |

### Supporting (existing patterns to reuse)

| Pattern | Location | Use For |
|---------|----------|---------|
| Migration step function | `src/core/migration-steps.ts` (`migrateV23toV24` → exemplar for V25) | New `migrateV24toV25(db)` adds the `episodic_events` table + indexes. |
| Migration runner registration | `src/core/migrations.ts` (the `[24, () => migrateV24toV25(db)]` row in the steps map) | Add the V25 step. |
| Schema constants block | `src/core/schema.ts` (existing `SCHEMA_V22` etc. exported strings) | Define `SCHEMA_V25` (or inline the DDL inside the migration step — both patterns exist; planner picks). |
| Schema version constant | `src/shared/constants.ts` (`SCHEMA_VERSION`) | Bump 24 → 25. |
| Hook lifecycle helpers | `src/adapters/shared/lifecycle.ts` (existing `storeConversationTurn*` family at lines 481–559) | Add `storeEpisodicEvents(...)` family. New helpers MUST be transactionally bundled with the existing `conversation_turns` writes — modify the existing functions to accept episodic args, OR introduce a new wrapper that calls both inside a single `db.transaction()`. |
| In-memory test DB | `src/tests/angel/heartbeat.test.ts` and similar | Fixture for unit + integration tests. |

### Alternatives Considered (and rejected)

| Instead of | Could Use | Tradeoff | Decision |
|------------|-----------|----------|----------|
| Closed enum CHECK constraint on `provenance` | Open string + runtime validation | CHECK constraint catches drift at insert time, raises an exception caught by the rollback path | **USE CHECK constraint** — provenance is locked, structural enforcement is the point. |
| Single combined dual-write helper | Two separate helpers called from each hook | Single helper guarantees atomicity by construction; two separate helpers risk being called outside a transaction | **USE single helper** that performs both inserts inside one transaction. |
| `db.transaction(() => {...})()` (better-sqlite3 closure form) | Manual `BEGIN/COMMIT/ROLLBACK` | Closure form auto-rollbacks on throw and is more idiomatic | **USE closure form**. |
| Storing wrapper text + tag inside a single injected row | Splitting into one row per wrapper block | One-row-per-wrapper aligns with "row-attribute provenance" — each injected span is independently filterable, link-able via `parent_event_id`, and addressable | **USE one row per wrapper**. Locked by CONTEXT.md. |
| Backfilling `conversation_turns` into `episodic_events` | No backfill | Backfill would default-tag legacy injected content as `organic` — re-introduces the Mem0 trap | **REJECTED** — locked by CONTEXT.md. |

**Installation:** None. All dependencies already in project.

## Architecture Patterns

### Recommended Project Structure (delta only)

```
src/
├── core/
│   ├── schema.ts                       # +SCHEMA_V25 constant (or inline)
│   ├── migrations.ts                   # +register migrateV24toV25
│   ├── migration-steps.ts              # +export migrateV24toV25
│   └── episodic-events.ts              # NEW — write helpers (insertEpisodicEvent, insertEpisodicEventBatch)
├── shared/
│   └── constants.ts                    # SCHEMA_VERSION 24 → 25
├── adapters/
│   ├── shared/
│   │   └── lifecycle.ts                # MODIFY existing storeConversationTurn* to dual-write inside one transaction; or add new wrapper helpers
│   └── cc-hooks/
│       ├── user-prompt-submit.ts       # call dual-write helper
│       ├── stop.ts                     # call dual-write helper
│       └── post-tool-use.ts            # NEW dual-write call for tool_result events
├── extraction/
│   └── wrapper-parser.ts               # NEW — single source of truth for splitting prompts into { organic, injected[] }
└── tests/
    └── adapters/
        └── episodic-events/
            ├── schema-migration.test.ts            # V24→V25 migration shape + indexes
            ├── wrapper-parser.test.ts              # wrapper splitting unit tests
            ├── dual-write-user-prompt.test.ts      # UserPromptSubmit dual-write + EPI-07 trap test
            ├── dual-write-stop.test.ts             # Stop hook dual-write
            ├── dual-write-tool-result.test.ts      # PostToolUse dual-write
            └── transaction-rollback.test.ts        # legacy + episodic both fail = telemetry row + nothing partial
```

### Pattern 1: Versioned Migration Step

**What:** Each migration is a function in `migration-steps.ts` registered in `migrations.ts`. Function MUST be idempotent (existence checks before DDL) and non-throwing.

**When to use:** Always — Claudex's migration runner walks the steps map and applies them in order on every DB open.

**Example (extracted from existing code, line ranges in `migration-steps.ts`):**

```typescript
export function migrateV24toV25(db: Database): void {
  // Idempotent — skip if already applied
  if (hasTable(db, 'episodic_events')) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      ts_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      turn_number INTEGER,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      parent_event_id INTEGER REFERENCES episodic_events(id),
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_session_turn_ts ON episodic_events(session_id, turn_number, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_project_ts     ON episodic_events(project, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_provenance     ON episodic_events(provenance);
    CREATE INDEX IF NOT EXISTS idx_epev_parent         ON episodic_events(parent_event_id);
  `);
}
```

### Pattern 2: Single-Transaction Dual-Write

**What:** Wrap both legacy + episodic INSERTs inside one `db.transaction(...)` closure. On any throw, the closure auto-rolls back; outside the closure, write one telemetry row recording the failure.

**When to use:** Every hook write path that today writes to `conversation_turns`.

**Example skeleton (the planner refines):**

```typescript
// src/core/episodic-events.ts
export function dualWriteUserPrompt(
  db: Database,
  sessionId: string,
  project: string,
  rawPrompt: string,
  turnNumber: number,
): void {
  const { organic, injected } = parseWrappers(rawPrompt);
  const tx = db.transaction(() => {
    // 1. Legacy conversation_turns INSERT (preserves v4 contract — uses raw prompt unchanged)
    cachedPrepare(db,
      `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(sessionId, project, turnNumber, rawPrompt);

    // 2. Organic episodic_events row
    const organicId = (cachedPrepare(db,
      `INSERT INTO episodic_events
         (session_id, project, turn_number, type, source, content, provenance, content_hash, metadata_json, schema_version)
       VALUES (?, ?, ?, 'user_prompt', 'cc-hooks/user-prompt-submit', ?, 'organic', ?, NULL, 1)
       RETURNING id`
    ).get(sessionId, project, turnNumber, organic, sha256(organic)) as { id: number }).id;

    // 3. One injected row per wrapper
    for (const w of injected) {
      cachedPrepare(db,
        `INSERT INTO episodic_events
           (session_id, project, turn_number, type, source, content, provenance, parent_event_id, content_hash, metadata_json, schema_version)
         VALUES (?, ?, ?, 'hook_injection', ?, ?, 'injected', ?, ?, ?, 1)`
      ).run(sessionId, project, turnNumber, `wrapper:${w.tag}`, w.content, organicId, sha256(w.content), JSON.stringify({ tag: w.tag }));
    }
  });

  try {
    tx();
  } catch (e) {
    // Outside the transaction — telemetry write must not roll back
    emitTelemetry(db, sessionId, 'episodic_write_failure', {
      hook: 'user-prompt-submit',
      attempted_rows: injected.length + 2,
      error: String(e),
    });
  }
}
```

### Pattern 3: Wrapper Parser as Shared Module

**What:** A single function `parseWrappers(text: string): { organic: string, injected: { tag: string, content: string }[] }` lives in a new module (`src/extraction/wrapper-parser.ts`) and is imported by both the dual-write helpers and any future readers (Phase 3+). It uses the same regex already in `src/adapters/cc-hooks/user-prompt-submit.ts:266`, but returns BOTH halves rather than just stripping.

**Why dedicated module:** The Phase 4 mandate is "make Mem0 trap structurally impossible." Having two regexes (one strip-only, one strip-and-collect) drifts. One source of truth, with tests.

### Anti-Patterns to Avoid

- **Fire-and-forget dual-write.** Hooks are ephemeral Node processes (CLAUDE.md: "Always await in hooks"). The dual-write must be synchronous (better-sqlite3 is sync) and the helper call awaited where the surrounding code is async.
- **Calling into Claude Code's API from a hook.** Mem0-trap fix MUST NOT introduce LLM calls. Use Ollama if any LLM logic is needed (Phase 1 needs none).
- **Storing structured data inside `content` instead of `metadata_json`.** `content` is the raw payload as the agent saw it. All Phase 2 modality-specific fields go in `metadata_json` so future indexes don't require ALTER TABLE.
- **Embedding eagerly.** Phase 1 explicitly does NOT embed. No `embedArtifact` calls, no Ollama queues. Embeddings are Phase 2/3.
- **Adding a reader.** Phase 1's value is testable correctness. Angel/Assembly/Hybrid-retrieval cuts over in Phase 3.
- **Stripping without collecting.** The existing strip regex deletes wrapper content — for v5 we MUST collect it as separate rows. The new parser replaces strip-only usage.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic dual-write | Manual `BEGIN/COMMIT/ROLLBACK` with try/catch ceremony | `db.transaction(() => {...})()` from better-sqlite3 | Closure form rolls back automatically on throw; one less footgun. |
| Wrapper splitting | A new regex from scratch | Lift the existing regex from `src/adapters/cc-hooks/user-prompt-submit.ts:266` into a shared parser | Single source of truth; existing regex already battle-tested in the strip path. |
| Telemetry write | A new logging table | `emitTelemetry(db, sessionId, 'episodic_write_failure', detail)` | Existing convention; CLAUDE.md cites it (`event_kind='reranker_fallback'`). |
| Migration registration | Custom migration system | `src/core/migrations.ts` step-table + `src/core/migration-steps.ts` exemplars | Already V24; the pattern is established. |
| Content hash | New crypto code | Node's built-in `crypto.createHash('sha256')` (already used elsewhere in the repo, e.g., observation dedup) | Standard library; no new dependency. |
| In-memory test DB | New test scaffolding | The pattern in `src/tests/angel/heartbeat.test.ts` (`new Database(':memory:')` + run migrations) | Existing fixtures; consistent with the rest of the suite. |

**Key insight:** Phase 1 adds zero new dependencies. Every primitive is already in the codebase. The failure mode here is over-engineering: a fresh wrapper-stripping regex, a custom transaction helper, an artisanal telemetry channel. Reuse aggressively.

## Common Pitfalls

### Pitfall 1: Forgetting to bump `SCHEMA_VERSION`

**What goes wrong:** Migration step exists, but the runner skips it because `SCHEMA_VERSION` constant in `src/shared/constants.ts` still says 24. Existing DBs never see V25.

**Why it happens:** Two-file change is easy to miss in a single PR.

**How to avoid:** Plan-checker validates SCHEMA_VERSION bump as a separate verification step. Test asserts post-migration that `db.pragma('user_version')` (or the `schema_versions` row, depending on the runner's tracking mechanism) equals 25.

**Warning signs:** New tests pass on fresh `:memory:` DB but fail in CI's persisted DB fixtures.

### Pitfall 2: CHECK constraint rejection silently dropped to telemetry

**What goes wrong:** A new provenance value (e.g., a typo `'organis'` instead of `'organic'`) is written by a hook → CHECK constraint fires → transaction rolls back → telemetry row written → silent data loss.

**Why it happens:** The closed enum is the entire point, but typos in the writer path can't be caught at compile time without a type union.

**How to avoid:** Define a TypeScript type union `type Provenance = 'organic' | 'injected' | 'tool_result' | 'environmental'` in `src/core/episodic-events.ts` and have all writer functions take it as a parameter. Compile-time enforcement + runtime CHECK constraint = belt-and-braces.

**Warning signs:** Hourly telemetry shows non-zero `episodic_write_failure` after Phase 1 ship.

### Pitfall 3: Wrapper regex drift

**What goes wrong:** The strip regex at `src/adapters/cc-hooks/user-prompt-submit.ts:266` lists 9 wrapper tags. Phase 2/3 work adds a new wrapper (e.g., `<curated-context>`) and forgets to update the parser.

**Why it happens:** Two copies of the regex (strip-only and split-into-rows) drift apart.

**How to avoid:** Lift the regex into `src/extraction/wrapper-parser.ts` as the single source of truth. Update `user-prompt-submit.ts:266` to call into it. A test asserts parity: every tag listed in the parser is also handled by the splitter (and vice versa).

**Warning signs:** Search hits like `<wrapper-name>` appearing inside `provenance='organic'` content rows.

### Pitfall 4: Tool-result rows for legitimately recall-driven content not labeled

**What goes wrong:** Some hooks already inject recall content into the prompt itself (not via tool calls). If those paths aren't audited, recall content reaches `episodic_events` as `provenance='organic'` — re-introducing the Mem0 trap.

**Why it happens:** The "hook-injected wrapper" framing assumes all recall lives in `<tag>...</tag>` blocks. But assembly may add prose-level recall hints.

**How to avoid:** Survey every place in `src/adapters/cc-hooks/` and `src/assembly/` that contributes to the user prompt as seen by the agent. Confirm that ALL recall content is wrapped. Audit table goes into the SUMMARY.md so Phase 3 knows the contract.

**Warning signs:** Phase 5 cluster surfaces patterns that quote injected content back to the agent.

### Pitfall 5: Session boundary events written before session row exists

**What goes wrong:** `session_boundary` events written during session-start may race against the session row creation; foreign-key-like assumptions break.

**Why it happens:** No actual FK on `session_id` (Claudex's tables are loosely coupled), but downstream readers may assume the parent session exists.

**How to avoid:** Phase 1 only writes `session_boundary` AFTER the session row is created. Document this ordering in the helper's doc-comment. Phase 6 may revisit.

**Warning signs:** Orphaned `session_boundary` rows with `session_id` not in `sessions`.

## Code Examples

### Inserting an organic + injected pair (verified pattern from `lifecycle.ts:481-559`)

The existing `storeConversationTurnUserText` is the template. The new dual-write helper extends it:

```typescript
// src/core/episodic-events.ts (new module)
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { cachedPrepare } from './stmt-cache.js';
import { emitTelemetry } from '../observability/telemetry.js';
import { parseWrappers } from '../extraction/wrapper-parser.js';

export type Provenance = 'organic' | 'injected' | 'tool_result' | 'environmental';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function dualWriteUserPrompt(
  db: Database,
  sessionId: string,
  project: string,
  rawPrompt: string,
): void {
  // ... see Pattern 2 above for full implementation
}
```

### Test pattern for EPI-07 (the structural-impossibility proof)

```typescript
// src/tests/adapters/episodic-events/dual-write-user-prompt.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/migrations.js';
import { dualWriteUserPrompt } from '../../../core/episodic-events.js';

describe('dualWriteUserPrompt — EPI-07 trap test', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('splits a prompt with one <experience-data> wrapper into 1 organic + 1 injected row', () => {
    const prompt = 'How do I fix this bug?\n<experience-data>previous lesson</experience-data>\nThanks';
    dualWriteUserPrompt(db, 'sess-1', 'test-proj', prompt);

    const rows = db.prepare(
      `SELECT provenance, content, parent_event_id FROM episodic_events
       WHERE session_id = 'sess-1' ORDER BY id`
    ).all() as Array<{ provenance: string; content: string; parent_event_id: number | null }>;

    expect(rows).toHaveLength(2);

    const organic = rows.find(r => r.provenance === 'organic')!;
    expect(organic.content).not.toContain('<experience-data>');
    expect(organic.content).not.toContain('previous lesson');

    const injected = rows.find(r => r.provenance === 'injected')!;
    expect(injected.content).toBe('previous lesson');
    expect(injected.parent_event_id).toBe(organic.id ?? expect.any(Number));
  });

  it('Mem0 trap structurally impossible: extractor reading WHERE provenance=organic never sees injected', () => {
    const prompt = 'real question\n<experience-data>RECALLED CONTENT</experience-data>';
    dualWriteUserPrompt(db, 'sess-2', 'test-proj', prompt);

    const organicOnly = db.prepare(
      `SELECT content FROM episodic_events WHERE session_id = 'sess-2' AND provenance = 'organic'`
    ).all() as Array<{ content: string }>;

    expect(organicOnly).toHaveLength(1);
    expect(organicOnly[0].content).not.toContain('RECALLED CONTENT');
  });

  it('legacy conversation_turns row preserves the raw prompt unchanged (v4 backwards compat)', () => {
    const prompt = 'q\n<system-reminder>note</system-reminder>';
    dualWriteUserPrompt(db, 'sess-3', 'test-proj', prompt);

    const turn = db.prepare(`SELECT user_text FROM conversation_turns WHERE session_id = 'sess-3'`).get() as { user_text: string };
    expect(turn.user_text).toBe(prompt);
  });
});
```

## State of the Art

| Old Approach (v4) | Current Approach (v5 Phase 1) | When Changed | Impact |
|--------------------|-------------------------------|--------------|--------|
| `conversation_turns(user_text, assistant_text)` flat-text capture | `episodic_events` with provenance-tagged structured rows | This phase | Mem0 trap structurally impossible; Phase 2 indexes have a clean substrate. |
| Strip wrappers and discard | Strip + collect into `provenance='injected'` rows | This phase | Injected content becomes addressable, traceable, indexable — but never confused with organic. |
| Tool results captured implicitly via `assistant_text` substring | Tool results as first-class `provenance='tool_result'` rows | This phase | Phase 2 error-fingerprint index can target tool results without parsing. |
| Backfill missing data on schema change | Forward-only; no backfill | This phase | Avoids re-introducing the trap during the migration itself. |

**Deprecated/outdated** (NOT used in Phase 1):
- Pattern extraction at write time (Phase 4 deletes this).
- LLM calls inside hooks (forbidden — deadlock risk).
- Embedding inside hooks (deferred to Phase 2/3).

## Open Questions

1. **Where exactly do `environmental` events get written?**
   - What we know: Angel heartbeats, session-start markers, hook errors are listed in CONTEXT.md as `provenance='environmental'`.
   - What's unclear: which existing call sites need to grow an episodic write. The Angel codebase is in `src/angel/` and writes telemetry today; mapping each environmental write site is a Phase 1 implementation detail.
   - Recommendation: Plan 03's task includes a code-trace step that lists every existing site and decides per-site whether to add an episodic write OR defer (some may be too noisy).

2. **What's the exact telemetry `detail` JSON shape?**
   - What we know: CONTEXT.md says "must be enough to debug; exact field set is operational judgment."
   - What's unclear: planner's call.
   - Recommendation: `{ hook, attempted_rows, organic_id_or_null, error_message, error_stack_first_5_lines }`. Logged via `emitTelemetry` outside the transaction (so the telemetry write itself never rolls back).

3. **Does the Stop hook need a separate dual-write helper, or can it reuse `updateConversationTurnAssistant`?**
   - What we know: today, Stop fills in `assistant_text` on a row created by UserPromptSubmit. The episodic table doesn't need that split — every assistant_message row is created at Stop time.
   - What's unclear: whether to keep the legacy split-write pattern AND introduce a Stop-time episodic insert, or to refactor.
   - Recommendation: keep legacy split-write (preserves v4 behavior unconditionally), add Stop-time episodic insert. No refactor of legacy.

## Sources

### Primary (HIGH confidence)
- Internal codebase — `src/core/migration-steps.ts`, `src/core/migrations.ts`, `src/core/schema.ts`, `src/adapters/shared/lifecycle.ts`, `src/adapters/cc-hooks/{user-prompt-submit,stop,post-tool-use}.ts`. Patterns are the live convention.
- `.planning/phases/01-episode-substrate/01-CONTEXT.md` — locked decisions.
- `CLAUDE.md` (project) and `.claude/rules/hooks-safety.md` — hook deadlock and fire-and-forget guards.

### Secondary (MEDIUM confidence)
- `.planning/research/2026-05-04-v5-bound-episodes-framing.md` — architectural framing.
- `.planning/research/2026-04-30-v5-episodic-memory.md` — engineering precedents.

### Tertiary (LOW confidence)
- None. This phase has no external dependencies to verify.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every component already in the project; no library evaluation needed.
- Architecture: HIGH — patterns directly extracted from existing code.
- Pitfalls: HIGH — derived from the codebase's documented hook-safety rules and from CONTEXT.md's locked decisions.

**Research date:** 2026-05-04
**Valid until:** 2026-06-04 (30 days — internal codebase, slow drift).
