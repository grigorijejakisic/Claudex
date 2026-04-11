# Project Curated Context

## Summary

A privileged always-on injection slot per project (and globally), written authoritatively by the agent that just worked via `/endsession`, with Angel fallback extraction for crashed sessions. Read at `/starthere` as ground truth, superseding stale CLAUDE.md descriptions on conflict.

**Why this exists:** The assembly pipeline currently injects ~15 sections, all of which either (a) come from CLAUDE.md (which drifts), (b) compete for slots via RRF ranking (buried under noise), or (c) are chronological journals (not curated). None of them represent "the current mental model" as a privileged, always-on signal. This subsystem adds that missing primitive.

**What this does NOT fix:** LoCoMo retrieval quality. This subsystem bypasses retrieval, it does not improve it.

---

## Failure modes addressed

- **"Stores learnings but fails to apply them"** → authoritative slot with explicit `/starthere` rule to internalize, not buried in RRF ranking.
- **"Pipeline works for STORAGE but fails for APPLICATION"** → short write-read cycle (one session), no multi-hop degradation.
- **"Silent failures"** → `curator`, `trust_tier`, `status` fields make provenance auditable.
- **Mental model drift** (Lacuna-Betting reframe example) → explicit `reframe` type with supersession pointer.
- **"DO NOT REBUILD" confusion** → explicit `shipped` type flagged prominently in the always-on slot.
- **Working directory confusion** (two-repo projects) → `workspace_map` type with actual paths.

---

## Schema (V15 → V16 migration)

```sql
CREATE TABLE project_curated_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN (
    'mental_model', 'workspace_map', 'shipped',
    'reframe', 'constraint', 'preference'
  )),
  content TEXT NOT NULL,
  tags TEXT,
  supersedes_id INTEGER REFERENCES project_curated_context(id),
  curator TEXT NOT NULL CHECK(curator IN ('agent', 'angel')),
  trust_tier INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'superseded', 'proposed', 'archived')),
  source_session_id TEXT,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_pcc_project_status
  ON project_curated_context(project, status);
CREATE INDEX idx_pcc_project_type
  ON project_curated_context(project, type, status);
```

### Field semantics

| Field | Meaning |
|---|---|
| `project` | Project name OR `'__global__'` for cross-project entries |
| `type` | One of the six curated types (see below) |
| `content` | The payload — ≤500 chars, active voice |
| `tags` | JSON array, free-form |
| `supersedes_id` | Chain-of-revisions; points to the entry being replaced |
| `curator` | `'agent'` (authoritative, written at `/endsession`) or `'angel'` (proposed, from background extraction) |
| `trust_tier` | 1=proposed, 2=confirmed, 3=promoted (user-marked permanent) |
| `status` | `active` (in rotation), `superseded` (replaced), `proposed` (Angel-written awaiting confirmation), `archived` (explicitly closed) |
| `source_session_id` | Provenance — which session produced this entry |

### Type matrix (which types are valid at which scope)

| Type | Project scope | Global scope | Example |
|---|---|---|---|
| `mental_model` | yes | yes | Global: "Honest assessment over pleasant answers." Project: "Racing Mozzart's stale feed, not courtsiding settlement lag." |
| `preference` | yes | yes | Global: "Prefer Sonnet for workers, Opus only for product-defining work." |
| `constraint` | yes | yes | Global: "Never commit without explicit user ask." Project: "Never touch the verifier — it's shipped." |
| `reframe` | yes | yes | Supersession pointer, either scope |
| `workspace_map` | yes | **no** | Global workspace makes no sense |
| `shipped` | yes | **no** | Shipped is per-project |

`workspace_map` / `shipped` scope restriction is enforced in the CRUD helper, not the DB CHECK — simpler to evolve.

---

## Assembly injection — new P2.1 slot

**Priority:** P2.1 (between Project at P2 and Session Continuity at P2.5).

**When:** session-start and post-compaction. NOT on regular prompts — this is boundary-only injection.

**Budget:** standard budget-gated, but sits early in the cascade so it almost always fits. Soft cap ~1500 tokens; when over cap, eviction order inside `formatCuratedContextSection`:
1. Oldest `proposed` entries (Angel-written, not yet confirmed)
2. Oldest non-reframe, non-constraint `active` entries
3. `constraint` and `reframe` entries are load-bearing — never auto-evicted (only replaced via explicit supersession)

