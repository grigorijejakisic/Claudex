# W4: Compaction Behavior Investigation

## Summary

Post-compaction triggers a full `assembleFullContext()` call — identical in structure to session-start but with one meaningful difference: the user's live prompt is passed as `searchQuery` for FTS5. The flag lifecycle is SQLite-backed per session. All 8 sections in the priority cascade are attempted post-compaction. Identity and project primer are not redundant because the injection point changes from `additionalContext` (session-start) to `systemMessage` (post-compaction). GSD is included and not skippable at current configuration. No race conditions exist. Budget cap is 4000 tokens (DEFAULT_CONFIG).

---

## Exact Flow Trace

### Phase 1: Pre-Compact Hook

**File:** `src/adapters/cc-hooks/pre-compact.ts`

```
main() [line 13]
  → getTokenGauge() [line 14-17]
  → readGsdState(input.cwd) [line 18]
  → runCompactionSequence({ db, sessionId, project, cwd, scope, gauge, gsd }) [line 20-28]
  → return {} [line 30]
```

### Phase 2: runCompactionSequence()

**File:** `src/adapters/shared/lifecycle.ts`, lines 246-270

```
runCompactionSequence(params)
  → writeCheckpoint({ trigger: 'compaction', ... }) [line 247-257]
  → IF result is truthy:
      → promoteLearnings({ db, project, sessionLearnings: [] }) [line 262-265]
          (no new learnings; call enforces cap/pruning only)
      → markPostCompactPending(db, sessionId) [line 268]
          SQL: UPSERT checkpoint_tracking SET post_compact_pending = 1
```

### Phase 3: Claude Code Compaction

Claude Code performs its own context summarization. The Claudex pre-compact hook has already returned `{}`.

### Phase 4: Post-Compaction Detection (UserPromptSubmit)

**File:** `src/adapters/cc-hooks/user-prompt-submit.ts`

```
main() [line 17]
  → getCheckpointTracking(ctx.db, input.session_id) [line 20]
      SQL: SELECT * FROM checkpoint_tracking WHERE session_id = ?
  → isPostCompaction = tracking?.post_compact_pending === 1 [line 21]
  → IF !isPostCompaction AND prompt:
      → topicShift detection (skipped post-compaction) [lines 30-50]
  → assembleRegularPrompt({ isPostCompaction, prompt, gauge, ... }) [line 52-62]
      → IF isPostCompaction: assembleFullContext({ ..., searchQuery: params.prompt }) [assembler.ts:262-270]
  → IF isPostCompaction: clearPostCompactPending(ctx.db, input.session_id) [line 65]
      SQL: UPDATE checkpoint_tracking SET post_compact_pending = 0 WHERE session_id = ?
  → IF payload.content: return { systemMessage: payload.content } [line 69]
```

---

## Post-Compact Flag Lifecycle

| Stage | Location | Operation | SQL |
|-------|----------|-----------|-----|
| **Set** | `lifecycle.ts:268` → `checkpoint-tracking.ts:68` | `markPostCompactPending(db, sessionId)` | `UPSERT checkpoint_tracking SET post_compact_pending = 1` |
| **Read** | `user-prompt-submit.ts:20-21` | `getCheckpointTracking()` → `.post_compact_pending === 1` | `SELECT * FROM checkpoint_tracking WHERE session_id = ?` |
| **Cleared** | `user-prompt-submit.ts:65` | `clearPostCompactPending(db, sessionId)` | `UPDATE ... SET post_compact_pending = 0 WHERE session_id = ?` |

**Storage:** `checkpoint_tracking` table, `post_compact_pending` column (INTEGER, 0/1). Row is keyed by `session_id`.

**Persistence:** SQLite (`better-sqlite3`), synchronous I/O within same process. The flag persists across process restarts if a new Claudex process opens the same DB and same session_id is re-used (unlikely but possible).

---

## assembleFullContext() — Session-Start vs Post-Compaction

