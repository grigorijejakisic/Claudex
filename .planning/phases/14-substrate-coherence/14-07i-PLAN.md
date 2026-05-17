---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07i
type: execute
wave: 3
depends_on: []
files_modified:
  - src/assembly/sections/codebase-context.ts (Wave 0 w0d split; I modifies formatCodebaseContextSection)
  - src/core/hybrid-retrieval.ts
  - src/tests/assembly/codebase-context-annotation.test.ts (NEW)
  - src/tests/intelligence/hybrid-retrieval-metadata.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "The Codebase Context section currently surfaces ~3-5 file paths per session-start with no reason annotation. Operator (and the agent reading the session-start) cannot tell WHY each file was surfaced. This plan adds a one-line reason annotation per file: either the retrieval query that matched + score, OR a natural-language synthesized reason."
    - "Retrieval-side change: `hybrid-retrieval.ts` extends its return shape to include `match_query`, `score`, and optionally `match_kind` ('fts' | 'vector' | 'reranker') for each candidate. Existing callers that don't need the metadata ignore the additional fields. The change is ADDITIVE — no caller breaks."
    - "Section-side change: `formatCodebaseContextSection` (the existing assembler function — exact name TBD during execution) is extended to render the annotation line per file. Format: `- <path> — matched \"<truncated_query>\" (score <N.NN>)` OR a natural-language one-line synthesized reason."
    - "Position-unless-flagged on annotation format: I lean on raw query + score (machine-readable, no LLM call needed). Alternative is natural-language synthesis — better human readability, requires an LLM pass per surfaced file. NL synthesis adds latency + token cost; the raw format is sufficient signal for the agent reading session-start. If PM flags this, the NL-synthesis alternative is a 1-2 day add and gates on local LLM availability."
    - "Annotation is per-file. If a file matched multiple queries (e.g., it's in both an FTS and vector hit), use the HIGHEST score's query as the canonical reason."
    - "Annotation is rendered ONLY when the retrieval metadata is available. If a fallback path produced the file list without metadata (e.g., a synthesized session-recovery surface), annotation is omitted and the section renders as before."
    - "Budget: the annotation adds ~30 tokens per file. With ~3-5 files in the Codebase Context section, that's ~150 tokens of new content. Existing section budget can absorb this without reducing file count."
  artifacts:
    - path: "src/core/hybrid-retrieval.ts"
      provides: "Retrieval return shape extended with match_query + score + match_kind fields per candidate. Existing fields unchanged."
      contains: "match_query|match_kind|retrieval_metadata"
    - path: "src/assembly/sections/codebase-context.ts"
      provides: "formatCodebaseContextSection extended with per-file annotation. Wave 0 w0d extracted this function from assembler.ts:857 into this file; I modifies it in-place. I owns ONLY this function per WAVE3-COORDINATION."
      contains: "formatCodebaseContextSection|matched|score"
    - path: "src/tests/assembly/codebase-context-annotation.test.ts"
      provides: "Tests for annotation rendering: format, highest-score selection, missing-metadata fallback, budget integration"
      contains: "annotation|matched|fallback|budget"
    - path: "src/tests/intelligence/hybrid-retrieval-metadata.test.ts"
      provides: "Tests for retrieval metadata surfaced through return shape"
      contains: "match_query|match_kind|score|metadata"
  key_links:
    - from: "src/assembly/sections/codebase-context.ts (formatCodebaseContextSection)"
      to: "src/core/hybrid-retrieval.ts (retrieval candidates with metadata)"
      via: "Section formatter consumes metadata from retrieval to render annotation lines"
      pattern: "match_query"
---

<objective>
Two deliverables in one plan, both targeting the Codebase Context section of session-start:

1. **Retrieval metadata surface** — `src/core/hybrid-retrieval.ts` extends its return shape to include `match_query` (the query string that matched the candidate), `score` (numeric ranking score), and `match_kind` ('fts' | 'vector' | 'reranker'). Additive change; existing callers unaffected.

2. **Codebase Context section annotation** — `src/assembly/sections.ts`'s codebase-context formatter (exact function name surveyed during execution) renders a one-line reason per file. Format: `- <path> — matched "<truncated_query>" (score <N.NN>)`.

After this plan lands:
- Session-start's Codebase Context section shows WHY each file was surfaced.
- The agent reading session-start can weight files by relevance.
- Operator can spot retrieval-quality issues at a glance.

| What this plan provides | Why |
|---|---|
| Retrieval metadata in return shape | The "why" data was already there; just surfaced |
| Per-file annotation in Codebase Context | Operator + agent see WHY each file surfaced |
| Highest-score selection for multi-match | Single reason per file, even when multi-match |
| Fallback for missing metadata | Section degrades gracefully if metadata absent |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md
@src/core/hybrid-retrieval.ts
@src/assembly/sections.ts
</context>

