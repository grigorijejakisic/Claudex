---
plan_id: 04-02
phase: 4
wave: 1
depends_on: []
files_modified:
  - src/angel/transcript-chunker.ts
  - src/tests/angel/transcript-chunker.test.ts
autonomous: true
requirements:
  - STOR-06
  - EXTR-06
---

# Plan 04-02: Transcript Chunker — LLM Topic-Segmented Artifacts at /endsession

## Objective

Produce `src/angel/transcript-chunker.ts` — a function that consumes a completed session's `conversation_turns` and writes one or more `artifact(kind='transcript_chunk', ...)` rows with `session_id`, `turn_range`, `topic_label` in `data`, and no pre-computed embedding (Phase 6b backfill handles embeds). The module is the producer half of CONTEXT's Recent Threads source. Embeddings are deferred to the existing backfill path; heartbeat wiring is in Plan 04-04.

## Must-haves (goal-backward)

- New module `src/angel/transcript-chunker.ts` exports `chunkSessionTranscript(db, sessionId, project): Promise<ChunkResult>` where `ChunkResult = {inserted:number, skipped:'already_chunked'|'empty_session'|null, errors:number}`.
- Reads `conversation_turns` rows for the session ordered by `turn_number ASC`.
- If `conversation_turns` has zero rows → returns `{inserted:0, skipped:'empty_session'}`; no DB writes.
- If any `artifact(kind='transcript_chunk', session_id=?)` already exists → returns `{inserted:0, skipped:'already_chunked'}`; no writes. (Idempotent per-session; re-chunking requires explicit flag — out of scope here.)
- LLM topic-segmenter: passes compact turn previews (turn_number + first 200 chars of user_text + first 200 chars of assistant_text) to `callLocalLLM` with a strict JSON prompt; accepts response shape `{segments: [{start:N, end:M, topic_label:string}]}`.
- Enforces bounds post-LLM: soft `[3, 20]` turns; hard cap `30`. Merge too-small segments with their predecessor; split too-large segments at turn boundaries keeping a generic topic label (`<label> (cont.)`). Segments must cover the full turn range with no gaps or overlaps.
- Insert `artifact` rows via the unified table: `kind='transcript_chunk'`, `title=<topic_label>`, `body=<joined full turn texts separated by \n\n>`, `project_id=<project>`, `session_id=<sessionId>`, `created_at_epoch=<last turn's timestamp in segment>`, `data={turn_range:[start,end], topic_label}`. `embedding_ref` left null. `id` = UUID via existing helper (mirror the pattern from `src/core/migration/v17-runner.ts:235` and directive-detector — use `randomUUID()` from `node:crypto`).
- Fallback when LLM unavailable or returns invalid JSON: **single-chunk fallback** — one chunk covering the full session, `topic_label='session-<sessionId>'`, `turn_range=[first, last]`. Non-throwing — returns `{errors: 1}` but still inserts the fallback.
- Fallback when LLM returns gaps/overlaps: reconstruct coverage deterministically: stitch gaps to the nearest predecessor; clip overlaps at the later segment's start.
- Fallback when turn count is 1 or 2 → produce a single chunk without calling the LLM (below the soft minimum).
- Latency: budget ~20–30s per `/endsession` per CONTEXT Q1 decision — no synchronous embedding in this path (backfill handles it).
- Unit tests assert: chunk schema + turn_range; idempotency (second call skips); LLM-unavailable fallback; bounds enforcement; kind_registry populated; coverage invariant (no gaps/overlaps across final segments).
- `bun run build` succeeds; `bun run test src/tests/angel/transcript-chunker.test.ts` passes; full suite still green.
- No edits to `heartbeat.ts`, `stop.ts`, `session-end.ts`, `assembler`, or `sections.ts` in this plan.

## Tasks

<task id="04-02-01">
  <subject>Scaffold module + types + early-return paths</subject>
  <description>
Create `src/angel/transcript-chunker.ts`. Imports:
```ts
import type { Database } from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { callLocalLLM } from './llama-client.js';
import { cachedPrepare } from '../core/stmt-cache.js';
```

Exports:
```ts
export interface ChunkResult {
  inserted: number;
  skipped: 'already_chunked' | 'empty_session' | null;
  errors: number;
}

export async function chunkSessionTranscript(
  db: Database,
  sessionId: string,
  project: string,
): Promise<ChunkResult> { ... }
```

Implement in order:
1. `const turns = cachedPrepare(db, 'SELECT turn_number, user_text, assistant_text, timestamp_epoch FROM conversation_turns WHERE session_id = ? ORDER BY turn_number ASC').all(sessionId) as ConvTurn[];`
2. If `turns.length === 0` → return `{inserted:0, skipped:'empty_session', errors:0}`.
3. `const existing = cachedPrepare(db, "SELECT 1 FROM artifact WHERE kind = 'transcript_chunk' AND session_id = ? LIMIT 1").get(sessionId);` → if truthy, return `{inserted:0, skipped:'already_chunked', errors:0}`.
4. Proceed to segmentation (next tasks).

