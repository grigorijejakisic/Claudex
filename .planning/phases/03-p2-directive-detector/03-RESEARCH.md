# Phase 3: P2 — Directive Detector — Research

**Researched:** 2026-04-20
**Driven by:** `03-CONTEXT.md` (169 lines, all Decisions locked)
**Scope:** Build `src/intelligence/directive-detector.ts` that turns user-authored directives in completed sessions into `artifact(kind='directive_rule', ...)` rows. Angel extraction phase. No injection-path changes.

## RESEARCH COMPLETE

---

## 1. Audit — CONTEXT plan-phase items resolved

### 1.1 Angel extraction integration point (audit item #1)

**Where the detector plugs in:** `src/angel/heartbeat.ts` lines **219-261** (Phase 2: "Process completed sessions"). The existing loop already fetches `getUnprocessedSessions()` and calls `extractPatternsFromSession()` + `classifySessionDomains()`. The directive detector must run on this same set **before** the pattern-extractor body executes — satisfies EXTR-03 "before generic ingester."

**Call-order contract** (inside the existing `for (const session of unprocessed)` loop):
```
1. extractDirectivesFromSession(db, session.session_id, session.project)   ← NEW (P2)
2. extractPatternsFromSession(db, session.session_id, ...)                 ← existing
3. classifySessionDomains(db, session.session_id, ...)                     ← existing
```

Reuse the **same `getUnprocessedSessions`** cursor the pattern extractor uses — do NOT add a parallel cursor. Rationale: P1 semantics say "a session is processed when Angel has finished all its extraction phases." Adding a second cursor forces dual bookkeeping and race windows between the two extractors. If the directive call throws, the outer `try`/catch at line 258 already absorbs it and continues to the next session — no work lost.

**Cursor persistence:** `markSessionProcessed()` at `session-monitor.ts` is called from the existing path after pattern extraction. The directive extractor does NOT mark the session processed itself; it hands off to the existing post-condition. If the directive call fails cleanly (returns `{directives: 0}`), we still mark processed via the existing `definitiveOutcomes` logic.

**Session batch size:** inherit `batchSize` from heartbeat.ts:225 (3 while user is active, 5 while autonomous). No separate config. Keeps LLM budget deterministic.

### 1.2 Fixture corpus discovery (audit item #2)

**Actual corpus after mapping session logs → DB session_ids:**

| Log file | session_id (first 18) | user turns | notes |
|---|---|---:|---|
| session-37 | ba9eeaf8-b666-41f9 | 61 | |
| session-38 | be1e3376-62a4-493b | 92 | log file appears twice — same sid, dedupe on sid |
| session-39 | 257380ce-1516-4e91 | 13 | |
| session-40 | 8fac41a9-022f-4c16 | 98 | |
| session-41 | 3c4196f4-2c7f-4c72 | 29 | |
| session-42 | 3af60620-a060-4646 | 30 | |
| session-43 | d8c2005c-5929-4918 | 52 | |
| session-44 | 5ad74da3-8ea6-4dcd | 37 | |
| session-45 | 812a07cf-5089-47a6 | 36 | |
| session-46 | 2029f591-1d6f-4145 | 11 | |
| session-47 | fade30a9-5fa0-41f2 | 28 | |
| session-48 | 4a20a39d-3c85-4697 | 17 | |
| session-49 | d4e1d7e0-48c3-4449 | 16 | |
| session-50 | 7947f681-ef01-4e6a | 6  | |
| session-51 | ff9a6bfa-184c-45c6 | 0  | **EXCLUDE** — log-only, no DB turns |

**Effective corpus:** 14 unique sessions, **526 user turns total**. session-51 is dropped because `conversation_turns` has zero rows (the session was saved to `context/sessions/` but turns were not persisted to DB). session-38 appears in two log files with the same session_id; dedupe by session_id at fixture-build time.

