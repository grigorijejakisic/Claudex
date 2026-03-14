# Injection Path Audit — eff-w7

**Scope:** All code paths that produce non-empty `additionalContext` or `systemMessage` injected into Claude's context.
**Files examined:** session-start.ts, user-prompt-submit.ts, assembler.ts, topic-shift.ts, sections.ts, constants.ts, config.ts, token-gauge.ts, semantic-dedup.ts, thread.ts

---

## 1. Complete Injection Path Map (Decision Tree)

### Hook 1: SessionStart → `additionalContext`

```
SessionStart fires
  └─ assembleFullContext()
       ├─ Tier 1: Priority-budgeted cascade (budget = 4000 tokens default)
       │    P1: Identity (USER.md) — if file exists and non-empty
       │    P2: Project (PROJECT_PRIMER.md + ACTIVE.md) — if either exists
       │    P3: Checkpoint — if checkpoint exists in DB
       │    P4: Learnings (top 10, score-weighted) — if any exist
       │    P5: Hot Files (pressure >= 0.851, up to 20) — if any qualify
       │    P6: GSD State — if .gsd-state.json exists
       │    P7: FTS5 search on checkpoint topic — if features.fts5_search=true AND topic exists
       │    P8: Recent observations (importance >= 3, < 24h) — if any qualify
       │    Post-redaction reclaim: if redaction frees space, one skipped section re-attempted
       ├─ Tier 2: Checkpoint-only + Identity (if Tier 1 throws)
       ├─ Tier 3: Identity-only (if Tier 2 throws)
       └─ Empty payload (if all tiers fail)
  └─ Returns { additionalContext: content } if content non-empty, else {}
```

**Condition for non-empty injection:** At least one of USER.md, PROJECT_PRIMER.md, ACTIVE.md, a checkpoint, learnings, hot files, GSD state, or recent observations exists. In any real project this is almost always true. SessionStart ALWAYS injects in practice.

---

### Hook 2: UserPromptSubmit → `systemMessage`

```
UserPromptSubmit fires on every user message
  │
  ├─ Read post_compact_pending from DB
  ├─ Read token gauge from transcript JSONL tail
  ├─ If NOT post-compaction AND prompt non-empty:
  │    Run topic shift detection (3-layer)
  │
  └─ assembleRegularPrompt()
       │
       ├─ BRANCH A: isPostCompaction == true
       │    └─ assembleFullContext() — same as SessionStart but with prompt as searchQuery
       │         INJECTS: Full context (up to 4000 tokens)
       │         THEN: clearPostCompactPending() clears the flag
       │
       ├─ BRANCH B: topicShift.shifted == true AND tokenEstimate <= topic_shift_budget (800)
       │    └─ assembleTopicPivot()
       │         └─ formatTopicPivotSection(): header + previousTopic -> newTopic
       │              + up to 3 relevant learnings (filtered by first keyword of newTopic)
       │              + up to 5 hot files
       │         Budget cap: if tokenEstimate > 800, truncate to first 3 lines
       │         INJECTS: Topic pivot section (20–800 tokens)
       │
       ├─ BRANCH C: gauge.utilization >= gauge_threshold (0.70 default)
       │    └─ formatGaugeSection()
       │         Returns: "# Token Gauge\nUtilization: XX% (N / M)"
       │         INJECTS: Gauge line (~15 tokens)
       │
       └─ BRANCH D: none of the above
            INJECTS: nothing (empty payload, returns {})
```

**Branch ordering is strictly exclusive (early return pattern).** Post-compaction short-circuits before topic-shift is even run. Topic-shift short-circuits before gauge. Gauge short-circuits before zero.

---

## 2. Per-Path Token Cost Estimates

| Path | Mechanism | Token Range | Frequency |
|------|-----------|-------------|-----------|
| SessionStart | `additionalContext` | 200–4000 tokens | Once per session |
| PostCompaction | `systemMessage` | 200–4000 tokens | Once per compaction event |
| TopicShift | `systemMessage` | ~20–800 tokens | When shift detected |
| Gauge | `systemMessage` | ~15 tokens | When utilization >= 70% |
| Normal turn | — | 0 tokens | Most turns |