Wrap the entire function body in a try/catch at top level; on unexpected throw, emit an error log (`console.error` is fine; Angel-side, captured by the supervisor log path) and return `{inserted:0, skipped:null, errors:1}`.
  </description>
</task>

<task id="04-02-02">
  <subject>LLM topic-segmenter call + strict JSON parser</subject>
  <description>
Add internal helper `async function segmentViaLLM(turns: ConvTurn[]): Promise<Segment[] | null>` where `Segment = {start:number, end:number, topic_label:string}`.

Compose a preview array: for each turn, `{n: turn_number, u: user_text?.slice(0,200) ?? '', a: assistant_text?.slice(0,200) ?? ''}`.

Prompt (literal text the planner can refine during implementation if LLM experiments demand it — keep strict JSON mode):

```
You are segmenting a conversation into topic-coherent chunks.

Rules:
- Each segment covers a contiguous range of turns [start, end] inclusive.
- Segments must cover all turns with no gaps or overlaps.
- Each segment gets a short topic_label (<= 60 chars).
- Aim for 3-20 turns per segment; absolute maximum 30.
- If the whole conversation is one topic, return one segment.

Output STRICT JSON matching:
{ "segments": [ { "start": N, "end": M, "topic_label": "..." } ] }

Turns:
<insert compact turn preview JSON here>
```

Call via `callLocalLLM({ messages, temperature: 0.2, jsonMode: true })` (check the actual `llama-client.ts` signature; mirror what `directive-detector.ts` does). Parse response; validate shape:
- `Array.isArray(segments)` and non-empty
- every element has integer `start`, `end`, `end >= start`, `topic_label` string
- `start` of first segment equals `turns[0].turn_number`
- `end` of last segment equals `turns[turns.length-1].turn_number`
- strictly increasing starts (no overlaps) and no gaps (prev.end + 1 === next.start)

If validation fails → return `null` (caller uses single-chunk fallback). Do not attempt repair here; task 04-02-03 handles post-LLM bounds enforcement separately from shape validity.
  </description>
</task>

<task id="04-02-03">
  <subject>Bounds enforcement (soft 3-20, hard 30) + coverage reconciliation</subject>
  <description>
Add `function enforceBounds(segments: Segment[], turnNumbers: number[]): Segment[]`:

1. **Merge-up pass**: iterate; if any segment has `end - start + 1 < 3` (below soft-min) AND it's not the only segment, merge it INTO its predecessor (extend predecessor.end = this.end; drop this segment; keep predecessor's topic_label).
   - If the FIRST segment is below soft-min, merge it INTO its successor instead; use successor's topic_label.
   - Single segment covering the whole session is always allowed (even < 3 turns).

2. **Split-down pass**: iterate; if any segment has `end - start + 1 > 30` (hard-max), split into consecutive 30-turn spans. Each span keeps a suffixed label: first span `<label>`, continuation spans `<label> (cont.)`.

