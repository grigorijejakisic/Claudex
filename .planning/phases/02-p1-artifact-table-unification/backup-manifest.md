# P1 Backup Manifest

Audit trail for `~/.claudex/backups/pre-v4-P1-*.db` files. `.db` binaries are
gitignored; this file is git-tracked. Rows are appended by `createAndVerifyBackup`
at backup-create time (see `src/core/migration/v17-backup.ts`).

| timestamp | path | size_bytes | sha256 | integrity | quick | parity | vec0 | total_ms | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 2026-04-20T10:34:01.437Z | C:\Users\Grigorije\.claudex\backups\pre-v4-P1-1776681238192.db | 331927552 | 6df20284784e9615... | ok | ok | FAIL | - | 3242 | FAIL |
| 2026-04-20T10:37:40.747Z | C:\Users\Grigorije\.claudex\backups\pre-v4-P1-1776681458021.db | 331939840 | 3680d8dcd68dc396... | ok | ok | ok | ok | 2724 | PASS |