### SessionStart / PostCompaction content breakdown (typical):
- Identity (USER.md): variable, ~100–500 tokens typical
- Project primer + active handoff: ~200–1000 tokens
- Checkpoint: ~200–800 tokens
- Learnings (10 items): ~100–300 tokens
- Hot files (filtered): ~50–200 tokens
- GSD state: ~50–150 tokens
- FTS5 results (10 items): ~100–400 tokens
- Recent observations (compact): ~50–200 tokens
- Total: capped at 4000 tokens, typical 800–2500 tokens

### TopicShift content breakdown:
- Header line: ~10 tokens
- Topic transition line: ~15 tokens
- Up to 3 learnings: ~30–150 tokens
- Up to 5 hot files: ~30–100 tokens
- Total: ~85–275 tokens in practice (hard cap 800 before truncation)

### Gauge content:
- Single formatted line: ~15 tokens

---

## 3. Compound Injection Analysis

**Can gauge + topic-shift fire simultaneously?**
No. The assembler uses exclusive early-return branches:
1. PostCompaction checked first → returns if true
2. TopicShift checked second → returns if shifted == true and within budget
3. Gauge checked third → returns if utilization >= threshold

If topic-shift fires, gauge is never evaluated. The three paths are mutually exclusive for any given turn.

**Exception — topic-shift pivot overbudget:**
If `assembleTopicPivot()` returns a payload with `tokenEstimate > topic_shift_budget` (800), the topic-shift branch does NOT return — it falls through to gauge check (line 281 in assembler.ts):
```typescript
if (pivot.tokenEstimate > 0 && pivot.tokenEstimate <= params.config.injection.topic_shift_budget) {
  return pivot;
}
// Falls through to gauge if over budget
```
This is the only case where the assembled topic-pivot content is discarded and gauge could fire instead on the same turn. Not truly compounding, but the over-budget case silently falls through.

**Can post-compaction + topic-shift compound?**
No. Topic-shift detection is explicitly skipped when `isPostCompaction` is true (user-prompt-submit.ts line 30):
```typescript
if (!isPostCompaction && prompt) {
  // topic shift detection runs here
}
```
And in assembleRegularPrompt, postCompaction returns before reaching the topic-shift branch. These are fully mutually exclusive.

**Summary:** Injection types CANNOT compound. Each turn produces at most one injection type. The only edge case is topic-shift over budget silently falling through to gauge.

---

## 4. Boundary-Only Principle Enforcement

**The `boundary_only` config field is declared in config.ts and defaults to `true`, but is NEVER READ in assembler.ts or user-prompt-submit.ts.**

Grep results confirm `boundary_only` appears only in:
- `src/shared/constants.ts` (defined)
- `src/shared/config.ts` (type + validation)
- Test files (value assertions)

It does NOT appear in `assembler.ts`, `user-prompt-submit.ts`, or `session-start.ts`.

**This means `boundary_only: false` in config.json would have NO EFFECT.** The boundary-only behavior is enforced structurally by the assembler logic, not by the flag. The flag is dead config.

**Is boundary-only structurally enforced?**
Partially. The assembler correctly gates full assembly behind `isPostCompaction` and delegates topic-shift/gauge to separate lightweight paths. However, gauge injection can fire on EVERY turn once utilization exceeds 70%, and topic-shift can fire on any turn where a shift is detected. Neither of these is a "boundary" in the original sense — they are ongoing per-turn checks.

The true "boundary-only" events (full context re-injection) are:
- SessionStart (once per session)
- PostCompaction (once per compaction event)

Gauge and topic-shift are sub-threshold partial injections that fire mid-session on any turn.

---

## 5. Topic Shift Frequency Risk Assessment

### Detection layers (in order):

**Layer 1 — Explicit regex (always checked, no embedding cost):**
```
/^(now let's|next[,:]|switch to|moving on|let's work on|different topic|
   new task|back to|forget that|actually[,:]?\s*(?:let's|can we|I need))/i
```
Fires immediately on phrase match. High precision, very low false positive rate. No sliding window protection. A user saying "actually, let me rephrase" would trigger this.

