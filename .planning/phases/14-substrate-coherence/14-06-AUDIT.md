# Plan 14-06: Epoch-MS Canonicalization — Task 1 Audit

**Worker D | 2026-05-15 | Pre-migration column inventory**

This document enumerates every `*_epoch` column (without `_ms` suffix) on every project table,
cross-referenced against the plan's must_haves enumeration. Used to confirm migration scope
before editing migration-steps.ts.

---

## Tables in must_haves scope — confirmed present

| Table | Column(s) | Source |
|---|---|---|
| sessions | `created_at_epoch`, `ended_at_epoch` | schema.ts SCHEMA_V3 |
| observations | `timestamp_epoch`, `last_accessed_at_epoch`, `deleted_at_epoch` | schema.ts SCHEMA_V3 |
| learnings | `first_seen_epoch`, `last_promoted_epoch`, `updated_at_epoch` | schema.ts SCHEMA_V3 |
| checkpoint_meta | `created_at_epoch`, `updated_at_epoch` | schema.ts SCHEMA_V3 |
| episodic_events | `ts_epoch` | migration-steps.ts migrateV24toV25 |
| telemetry | `timestamp_epoch` | schema.ts TELEMETRY_SCHEMA |
| pressure_scores | `last_touched_epoch` | schema.ts SCHEMA_V3 |
| schema_versions | `applied_at_epoch` | schema.ts SCHEMA_V3 |

## Tables in must_haves "enumerate during Task 1" — confirmed

| Table | Column(s) | Verdict |
|---|---|---|
| session_messages | `created_at_epoch`, `delivered_at_epoch` | **IN SCOPE** — rename both |
| session_signals | `created_at_epoch`, `expires_at_epoch`, `cleared_at_epoch` | **IN SCOPE** — rename all three |
| retrieval_events | `timestamp_epoch` | **IN SCOPE** — rename |

## Tables already using `*_epoch_ms` — excluded per must_haves

| Table | Column(s) | Note |
|---|---|---|
| session_highlights | `created_at_epoch_ms`, `re_extracted_at_epoch_ms` | EXCLUDED — already ms |
| transcript_chunk_v6 | `created_at_epoch_ms` | EXCLUDED — already ms |
| artifact_task_pattern | `classified_at_epoch_ms` | EXCLUDED — already ms |
| lesson_pointer | `first_seen_epoch_ms` | EXCLUDED — already ms |
| pointer_recall_log | `retrieved_at_epoch_ms` | EXCLUDED — already ms |
| retrieval_log | `invoked_at_epoch_ms` | EXCLUDED — already ms |
| session_flag | `set_at_epoch_ms` | EXCLUDED — already ms |

## Tables with `*_epoch` columns NOT in plan scope (out of scope per anti_scope)

These tables have `*_epoch` columns but are NOT in the migration scope because they
either are not "project tables" (per plan definition) or are already excluded:

| Table | Column(s) | Reason excluded |
|---|---|---|
| artifact (V17) | `created_at_epoch`, `updated_at_epoch` | **IN SCOPE** — listed in must_haves as "artifact (V17)" |
| decisions | `timestamp_epoch`, `updated_at_epoch` | NOT in must_haves; legacy table, not in plan's enumeration |
| thread_state | `updated_at_epoch` | NOT in must_haves |
| checkpoint_tracking | `last_checkpoint_epoch`, `updated_at_epoch` | NOT in must_haves |
| session_journal | `timestamp_epoch` | NOT in must_haves |
| artifacts (legacy) | `timestamp_epoch`, `last_materialized_epoch` | NOT in must_haves (different from V17 `artifact`) |
| session_events | `timestamp_epoch` | NOT in must_haves |
| verified_facts | `created_at_epoch` | NOT in must_haves |
| experience_patterns | `created_at_epoch`, `last_triggered_epoch` | NOT in must_haves |
| artifact_links | `created_at_epoch`, `valid_at_epoch`, `invalid_at_epoch` | NOT in must_haves |
| capability_boundaries | `last_updated_epoch` | NOT in must_haves |
| conversation_turns | `timestamp_epoch` | NOT in must_haves |
| angel_opinions | `created_at_epoch`, `updated_at_epoch` | NOT in must_haves |
| entity_aliases | `created_at_epoch` | NOT in must_haves |
| solution_outcomes | `created_at_epoch` | NOT in must_haves |
| artifact_access_log | `timestamp_epoch` | NOT in must_haves |
| knowledge_gaps | `detected_at_epoch`, `resolved_at_epoch` | NOT in must_haves |
| temporal_profile | `updated_at_epoch` | NOT in must_haves |
| action_transitions | `last_epoch` | NOT in must_haves |
| shape_vocabulary | `promoted_at_epoch` | NOT in must_haves |
| shape_candidates | `proposed_at_epoch` | NOT in must_haves |
| critical_rules_multi_project | `updated_at_epoch` | NOT in must_haves |
| TEAM_COORDINATION: file_leases | `granted_at_epoch` | NOT in must_haves |
| TEAM_COORDINATION: artifact_claims | `claimed_at_epoch` | NOT in must_haves |
| episode_boundary_cursor | `last_processed_event_ts_epoch` | NOT in must_haves; unit-agnostic name like `last_heartbeat_ts` |