**Regex pre-filter hit rate on CONTEXT §Area-1 family set** (empirical, measured against the corpus, after stripping fenced `` ``` `` and inline single-backtick code):

```
turns matching ≥1 regex family:  105 / 526 = 20.0%
```

This matches CONTEXT's projection of "~7-10 hits/session → ~100 candidates." Labeling effort estimate from CONTEXT (~30 min human review for ~100) stands.

**Fixture spec:**
- Source of truth: hard-coded list of 14 session_ids in `src/benchmarks/directive-detector/fixture-sessions.ts` (ordinal → sid), committed. Enables cross-machine reproducibility without re-reading session logs.
- Corpus build step: materialize `fixture-candidates.jsonl` containing `{session_id, turn_idx, user_text, surrounding_turns[±2], matched_regex_family}` — one row per regex hit. Committed to `.planning/phases/03-p2-directive-detector/fixtures/` (gitignored for size? decide at execution — 105 rows × ~2KB = ~200KB, tiny, commit it).

### 1.3 Labeling agent design (audit item #3)

**Labeler runs as a team-spawned sub-agent during P2 execution** — reuses the same `auto-gsd-pipeline` team pattern that produced this plan. Critical constraint: **labeler must NOT be glm-5.1** (the detector's LLM), or self-agreement bias inflates precision. Labeler model = Claude Sonnet via CLIProxy main-Claude (per CONTEXT §Area 4).

**Labeler contract:**
- Input: `fixture-candidates.jsonl` (from §1.2).
- Per candidate, output: `{candidate_id, label: {is_directive, scope, polarity}, self_confidence: 0..1, reasoning: string}`.
- Output file: `.planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl`.
- Temperature 0; single-pass (no chain-of-thought loop).

**Labeler prompt structure** (skeleton — full prompt crafted during Plan 03-03 execution):
```
You are labeling candidate directives in user turns from a coding agent's
conversation transcripts. For each candidate, output JSON:
- is_directive: bool (is this a standing directive vs. a request/question/observation?)
- scope: 'session'|'project'|'universal' (null if is_directive=false)
- polarity: 'prescriptive'|'prohibitive' (null if is_directive=false)
- self_confidence: 0..1
- reasoning: one sentence

Use the ±2 surrounding turns for context. A directive is a standing rule the
user wants applied in future turns — not a task request, not a question.
```

**Human review pass:**
- All labels with `self_confidence < 0.8` → manual review.
- All detector/labeler disagreements → manual review.
- ~10% random spot-check of agreed-high-confidence rows → manual review.
- Output: `gold-labels.jsonl` with a `human_verified: bool` flag merged in.

### 1.4 Prompt fixture file layout (audit item #4)

**On-disk layout:**
```
src/intelligence/directive-detector-prompts/
  confirmation-few-shot.json      — array of {candidate_text, context[±2], expected_output}
  scope-rubric-few-shot.json      — array of {text, expected_scope, rationale}
  confirmation-system-prompt.md   — static system prompt, `{{FEW_SHOT}}` placeholder
  scope-rubric-system-prompt.md   — static system prompt, `{{FEW_SHOT}}` placeholder
```

**Loader:** `loadPromptAssets()` in `directive-detector.ts` reads both JSON files at detector-module init, validates schema via a small zod-like guard (or plain TypeScript type assertion — we already use plain TS guards throughout Angel), formats `{{FEW_SHOT}}` via `JSON.stringify(examples, null, 2)`. Cache in module scope. Re-read if `DIRECTIVE_DETECTOR_RELOAD_PROMPTS=1` env flag set (iteration ergonomics).

**Fixture content source:** 3 session-scoped examples, 3 project-scoped, 3 universal. Draw from the user's actual directives (CLAUDE.md global + `memory/feedback_*.md`). CONTEXT §Area-3 lists starter examples; flesh out during Plan 03-02 execution.

**Why JSON not hardcoded TS:** CONTEXT §specifics: swap examples without a source-code patch; P8 tuning future-proofing. JSON also makes prompt-example diffs reviewable without Git showing strings inside TS literals.

### 1.5 Precision test harness (audit item #5)

**Harness location:** `src/benchmarks/directive-detector/run-precision.ts`. Entry point:
```
bun run src/benchmarks/directive-detector/run-precision.ts
  --fixture=gold-labels.jsonl
  --prompts=src/intelligence/directive-detector-prompts/
  --threshold=0.7
  [--threshold-universal=0.85]
  [--model=glm-5.1:cloud]
  --output=.planning/phases/03-p2-directive-detector/fixtures/runs/<timestamp>.json
```

**Metrics emitted:**
- **Primary gate:** `joint_precision = count(is_directive ✓ AND scope ✓ AND polarity ✓) / count(detector-confirmed directives)`.
- Diagnostic: `is_directive_precision`, `scope_precision_given_is_directive_correct`, `polarity_precision_given_is_directive_correct`.
- Secondary: recall vs. labeler's gold set (informational only — CONTEXT says silent > wrong, recall does NOT gate).
- Per-regex-family breakdown (useful when tuning regex list in iteration).
- Per-scope breakdown (universal errors count double — higher blast radius).

**Output format:** single JSON per run, committed to `fixtures/runs/` for longitudinal comparison across iteration cycles. Diff two runs with a built-in `compare-runs.ts` helper that emits a markdown table.

**Re-runnable:** no DB mutation — the harness reads `fixture-candidates.jsonl` as input; detector runs in dry-run mode (no `INSERT INTO artifact`). Adds `dryRun: true` flag to `detectDirectivesInSession(...)`. Tests the exact same code path as production minus the write.

### 1.6 Iteration-cycle runbook (audit item #6)

**Tuning decision tree** (formalized from CONTEXT §Area 4):

```
Run precision harness →
├─ joint_precision ≥ 92%   → SHIP. Commit config, run full benchmark suite.
├─ 88% ≤ joint < 92%       → NOISE-BOUND. Expand fixture to ~200 candidates
│                            (label sessions 22-36 — see §1.2 extension below).
│                            Re-run. Go back to decision tree.
└─ joint_precision < 88%   → TUNE. Enter 3-cycle budget:
     Cycle 1 — THRESHOLD: sweep confidence threshold in {0.65, 0.70, 0.75, 0.80}
               for project/session; {0.80, 0.85, 0.90} for universal.
               Pick the (t_p, t_u) pair that maximizes joint while keeping
               universal_precision ≥ 95%. If max < 88%, proceed to Cycle 2.
     Cycle 2 — REGEX + FEW-SHOT: inspect per-regex-family breakdown; drop
               families with <50% confirm rate; add families suggested by
               false-negatives (labeler-said-yes but detector missed).
               Swap 3 few-shot examples toward the dominant failure mode.
               Re-run at Cycle-1 best threshold. If < 88%, proceed to Cycle 3.
     Cycle 3 — PROMPT REWRITE: rewrite scope rubric + confirmation system
               prompt. One structural change per run (easier to attribute).
               Re-run. If still < 88% → ESCALATE to user with:
                 - all 3 cycle run JSONs
                 - top-10 false-positives + top-10 false-negatives
                 - proposed alternatives (lower fixture gate? wider corpus?
                   reframe scope definitions?)
```

**Extension corpus (if Cycle 1 produces noise-bound result):** sessions 22-36 (15 additional) — logs exist at `context/sessions/2026-03-2?_session-*.md`. Enough to roughly double candidates to ~200, dropping ±3pp CI to ±2pp.

**Escalation message format** (human-readable, posted as teammate message to `team-lead`):
```
Directive detector P2 iteration budget exhausted — cycle 3 joint precision=X%.
Cycles tried: threshold={values}, regex={changes}, prompt={summary}.
Top failure mode: {scope confusion | polarity flip | is_directive false positive}.
Options:
  (A) Lower fixture gate to Y%  — risk Z
  (B) Corpus expansion to 30 sessions — estimated +M hours labeling
  (C) Rethink scope taxonomy — {specific proposal}
Awaiting direction.
```

### 1.7 Threshold source of truth (audit item #7)

**Decision: config file, not env var, not constant.** New file `src/intelligence/directive-detector-config.ts`:
```ts
export interface DirectiveDetectorConfig {
  thresholdGeneral: number;       // default 0.70
  thresholdUniversal: number;     // default 0.85
  dedupCosineThreshold: number;   // default 0.80
  model: string;                  // default 'glm-5.1:cloud'
  dryRun?: boolean;               // precision harness only
}
export function loadConfig(overrides?: Partial<DirectiveDetectorConfig>): DirectiveDetectorConfig;
```

- **Why config file, not env:** iteration-friendly (a run-specific override goes in the harness CLI args, not in shell state), but still single-source-of-truth for production.
- **Why not a `directive_detector_config` DB table:** feature-flag-level tuning stays local to the detector module. If P8 later needs cross-session config dynamics, promote to DB then.
- Harness overrides via `--threshold=0.7 --threshold-universal=0.85`. Production Angel loads defaults.

### 1.8 Schema contract with P8 (audit item #8)

**Passive annotations P2 writes into `artifact.data` (strings/JSON; never indexed):**
- `possible_contradicts: string` — UUID of `artifact` row whose polarity is opposite at cosine ≥ 0.80. Set when `dedupRelation = 'opposite_polarity'`.
- `contradict_reason: string` — the relation-LLM's free-text rationale.
- `related_to: string` — UUID of closest-cosine same-scope `directive_rule`.
- `related_cosine: number` — the cosine score (for P8 auditability).
- `related_relation: string` — `'related_but_distinct'` (only case stored; `'unrelated'` writes no annotation).
- `reinforcement_count: number` — starts at 1 at INSERT, incremented on `'restatement'` UPDATE.
- `reinforcements: Array<{session_id, turn_idx, seen_at_epoch, regex_family}>` — appended on every `'restatement'`. Cap at **50 entries** (slide window; drop oldest beyond cap) to prevent unbounded JSON growth on rules the user repeats forever.

**P2 does NOT:**
- set `supersedes_id` (P8 owns this)
- update `status` (everything stays `'active'`)
- decay `confidence` (initial value from the confirmer is frozen until P8)

**Test artifact for P8 handoff:** a `directive-schema.test.ts` file that snapshots the JSON shape of `data` across the 4 write-paths (restatement / opposite / related / unrelated). Becomes the contract P8 must not break.

---

## 2. Integration path — source file map

### 2.1 New files

| Path | Purpose | Plan |
|---|---|---|
| `src/intelligence/directive-detector.ts` | Core detector — regex + LLM confirm + scope + dedup + write | 03-01 |
| `src/intelligence/directive-detector-config.ts` | Thresholds, model, dryRun | 03-01 |
| `src/intelligence/directive-detector-prompts/confirmation-few-shot.json` | swappable few-shot set | 03-02 |
| `src/intelligence/directive-detector-prompts/scope-rubric-few-shot.json` | swappable scope examples | 03-02 |
| `src/intelligence/directive-detector-prompts/confirmation-system-prompt.md` | static prompt, `{{FEW_SHOT}}` | 03-02 |
| `src/intelligence/directive-detector-prompts/scope-rubric-system-prompt.md` | static prompt, `{{FEW_SHOT}}` | 03-02 |
| `src/benchmarks/directive-detector/fixture-sessions.ts` | session ordinal → sid mapping | 03-03 |
| `src/benchmarks/directive-detector/build-candidates.ts` | regex + code-strip → `fixture-candidates.jsonl` | 03-03 |
| `src/benchmarks/directive-detector/run-precision.ts` | dry-run harness → precision JSON | 03-05 |
| `src/benchmarks/directive-detector/compare-runs.ts` | run-vs-run diff helper | 03-05 |
| `src/tests/intelligence/directive-detector.test.ts` | unit tests (regex, confirm, dedup) | 03-01 |
| `src/tests/intelligence/directive-detector-integration.test.ts` | heartbeat hook test | 03-04 |
| `src/tests/intelligence/directive-schema.test.ts` | `data` JSON shape contract (P8 handoff) | 03-01 |

### 2.2 Files modified

| Path | Change | Plan |
|---|---|---|
| `src/angel/heartbeat.ts` | Call `extractDirectivesFromSession()` inside the Phase-2 loop, before pattern extraction | 03-04 |
| `src/angel/index.ts` | (if heartbeat imports a new module) add to module graph only | 03-04 |
| `.planning/phases/03-p2-directive-detector/03-CONTEXT.md` | no change — reference | — |

**No changes to:** `src/assembler/*`, `src/hooks/*`, any injection path, any `sections.ts` formatter, any existing `artifact.kind` semantics. The `directive_rule` kind is new — `kind_registry` auto-registers on first INSERT via the AFTER-INSERT trigger (see `v17-ddl.ts:92`), so no explicit registry modification is needed.

### 2.3 Dependency graph

```
03-01 detector core + config                     [Wave 1]
03-02 prompt fixture files                       [Wave 1]   (no code dependency on 03-01 — just content)
03-03 fixture corpus + labeling harness          [Wave 1]   (independent of 03-01; reads DB)
            │
            ▼
03-04 angel heartbeat hook                       [Wave 2]   (depends on 03-01)
03-05 precision harness + iteration runbook      [Wave 2]   (depends on 03-01, 03-02, 03-03)
            │
            ▼
03-06 calibration + ship                         [Wave 3]   (depends on 03-01..03-05; runs precision + tunes + re-runs)
```

03-02 can technically ship before 03-01 — they touch disjoint files — but the detector code won't actually call into the prompts until 03-01 is in. We bundle them in Wave 1 so both are ready when 03-05 runs the first measurement.

03-03 runs in parallel: it reads DB + writes JSONL files; it does not depend on the detector code, only on the same regex families. Slight risk: the regex families used in 03-03's candidate builder must exactly match those in 03-01's detector. We solve this by factoring the regex list into `src/intelligence/directive-detector-regex.ts` in 03-01 and having 03-03 import that constant. Guarantees the fixture is testing the same filter.

---

## 3. Runtime mechanics — detail

### 3.1 Data path inside the detector

```
extractDirectivesFromSession(db, sessionId, projectId)
    │
    ├─ fetch all user turns  (conversation_turns WHERE session_id=? AND user_text IS NOT NULL ORDER BY turn_number)
    │
    ├─ per turn:
    │   ├─ strip fenced + inline code
    │   ├─ DIRECTIVE_REGEXES.some(re => re.test(stripped_text))?
    │   │     ├─ no  → continue
    │   │     └─ yes → push candidate {turn_idx, raw_text, matched_families[]}
    │   └─ (keep original case; case-insensitive match)
    │
    ├─ per candidate:
    │   ├─ fetch context window (turns where turn_number BETWEEN turn_idx-2 AND turn_idx+2)
    │   │
    │   ├─ confirm() via callLocalLLM with confirmation-system-prompt + few-shot
    │   │     response JSON: { is_directive, confidence, polarity, scope,
    │   │                      suggested_title, normalized_text, reasoning }
    │   │
    │   ├─ reject if !is_directive OR confidence < thresholdGeneral
    │   │   (reject if scope==='universal' AND confidence < thresholdUniversal)
    │   │
    │   ├─ embed(`${suggested_title} ${normalized_text}`) via embedText()
    │   │
    │   ├─ vec0 top-3 same-scope lookup:
    │   │     SELECT a.id, a.body, ae.distance
    │   │     FROM artifact a
    │   │     JOIN artifact_embeddings ae ON ae.rowid = a.embedding_ref
    │   │     WHERE a.kind='directive_rule' AND a.scope=? AND a.project_id=?
    │   │       AND ae.embedding MATCH ? AND k=3
    │   │     ORDER BY ae.distance
    │   │
    │   ├─ max_cosine = 1 - top1.distance  (vec0 returns L2 or cosine distance depending on config;
    │   │                                   arctic-embed2 is cosine → distance = 1-cos; verify in Plan 03-01
    │   │                                   by reading sqlite-vec-backend.ts for conversion math)
    │   │
    │   ├─ if max_cosine ≥ 0.80:
    │   │     relation = callLocalLLM(dedup-prompt, candidate + top3)
    │   │                → 'restatement' | 'opposite_polarity' | 'related_but_distinct' | 'unrelated'
    │   │     switch(relation) { … }
    │   └─ else:
    │         INSERT fresh artifact row (see 3.2)
    │
    └─ return { candidates, confirmed, inserted, updated, skipped }
```

### 3.2 Write mapping (from CONTEXT §Area 2 + §1.8 above)

**INSERT path** (fresh, related_but_distinct, opposite_polarity all INSERT):
```ts
const id = randomUUID();
const now = Date.now();
db.prepare(`
  INSERT INTO artifact(
    id, kind, title, body, scope, status, confidence,
    created_at_epoch, updated_at_epoch, session_id, project_id, data
  ) VALUES (?, 'directive_rule', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
`).run(
  id, suggested_title, normalized_text, scope, confidence,
  now, now, source_session_id, project_id,
  JSON.stringify({
    polarity, reasoning,
    source_session_id, source_turn_idx, regex_family: matched_families[0],
    reinforcement_count: 1,
    reinforcements: [{session_id: source_session_id, turn_idx: source_turn_idx, seen_at_epoch: now, regex_family: matched_families[0]}],
    ...(relation === 'opposite_polarity' ? { possible_contradicts: top1.id, contradict_reason } : {}),
    ...(relation === 'related_but_distinct' ? { related_to: top1.id, related_cosine: max_cosine, related_relation: relation } : {}),
  })
);
// Embedding write
const embBuf = floatsToBuffer(embedding);
const rowid = db.prepare('INSERT INTO artifact_embeddings(embedding) VALUES (?) RETURNING rowid').get(embBuf).rowid;
db.prepare('UPDATE artifact SET embedding_ref=? WHERE id=?').run(rowid, id);
```

**UPDATE path** (restatement):
```ts
db.prepare(`
  UPDATE artifact
     SET updated_at_epoch = ?,
         data = json_set(
                  json_set(data, '$.reinforcement_count',
                                  COALESCE(json_extract(data, '$.reinforcement_count'), 1) + 1),
                  '$.reinforcements',
                  json(
                    json_insert(
                      COALESCE(json_extract(data, '$.reinforcements'), json('[]')),
                      '$[#]',
                      json(?)
                    )
                  )
                )
   WHERE id = ?
`).run(now, JSON.stringify({session_id, turn_idx, seen_at_epoch: now, regex_family}), top1.id);
```

**Slide window cap at 50 entries** (per §1.8): after `json_insert`, if array length > 50, post-process with `json_set` to keep the last 50. Implemented as a small helper `trimReinforcements(db, artifactId, cap=50)` called only when length exceeds cap (checked cheaply with `json_array_length(...)` in a trigger-free helper). Guards against unbounded JSON.

### 3.3 vec0 cosine plumbing — verification note

sqlite-vec's `MATCH` with `k=N` returns `distance`. Whether that's L2 or cosine depends on how the column was declared. `v17-ddl.ts:155` declares `embedding float[1024]` with no distance hint — vec0 **defaults to L2**. Our artic-embed2 vectors are unit-normalized (the embed-pipeline returns raw model output; arctic-embed2 outputs are L2-normalized natively), so **L2_distance² = 2 − 2·cosine** → `cosine = 1 − distance²/2`. Plan 03-01 MUST:
- verify unit-normalization in a unit test (`cosineNorm(embedding) ≈ 1.0`)
- implement the `l2_to_cosine(d) = 1 - d*d/2` conversion
- OR redeclare the vec0 column with `distance_metric=cosine` if sqlite-vec's build supports the hint (check `sqlite-vec-loader.ts`). If it does, use the hint — simpler and correct by construction.

A mis-converted distance at this step will silently flip the 0.80 dedup gate and cascade into schema-correctness bugs downstream. Must be unit-tested before 03-04 wires the detector into the heartbeat.

### 3.4 Transcript pre-filter — code-strip specification

- **Fenced blocks** (``` ``` ``` ```): strip greedy multi-line with `/\u0060\u0060\u0060[\s\S]*?\u0060\u0060\u0060/g`.
- **Inline single-backtick**: strip with `/\u0060[^\u0060\n]*\u0060/g`.
- Preserve line breaks outside the strip ranges (for LLM readability in context window).
- Do NOT strip quoted speech (`"user says 'always X'"`) — per CONTEXT §Area 1, let the LLM handle quotation context.

Strip happens ONCE per turn at candidate-collection time; the ±2 surrounding turns fed to the LLM are **un-stripped** originals (LLM needs code context to disambiguate imperatives referencing code changes).

---

## 4. Open questions surfaced (for plan-checker to gate)

1. **Universal threshold gate interaction with confirm rejection.** CONTEXT says "Universal threshold ≥ 0.85, general ≥ 0.70." If the LLM returns `scope='universal', confidence=0.75`, do we (a) reject outright, or (b) attempt to downgrade to `project`? Decision here must be explicit. **Proposal:** reject outright. Downgrading bypasses the stricter gate the user chose. Record as Plan 03-01 decision.

2. **Project_id for `scope='universal'`.** An artifact with `scope='universal'` still has a `project_id` column value. What should it be — the source session's project, or `NULL`? CONTEXT §Area 3 says "project identity always session's project_id, LLM doesn't pick a project." So we write `project_id = source_session.project`, even for universal scope. Retrieval filters by `scope='universal'` OR matching `project_id` — project_id is informational for universal rows. Record as Plan 03-01 decision.

3. **Dedup scope boundary.** The dedup query filters `scope=?`. Should we dedup across all scopes (a universal "never do X" and a project "never do X" are near-duplicates)? **Proposal:** no — scope is a semantic facet, not a duplicate dimension. A universal rule and a project rule with the same body are semantically distinct (different blast radius). Keep `scope=?` filter.

4. **session-scope dedup project boundary.** `scope='session'` artifacts are tied to a specific session. Should dedup look only within the same session, or across all same-project sessions? **Proposal:** same-project, all sessions. Rationale: `scope='session'` means "narrow retrieval context," not "only visible in this session." CONTEXT §Area 3 defines it as "permanent-but-contextually-narrow."

These are small design questions. They do NOT block Wave-1 execution; they must be resolved inside Plan 03-01 before the dedup code ships.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|:---:|:---:|---|
| vec0 distance metric mismatch (L2 vs cosine) | med | high (breaks dedup silently) | §3.3 — unit-test normalization + conversion before 03-04 |
| glm-5.1:cloud rate limit / flake during P2 run | med | med | retry-on-next-heartbeat path already exists in pattern-extractor.ts; reuse |
| Joint precision stuck < 88% after 3 cycles | low-med | med | escalation runbook §1.6 — no silent gate lowering |
| Fixture corpus too small (14 sessions vs planned 15) | low | low | +1 session deficit; still ~105 hits; within CI band |
| session-38 duplicate log file confuses fixture build | low | low | dedupe by session_id at §1.2 mapping step |
| LLM output schema drift — JSON parse fails | med | low | wrap `JSON.parse` in try/catch; treat as reject; log for review |
| User adds new directive phrasings after P2 ships | high | low | §1.6 iteration runbook covers iterative regex extension; not a P2-scope gate |
| `scope='universal'` row created by accident (bug) leaks cross-project | low | high | universal threshold = 0.85 + tests asserting universal-scope writes emit a log line + manual review in P8 |

---

## 6. Execution-time heuristics

- **Expected LLM calls per session** (rough):
  - regex → ~7 candidates per session (empirical 105/14 = 7.5)
  - confirmation call per candidate → 7
  - dedup LLM call only when cosine ≥ 0.80 → estimate 2-3 per session
  - total: ~10 glm-5.1:cloud calls per session, at ~2-8s each = ~40-80s per session
  - batch size 5 when autonomous → one heartbeat tick spends ~3-6 min on directive extraction alone. Fine — Angel is autonomous, and ticks don't block users.

- **Token budget per call**:
  - confirmation call: ~200-tok prompt + ~500-tok few-shot + ~300-tok context = ~1000 input, ~150 output
  - 10 calls/session × 1150 tok ≈ 11.5K tok per session. Over 500 sessions (the whole backlog) = ~5.7M tok. Ollama-Cloud glm-5.1 cost profile is acceptable (no MAX-subscription coupling).

---

## 7. Summary of locked facts for planner

- Integration point: `src/angel/heartbeat.ts:219-261`, before `extractPatternsFromSession()`, inside the same `for (const session of unprocessed)` loop.
- Fixture: 14 sessions, 526 user turns, 105 regex hits (20%). session-51 excluded (0 DB turns). session-38 has duplicate log files — dedup by session_id.
- Regex families: CONTEXT §Area 1 (remember, always, never, from now on, next time, in the future, please {do|don't|stop|always|never}, stop {doing|using}, don't, do X instead, use X instead). Factor into `directive-detector-regex.ts` so detector and candidate-builder share.
- LLM: `glm-5.1:cloud` via `callLocalLLM()`. Labeler MUST be Sonnet (different family) — main-Claude via CLIProxy during execution.
- Thresholds: 0.70 general, 0.85 universal, 0.80 dedup cosine. All in `directive-detector-config.ts`.
- Prompt assets: 4 files under `src/intelligence/directive-detector-prompts/`. JSON few-shot + MD system prompt with `{{FEW_SHOT}}` template.
- vec0: verify distance metric conversion in 03-01 before 03-04 wires heartbeat.
- Schema contract with P8: `data` keys documented in §1.8; `directive-schema.test.ts` snapshots the shape.
- Gate: joint precision ≥ 90% (CONTEXT §gate_criteria); per-field diagnostics recorded in completion commit.
- No injection-path changes. No changes to `src/assembler/*` or `sections.ts`.

*End of RESEARCH.*
