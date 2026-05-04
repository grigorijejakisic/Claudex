---
plan_id: 03-01
phase: 3
wave: 1
depends_on: []
files_modified:
  - src/intelligence/directive-detector.ts
  - src/intelligence/directive-detector-config.ts
  - src/intelligence/directive-detector-regex.ts
  - src/tests/intelligence/directive-detector.test.ts
  - src/tests/intelligence/directive-schema.test.ts
autonomous: true
requirements:
  - EXTR-01
  - EXTR-02
---

# Plan 03-01: Detector Core (regex + LLM confirm + scope + dedup + write)

## Objective

Implement the directive detector as a pure module — callable as `extractDirectivesFromSession(db, sessionId, projectId, opts?)`. No heartbeat hook yet (Plan 03-04 wires it). No prompt asset loading yet (Plan 03-02 ships the assets; this plan stubs `loadPromptAssets()` with inline-for-now strings that match the eventual fixture shape).

## Must-haves (goal-backward)

- `directive-detector.ts` exports `extractDirectivesFromSession(db, sessionId, projectId, opts?): Promise<{candidates, confirmed, inserted, updated, skipped, errors}>`.
- `directive-detector-config.ts` exports `DirectiveDetectorConfig` + `loadConfig(overrides?)` with locked defaults (`thresholdGeneral: 0.70, thresholdUniversal: 0.85, dedupCosineThreshold: 0.80, model: 'glm-5.1:cloud'`).
- `directive-detector-regex.ts` exports `DIRECTIVE_REGEX_FAMILIES: Array<{name: string, re: RegExp}>` covering the 12 CONTEXT §Area-1 families. Shared with Plan 03-03.
- Regex pre-filter runs only on stripped user_text (fenced + inline backtick removed); assistant_text never scanned.
- Context window: `±2` turns around match, fetched from `conversation_turns`, un-stripped (preserves code context for LLM).
- Confirmer call returns `{is_directive, confidence, polarity, scope, suggested_title, normalized_text, reasoning}` JSON.
- Reject rule: `!is_directive || confidence < thresholdGeneral || (scope === 'universal' && confidence < thresholdUniversal)` → no write.
- Dedup: vec0 top-3 same-scope, same-project `directive_rule` lookup; cosine ≥ 0.80 → LLM relation classification; 4-branch write policy (restatement UPDATE; opposite INSERT + annotate; related INSERT + annotate; unrelated INSERT).
- `dryRun: true` in opts skips all DB writes but returns the full decision record — enables Plan 03-05 harness.
- Open questions from RESEARCH §4 resolved in code comments + matching unit tests:
  - Q1: reject outright on universal-under-gate; no downgrade.
  - Q2: `project_id = source_session.project` even for universal scope.
  - Q3: dedup scope filter `scope=?` (no cross-scope dedup).
  - Q4: session-scope dedup spans all same-project sessions.
- vec0 distance → cosine conversion verified:
  - unit test asserts `embedText()` output is unit-normalized (norm in [0.999, 1.001]).
  - helper `l2DistanceToCosine(d) = 1 - d*d/2` with unit test covering d=0, d=√2, d=2.
  - OR: vec0 column redeclared with cosine hint if supported by the build (check `sqlite-vec-loader.ts` before committing).
- `reinforcements[]` slide-window cap at 50 entries (drop oldest).
- `directive-schema.test.ts` snapshots `data` JSON shape for all 4 write-paths (fresh, restatement, opposite_polarity, related_but_distinct).
- All 2020 pre-existing tests still pass.

## Tasks

<task id="03-01-01">
  <subject>Create directive-detector-regex.ts</subject>
  <description>
Export `DIRECTIVE_REGEX_FAMILIES: Array<{name: string, re: RegExp}>`. Names are `snake_case` family tags used as `regex_family` values in `artifact.data`.