### Session-Start Call (`session-start.ts:32-38`)
```typescript
assembleFullContext({
  db: ctx.db,
  project: ctx.project,
  projectDir: input.cwd,
  config: ctx.config,
  identityDir: getIdentityDir(),
  // searchQuery: NOT passed → undefined
})
```
- **Injection point:** `{ additionalContext: payload.content }` (line 41)
- **FTS5 query:** falls back to `checkpoint?.thread?.topic ?? null` (`assembler.ts:153`)

### Post-Compaction Call (`assembler.ts:262-270`)
```typescript
assembleFullContext({
  db: params.db,
  project: params.project,
  projectDir: params.projectDir,
  config: params.config,
  searchQuery: params.prompt,   // ← USER'S LIVE PROMPT PASSED
  identityDir: params.identityDir,
})
```
- **Injection point:** `{ systemMessage: payload.content }` (`user-prompt-submit.ts:69`)
- **FTS5 query:** uses actual user prompt string (more relevant than topic)

### Structural Identity
Both calls invoke the same `assembleFullContext()` function with the same 8-priority cascade. The only functional difference is:
1. `searchQuery` is set post-compaction (better FTS5 relevance)
2. Injection point differs (`additionalContext` vs `systemMessage`)
3. Session-start additionally calls `createSession()`, `recoverFromDb()`, `pruneTelemetry()` — post-compaction does not

---

## Section-by-Section Redundancy Analysis

### Priority 1: Identity (`formatIdentitySection`)
**Source:** `~/.claudex/identity/USER.md`
**Redundant post-compaction?** — **No, not redundant.**

At session-start, identity is injected as `additionalContext`, which may appear in the context window. After compaction, CC summarizes/truncates older content — USER.md content is likely to be partially or fully compressed out. Re-injecting via `systemMessage` re-establishes it for the new compressed window. The two injection hooks have different semantics in the CC runtime.

### Priority 2: Project Context (`formatProjectSection`)
**Source:** `PROJECT_PRIMER.md` + `context/handoffs/ACTIVE.md`
**Redundant post-compaction?** — **No, not redundant.**

Same reasoning as identity. ACTIVE.md in particular is critical handoff state that should be re-surfaced after every compaction. PROJECT_PRIMER.md provides architectural context that compression may collapse. Re-injection is justified.

**Potential optimization:** ACTIVE.md changes frequently. The checkpoint section (priority 3) also contains recent state. There may be overlap between ACTIVE.md and checkpoint content — this is worth measuring.

### Priority 3: Checkpoint (`formatCheckpointSection` with RESUME preset)
**Source:** DB (`checkpoint_meta` table, latest committed/mirrored row for project)
**RESUME preset strips:** `gsd` field from checkpoint, leaves everything else
**Redundant post-compaction?** — **No, not redundant.**

The checkpoint was JUST written by `writeCheckpoint()` in `runCompactionSequence()` immediately before this. So post-compaction, the checkpoint contains a fresh snapshot. This is the most up-to-date and valuable section.

### Priority 4: Learnings (`formatLearningsSection`, top 10)
**Source:** `learnings` table, ordered by `promotion_count DESC`
**Redundant post-compaction?** — **Partially redundant, but low cost.**

Learnings are durable cross-session knowledge. After compaction, Claude has forgotten session-specific context. Re-surfacing top learnings is valuable for guiding continued work. Low token cost (~10 bullets). Keep as-is.

### Priority 5: Hot Files (`formatHotFilesSection`, >= 0.851 pressure threshold)
**Source:** `file_pressure` table
**Redundant post-compaction?** — **No, valuable.**

Hot files indicate recently-active code paths. After compaction, this is orientation data. The 0.851 filter means only truly hot files appear. Typically 0–5 entries.

### Priority 6: GSD State (`formatGsdSection`)
**Source:** Live `readGsdState(projectDir)` → `STATE.md` file parse
**Note:** Checkpoint's embedded `gsd` field is STRIPPED by RESUME preset (loader.ts:290), so GSD section comes from live file, not checkpoint
**Redundant post-compaction?** — **No, but minimal value.**

