---
plan_id: 02-02
phase: 2
wave: 1
depends_on: []
files_modified:
  - src/core/migration/v17-backup.ts
  - src/cli/migrate.ts
  - src/tests/core/migration/v17-backup.test.ts
  - .planning/phases/02-p1-artifact-table-unification/backup-manifest.md
autonomous: true
requirements:
  - STOR-08
---

# Plan 02-02: Backup verifier (6-check gate + manifest)

## Objective

Implement the backup creation + 6-check verification gate from CONTEXT Decision 10. If any of the 6 checks fail, P1 migration aborts before touching real tables.

## Must-haves (goal-backward)

- `createAndVerifyBackup(sourcePath, backupPath, opts)` returns a typed result.
- Backup is created via native `Database.backup()` API (NOT `.dump`, NOT `cp`).
- Backup is reopenable with sqlite-vec extension loaded (fail-fast).
- 6 checks run in order; first fail short-circuits.
- Manifest row appended to `backup-manifest.md`.
- Rotation keeps only 5 newest per phase per kind (real | dry-run).

## Tasks

<task id="02-01-01">
  <subject>Create src/core/migration/v17-backup.ts</subject>
  <description>
Export:

```ts
export interface VerifyCheck {
  name: 'create' | 'reopen_with_vec' | 'integrity_check' | 'quick_check' | 'parity' | 'vec0_smoke';
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface VerifyResult {
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  checks: VerifyCheck[];
  verdict: 'PASS' | 'FAIL';
  totalMs: number;
}

export async function createAndVerifyBackup(
  sourcePath: string,
  backupPath: string,
  opts: {
    loadVecExt: string;             // absolute path to sqlite-vec extension binary
    legacyTables: string[];         // for parity check (expected: 6 legacy + 'artifacts' + 'artifact_links')
    anyVec0Table?: string;          // default 'vec_artifacts'
  }
): Promise<VerifyResult>;
```

Implementation steps:
1. **create**: Open source as `Database(sourcePath, { readonly: true })`. Call `db.backup(backupPath)`. Capture duration. Close source handle.
2. **reopen_with_vec**: Open backup as fresh `Database(backupPath)`. Try `sqliteVec.load(db)` — if throws, record error, mark FAIL, short-circuit.
3. **integrity_check**: `db.pragma('integrity_check', { simple: true })` — must equal `'ok'`.
4. **quick_check**: `db.pragma('quick_check', { simple: true })` — must equal `'ok'`.
5. **parity**: For each `tbl` in `opts.legacyTables`, query `COUNT(*)` in backup, query `COUNT(*)` in source (reopen source read-only). Must match. Aggregate mismatches → fail with list.
6. **vec0_smoke**: `db.prepare(`SELECT COUNT(*) FROM ${opts.anyVec0Table ?? 'vec_artifacts'}`).get()` — must not throw.

Return `VerifyResult` with:
- `sha256`: computed via `crypto.createHash('sha256')` streaming from backup file.
- `sizeBytes`: `fs.statSync(backupPath).size`.
- `verdict`: `'PASS'` if all 6 `passed`, else `'FAIL'`.

Close backup handle before returning.
  </description>
</task>

<task id="02-01-02">
  <subject>Implement manifest writer and rotation</subject>
  <description>
In same file (or a sibling `v17-backup-manifest.ts`):

```ts
export function appendManifestRow(manifestPath: string, result: VerifyResult, phaseLabel: string, kind: 'real' | 'dry-run'): void;
export function rotateBackups(backupDir: string, phaseLabel: string, kind: 'real' | 'dry-run', keep: number): string[]; // returns deleted paths
```

`appendManifestRow` appends markdown table row matching the format in 02-RESEARCH.md §2.3.

`rotateBackups`: glob files matching `pre-v4-P1{-dry}-*.db` in `backupDir`, sort by mtime desc, `fs.unlinkSync` all beyond `keep` (default 5). Return deleted paths.

Initial manifest file must exist with a header row; Plan #07 creates it empty with just the table header if missing.
  </description>
</task>

<task id="02-01-03">
  <subject>Add CLI entry points in src/cli/migrate.ts</subject>
  <description>
Add subcommands (using existing CLI parser pattern in the file):

- `migrate:backup` — creates backup at `~/.claudex/backups/pre-v4-P1-{ts}.db`, runs verifier, appends manifest, rotates. Exit code 0 PASS / 1 FAIL.
- `migrate:backup:dry-run` — same but path is `pre-v4-P1-dry-{ts}.db`.

Both load sqlite-vec extension path from existing env discovery used by `migrateV14toV15()`.
  </description>
</task>

<task id="02-01-04">
  <subject>Create src/tests/core/migration/v17-backup.test.ts</subject>
  <description>
Vitest cases:

- **Happy path**: seed a temp DB with legacy tables + `vec_artifacts` populated. Run `createAndVerifyBackup`. Assert all 6 checks pass. Assert backup file exists. Assert `sha256` is 64 hex chars.
- **Integrity failure**: corrupt the backup file between step 1 and step 3 (write garbage bytes into middle of file). Assert `integrity_check` fails, `verdict === 'FAIL'`, short-circuit (no later checks run).
- **Row count mismatch**: after backup, insert a row into source. Rerun parity check → assert mismatch reported.
- **Manifest append**: run 2 backups. Read manifest file, assert 2 new rows.
- **Rotation**: create 7 backup files (via touch), call `rotateBackups` with keep=5, assert 2 oldest deleted.

All tests use temp dirs (`os.tmpdir()`); clean up after.
  </description>
</task>

## Verification

- `bun run test -- v17-backup` → all cases green.
- `bun run build` → no TS errors.
- Manual: `bun run cli -- migrate:backup:dry-run` on the live dev DB produces a file + manifest row. Do NOT commit the `.db` file (gitignored).

## Quality gate

- [ ] Uses `Database.backup()` native API, not shell `sqlite3 .backup` / `cp`.
- [ ] sqlite-vec extension load failure is detected and reported (check #2).
- [ ] Manifest rotation logic runs at backup-create time, never at verify-fail time (per CONTEXT §Decision 10).
- [ ] Temp DBs fully closed before SHA-256 computation (no file lock on Windows).
