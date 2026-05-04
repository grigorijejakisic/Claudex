---
plan_id: 02-03
phase: 2
wave: 1
depends_on: []
files_modified:
  - src/core/migration/v17-stale-scan.ts
  - src/core/migration/stale-review-parser.ts
  - src/tests/core/migration/v17-stale.test.ts
  - .planning/phases/02-p1-artifact-table-unification/stale-review.md
autonomous: true
requirements:
  - STOR-05
---

# Plan 02-03: Stale-review flow (heuristic scan + file I/O + parser)

## Objective

Implement the two-phase stale-flag review: `migrate:v17:dry-run` scans `project_curated_context` rows matching the 3 stale keywords, writes the heuristic-matches section to `stale-review.md`; `migrate:v17:apply` parses the file and flags the accepted rows during the Phase B atomic tx.

Per CONTEXT Decision 8 §specifics: this P1 run is pre-approved — orchestrator commits `stale-review.md` with all heuristic defaults accepted.

## Must-haves (goal-backward)

- `scanStaleRows(db)` returns the ids of `project_curated_context` rows matching any of: `'Gemma 4 31B'`, `'llama-server:8081'`, `'local llama-server'`.
- `writeStaleReview(path, matches)` writes the git-trackable markdown file.
- `parseStaleReview(path)` reads the file; returns the set of legacy ids to flag stale. Truncated/malformed file → throws with clear error (migration aborts).
- Scan uses `LIKE` (SQLite default case-insensitive for ASCII only — confirm via test that `'gemma 4 31b'` still matches).

## Tasks

<task id="02-01-01">
  <subject>Implement src/core/migration/v17-stale-scan.ts</subject>
  <description>
Export:

```ts
export interface StaleMatch {
  legacyId: number;
  contentPreview: string;   // first 120 chars of row.content, single-line (newlines → spaces)
  triggers: string[];       // which keyword(s) matched
}

export const STALE_KEYWORDS = ['Gemma 4 31B', 'llama-server:8081', 'local llama-server'] as const;

export function scanStaleRows(db: Database): StaleMatch[];
```

Implementation: single SQL query using `LIKE` with `OR` clauses (case-sensitive since SQLite LIKE is case-insensitive for ASCII, but keywords are ASCII). For each row, compute `triggers[]` by re-checking which keyword substrings are present.

Order by `id ASC` for deterministic output.
  </description>
</task>

<task id="02-01-02">
  <subject>Implement stale-review.md writer and parser in src/core/migration/stale-review-parser.ts</subject>
  <description>
Export:

```ts
export interface StaleReviewFile {
  heuristicMatches: { legacyId: number; decision: 'stale' | 'keep'; contentPreview: string; triggers: string[] }[];
  manualAdditions: { legacyId: number; decision: 'stale'; contentPreview: string }[];
}

export function writeStaleReview(path: string, matches: StaleMatch[]): void;
export function parseStaleReview(path: string): StaleReviewFile;
export function getStaleIds(parsed: StaleReviewFile): Set<number>;
```

File format (exact, for parser):
```
# P1 stale review

## Heuristic matches (decision: stale unless flipped to keep)

- id=42 | status=stale | triggers=[Gemma 4 31B] | content="first 120 chars..."
- id=47 | status=stale | triggers=[llama-server:8081] | content="..."

## Manual additions (decision: stale)

<!-- add additional stale rows below -->
- id=99 | status=stale | content="..."

```

Parser regex: `^- id=(\d+) \| status=(stale|keep)( \| triggers=\[([^\]]+)\])? \| content="(.*)"$` — fails cleanly if not matched.

**Malformed file handling:** `parseStaleReview` throws `new Error('stale-review.md malformed at line N: ...')` on first parse failure. `migrate:apply` catches and exits with non-zero.

**Missing file:** throws `new Error('stale-review.md missing — run migrate:v17:dry-run first and commit the result')`.

**Empty heuristic section with dry-run output pending:** acceptable if no matches in source DB.
  </description>
</task>

<task id="02-01-03">
  <subject>Wire into CLI (dry-run side)</subject>
  <description>
In `src/cli/migrate.ts`, add `migrate:v17:dry-run` subcommand (will be extended in Plan 02-05; this plan stubs only the stale-scan portion):

1. Open DB read-only.
2. Call `scanStaleRows(db)`.
3. Call `writeStaleReview(STALE_REVIEW_PATH, matches)`.
4. Print `Wrote {N} heuristic matches to {path}. Review, commit, then run migrate:v17:apply.`

`STALE_REVIEW_PATH` = `.planning/phases/02-p1-artifact-table-unification/stale-review.md` (absolute from cwd).
  </description>
</task>

<task id="02-01-04">
  <subject>Tests at src/tests/core/migration/v17-stale.test.ts</subject>
  <description>
- Seed temp DB with `project_curated_context` rows: 2 matching `Gemma 4 31B`, 1 matching `llama-server:8081`, 1 matching `local llama-server`, 3 non-matching. Assert `scanStaleRows()` returns 4 ids in ascending order, with correct `triggers`.
- `writeStaleReview` + `parseStaleReview` round-trip: write N matches, parse, assert set equality of ids.
- Parse malformed file: insert garbage line between valid lines → assert throws with line number.
- Parse file with manual addition flipped to `keep` — verify `getStaleIds` excludes flipped rows.
- Missing file → assert throws with "missing" message.
</description>
</task>

<task id="02-01-05">
  <subject>Pre-commit the stale-review.md file for this P1 run</subject>
  <description>
Per CONTEXT Decision 8 §specifics: this P1 run is pre-approved. After the first `migrate:v17:dry-run` produces the file on the live DB, orchestrator commits `stale-review.md` unchanged (all heuristic defaults `stale`, manual additions empty) so `migrate:v17:apply` has a valid input in the repo.

Plan author (executor) does NOT commit a hand-crafted stale-review.md here — that is Plan 02-05's responsibility during the first dry-run on the real DB.
  </description>
</task>

## Verification

- `bun run test -- v17-stale` → all cases green.
- `bun run build` → no TS errors.
- Manual: `bun run cli -- migrate:v17:dry-run` on a dev DB populated with stale keyword rows produces `stale-review.md` with matches.

## Quality gate

- [ ] Keyword list is exactly `['Gemma 4 31B', 'llama-server:8081', 'local llama-server']` — no additions, no removals.
- [ ] Parser fails loud on malformed input (no silent skip).
- [ ] Writer is deterministic (sorted by legacy id, same input → byte-identical output).
- [ ] File lives under `.planning/`, is git-tracked, 1 file per phase.