Families (case-insensitive):
- `remember_this_that_to`: `/\bremember\s+(this|that|to)\b/i`
- `remember_colon`: `/\bremember:/i`
- `always_emphasis`: `/\balways\b/i`
- `never_emphasis`: `/\bnever\b/i`
- `from_now_on`: `/\bfrom now on\b/i`
- `next_time`: `/\bnext time\b/i`
- `in_the_future`: `/\bin the future\b/i`
- `polite_imperative`: `/\bplease\s+(do|don't|stop|always|never)\b/i`
- `stop_doing_using`: `/\bstop\s+(doing|using)\b/i`
- `negation_dont`: `/\b(don't|do not)\b/i`
- `do_x_instead`: `/\bdo\s+[^.!?\n]+?\s+instead\b/i`
- `use_x_instead`: `/\buse\s+[^.!?\n]+?\s+instead\b/i`

Also export `stripCodeBlocks(text: string): string` — removes fenced + inline single-backtick. Fenced: `/\u0060\u0060\u0060[\s\S]*?\u0060\u0060\u0060/g`. Inline: `/\u0060[^\u0060\n]*\u0060/g`.

Used by both the detector (03-01) and the candidate-builder (03-03). No other responsibilities.
  </description>
</task>

<task id="03-01-02">
  <subject>Create directive-detector-config.ts</subject>
  <description>
```ts
export interface DirectiveDetectorConfig {
  thresholdGeneral: number;        // default 0.70
  thresholdUniversal: number;      // default 0.85
  dedupCosineThreshold: number;    // default 0.80
  reinforcementCap: number;        // default 50
  model: string;                   // default 'glm-5.1:cloud'
  dryRun: boolean;                 // default false
}

export const DEFAULT_CONFIG: DirectiveDetectorConfig = {
  thresholdGeneral: 0.70,
  thresholdUniversal: 0.85,
  dedupCosineThreshold: 0.80,
  reinforcementCap: 50,
  model: 'glm-5.1:cloud',
  dryRun: false,
};

export function loadConfig(overrides?: Partial<DirectiveDetectorConfig>): DirectiveDetectorConfig {
  return { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
}
```

No env-var read. The harness (03-05) and Angel hook (03-04) pass overrides explicitly.
  </description>
</task>

<task id="03-01-03">
  <subject>Implement directive-detector.ts — pipeline skeleton + pure helpers</subject>
  <description>
Export:

```ts
export interface DetectionRecord {
  session_id: string;
  turn_idx: number;
  raw_text: string;
  matched_families: string[];
  confirmation?: ConfirmationResult;
  decision: 'rejected_regex' | 'rejected_confirm' | 'inserted' | 'updated' | 'annotated_opposite' | 'annotated_related' | 'error';
  artifact_id?: string;
  dedup?: { top1_id: string; cosine: number; relation: string };
  error?: string;
}

export interface ConfirmationResult {
  is_directive: boolean;
  confidence: number;
  polarity: 'prescriptive' | 'prohibitive' | null;
  scope: 'session' | 'project' | 'universal' | null;
  suggested_title: string | null;
  normalized_text: string | null;
  reasoning: string | null;
}

export interface ExtractResult {
  candidates: number;
  confirmed: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  decisions: DetectionRecord[];  // always populated; caller picks what to log
}

export async function extractDirectivesFromSession(
  db: Database,
  sessionId: string,
  projectId: string,
  opts?: Partial<DirectiveDetectorConfig>,
): Promise<ExtractResult>;
```

Internal helpers (all pure where possible, each unit-tested):
- `collectCandidates(turns): DetectionRecord[]` — applies `stripCodeBlocks` + regex families.
- `fetchContextWindow(db, sessionId, turnIdx): Turn[]` — ±2, un-stripped.
- `formatContextForLLM(window, targetTurnIdx): string` — "[Turn N] USER: …" style, matches pattern-extractor.ts:69-89 style.
- `parseConfirmation(raw: string): ConfirmationResult | null` — JSON.parse inside try/catch + shape guard. null on malformed.
- `shouldReject(c: ConfirmationResult, cfg): 'reject_is_directive' | 'reject_threshold' | 'accept'` — encodes Q1 (universal under 0.85 → reject outright, no downgrade).
- `dedupLookup(db, embedding, scope, projectId): Array<{id, cosine, body, data}>` — top-3 via vec0.
- `classifyRelation(llm, candidate, shortlist): Promise<'restatement' | 'opposite_polarity' | 'related_but_distinct' | 'unrelated'>` — one LLM call when cosine ≥ 0.80.
- `writeArtifact(db, record, relation, dedupHit, cfg)` — honors dryRun; 4-branch switch from RESEARCH §3.2.
- `trimReinforcements(db, artifactId, cap)` — slide-window helper; called after UPDATE if `json_array_length` > cap.