<anti_scope>
- Do NOT modify hybrid-retrieval ranking math. The metadata fields are READ-ONLY surfaces of what the existing pipeline already computed.
- Do NOT modify any function in `src/assembly/sections.ts` other than the codebase-context formatter. I owns ONLY this function per WAVE3-COORDINATION.
- Do NOT modify the lessons section formatter (14-07h / 14-07j territory).
- Do NOT add new MCP tools.
- Do NOT change the assembler cascade order.
- Do NOT modify link tables, link-writer.ts, or other Wave 2 surfaces.
- Do NOT generate the annotation via an LLM call in v7.0.0. Raw query + score is the locked format. NL synthesis is post-ship.
- Do NOT touch the reranker, embedder, or vector dimensions.
- Do NOT change V17 schema or caller migration (Wave 1 territory).
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Hybrid-retrieval return shape extension</name>
  <files>src/core/hybrid-retrieval.ts</files>
  <action>
Locate the existing candidate return type. Extend it with:

```typescript
export interface RetrievalCandidate {
  artifact_id: string;
  file_path?: string;
  score: number;             // already present in some shape; verify
  // NEW fields (additive):
  match_query?: string;      // The query string that retrieved this candidate
  match_kind?: 'fts' | 'vector' | 'reranker';  // Which retrieval channel surfaced this
  // ... existing fields ...
}
```

Survey the existing types in hybrid-retrieval.ts; the candidate object may already have a `score` field — confirm + reuse. Add `match_query` and `match_kind` as optional new fields.

Modify the retrieval pipeline:
- The FTS5 path attaches `match_kind: 'fts'` and `match_query` = the FTS5 query string.
- The vector path attaches `match_kind: 'vector'` and `match_query` = the original input text (or a snippet of it).
- After reranking: candidate retains its original `match_kind` from whichever channel surfaced it; if a candidate appears in BOTH FTS and vector hits, keep the HIGHER-score channel's `match_query` and `match_kind`.
- After BGE reranker: optionally annotate `match_kind: 'reranker'` for the top-K post-rerank candidates (TBD: keep original channel or mark as reranker? Lean keep original to show provenance; reranker only re-orders).

Position-unless-flagged: keep original channel's match_query/match_kind post-rerank; reranker is a re-ordering step, not a source of new matches. If PM flags this, the alternative is to overwrite with `match_kind: 'reranker'` (loses source channel info).

Add `// 14-07i: retrieval metadata` comment marker per attachment site.
  </action>
  <verification>
- Existing tests pass (additive change).
- Candidates returned by hybrid retrieval include match_query + match_kind.
- FTS hits have match_kind='fts'; vector hits have 'vector'.
- Multi-channel candidate: keeps higher-score channel's match_query.
- Reranker preserves original channel's match_query/match_kind.
- match_query is truncated to a reasonable length (~200 chars) for storage.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Codebase Context section formatter annotation</name>
  <files>src/assembly/sections.ts</files>
  <action>
Locate the existing codebase-context section formatter (survey + identify; exact function name during execution).

Extend the formatter to render the annotation line per file.

Current format (pre-plan):
```
**Relevant files:**
- src/angel/heartbeat.ts: function heartbeatTick, type X
- src/assembly/assembler.ts: function ...
- ...
```

New format (post-plan):
```
**Relevant files:**
- src/angel/heartbeat.ts — matched "Angel heartbeat" (score 0.84, vector) — function heartbeatTick, type X
- src/assembly/assembler.ts — matched "session start cascade" (score 0.71, fts) — function ...
- ...
```

Implementation:

1. Per file, retrieve the associated retrieval candidate metadata (`match_query`, `score`, `match_kind`).
2. If metadata present, render: `- <path> — matched "<truncated_query>" (score <score>, <kind>) — <existing-function-list>`.
3. If metadata absent (fallback path), render the existing format: `- <path>: <existing-function-list>`.
4. Truncate match_query display to ~50 chars for readability; ellipsize.
5. Score formatted to 2 decimal places.
6. Multi-match selection: highest score wins (single annotation per file even when multi-match).
7. Budget cap: annotation adds ~30 tokens per file; existing budget unchanged unless overflow — if overflow, drop the last file rather than dropping annotations.

Add `// 14-07i: codebase-context annotation` comment marker.

**Critical:** do NOT modify any other function in sections.ts. I owns ONLY this function.
  </action>
  <verification>
- Annotation rendered when metadata present.
- Fallback to existing format when metadata absent.
- match_query truncated to readable length.
- Score formatted to 2 decimals.
- Highest-score selection for multi-match.
- Budget cap respected.
- No other sections.ts function modified.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Tests for retrieval metadata</name>
  <files>src/tests/intelligence/hybrid-retrieval-metadata.test.ts</files>
  <action>
