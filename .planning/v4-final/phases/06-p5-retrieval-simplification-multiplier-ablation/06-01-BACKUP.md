# Phase 06-01 Pre-Deletion DB Backup (STOR-08)

## Backup file

- **Path:** `C:\Users\Grigorije\.claudex\backups\pre-v4-P5-1777493188.db`
- **Unix timestamp:** `1777493188`
- **Captured at (UTC):** 2026-04-29T20:06:28Z
- **Source:** `~/.claudex/db/claudex.db`
- **File size:** 365,731,840 bytes (348.79 MiB)

## Verification readings (taken on the backup, not the live DB)

| PRAGMA / query             | Value |
| -------------------------- | ----- |
| `integrity_check`          | `ok`  |
| `user_version`             | 19    |
| `SELECT COUNT(*) artifacts`| 8916  |
| `SELECT COUNT(*) sessions` | 990   |

These four readings are the rollback witnesses. The V20 migration must end with:
- `user_version = 20`
- `artifact_count` and `session_count` unchanged from the values above
- `integrity_check = ok`

## Restorability

`PRAGMA integrity_check` returned a single `ok` row — the backup is internally consistent and fully restorable via `cp pre-v4-P5-1777493188.db ~/.claudex/db/claudex.db`.

## Other recent backups in `~/.claudex/backups/`

- `pre-v4-P1-1776681458021.db` (2026-04-20, 316.6 MiB)
- `pre-v4-P1-1776681503089.db` (2026-04-20, 316.6 MiB)
- `pre-v4-P4-1777478253.db` (2026-04-29 17:56, 345.9 MiB) — Phase 4 backup
- `pre-v4-P5-1777493188.db` (2026-04-29 22:06, 348.79 MiB) — **this backup**