**Layer 2 — Embedding cosine (requires Ollama running):**
- Threshold: 0.35 (configurable, default in constants.ts)
- Also requires `avgRecent < 0.40` (sliding window of 3 recent prompts)
- Dual condition reduces false positives significantly
- If embeddings unavailable, falls through to Layer 3

**Layer 3 — Keyword Jaccard fallback:**
- Threshold: 0.15 (overlap < 15% triggers shift)
- Compares current thread topic against full prompt text
- This is the most sensitive layer and has the highest false-positive risk

### Cooldown mechanism:
**There is NO cooldown mechanism.** After a topic shift is detected:
1. `topicEmbeddingCache` is invalidated (line 99 in topic-shift.ts)
2. Thread state topic is NOT immediately updated in the detector — `getThreadState()` reads the DB, and topic update happens in a separate TurnEnd hook (thread-tracker)
3. There is no "last-shift-timestamp" stored that would prevent re-firing on the next turn

**Frequency risk — Jaccard path (worst case):**
The Jaccard comparison is against `thread.topic` (a short extracted topic phrase) vs. the full prompt text. A short topic like "debugging" compared against a longer prompt will almost always score < 0.15 Jaccard overlap because:
- The topic is typically 1–3 words
- The prompt contains many non-overlapping words
- Jaccard = intersection / union, and a long prompt's union will dominate

This creates a systematic bias: once a topic is set, ANY sufficiently verbose prompt on the same topic could trigger a false shift if the Jaccard overlap between the topic phrase and the full prompt is < 0.15.

**Concrete scenario:**
- Thread topic: "authentication"
- User sends: "Can you help me understand how the JWT middleware validates tokens and what happens when the refresh token expires?"
- Keywords in topic: {"authent"} (stemmed)
- Keywords in prompt: {"help", "understand", "jwt", "middlewar", "valid", "token", "happen", "refresh", "expir"} (after stop-word removal and stemming)
- "authent" not present in prompt keywords (JWT ≠ authentication after stemming)
- Jaccard = 0/9 = 0.0 → triggers shift detection
- Result: False positive shift injection on a prompt clearly about the same topic

**Risk level: HIGH for Jaccard fallback path.** When Ollama is unavailable, every verbosely-phrased follow-up on the same topic could trigger a shift if the keyword overlap with the stored topic phrase is < 15%.

**Layer 2 window protection:**
With embeddings enabled, the dual condition (`similarity < 0.35 AND avgRecent < 0.40`) is a meaningful guard. The sliding window of 3 recent prompts provides noise smoothing. However, on the FIRST prompt of a session (empty window), `computeAvgRecent()` returns 0 unconditionally (line 162 in topic-shift.ts):
```typescript
if (this.recentPromptEmbeddings.length === 0) {
  return 0; // Conservative: treat as low similarity to allow shift detection
}
```
This means the first prompt is evaluated with `avgRecent = 0`, so if embedding similarity to the stored topic is < 0.35, a shift fires immediately. This is intentional for first-message-of-session detection but could produce false positives on session resume.

---

## 6. Gauge Frequency Risk Assessment

**The gauge has NO cooldown.** It fires on every turn where `utilization >= 0.70` (default threshold).

**Trajectory:** Once context utilization exceeds 70%, gauge injects ~15 tokens on every single subsequent turn until compaction. During long sessions this could mean 10–50 consecutive turns each receiving a gauge injection.

**Cost per injection:** ~15 tokens (the gauge string itself). Negligible per-turn cost but cumulative across many turns.

**Interaction with compaction:** Once compaction fires, `post_compact_pending` is set, and the next turn triggers full assembly instead of gauge. Gauge injections cease until utilization climbs again past 70%.