New test file. Tests:

1. `FTS hit attaches match_kind='fts' + match_query`
2. `Vector hit attaches match_kind='vector' + match_query`
3. `Multi-channel hit: higher-score channel's match_query retained`
4. `Multi-channel hit: lower-score channel ignored`
5. `Post-rerank: original channel's match_kind preserved`
6. `Post-rerank: ranks change but match_query unchanged for each candidate`
7. `match_query truncated to ~200 chars when source query is longer`
8. `Existing callers (without using metadata) still work`
  </action>
  <verification>
- 8 tests pass.
- No regression in existing hybrid-retrieval tests.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for codebase-context section annotation</name>
  <files>src/tests/assembly/codebase-context-annotation.test.ts</files>
  <action>
New test file. Tests:

1. `single-file section with metadata: annotation line rendered`
2. `multi-file section with metadata: each file has annotation`
3. `file without metadata (fallback): existing format preserved`
4. `match_query truncated to ~50 chars in display`
5. `Score formatted to 2 decimal places`
6. `Multi-match file: highest-score query rendered`
7. `Budget overflow: drops last file, not annotations`
8. `Function-list within file preserved post-annotation`
9. `Empty match_query (defensive): falls back to format without annotation`
10. `Cascade integration: assembler invokes the formatter and section appears in expected position`
  </action>
  <verification>
- 10 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Build + test sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/intelligence/hybrid-retrieval-metadata.test.ts src/tests/assembly/codebase-context-annotation.test.ts` — 8 + 10 = 18 new tests pass.
- `npx vitest run` — full suite green.
- `bun run vesna` — SC#1 PASS 18/18 (annotation is purely additive surface; doesn't affect retrieval behavior).
- Manual smoke: assemble session-start against a real DB; observe Codebase Context section with annotations.
  </action>
  <verification>
- Build green.
- 18 new tests pass.
- Full suite green.
- Vesna SC#1 PASS unchanged.
- Manual smoke confirms annotation rendering.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: hybrid-retrieval.ts return shape includes `match_query`, `score`, `match_kind` (additive).
- AC-2: FTS hits have match_kind='fts'; vector hits have 'vector'.
- AC-3: Multi-channel hit retains higher-score channel's metadata.
- AC-4: Post-rerank candidates retain original channel's match_kind.
- AC-5: match_query truncated to ~200 chars at attachment time.
- AC-6: Codebase Context section renders per-file annotation when metadata present.
- AC-7: Fallback to existing format when metadata absent.
- AC-8: match_query truncated to ~50 chars for display; score to 2 decimals.
- AC-9: Highest-score selection for multi-match candidate.
- AC-10: Budget overflow drops trailing file rather than annotations.
- AC-11: No other function in sections.ts modified (I scope respected).
- AC-12: All 18 new tests pass.
- AC-13: Vesna SC#1 PASS 18/18 unchanged.
- AC-14: Manual smoke confirms session-start renders annotations.
</acceptance_criteria>

<risks>
- **Risk 1: Annotation truncation too aggressive — operator can't read the query.** Mitigation: 50-char display truncation is the position-unless-flagged value; tunable post-ship. Operator can grep MEMORY.md or session log for full query.
- **Risk 2: Metadata attachment misses a code path.** Some legacy retrieval path may not surface metadata. Mitigation: fallback path renders existing format; no regression.
- **Risk 3: Score field shape may differ across retrieval paths (FTS bm25, vector cosine, reranker logit).** Mitigation: keep score as raw float; display as "(score N.NN)" without normalizing. Operator interprets in context of channel.
- **Risk 4: Annotation makes Codebase Context section noisier.** Mitigation: section's signal-to-noise improves (per CONTEXT goal). If operator finds noisy, the additive can be feature-flagged post-ship.
- **Risk 5: match_query embeds something sensitive (e.g., a passphrase from operator query history).** Mitigation: queries are operator-typed text; same surface as existing claudex_search. Not a new exposure.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Additive extension correctness — does the return shape change break any caller?
- (b) Multi-channel candidate semantics — is "highest score wins" the right rule for which query to display?
- (c) Truncation — are 200 chars at attachment + 50 chars at display the right values?
- (d) Score field semantics across channels — is displaying raw scores from different channels misleading?

NO-SIGNOFF triggers PM escalation.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (18 new tests + smoke).
3. Live-wiring smoke: real-DB session-start with annotation rendering observed.
4. No "MVP" shortcuts — additive return shape extension is the safe pattern; fallback for missing metadata is the production-quality safeguard.
5. Negative results valid: if annotations turn out to be too noisy, surface to operator; do not silently suppress.
6. Cross-family external review.
7. No time estimates.
</methodology_gates>
