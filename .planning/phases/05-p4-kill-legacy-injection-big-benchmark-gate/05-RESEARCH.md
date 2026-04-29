# Phase 5: P4 — Kill legacy injection - Research

**Researched:** 2026-04-29
**Domain:** assembly cascade deletion, cache-stable injection, behavioral verification (Vesna)
**Confidence:** HIGH (codebase-verified) / MEDIUM (Vesna probe shape — specific suite is in Phase 10)

<user_constraints>
## User Constraints (from CONTEXT.md + AMENDMENT)

### Locked Decisions

**Pre-flight safety (STOR-08, team-lead directive):**
- DB backup at `~/.claudex/backups/pre-v4-P4-{ts}.db` MUST be taken and verified restorable before any code change to `assembler.ts` lands. Backup gate is plan task 05-01-pre.

**Deletion sequencing & bisectability:**
- One commit per deleted section (atomic, bisectable). Mega-commit forbidden.
- Tier-based deletion (per ROADMAP SC#7):
  - **Tier A** (lowest signal density): Flow, Reference Layer, Materialization
  - **Tier B**: Predicted Context, Angel Opinions, Proven Principles
  - **Tier C** (highest density, last to cut): Entity Summaries auto-surface, Curated Context, Experience Warnings auto-surface
- Vitest must pass after every commit.
- Per-tier verification: Vesna + content-quality + cache-stability run at each tier boundary (NOT LongMemEval — see AMENDMENT).
- BENCH-09 telemetry/per-commit LongMemEval spot-checks DROPPED per AMENDMENT — superseded.

**`initialUserMessage` auto-prime mechanics (INJ-06):**
- System-role prime; fires only when handoff frontmatter `status: active` AND `phase` matches `STATE.md` (no mtime gate).
- Project-scoped: `<projectDir>/context/handoffs/ACTIVE.md` (not `.planning/handoffs/`). Existing `session-start.ts:329-375` implementation reads `context/handoffs/ACTIVE.md`; preserve that path.
- Format: `"Resume handoff: <ACTIVE.md first-line summary>. Full state at .planning/handoffs/ACTIVE.md."` per CONTEXT — but updated by AMENDMENT to align with Phase 7.5's YAML-frontmatter handoff format. Use the `summary:` field if present; fall back to first H1/non-blank line.
- Fires once per session-start, NOT per UPS turn.
- Kills the existing auto-`/starthere` injection at `src/adapters/cc-hooks/session-start.ts:333+` (currently behind `auto_prime` config flag — must become the default behavior, gated by frontmatter contract not config).

**Experience-warning trigger surface (INJ-07):**
- Removed from auto-surface in session-start. Resurfaces on:
  - Explicit query keyword match in user prompt (`"do you remember"`, `"have we"`, `"last time"`)
  - PreToolUse path trigger: regex match on Edit/Write `file_path` against stored experience-pattern `path_glob` field
  - PreToolUse command trigger: substring match on Bash `command` against stored experience-pattern `command_substring` field
- Implemented in UPS, not session-start (reactive not proactive).

**Cache-stability verification (CACH-01, CACH-02, SC#2):**
- Snapshot test on `assembler.ts` output for fixed corpus (≥4 scenarios: cold start, warm start with MEMORY.md, handoff start, GSD-active start).
- Hash output, assert byte-identical across two consecutive invocations with identical inputs.
- Layer 1: tokenizer assertion ≤500 tokens (cl100k_base via `gpt-tokenizer` or `tiktoken`).
- Layer 2: golden snapshot byte-identical across consecutive runs.
- Layer 3: invariance under volatile-state mutation — clock change, session-ID change, host-env change must NOT change output bytes.
- Test file: `src/tests/assembly/assembler.cache-stability.test.ts`.

**Pre-work hardening (CACH-03 — must land before deletion):**
- Clock leaks: 3 sites — `assembler.ts:572` (`STALE_OBS_CUTOFF`), `assembler.ts:657` (`lastSessionEpoch` fallback), `assembler.ts:447` (currently `unixepoch() - 604800` inside SQL — verify that's stable since SQL evaluation is deterministic per call but the *value* changes with clock).
- Session-ID strips: 2 sites — `sections.ts:859` (`getSessionAttribution(a.session_id, currentSessionId)`), `sections.ts:1005-1006` (session-ID slice in journal note).
- Host-env normalization: 2 sites — `sections.ts:635`, `assembler.ts:646` (path separators / project-relative shortener).
- Stable tiebreakers: 4 sites — `learnings.ts:60`, `artifacts.ts:178/:212`, `codebase-indexer.ts:306`, `state-reader.ts:109`.
- CRLF/BOM normalizer + `.gitattributes * text eol=lf`.
- STATE.md parser extension (extract phase NAME + number; current `parseStateMd` at `state-reader.ts:66` only extracts number).
- Handoff frontmatter spec (canonical `status:`, `phase:` keys — used by INJ-06).

**Fallback ladder execution policy:**
- Stop after each rung for human review. Autonomous climbing forbidden.
- L1: raise UPS budget 1KB → 2KB; re-run Vesna. Autonomous IF UPS budget split from session-start budget first.
- L2: keep one injection section (highest-signal-density first; manual review). Reset L1's UPS bump.
- L3: dual-inject diagnostic mode via env flag `CLAUDEX_P4_INJECTION_MODE=lean|entity_only|dual` ("Ghost Code" pattern, NOT branch checkout). Run targeted Vesna probes lean vs dual to attribute which section(s) carry recall load. Funeral PR deletes legacy after gate passes.
- L4: full revert to Phase 4.1 candidate. Pre-condition: MEMORY.md SC#3 score delta must show measurable improvement before next attempt.

**L3 attribution telemetry:**
- AMENDMENT: attribution mechanism shifted from LongMemEval-delta to **Vesna-delta** per section. `scripts/p4-attribute-l3.ts` reads telemetry and emits per-section Vesna pass-rate delta; methodology stays "scripted, not eyeball." Telemetry written to `benchmarks/results/p4-fallback/L3-attribution.json` (path retained from CONTEXT for continuity).

### Claude's Discretion

- Tokenizer choice for ≤500 token measurement: `gpt-tokenizer` package (cl100k_base equivalent, MIT, no native build) recommended over `tiktoken` (Rust binding, build issues on Windows — Phase 1 primer noted similar pain).
- Filename for `initialUserMessage` prime emitter: extend existing logic in `src/adapters/cc-hooks/session-start.ts` (already does this behind `auto_prime` flag); rewrite that block, no new file needed.
- Test fixture reuse: reuse existing `src/tests/assembly/assembler.test.ts` setup helpers (`createTestDb`, fixture builder); add new `assembler.cache-stability.test.ts` rather than extending existing.
- Vesna probe subset selection per tier: minimum 5 probes per tier boundary (entity recall, constraint recall, handoff pickup categories prioritized). Phase 10 will provide the full suite; Phase 5 uses whatever subset is live when 5 ships.
- Config flag for L3 dual-inject mode: env var `CLAUDEX_P4_INJECTION_MODE` with values `lean` (default after deletion), `entity_only` (L2 keep-one), `dual` (L3 diagnostic).
- BENCH-09 telemetry table cleanup: deferred to Phase 9.X cleanup, NOT touched in 5.

### Deferred Ideas (OUT OF SCOPE)

- LLM-based intent classifier for experience-warning surfacing (keyword match in v1).
- Staleness/hash gating on `initialUserMessage` prime (frontmatter contract is the gate).
- Auto-climbing fallback ladder without human approval.
- Glob/Grep result triggers for experience warnings (v1 is too noisy).
- LongMemEval / LoCoMo / BENCH-05/06/07/09 as gates — DROPPED per v4 rebind. Not run in Phase 5 acceptance.
- Directory rename of `05-p4-kill-legacy-injection-big-benchmark-gate` (out of scope; touches refs).
- BENCH-09 telemetry table drop (deferred to 9.X cleanup).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INJ-01 | Session-start ≤500 tokens (identity, handoff pointer, MEMORY.md native load, active safety-critical signals) | Identified surviving sections (Identity, Project=CLAUDE.md, Session Continuity, Checkpoint, GSD); requires removing Claudex Ready (~70t) into a tightened Identity, project_overview, codebase_index, learnings, rules_reminder paths from the cascade |
| INJ-02 | Remove from `assembler.ts`: Proven Principles, Entity Summaries auto-surface, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization | Locations identified (see "Deletion site map" below) |
| INJ-03 | Keep assembler sections: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD | These remain. Note also: project_overview, codebase_index, learnings, rules_reminder, claudex_ready exist in current cascade and need explicit keep/delete rulings (see "Surviving cascade gaps") |
| INJ-04 | All surviving injected text stripped of timestamps, turn counts, session IDs, wall-clock — cache-stable prefix | CACH-03 hardening sites enumerated; sections.ts:859 + 1005 strip session-IDs |
| INJ-05 | UPS per-turn payload ≤1KB; only dynamic signals | `assembleRegularPrompt()` cascade at `assembler.ts:819` reviewed below |
| INJ-06 | `initialUserMessage` auto-prime — system-role; status+phase frontmatter contract; replaces auto-`/starthere` at `session-start.ts:333+` | Existing `auto_prime` block at lines 326-375 found — rewrite block to default-on with frontmatter contract gate |
| INJ-07 | Experience-warning content surfaces only on explicit agent query OR PreToolUse hook trigger — never auto-injected at session-start | Move `renderExperienceWarnings()` callers from `assembler.ts:295-303` (full assembly) to UPS + PreToolUse hook |
| CACH-01 | Golden snapshot byte-identical across runs (3-layer cache test, layer 1) | Snapshot test pattern proven by `src/tests/assembly/assembler.test.ts` already; new `assembler.cache-stability.test.ts` builds on this |
| CACH-02 | Invariance under volatile-state mutation — clock change, session-ID change, host-env change | Test mutates `Date.now`, session-ID, OS path separators between snapshots; assert hash equal |
| CACH-03 | Pre-work hardening before deletion (clock/session/host/tiebreakers/CRLF/parser/handoff) | All sites enumerated above |
| TOK-01 | Session-start ≤500 tokens (tokenizer assertion on actual session-start output). Hard. | Use `gpt-tokenizer` (cl100k_base) in dedicated test |

</phase_requirements>

## Summary

Phase 5 deletes 9 legacy injection sections from `src/assembly/assembler.ts`'s `assembleFullContext()` function, drops session-start to ≤500 tokens cache-stable, drops UPS per-turn to ≤1KB, replaces the existing config-gated `auto_prime` block in `session-start.ts` with a default-on `initialUserMessage` driven by handoff frontmatter contract, and moves experience warnings from auto-surface to reactive triggers. The work is gated by **SC#1 (Vesna ≥80%)**, **SC#2 (≤500 tokens cache-stable, 3-layer test)**, **SC#3 (MEMORY.md content-quality ≥80% — must NOT regress)**, and **SC#4 (one-turn handoff pickup)** — NOT by LongMemEval/LoCoMo (DROPPED per AMENDMENT). MEMORY.md (Phase 4.1's deliverable) is the new injection that replaces the deleted sections via CC's native load path.

Pre-deletion hardening (CACH-03) lands first to make the assembler output deterministic; deletion sequence is tiered (A: low-density → C: high-density), one commit per section, with vitest + Vesna + content-quality + cache-stability run at each tier boundary. A fallback ladder (L1 UPS bump → L2 keep-one → L3 dual-inject Ghost Code attribution → L4 full revert to 4.1 candidate) handles regressions, with human approval at each rung.

**Primary recommendation:** Land hardening (Plan 1) and pre-flight backup + DB snapshot (Plan 1) before touching deletion code. Build the cache-stability test harness (Plan 2) first so every subsequent commit has a green/red gate. Then delete tiered (Plans 3-5), one section per commit, running cache + Vesna + content-quality at each tier boundary. Wrap with INJ-06 prime rewrite (Plan 6), INJ-07 experience-warning move (Plan 7), and a final close plan (Plan 8) that runs the full SC#1-#4 gate.

## Standard Stack

### Core (already in repo — no installs needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `vitest` | latest | Snapshot tests, integration tests | Project test runner; project rule "Do NOT use `bun test`" |
| `better-sqlite3` | already used | Test fixtures DB access | Project standard via `Database` import |
| `gpt-tokenizer` | ^2.x | cl100k_base token counting (TOK-01) | Pure-JS, no native build, MIT license — no Windows native-build pain (vs `tiktoken`) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `crypto` (node built-in) | — | SHA-256 hash for snapshot byte-equality | Cache-stability test layer 2 |
| existing project test helpers | — | DB fixture, project dir setup | Reuse `src/tests/assembly/assembler.test.ts` setup helpers (`createTestDb`, etc.) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `gpt-tokenizer` | `tiktoken` (Rust-bound) | Faster, but native build issues on Windows historically |
| Vitest snapshot files | Manual SHA-256 hashes in JSON | Snapshot files give richer diffs on regression; hashes are stricter byte-equality. Use BOTH: vitest snapshot for content readability + crypto.hash for explicit byte-identical assertion |
| New experience-warning hook | Add gating into existing `pre-tool-use.ts` | Reuse existing — `pre-tool-use.ts` already exists in `src/adapters/cc-hooks/`; PostToolUse triggers experience patterns elsewhere |

**Installation:**
```bash
bun add gpt-tokenizer
```

## Architecture Patterns

### Recommended Project Structure (no new dirs)

```
src/
├── assembly/
│   ├── assembler.ts        # MUST shrink — 9 sections deleted
│   └── sections.ts         # MUST harden — clock/session-ID strips
├── adapters/cc-hooks/
│   ├── session-start.ts    # initialUserMessage rewrite (INJ-06)
│   ├── user-prompt-submit.ts  # experience-warning explicit-query trigger (INJ-07)
│   └── pre-tool-use.ts     # experience-warning path/command trigger (INJ-07)
├── gsd/
│   └── state-reader.ts     # parseStateMd extension — phase NAME (CACH-03)
├── core/
│   ├── learnings.ts        # tiebreaker fix line 60 (CACH-03)
│   └── artifacts.ts        # tiebreaker fix lines 178/212 (CACH-03)
├── indexer/
│   └── codebase-indexer.ts # tiebreaker fix line 306 (CACH-03)
└── tests/
    └── assembly/
        ├── assembler.test.ts (existing — keep)
        └── assembler.cache-stability.test.ts (NEW — Plan 2)

scripts/
└── p4-attribute-l3.ts      # Vesna-delta attribution tool (only built if L3 fires)

benchmarks/results/p4-fallback/
└── L3-attribution.json     # produced when L3 fires (NOT pre-built)
```

### Pattern 1: Tiered Deletion with Per-Tier Gate

**What:** Each tier is a sequence of single-section deletions. Between tiers, run cache-stability + Vesna probes + SC#3 scorer + token budget assert. If any fail, stop and trigger fallback ladder.

**When to use:** This phase. Do NOT batch deletions across tier boundaries.

**Per-deletion commit shape:**
```
feat(05): delete <section> from assembleFullContext

- Removed Priority 4.X / LAYER X block from assembler.ts
- Removed dependency: <imports>
- Tests: vitest pass, snapshot updated
- Token budget: 643 → 587 (still over 500; tier in progress)
- Cache-stability: PASS
```

**Per-tier-boundary commit shape:**
```
feat(05): close Tier A (Flow, Reference, Materialization)

Verification:
- Vesna: 16/20 (80%, threshold met)
- SC#3 content-quality: 87/100 (no regression vs 89/100 baseline within ±5)
- Cache-stability 3-layer: PASS
- Token budget: 643 → 412 (under 500 — INJ-01 ✓)
```

### Pattern 2: Cache-Stability 3-Layer Test (CACH-01/02, SC#2)

**What:** Single test file with 3 logical layers, run on a fixed corpus of 4+ scenarios.

**When to use:** Mandatory CI gate from this phase forward.

**Code shape:**
```typescript
// src/tests/assembly/assembler.cache-stability.test.ts
import { encode } from 'gpt-tokenizer';
import { createHash } from 'crypto';

const SCENARIOS = [
  { name: 'cold-start', setup: makeColdStart },
  { name: 'warm-start-with-memory-md', setup: makeWarmStart },
  { name: 'handoff-start', setup: makeHandoffStart },
  { name: 'gsd-active-start', setup: makeGsdActiveStart },
];

for (const sc of SCENARIOS) {
  describe(`cache-stability: ${sc.name}`, () => {
    test('layer 1 — token budget ≤500', () => {
      const out = sc.setup().run();
      const tokens = encode(out.content).length;
      expect(tokens).toBeLessThanOrEqual(500);
    });

    test('layer 2 — byte-identical across consecutive runs', () => {
      const ctx = sc.setup();
      const a = ctx.run();
      const b = ctx.run();
      expect(hash(a.content)).toBe(hash(b.content));
    });

    test('layer 3 — invariant under volatile mutation', () => {
      const ctx = sc.setup();
      const baseline = ctx.run();
      // mutate clock
      vi.setSystemTime(Date.now() + 100_000);
      // mutate session-ID
      ctx.sessionId = 'different-uuid-here';
      // mutate host env: simulate \\ vs / in cwd
      ctx.projectDir = ctx.projectDir.replace(/\\/g, '/');
      const mutated = ctx.run();
      expect(hash(baseline.content)).toBe(hash(mutated.content));
    });
  });
}
```

### Pattern 3: `initialUserMessage` Frontmatter-Gated Prime (INJ-06)

**What:** Replace existing `auto_prime` config-flag block (`session-start.ts:326-375`) with default-on logic gated by handoff frontmatter `status: active` AND `phase` matching STATE.md.

**When to use:** This phase, exactly once.

**Code shape (replaces existing block):**
```typescript
// src/adapters/cc-hooks/session-start.ts (replaces lines 326-375)
let initialMessage: string | undefined;
try {
  const sessionType = (input.type as string) ?? '';
  if (sessionType === 'startup' || sessionType === '') {
    const handoffPath = path.join(input.cwd, 'context', 'handoffs', 'ACTIVE.md');
    if (fs.existsSync(handoffPath)) {
      const handoffContent = fs.readFileSync(handoffPath, 'utf-8');
      const fm = handoffContent.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        const fmBlock = fm[1];
        const isActive = /^status:\s*active\b/im.test(fmBlock);
        const handoffPhaseMatch = fmBlock.match(/^phase:\s*(.+?)\s*$/im);
        const handoffPhase = handoffPhaseMatch?.[1]?.trim();

        // Read STATE.md phase number for match check
        const statePath = path.join(input.cwd, '.planning', 'STATE.md');
        let statePhase: string | undefined;
        if (fs.existsSync(statePath)) {
          const stateContent = fs.readFileSync(statePath, 'utf-8');
          const m = stateContent.match(/Phase:\s*(\d+(?:\.\d+)?)/);
          statePhase = m?.[1];
        }

        if (isActive && handoffPhase && statePhase && handoffPhase.startsWith(statePhase)) {
          // Extract first-line summary: prefer `summary:` frontmatter key, fall back to first non-blank H1 line in body
          const summaryMatch = fmBlock.match(/^summary:\s*["']?(.+?)["']?\s*$/im);
          let summary = summaryMatch?.[1]?.trim();
          if (!summary) {
            const body = handoffContent.slice(fm[0].length).trim();
            summary = body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim();
          }
          if (summary) {
            initialMessage = `Resume handoff: ${summary}. Full state at .planning/handoffs/ACTIVE.md.`;
          }
        }
      }
    }
  }
} catch { /* non-fatal — auto-prime is best-effort */ }
```

### Anti-Patterns to Avoid

- **Mega-commit deletion:** Multi-section deletion in one commit destroys bisectability. Each section gets its own commit.
- **Branch checkout for L3:** AMENDMENT explicitly says env-flag dual-inject ("Ghost Code"), NOT branch checkout. Branch checkout loses the in-process attribution telemetry.
- **Deleting the cascade *AND* hardening sources in the same commit:** CACH-03 hardening lands first as a separate, no-behavior-change commit so the cache-stability test can validate post-hardening / pre-deletion baseline.
- **Removing `MEMORY.md` injection from CC's native load path:** MEMORY.md is loaded by CC outside `assembler.ts`. Phase 5 does NOT touch CC's native load — only `assembler.ts` and UPS path.
- **Auto-climbing fallback ladder:** Each rung stops for human review. Don't add a config flag to skip the gate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting | Char-divided-by-4 estimator beyond `estimateTokens()` for the SC#2 hard gate | `gpt-tokenizer.encode().length` for CACH-01 layer 1 | The internal `estimateTokens()` is a heuristic — fine for budget cascade, not fine for the SC#2 hard 500-token assertion. Use the real cl100k_base tokenizer for the gate. |
| Frontmatter parsing | Custom regex for handoff frontmatter beyond what's already in `session-start.ts:348` | Existing simple regex pattern (status/phase only) | Phase 7.5 will introduce a richer frontmatter parser. For Phase 5, the current line-anchored regex is sufficient and avoids introducing `gray-matter` dependency. |
| Vesna probe runner | New harness for per-tier verification | Phase 10's existing harness when it ships; until then, manual Vesna probes (5 minimum per tier) | The full suite is parallelizable per ROADMAP. Phase 5 uses whatever subset is live. |
| Cache-stability snapshot serialization | Hand-rolled JSON dumps of full assembler context | Vitest snapshot + SHA-256 hash | Snapshot file gives a readable diff in CI; hash gives strict byte-equality. Vitest's `toMatchSnapshot()` is the standard. |
| L3 dual-inject mode | New module / config object | Env flag `CLAUDEX_P4_INJECTION_MODE` checked at top of `assembleFullContext()` | Single env var, single branch — no config-system entanglement. Reverts cleanly when L3 closes. |

**Key insight:** The cascade is dense (1102 lines in `assembler.ts`), but the deletion is mechanical — every section is bracketed by `// === LAYER X ===` or `// Priority N.X:` comments. Resist the urge to refactor surrounding code while deleting; surgical removal first, refactor in a later phase.

## Common Pitfalls

### Pitfall 1: Deleting an import that's still used

**What goes wrong:** Section X imports helper Y; deletion of section X also deletes the import, but helper Y is also used by section Z (which survives).

**Why it happens:** `assembler.ts` has 30+ imports. Section deletions touch imports.

**How to avoid:** After each deletion, run `bun run build` (esbuild ~70ms) — TS will catch unused imports and stale references immediately.

**Warning signs:** Build succeeds but tests fail with `ReferenceError`.

### Pitfall 2: Snapshot test "passes" because content was re-snapshotted

**What goes wrong:** Developer runs `vitest -u` (update snapshots) when test fails, masking a real regression.

**Why it happens:** Vitest UX makes update easy.

**How to avoid:** CI runs `vitest --run` (no `-u`); snapshot files committed to git; PR review checks for unintended snapshot diff.

**Warning signs:** Snapshot diff in PR larger than expected for the change.

### Pitfall 3: Cache-stability layer 3 (volatile mutation) passes by accident

**What goes wrong:** Test mutates clock/session-ID/host-env BEFORE the first run, so both runs use the mutated values — no actual invariance check.

**Why it happens:** Test setup ordering is subtle.

**How to avoid:** Layer 3 test ALWAYS calls `ctx.run()` (baseline), then mutates, then calls `ctx.run()` (mutated), then compares.

**Warning signs:** Test passes even when CACH-03 hardening is incomplete.

### Pitfall 4: `initialUserMessage` fires for non-startup session types

**What goes wrong:** CC fires SessionStart with `type: 'resume'` or `type: 'compact'`. Auto-prime fires on those, surprising the user mid-session.

**Why it happens:** Existing code at `session-start.ts:332` already gates on `type === 'startup' || ''`. Plan 6 must preserve this gate.

**How to avoid:** Test fixture covers all 3 session types: startup, resume, compact. Only startup yields `initialUserMessage`.

**Warning signs:** User reports "system started talking about old work after I asked something new."

### Pitfall 5: Tier C deletion regresses Vesna by >5pp

**What goes wrong:** Tier C contains the highest-signal sections. Deleting Entity Summaries / Curated Context / Experience Warnings sequentially can drop Vesna recall below 80%.

**Why it happens:** MEMORY.md may not yet have full coverage of what Curated Context provided.

**How to avoid:** Per-tier gate STOPS deletion at Tier B if Vesna already at threshold; Tier C only proceeds if Vesna is comfortably above 80% (e.g., ≥85%) so we have headroom.

**Warning signs:** Tier B post-gate Vesna is exactly 80% — too tight; trigger fallback ladder before Tier C.

### Pitfall 6: STATE.md phase mismatch on decimal phase numbers

**What goes wrong:** Handoff frontmatter says `phase: 4.1` but STATE.md says `Phase: 4` — `startsWith` check passes, prime fires on Phase 4 handoff during a Phase 4.1 session.

**Why it happens:** Decimal phases share integer prefix.

**How to avoid:** Use exact match OR a more careful prefix rule (e.g., `handoffPhase === statePhase` exactly, accept `.x` extensions).

**Warning signs:** Two phases in a row use the same handoff prime.

## Code Examples

### Identifying section boundaries in `assembler.ts`

The 9 deletable sections are clearly bracketed in `assembleFullContext()`:

| Section | Lines (current) | Source name |
|---------|-----------------|-------------|
| Curated Context | 316-331 | `curated_context` |
| Experience Warnings (auto-surface) | 291-303 | `experience_warnings` |
| Entity Summaries (auto-surface) | 379-399 | `entity_summaries` |
| Angel Opinions | 401-423 | `angel_opinions` |
| Proven Principles | 425-441 | `proven_principles` |
| Flow | 491-505 | `flow` |
| Reference Layer (LAYER 2) | 507-523 | `reference_layer` |
| Materialization (LAYER 3) | 525-633 (largest) | `materialized` |
| Predicted Context | 693-713 | `predicted_context` |

**Surviving cascade (per INJ-03 + claudex_ready/codebase_index/learnings/project_overview/rules_reminder which ROADMAP doesn't mention):**

| Section | Lines | Source name | Status per ROADMAP |
|---------|-------|-------------|--------------------|
| Identity | 268-276 | `identity` | KEEP (INJ-03) |
| Claudex Ready | 281-289 | `claudex_ready` | **AMBIGUOUS** — ROADMAP says "remove auto-surface of [9 listed]"; Claudex Ready is not listed. Recommend KEEP (~70 tokens, navigation reinforcement, cache-stable). |
| Project | 306-314 | `project` | KEEP (INJ-03) |
| Session Continuity | 333-348 | `session_continuity` | KEEP (INJ-03) |
| Checkpoint | 351-361 | `checkpoint` | KEEP (INJ-03) |
| Learnings | 363-377 | `learnings` | **AMBIGUOUS** — not in deletion list, not in keep list. Recommend KEEP (top 5 cross-session learnings, dedup'd from materialization which gets deleted). |
| Project Overview | 443-473 | `project_overview` | **AMBIGUOUS** — recommend KEEP for cross-project awareness (cap at 1 line per project, ≤5 projects). Audit token cost; if >100, simplify or delete. |
| Rules Reminder | 475-489 | `rules_reminder` | KEEP (post-compaction only). |
| Codebase Index | 636-690 | `codebase_index` | **AMBIGUOUS** — 800-token cap, only at session-start. Recommend KEEP — token-bounded, no clock leak after CACH-03 hardening. |
| GSD | 715-727 | `gsd` | KEEP (INJ-03). |

**Action item for the planner:** Plan 1 (hardening + scope decisions) MUST resolve the AMBIGUOUS items via explicit team-lead query OR research the token impact. Going into Plan 3 (Tier A) without these decisions risks scope drift.

### UPS cascade survey (`assembleRegularPrompt()` at `assembler.ts:819`)

Read this function to confirm the UPS payload composition; current sections include intent-triggered patterns, critical reminders, proven principles (per UPS), experience warnings (FTS5+vector). UPS deletion targets per ROADMAP SC#4 ("only dynamic signals carried"): proven principles can stay (per-turn cap 500t), but the per-turn experience-warning auto-fire moves to PreToolUse / explicit-query gate (INJ-07).

**Token cap:** 1KB ≈ ~250 cl100k_base tokens (rough char/4). Hard assert in test.

### Pre-flight backup script (Plan 1)

```bash
# scripts/p4-pre-backup.sh (or .ts)
TS=$(date +%s)
mkdir -p ~/.claudex/backups
cp ~/.claudex/db/claudex.db ~/.claudex/backups/pre-v4-P4-${TS}.db
# Verify restorability: open with sqlite3, run a smoke query
node -e "
const Database = require('better-sqlite3');
const db = new Database('${HOME}/.claudex/backups/pre-v4-P4-${TS}.db', { readonly: true });
const r = db.prepare('SELECT COUNT(*) as n FROM artifacts').get();
console.log('backup verified, artifacts count:', r.n);
db.close();
"
```

## State of the Art

| Old Approach (pre-Phase 5) | Current Approach (Phase 5) | When Changed | Impact |
|----------------------------|---------------------------|--------------|--------|
| 9-section auto-surface cascade in session-start | Lean ≤500-token cascade; MEMORY.md replaces auto-surface; experience warnings reactive | Phase 5 | Drops session-start tokens from ~3-5K to ≤500; cache-prefix becomes stable |
| `auto_prime` config flag (default off) | `initialUserMessage` default-on, frontmatter contract gates | Phase 5 (INJ-06) | One-turn handoff pickup (SC#4) |
| Experience warnings auto-fired in session-start full assembly | Reactive surface in UPS / PreToolUse | Phase 5 (INJ-07) | Less noise; warnings appear when relevant, not unconditionally |
| Per-commit LongMemEval spot-check (CONTEXT.md) | Per-tier Vesna + content-quality + cache-stability (AMENDMENT) | 2026-04-29 | Faster iteration; benchmark gates dropped per v4 rebind |

**Deprecated/outdated:**
- BENCH-09 telemetry (still present in code, removal deferred to Phase 9.X)
- The "BIG BENCHMARK GATE" framing in directory name and CONTEXT.md (superseded by AMENDMENT)
- `auto_prime` config flag — removed in this phase; replaced by frontmatter contract

## Open Questions

1. **Should `claudex_ready`, `learnings`, `project_overview`, `codebase_index` survive?**
   - What we know: ROADMAP SC#1-#2 enumerate 9 deleted + 5 kept by name. The 4 listed here are not in either list.
   - What's unclear: Were they intentionally omitted? Are they part of the implicit "keep" set because they're cache-stable post-CACH-03?
   - Recommendation: Plan 1 task explicitly raises this with team-lead via SendMessage; default to KEEP if no response (token-bounded, low risk). DELETE candidates have specific signals listed in deletion list.

2. **Vesna probe baseline — is there a pre-Phase-5 number to delta against?**
   - What we know: Phase 4.1 closed with SC#3 (content-quality) at ≥80%. SC#1 (Vesna) is Phase 10's territory.
   - What's unclear: What Vesna pass-rate exists today (Phase 5 entry)? AMENDMENT says ≥80% absolute, not delta.
   - Recommendation: Plan 1 task captures pre-Phase-5 Vesna baseline (whatever subset is live). If <80% before deletion, that's a Phase 4.1 follow-up, not Phase 5's problem.

3. **Does `STATE.md` phase line currently include phase NAME?**
   - What we know: `parseStateMd` at `state-reader.ts:66` parses only number. STATE.md currently shows `**Current Phase:** 4.1 (COMPLETE)` and `**Current Phase Name:** MEMORY.md content redesign + Lessons section`.
   - What's unclear: The CACH-03 task says "STATE.md parser extension (extract phase name + number)" — is this used by the prime, or just future-proofing?
   - Recommendation: Extend `parseStateMd` to optionally extract `Current Phase Name:` line. Use in handoff prime if available, else fall back to phase number match only.

4. **L3 dual-inject env flag — single env var or three states?**
   - What we know: AMENDMENT mentions `CLAUDEX_P4_INJECTION_MODE=lean|entity_only|dual`.
   - What's unclear: Three distinct values or boolean? Should `lean` be the implicit default (no env var set)?
   - Recommendation: Three explicit values; default to `lean` when unset. Document in env-vars.md or wherever flags live.

## Sources

### Primary (HIGH confidence)
- `src/assembly/assembler.ts` (lines 256-782 for `assembleFullContext`, 819-1041 for `assembleRegularPrompt`) — directly inspected
- `src/assembly/sections.ts` (lines 438, 444, 826, 1005-1006) — clock/session-ID leak sites verified
- `src/adapters/cc-hooks/session-start.ts` (lines 326-388) — existing `auto_prime` block
- `src/gsd/state-reader.ts` (lines 1-130) — `parseStateMd` API surface
- `.claude/rules/assembly-budget.md` — full cascade priority order
- `.planning/ROADMAP.md` — Phase 5 success criteria
- `.planning/phases/05-*/05-CONTEXT.md` — original phase context
- `.planning/phases/05-*/05-CONTEXT-AMENDMENT.md` — gate framing change
- `.planning/REQUIREMENTS.md` — INJ/CACH/TOK requirement bodies
- `.planning/phases/04.1-*/04.1-09-SUMMARY.md` — Phase 4.1 deliverables

### Secondary (MEDIUM confidence)
- Phase 4.1 plan SUMMARYs — for plan style precedent

### Tertiary (LOW confidence — flagged for validation)
- `gpt-tokenizer` package suitability on Windows — not directly verified in this repo; standard pure-JS package, low risk

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — packages already in use or pure-JS additions
- Architecture: HIGH — deletion sites verified by line inspection
- Pitfalls: MEDIUM — pitfalls 5 and 6 inferred from CONTEXT/AMENDMENT logic, not codebase-verified
- Open questions: 4 items flagged for planner / team-lead resolution

**Research date:** 2026-04-29
**Valid until:** 2026-05-13 (14 days; assembler.ts is actively under deletion in this phase, so source-of-truth shifts daily during execution)