**Is this a boundary violation?** Technically yes — gauge injects on every non-boundary turn above the threshold. This is by design (it's a monitoring signal) but it is not "boundary-only" in the strict sense.

---

## 7. Edge Case: PostCompaction AND TopicShift Both True

This cannot happen. In `user-prompt-submit.ts`:
```typescript
if (!isPostCompaction && prompt) {
  // topic shift detection only runs here
}
```
Topic shift detection is entirely skipped when `isPostCompaction` is true. The `topicShift` variable remains `null`. Then in `assembleRegularPrompt`, the postCompaction branch returns before reaching the topic-shift check. Both the detection and the assembly path are fully gated.

---

## 8. Normal Turn Verification

**Is zero injection truly guaranteed on a normal turn?**

A "normal turn" means: `isPostCompaction == false`, `topicShift.shifted == false` (or null), and `gauge.utilization < 0.70` (or gauge is null).

In `assembleRegularPrompt`, Branch D returns `{ ...EMPTY_PAYLOAD }` where `EMPTY_PAYLOAD = { content: '', tokenEstimate: 0, sources: [] }`.

In `user-prompt-submit.ts`:
```typescript
if (payload.content) {
  return { systemMessage: payload.content };
}
return {};
```

Empty string is falsy in JavaScript, so `if (payload.content)` is false for `content: ''`. Returns `{}`. **Zero injection confirmed for normal turns when no path fires.**

However, "normal turn" requires ALL three conditions simultaneously. In sessions with long context or frequent topic changes, these conditions may rarely all be false simultaneously.

---

## 9. Specific Recommendations

**REC-1 [HIGH]: Implement topic shift cooldown.**
After a shift is detected and injection fires, record a `last_shift_epoch` in thread state. Suppress further shift detection for N turns (e.g., 3) or M seconds (e.g., 60). Without this, rapid back-and-forth between topics can inject on every other turn.

**REC-2 [HIGH]: Fix Jaccard false-positive bias.**
The Jaccard comparison should be between topic phrase vs. prompt KEYWORDS (not full prompt). Currently it compares topic phrase against the full verbose prompt, making it nearly impossible to score >= 0.15 if the stored topic is short (1-2 words). Alternative: raise the threshold to 0.10, or compare against top-5 prompt keywords only.

**REC-3 [MEDIUM]: Remove or enforce `boundary_only` config flag.**
The flag is defined in config, validated, surfaced in tests, but never read in any injection logic. Either:
- Read it in `assembleRegularPrompt` to disable gauge+topicShift injection when true, OR
- Remove it from the config schema and docs to avoid false expectations

**REC-4 [MEDIUM]: Add gauge cooldown or hysteresis.**
Once gauge fires, suppress re-firing until utilization drops below threshold then rises above it again (hysteresis band). A 5-point band (fire at 70%, silence until drops to 65%, re-arm above 70%) would prevent continuous per-turn gauge injection.

**REC-5 [LOW]: Document topic-shift over-budget fallthrough.**
The silent fallthrough from topic-shift to gauge when `tokenEstimate > topic_shift_budget` is non-obvious. Add a comment in `assembleRegularPrompt` lines 281-283 noting this is intentional fallthrough, not a missing return.

**REC-6 [LOW]: First-session-prompt window protection.**
The `computeAvgRecent` returning 0 for empty window makes the first prompt of any session vulnerable to a false topic-shift detection via Layer 2 embedding. Consider returning a neutral value (e.g., 0.5) or skipping Layer 2 when the window is empty.

---

## Summary Table

| Path | Trigger | Frequency | Token Cost | Boundary? | Compound? |
|------|---------|-----------|------------|-----------|-----------|
| SessionStart | Session creation | Once/session | 200–4000 | Yes | N/A |
| PostCompaction | `post_compact_pending=1` | Once/compaction | 200–4000 | Yes | No (blocks topic-shift) |
| TopicShift | `shifted==true` + within 800 budget | Variable (see risk) | 20–800 | No | No (exclusive) |
| Gauge | utilization >= 70% | Every turn above threshold | ~15 | No | No (exclusive) |
| Normal | All above false | Most turns | 0 | N/A | N/A |

**Critical finding:** `boundary_only` config is dead code — it has no runtime effect. Topic-shift and gauge both fire mid-session (non-boundary). Gauge fires on every turn above 70% utilization with no cooldown. Jaccard fallback has significant false-positive risk for verbose prompts against short topic phrases.
