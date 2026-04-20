# P1 Backup Manifest

Audit trail for `~/.claudex/backups/pre-v4-P1-*.db` files. `.db` binaries are
gitignored; this file is git-tracked. Rows are appended by `createAndVerifyBackup`
at backup-create time (see `src/core/migration/v17-backup.ts`).

| timestamp | path | size_bytes | sha256 | integrity | quick | parity | vec0 | total_ms | verdict |
|---|---|---|---|---|---|---|---|---|---|