**Rendering format:**

```
## Project Curated Context
Project-curated by the agent at end-of-session. Supersedes CLAUDE.md on conflict.

### Global — Rules & Preferences
- Honest assessment over pleasant answers. [confirmed]
- Prefer Sonnet for workers, Opus only for product-defining work. [confirmed]

### Mental Model
- Racing Mozzart's stale feed, not courtsiding settlement lag. (session 17)
- [proposed] The Azuro channel is parked — focus is Mozzart–bet365. (angel, session 23)

### Workspace Map
- docs: ~/Desktop/Projects/Lacuna-Betting
- code: ~/Desktop/Lacuna

### Shipped — DO NOT REBUILD
- bet365_zap_verifier — Lacuna/src/verifier/zap.ts (session 22)
- mozzart_feed_watcher — Lacuna/src/feeds/mozzart.ts (session 24)

### Constraints
- Never touch the verifier — load-bearing, shipped.
```

Global entries render first (global rules apply regardless of project), then project entries grouped by type.

---

## Write paths

### 1. Agent at `/endsession` (authoritative — `curator='agent'`, `tier=2`)

Agent reviews existing curated entries for the project, adds new ones that emerged during the session, marks stale entries as superseded. No user confirmation required — the agent has full session context and is the curator.

Global entries written at `/endsession` require an explicit user directive in the session ("from now on always X", "never Y"). Inferred global rules are NOT written by the agent — they go through Angel's fallback path.

### 2. Angel extraction (proposed — `curator='angel'`, `tier=1`, `status='proposed'`)

Runs in the heartbeat for completed sessions that don't yet have agent-curated entries. Scans transcript for reframe / directive signals (regex + LLM classification). Writes proposed entries that the next agent in the project (or any project, for global) confirms/archives at its own `/endsession`.

### 3. User promotion (tier 3)

Reserved for entries the user explicitly marks as permanent via MCP action. Tier 3 entries are immune to auto-eviction and render with a `[promoted]` marker.

---

## Read path — `/starthere` rule

New rule in the `/starthere` skill wording:

> **Internalize Curated Context**: If `## Project Curated Context` appears in the injected context, those entries are authoritative for this project and globally. They supersede stale CLAUDE.md descriptions on conflict. Do not ask the user to confirm them. Use them as ground truth for workspace paths, mental model, shipped components, global preferences, and constraints. If an entry contradicts CLAUDE.md, the entry wins — flag the drift in your opening response so the user can decide whether to update CLAUDE.md.

---

## Relationship to existing systems

- **Experience patterns** stay as-is. They are the broad auto-extracted RRF-ranked layer. Curated context is the explicit, always-on, non-ranked layer. They coexist.
- **Proven principles** (P4.1) are similar in spirit (always-on global rules) but derived from experience-pattern promotion. Curated context global entries bypass that loop — they come directly from explicit user directives.
- **CLAUDE.md** remains the human-editable anchor. Curated context supplements it and can supersede it, but does not replace it. If a curated entry has been stable for a long time, the user can still manually promote it into CLAUDE.md.

---

## Implementation phases

| Phase | Scope | Status |
|---|---|---|
| **1. Schema + injection** | V16 migration, CRUD helpers, formatter, P2.1 wire-in, tests | **this commit** |
| **2. Agent write path** | MCP tool `claudex_curated_context`, `/endsession` skill diff | pending |
| **3. Angel extraction** | `curated-context-extractor.ts`, heartbeat wire-in | pending |
| **4. `/starthere` rule** | Skill wording update | pending |

Each phase is a separate atomic commit. Phase 1 is read-only from the agent's perspective — until Phase 2 ships, entries can only be seeded via direct SQL. This is fine for internal testing.

---

## Open design questions (for future phases)

- Should Phase 3 Angel extractor use Opus (via CliProxy) or Ollama? Opus for quality, Ollama as fallback. Needs measurement.
- Should tier 3 promotion require an explicit user action, or can Angel auto-promote entries that survive N sessions without being archived? Auto-promotion is convenient but risks entrenching wrong entries.
- Should global entries have per-project opt-out? E.g., "Prefer Sonnet" applies generally but maybe one project wants Opus everywhere. Out of scope for Phase 1.