## Special cases: left as-is per anti_scope

| Table | Column(s) | Reason |
|---|---|---|
| sessions | `last_heartbeat_ts`, `last_jsonl_write_ts` | Per plan anti_scope: already unit-agnostic names; document as ms-precision |
| episode_boundary_cursor | `last_processed_event_ts_epoch` | Similar to `last_heartbeat_ts` — unit-agnostic context |

## V17 artifact table (must_haves item "artifact (V17)")

The V17 `artifact` kernel table (in migration/v17-ddl.ts) has:
- `created_at_epoch` → rename to `created_at_epoch_ms`
- `updated_at_epoch` → rename to `updated_at_epoch_ms`

Values are currently stored as `unixepoch() * 1000` (already ms!) per the V17 DDL.
Therefore: rename only (no `* 1000` scaling needed for this table; the WHERE guard
`value < 1e12` will protect against double-scaling anyway).

## Final migration column list

```
sessions:          created_at_epoch → created_at_epoch_ms   (scale ×1000)
                   ended_at_epoch   → ended_at_epoch_ms     (scale ×1000)

observations:      timestamp_epoch        → timestamp_epoch_ms        (scale ×1000)
                   last_accessed_at_epoch → last_accessed_at_epoch_ms (scale ×1000)
                   deleted_at_epoch       → deleted_at_epoch_ms       (scale ×1000)

learnings:         first_seen_epoch    → first_seen_epoch_ms    (scale ×1000)
                   last_promoted_epoch → last_promoted_epoch_ms (scale ×1000)
                   updated_at_epoch    → updated_at_epoch_ms    (scale ×1000)

checkpoint_meta:   created_at_epoch → created_at_epoch_ms (scale ×1000)
                   updated_at_epoch → updated_at_epoch_ms (scale ×1000)

artifact (V17):    created_at_epoch → created_at_epoch_ms (NO scale — already ms in DDL)
                   updated_at_epoch → updated_at_epoch_ms (NO scale — already ms in DDL)

episodic_events:   ts_epoch → ts_epoch_ms (scale ×1000)

telemetry:         timestamp_epoch → timestamp_epoch_ms (scale ×1000)

pressure_scores:   last_touched_epoch → last_touched_epoch_ms (scale ×1000)

schema_versions:   applied_at_epoch → applied_at_epoch_ms (scale ×1000)

session_messages:  created_at_epoch   → created_at_epoch_ms   (scale ×1000)
                   delivered_at_epoch → delivered_at_epoch_ms (scale ×1000)

session_signals:   created_at_epoch → created_at_epoch_ms (scale ×1000)
                   expires_at_epoch  → expires_at_epoch_ms  (scale ×1000)
                   cleared_at_epoch  → cleared_at_epoch_ms  (scale ×1000)

retrieval_events:  timestamp_epoch → timestamp_epoch_ms (scale ×1000)
```

## PM Acknowledgment

This audit was produced as the Task 1 deliverable. Worker D has enumerated all
`*_epoch` columns against the must_haves enumeration. Deltas from must_haves:

- `session_messages`: must_haves says "enumerate during Task 1" — confirmed: `created_at_epoch`, `delivered_at_epoch` → IN SCOPE
- `session_signals`: must_haves says "enumerate during Task 1" — confirmed: `created_at_epoch`, `expires_at_epoch`, `cleared_at_epoch` → IN SCOPE
- `retrieval_events`: must_haves says "enumerate during Task 1" — confirmed: `timestamp_epoch` → IN SCOPE
- V17 `artifact` table values: stored as ms already (DDL uses `unixepoch() * 1000`); rename-only, no scale step needed for existing rows (WHERE guard will still apply safely)

Worker D proceeds to Task 2 with this confirmed column list.