`extractDirectivesFromSession` orchestrates these. Non-throwing at top level: wrap individual candidate processing in try/catch; increment `errors` and continue. Return populated `decisions` array for harness auditability.
  </description>
</task>

<task id="03-01-04">
  <subject>Implement vec0 dedup lookup + distance conversion</subject>
  <description>
Check `src/embeddings/sqlite-vec-backend.ts` for how existing code consumes vec0 `MATCH`. Determine:
- Does `artifact_embeddings` declaration support a cosine hint in this build? If yes (check `sqlite-vec-loader.ts` and the version pinned in `package.json`): redeclare the column with the hint in a lightweight migration, OR document that `v17-ddl.ts` should be updated in a follow-up and convert in code for now.
- If no: use `l2DistanceToCosine(d) = 1 - d*d/2` with a unit test covering d=0 (cos=1.0), d=√2≈1.414 (cos=0.0), d=2 (cos=-1.0).

Do NOT modify `v17-ddl.ts` in this plan (would require a migration bump). Stay in-module and convert.

Query skeleton:
```sql
SELECT a.id, a.body, a.scope, a.data, ae.distance
FROM artifact a
JOIN artifact_embeddings ae ON ae.rowid = a.embedding_ref
WHERE a.kind='directive_rule'
  AND a.scope = ?
  AND a.project_id = ?
  AND ae.embedding MATCH ?
  AND k = 3
ORDER BY ae.distance
```

Note: sqlite-vec requires `MATCH` + `k` as a KNN query; `WHERE scope = ... AND project_id = ...` is a post-filter after the vec0 join. If vec0 version doesn't support pre-filter, materialize candidates then filter in JS — ~3-5 rows either way.

Unit test: seed 5 `directive_rule` artifacts (3 same-scope, 2 different-scope) with known embeddings; assert dedup returns only same-scope top-3 ordered by cosine DESC.
  </description>
</task>

<task id="03-01-05">
  <subject>Implement write-path (INSERT fresh / restatement UPDATE / annotated INSERTs)</subject>
  <description>
Implement `writeArtifact()` per RESEARCH §3.2. Four branches:

1. **Fresh / unrelated / no-cosine-hit:** INSERT with baseline `data` (no `possible_contradicts`, no `related_to`). `reinforcement_count: 1`, `reinforcements: [{…}]`.
2. **Restatement:** UPDATE existing row only. Bump `reinforcement_count`, append to `reinforcements[]` via `json_insert`, bump `updated_at_epoch`. Call `trimReinforcements` if length > cap. Do NOT bump `confidence`.
3. **Opposite polarity:** INSERT new row; `data.possible_contradicts = top1.id`, `data.contradict_reason = relation_llm.reasoning`.
4. **Related but distinct:** INSERT new row; `data.related_to = top1.id`, `data.related_cosine = <num>`, `data.related_relation = 'related_but_distinct'`.

For every INSERT: write the embedding into `artifact_embeddings` (auto rowid via `RETURNING rowid`), then `UPDATE artifact SET embedding_ref = ? WHERE id = ?`. Use a single transaction per candidate to keep the artifact + its embedding_ref consistent.

`dryRun: true` → short-circuit before any DB write; still return the `DetectionRecord` with `decision` set to the branch that would have been taken.
  </description>
</task>

<task id="03-01-06">
  <subject>Inline prompt stubs (to be replaced by 03-02 loader)</subject>
  <description>
Until Plan 03-02 ships the prompt-asset files, inline the system prompts as constants in `directive-detector.ts`:

```ts
const CONFIRMATION_SYSTEM_PROMPT = `You detect user directives in conversation transcripts.
A directive is a standing rule the user states for future turns — not a task request, not
a question, not an observation.

Output JSON only, matching:
{ "is_directive": boolean,
  "confidence": number (0..1),
  "polarity": "prescriptive"|"prohibitive"|null,
  "scope": "session"|"project"|"universal"|null,
  "suggested_title": string|null,
  "normalized_text": string|null,
  "reasoning": string }

Scope rubric:
- session: scoped to the current task/PR/debugging loop
- project: applies everywhere in this repo
- universal: applies across every project the user works on

If is_directive is false, set polarity/scope/suggested_title/normalized_text to null.`;
```

And a similar `DEDUP_RELATION_SYSTEM_PROMPT` for the 4-way classifier. Document with a TODO comment that 03-02 replaces these with file-backed + few-shot-augmented versions via `loadPromptAssets()`.

Shape the inline version so the eventual swap is a pure refactor — 03-02 doesn't have to change the detector's call site.
  </description>
</task>

<task id="03-01-07">
  <subject>Write unit tests — directive-detector.test.ts</subject>
  <description>
Coverage matrix (one vitest `describe` block per helper):
- `stripCodeBlocks`: fenced, inline, mixed, no-code, nested-looking.
- `collectCandidates`: each of 12 regex families hits; negative (no match); mixed (one turn, multiple families).
- `shouldReject`: is_directive=false; confidence=0.69 (general); confidence=0.84 on universal; confidence=0.70 on general (accept); confidence=0.85 on universal (accept).
- `parseConfirmation`: valid, missing fields, wrong types, unparseable JSON.
- `dedupLookup`: seeds 5 artifacts, asserts top-3 same-scope same-project ordering.
- `classifyRelation`: mocks LLM client, asserts each of 4 relation strings routes correctly.
- End-to-end with `dryRun: true`: seed conversation_turns with 3 user turns (1 confirmed, 1 regex-rejected, 1 confirm-rejected); assert `ExtractResult` counters.

Mock `callLocalLLM` via dependency injection OR module-level vi.mock.
Mock `embedText` to return a stable unit-normalized vector.
  </description>
</task>

<task id="03-01-08">
  <subject>Write schema contract test — directive-schema.test.ts</subject>
  <description>
Four `it` blocks, one per write-path. Each seeds state, runs `extractDirectivesFromSession` with canned LLM responses, then snapshots `JSON.parse(artifact.data)` via vitest `toMatchInlineSnapshot`.

Shapes (asserted via inline snapshot):

**Fresh INSERT `data`:**
```json
{
  "polarity": "prescriptive",
  "reasoning": "<string>",
  "source_session_id": "<uuid>",
  "source_turn_idx": <int>,
  "regex_family": "<snake_case>",
  "reinforcement_count": 1,
  "reinforcements": [{ "session_id": "...", "turn_idx": <int>, "seen_at_epoch": <int>, "regex_family": "..." }]
}
```

**Restatement (UPDATE) `data`:** same keys, `reinforcement_count: 2`, `reinforcements.length: 2`.

**Opposite polarity `data`:** fresh keys + `possible_contradicts: "<uuid>"` + `contradict_reason: "<string>"`.

**Related-but-distinct `data`:** fresh keys + `related_to: "<uuid>"` + `related_cosine: <num>` + `related_relation: "related_but_distinct"`.

Comment block at the top of the file: `This test is the P2↔P8 schema contract. Changing it means coordinating with Phase 10 (Rule lifecycle).`
  </description>
</task>

## Verification

- `bun run build` succeeds — no new type errors.
- `bun run test src/tests/intelligence/directive-detector.test.ts src/tests/intelligence/directive-schema.test.ts` — all pass.
- `bun run test` — all 2020 pre-existing tests still pass.
- `rg -n 'from .*/assembler/' src/intelligence/directive-detector.ts` — no import (injection-path isolation).
- `rg -n 'extractDirectivesFromSession' src/angel/heartbeat.ts` — no call yet (wired by 03-04).