3. **Coverage invariant**: after merge+split, assert that:
   - first segment start == first turn number,
   - last segment end == last turn number,
   - every pair (prev, next) satisfies `prev.end + 1 === next.start`.
   If any of these fail after merge+split (shouldn't, but defensive), rebuild a single fallback segment covering everything with label `'session-<sessionId>'`.

Unit tests for this function alone (pure, no DB):
- 5 segments with one 2-turn segment in the middle → merged into predecessor.
- 1 segment of 60 turns → split into two 30-turn segments, labels `<X>` and `<X> (cont.)`.
- Mixed gaps (LLM produced [1,5],[7,10]) → bounds enforcement returns single fallback (coverage invariant fail path tested by feeding raw invalid input directly).
  </description>
</task>

<task id="04-02-04">
  <subject>Artifact insertion with turn_range + topic_label</subject>
  <description>
Add `function insertChunks(db: Database, sessionId: string, project: string, turns: ConvTurn[], segments: Segment[]): number`.

For each segment:
1. Collect the turn rows in `[start..end]`.
2. `body = turns.map(t => [t.user_text, t.assistant_text].filter(Boolean).join('\n')).join('\n\n')`. Skip per-turn truncation here — the full-text body is the source of truth for embeds. (Long-tail sessions may produce multi-KB chunks; that is fine — 25KB per chunk is well within SQLite TEXT.)
3. `created_at_epoch = turnsInSegment[last].timestamp_epoch` (most-recent turn's ts).
4. `data = JSON.stringify({ turn_range: [segment.start, segment.end], topic_label: segment.topic_label })`.
5. Insert via:
```sql
INSERT INTO artifact(
  id, kind, title, body, scope, status, confidence,
  created_at_epoch, updated_at_epoch, session_id, project_id, data
) VALUES (?, 'transcript_chunk', ?, ?, NULL, 'active', NULL, ?, ?, ?, ?, ?)
```
Bind: `randomUUID(), topic_label, body, created_at_epoch, created_at_epoch, sessionId, project, JSON.stringify(data)`.

Rely on V17's `artifact_register_kind` trigger (src/core/migration/v17-ddl.ts:91-99) to populate `kind_registry` on first insert — no manual registry write.

Return inserted count.

Implementation uses a single `db.prepare` outside the loop + `stmt.run(...)` inside; do NOT wrap in a transaction (Angel is cooperative; the DB lock model allows concurrent readers).
  </description>
</task>

<task id="04-02-05">
  <subject>Single-chunk fallback when LLM path fails</subject>
  <description>
In the main `chunkSessionTranscript` flow, after the idempotency guard:

```ts
let segments: Segment[] | null = null;
let errors = 0;

if (turns.length >= 3) {
  try {
    segments = await segmentViaLLM(turns);
  } catch { errors++; }
}

if (!segments) {
  // Single-chunk fallback: always covers the entire session.
  segments = [{
    start: turns[0].turn_number,
    end: turns[turns.length - 1].turn_number,
    topic_label: `session-${sessionId.slice(0, 8)}`,
  }];
} else {
  segments = enforceBounds(segments, turns.map(t => t.turn_number));
}

const inserted = insertChunks(db, sessionId, project, turns, segments);
return { inserted, skipped: null, errors };
```

Rationale: LLM unavailability (reranker down, timeout, malformed JSON) must NOT block chunking. The fallback is a functional single chunk with a generic label; Recent Threads section will still surface the session, just without a topic-coherent label. This matches CONTEXT §Handoff source rationale — "loud failure, clean fallback" over silent corruption.

Unit test: mock `callLocalLLM` to throw → fallback invokes → one chunk inserted, `errors === 1`.
Unit test: mock `callLocalLLM` to return `{segments: [...]}` that fails shape validation → fallback invokes → one chunk inserted, `errors === 0` (no exception), `segments` was null not thrown.

Clarification: the `errors` counter reflects exceptions during LLM call specifically (network, JSON parse throw). Shape-validation returning `null` is not counted as an error because it's a deterministic "LLM output unusable" and the fallback handles it cleanly.
  </description>
</task>

<task id="04-02-06">
  <subject>Unit test suite</subject>
  <description>
Create `src/tests/angel/transcript-chunker.test.ts` using vitest + in-memory SQLite + `applyV17DDL`:

1. **Empty session** — no conversation_turns rows → returns `{inserted:0, skipped:'empty_session'}`.
2. **Already chunked** — pre-insert one `artifact(kind='transcript_chunk', session_id=X)` → second call returns `{inserted:0, skipped:'already_chunked'}`.
3. **Single turn** — 1 turn only → bypass LLM, single chunk, `topic_label` starts with `session-`.
4. **Three turns, LLM returns one segment** — mock `callLocalLLM` to return `{segments:[{start:1,end:3,topic_label:'setup'}]}` → one chunk inserted; assert `data.turn_range === [1,3]`, `data.topic_label === 'setup'`, `kind_registry` has `transcript_chunk` row, `title === 'setup'`.
5. **30 turns, LLM returns two segments** — mock returns `{segments:[{1,15,'a'},{16,30,'b'}]}` → two chunks, coverage invariant holds.
6. **LLM returns too-small segment** — mock returns `{segments:[{1,2,'tiny'},{3,10,'main'}]}` → bounds merge → one chunk `[1,10]` labeled `'main'` (or `'tiny'` if predecessor-merge applies at position 0 → test explicitly asserts label came from segment 2 per task 04-02-03 rule "first segment below soft-min merges INTO successor").
7. **LLM returns oversize segment** — mock returns `{segments:[{1,60,'huge'}]}` → split into `[1,30,'huge']` and `[31,60,'huge (cont.)']`.
8. **LLM throws** — mock throws `new Error('timeout')` → fallback single chunk inserted, `errors:1`.
9. **LLM returns malformed JSON** — mock returns string `'not json'` → fallback single chunk, `errors:0`.
10. **LLM returns shape-invalid with gaps** — mock returns `{segments:[{1,3,'a'},{5,10,'b'}]}` (gap at turn 4) → validation rejects → fallback, `errors:0`.
11. **Turn texts preserved in body** — 5 turns with distinct user_text/assistant_text → assert chunk body contains every turn's full text verbatim, joined with `\n\n`.

Use `vi.mock('../../../../src/angel/llama-client.js', ...)` or dependency-inject the LLM function. If the existing llama-client export makes mocking ugly, prefer passing a `llmFn` parameter with a default — planner's call. Consistency note: `directive-detector.ts` doesn't inject; it imports directly. Mirror whichever pattern is already tested in `src/tests/intelligence/directive-detector.test.ts` (likely `vi.mock`).
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/angel/transcript-chunker.test.ts` — all 11 cases pass.
- `bun run test` — full suite green.
- `kind_registry` has `transcript_chunk` row after any successful chunk insert (covered by task 04-02-06 case 4).
- Diff touches ONLY `src/angel/transcript-chunker.ts` and `src/tests/angel/transcript-chunker.test.ts`. No heartbeat, no stop hook, no session-end, no assembly layer changes.