The checkpoint (priority 3) now has `gsd = null` (RESUME preset). So the only GSD context comes from this section. It's 5-6 lines (~50-100 tokens). If a GSD phase is active, this is important orientation. If not, `formatGsdSection` returns null and no tokens are spent.

### Priority 7: FTS5 Search (`formatFts5Section`)
**Source:** FTS5 search against `observations` table using user's prompt
**Redundant post-compaction?** — **No, uniquely valuable post-compaction.**

This uses the CURRENT user prompt as the search query (post-compaction advantage over session-start). This is the highest-relevance section for the immediate task. `referenceMode` activates if budget < 500 tokens remaining, producing compact one-line format.

### Priority 8: Recent Observations (`formatRecentSection`)
**Source:** Observations with `importance >= 3` AND age < 24 hours
**Redundant post-compaction?** — **Marginally valuable.**

This overlaps with FTS5 (different filter: recency vs query-relevance). If FTS5 is included, recent observations add noise. If FTS5 was skipped (budget exhausted), this is a fallback. The budget ordering means by the time priority 8 is reached, very little budget may remain.

---

## Token Cost Analysis

### Budget Cap
**Default:** `config.injection.budget_tokens = 4000` (constants.ts:38)

### Typical Section Costs (estimates)
| Priority | Section | Typical Tokens | Notes |
|----------|---------|----------------|-------|
| 1 | Identity (USER.md) | 100–500 | File-dependent |
| 2 | Project (PRIMER + ACTIVE) | 500–3000 | PRIMER can be very large |
| 3 | Checkpoint (RESUME) | 300–1500 | Full checkpoint minus GSD field |
| 4 | Learnings (top 10) | 100–300 | 10 bullets |
| 5 | Hot Files | 0–100 | Only files >= 0.851 pressure |
| 6 | GSD State | 0–100 | ~5-6 lines; null if no active phase |
| 7 | FTS5 Results | 50–500 | referenceMode triggers at < 500 remaining |
| 8 | Recent Obs | 0–200 | Only importance>=3, age<24h |
| **Total** | | **~1150–5700** | Budget-capped at 4000 |

### Budget Exhaustion Pattern
The cascade is priority-ordered. With a 4000 token budget:
- If PROJECT_PRIMER.md is large (1500+ tokens), sections 6-8 are commonly skipped
- `referenceMode = true` activates when remaining budget < 500 (line 136)
- Post-redaction reclaim attempts one additional skipped section (lines 198-211) but only if redaction freed tokens

### Gauge Threshold (regular turns, not post-compaction)
- `gauge_threshold: 0.70` (constants.ts:42) — gauge injection only fires at >= 70% utilization
- At post-compaction this path is bypassed entirely (isPostCompaction takes priority)

---

## Assumption Verification

### Assumption 1: "Identity is redundant post-compaction (Claude retains system prompt)"
**VERDICT: FALSE**

Session-start injects via `additionalContext`; post-compaction via `systemMessage`. These are different CC hook return types. The system prompt (CLAUDE.md) persists through compaction, but `additionalContext` from session-start is part of the compacted conversation history — it can be summarized away. Re-injecting identity as `systemMessage` on the next user turn is a different operation from the original `additionalContext` injection.

### Assumption 2: "Project primer is redundant post-compaction (Claude can re-read it)"
**VERDICT: FALSE**

Claude Code does not autonomously re-read files after compaction. The primer must be explicitly re-injected. ACTIVE.md in particular contains handoff state that is critical for continuity. The only question is whether the CHECKPOINT (priority 3) already covers what ACTIVE.md adds — there's potential overlap worth measuring.

### Assumption 3: "GSD is truly skippable post-compaction"
**VERDICT: PARTIALLY TRUE — skippable only when no active GSD phase**

`readGsdState()` reads `STATE.md`. If no GSD phase is active or the file doesn't exist, `formatGsdSection` returns `null` and no tokens are spent. If a phase IS active, GSD provides critical orientation (~50-100 tokens) that is NOT in the checkpoint (RESUME preset strips checkpoint's GSD). Without this section, Claude would lose track of what phase/goal it's working on. Skipping it when active would be harmful.

### Assumption 4: "assembleFullContext() is called identically for session-start and post-compaction"
**VERDICT: MOSTLY TRUE with one key difference**

Structurally identical (same function, same priority cascade, same budget). Key difference: post-compaction passes `searchQuery: params.prompt` enabling better FTS5 relevance. Post-compaction is actually BETTER than session-start for FTS5 because it uses the user's current prompt rather than the stored topic.

### Assumption 5: "Race conditions exist in the flag lifecycle"
**VERDICT: FALSE — no race conditions**

The `better-sqlite3` library uses synchronous writes within a single process. The flag is set by pre-compact (one process invocation), read and cleared by user-prompt-submit (next process invocation). These are sequential by design — CC calls hooks sequentially and each hook is a separate Node.js process execution. The SQLite DB provides durability between invocations.

**Minor robustness note:** If user-prompt-submit crashes after `assembleRegularPrompt()` but before `clearPostCompactPending()` (line 65), the flag remains set. The NEXT user prompt would also trigger full assembly. This is benign over-injection, not a correctness bug.

---

## Findings

1. **Full assembly fires identically for session-start and post-compaction** with a single beneficial difference: post-compaction uses the live user prompt as the FTS5 search query, producing more relevant observations for the immediate task.

2. **The flag `post_compact_pending` lives in the `checkpoint_tracking` SQLite table**, set synchronously in pre-compact's `runCompactionSequence()` and cleared synchronously in user-prompt-submit after assembly.

3. **The checkpoint written during pre-compact is immediately available post-compaction** — `writeCheckpoint()` runs before `markPostCompactPending()`, so the checkpoint is current when full assembly reads it.

4. **GSD state is NOT in the checkpoint during post-compaction injection** — the RESUME preset strips `checkpoint.gsd = null`. The only source of GSD data post-compaction is the live `readGsdState()` call in priority 6 of the cascade.

5. **`systemMessage` vs `additionalContext` injection types**: Session-start uses `additionalContext`; post-compaction uses `systemMessage`. This distinction matters — they attach to different parts of the CC context. Identity and project primer re-injection post-compaction is NOT redundant.

6. **Topic-shift detection is skipped post-compaction** (`user-prompt-submit.ts:30`): `if (!isPostCompaction && prompt)` — this saves an embedding inference call when the full context assembly already covers everything.

7. **4000 token budget** often exhausted before reaching priorities 7 and 8 when PROJECT_PRIMER.md is large, activating `referenceMode` for FTS5.

8. **No race conditions detected.**

---

## Recommendations

1. **Do NOT remove identity or project primer from post-compaction assembly** — the `systemMessage` injection mechanism differs from session-start's `additionalContext` and both serve non-redundant purposes in re-establishing context.

2. **Potential overlap investigation:** Check whether ACTIVE.md (priority 2) and the checkpoint's thread summary (priority 3) contain redundant information. If so, ACTIVE.md could be conditionally skipped if the checkpoint was written within N minutes.

3. **GSD section cost is minimal** (~50-100 tokens) and critical when a phase is active. The `null` return when no GSD state exists is already optimal.

4. **Post-compaction FTS5 is better than session-start FTS5** (uses live prompt vs stored topic). This is an existing advantage that needs no changes.

5. **The benign double-injection scenario** (flag not cleared on crash) is acceptable — full re-injection on the next prompt is strictly better than losing context.

6. **Budget configuration (4000 tokens)** may be worth reviewing if PROJECT_PRIMER.md is consistently >1500 tokens, causing priorities 7-8 to be regularly skipped. Increasing the budget or adding a PRIMER-specific length cap could improve coverage.
