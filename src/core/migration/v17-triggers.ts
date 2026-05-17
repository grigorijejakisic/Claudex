/**
 * V17 view + INSTEAD OF trigger generator.
 *
 * Emits 6 legacy views + 18 INSTEAD OF triggers (6 views × INSERT/UPDATE/DELETE)
 * from the KIND_MAPPING source-of-truth in kind-mapping.ts.
 *
 * View projections preserve the v3 column order + types via aggressive CAST
 * on JSON-extracted values. Writes through the views route to `artifact` +
 * `legacy_id_map`; reads project `artifact` rows back into the v3 shape.
 *
 * Special cases:
 *   - experience_patterns.id is TEXT UUID → preserved verbatim (no legacy_id_map entry).
 *   - project_curated_context.supersedes_id → lazy-resolved via legacy_id_map on read;
 *     stored in data._pending_supersedes on write (Amendment 2).
 *   - learnings.updated_at_epoch + decisions.updated_at_epoch are seconds-since-epoch
 *     in v3 but milliseconds on the kernel. The view rounds down to seconds.
 *     The INSERT trigger multiplies by 1000 to restore ms resolution.
 */

import type { Database } from 'better-sqlite3';
import {
  KIND_MAPPING,
  type KindMapping,
  type LegacyTable,
  type LegacyColSpec,
} from './kind-mapping.js';

export interface GeneratedViewDDL {
  legacyTable: LegacyTable;
  kind: string;
  viewSql: string;
  insertTriggerSql: string;
  updateTriggerSql: string;
  deleteTriggerSql: string;
}

export function generateViewsAndTriggers(
  mapping: Record<LegacyTable, KindMapping> = KIND_MAPPING,
): GeneratedViewDDL[] {
  const out: GeneratedViewDDL[] = [];
  for (const table of Object.keys(mapping) as LegacyTable[]) {
    const m = mapping[table];
    out.push({
      legacyTable: table,
      kind: m.kind,
      viewSql: generateViewSql(m),
      insertTriggerSql: generateInsertTriggerSql(m),
      updateTriggerSql: generateUpdateTriggerSql(m),
      deleteTriggerSql: generateDeleteTriggerSql(m),
    });
  }
  return out;
}

export function applyGeneratedDDL(db: Database, generated: GeneratedViewDDL[]): void {
  for (const g of generated) {
    db.exec(g.viewSql);
    db.exec(g.insertTriggerSql);
    db.exec(g.updateTriggerSql);
    db.exec(g.deleteTriggerSql);
  }
}

// ─── View generation ──────────────────────────────────────────────────

function generateViewSql(m: KindMapping): string {
  const legacyTable = m.legacyTable;
  const kind = m.kind;

  const projections: string[] = [];
  for (const col of m.columns) {
    projections.push(viewProjectionForCol(legacyTable, col));
  }

  return `DROP VIEW IF EXISTS ${legacyTable};
CREATE VIEW ${legacyTable} AS
SELECT
  ${projections.join(',\n  ')}
FROM artifact
WHERE kind = '${kind}'
ORDER BY created_at_epoch_ms;`;
}

function viewProjectionForCol(legacyTable: LegacyTable, col: LegacyColSpec): string {
  const name = col.name;
  const type = col.type;

  // Legacy integer id resolved via legacy_id_map
  if (col.storage.kind === 'legacy_id_map') {
    return `CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = '${legacyTable}' AND m.new_uuid = artifact.id) AS INTEGER) AS ${name}`;
  }

  // Kernel column
  if (col.storage.kind === 'kernel') {
    const kernelCol = col.storage.col;
    // experience_patterns.created_at_epoch + decisions.timestamp_epoch_ms + learnings.updated_at_epoch
    // live in v3 as seconds (except decisions.timestamp_epoch_ms which is already ms);
    // kernel stores ms. Divide to restore v3 shape where we know the legacy column name matches
    // 'created_at_epoch' and kernel stored ms.
    // kind-mapping.col values are still 'created_at_epoch'/'updated_at_epoch' (legacy names);
    // map to the canonical _ms column names in the artifact kernel.
    if (kernelCol === 'created_at_epoch' || kernelCol === 'updated_at_epoch') {
      return `CAST(artifact.${kernelCol}_ms / 1000 AS INTEGER) AS ${name}`;
    }
    if (kernelCol === 'body' || kernelCol === 'title' || kernelCol === 'id') {
      return `artifact.${kernelCol} AS ${name}`;
    }
    return `CAST(artifact.${kernelCol} AS ${type}) AS ${name}`;
  }

  // Data-JSON sidecar column
  if (col.storage.kind === 'data') {
    return `CAST(json_extract(artifact.data, '${col.storage.path}') AS ${type}) AS ${name}`;
  }

  // Computed (per-kind special handling)
  if (col.storage.kind === 'computed') {
    return computedViewColumn(legacyTable, col);
  }

  return `NULL AS ${name}`;
}

function computedViewColumn(legacyTable: LegacyTable, col: LegacyColSpec): string {
  const name = col.name;
  // experience_patterns: lesson/anti_pattern are composed into body.
  // Recover them by splitting body on the sentinel "\n\nWhat went wrong: ".
  if (legacyTable === 'experience_patterns') {
    if (name === 'lesson') {
      return `CAST(CASE
        WHEN instr(artifact.body, char(10)||char(10)||'What went wrong: ') > 0
          THEN substr(artifact.body, 1, instr(artifact.body, char(10)||char(10)||'What went wrong: ') - 1)
        ELSE artifact.body
      END AS TEXT) AS lesson`;
    }
    if (name === 'anti_pattern') {
      return `CAST(CASE
        WHEN instr(artifact.body, char(10)||char(10)||'What went wrong: ') > 0
          THEN substr(artifact.body, instr(artifact.body, char(10)||char(10)||'What went wrong: ') + length(char(10)||char(10)||'What went wrong: '))
        ELSE NULL
      END AS TEXT) AS anti_pattern`;
    }
    if (name === 'embedding') {
      // Legacy BLOB embedding is retired — expose NULL.
      return `CAST(NULL AS BLOB) AS embedding`;
    }
  }

  // project_curated_context.supersedes_id — integer recovered via legacy_id_map
  // reverse lookup on kernel supersedes_id; fall back to data._pending_supersedes
  // (lazy case for post-migration INSERTs where the target hasn't migrated yet).
  if (legacyTable === 'project_curated_context' && name === 'supersedes_id') {
    return `CAST(COALESCE(
      (SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'project_curated_context' AND m.new_uuid = artifact.supersedes_id),
      json_extract(artifact.data, '$._pending_supersedes')
    ) AS INTEGER) AS supersedes_id`;
  }

  return `NULL AS ${name}`;
}

// ─── INSERT trigger generation ────────────────────────────────────────

function generateInsertTriggerSql(m: KindMapping): string {
  const legacyTable = m.legacyTable;
  const kind = m.kind;
  const triggerName = `${legacyTable}_instead_insert`;

  // Build kernel fill expressions + data JSON pairs from NEW columns.
  const kernelFills = buildKernelInsertMap(m);
  const dataPairs = buildDataInsertPairs(m);

  const isUuidId = m.legacyIdType === 'TEXT_UUID';

  // For UUID-id legacy tables (experience_patterns), preserve NEW.id if supplied.
  // For integer-id legacy tables, we need an AFTER-INSERT-like insert into
  // legacy_id_map to synthesize the legacy_id. SQLite INSTEAD OF triggers run
  // multiple statements inside BEGIN…END, so we can do both.
  const idExpr = isUuidId
    ? `COALESCE(NEW.${m.legacyIdCol}, lower(hex(randomblob(16))))`
    : `lower(hex(randomblob(16)))`;

  const mapInsertSql = isUuidId
    ? ''
    : `
  INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
  VALUES (
    '${legacyTable}',
    COALESCE(
      NEW.${m.legacyIdCol},
      (SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM legacy_id_map WHERE legacy_table = '${legacyTable}')
    ),
    (SELECT id FROM artifact WHERE rowid = last_insert_rowid())
  );`;

  return `DROP TRIGGER IF EXISTS ${triggerName};
CREATE TRIGGER ${triggerName} INSTEAD OF INSERT ON ${legacyTable}
BEGIN
  INSERT INTO artifact(
    id, kind, title, body, scope, status, confidence,
    created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
  ) VALUES (
    ${idExpr},
    '${kind}',
    ${kernelFills.title},
    ${kernelFills.body},
    'project',
    ${kernelFills.status},
    ${kernelFills.confidence},
    ${kernelFills.created_at_epoch},
    ${kernelFills.updated_at_epoch},
    ${kernelFills.session_id},
    ${kernelFills.project_id},
    ${dataPairs}
  );${mapInsertSql}
END;`;
}

interface KernelFills {
  title: string;
  body: string;
  status: string;
  confidence: string;
  created_at_epoch: string;
  updated_at_epoch: string;
  session_id: string;
  /** Maps to the `project` column on artifact (formerly project_id). */
  project_id: string;
}

function buildKernelInsertMap(m: KindMapping): KernelFills {
  // Default fills; per-kind overrides follow.
  const fills: KernelFills = {
    title: 'NULL',
    body: `''`,
    status: `'active'`,
    confidence: 'NULL',
    created_at_epoch: `unixepoch() * 1000`,
    updated_at_epoch: `unixepoch() * 1000`,
    session_id: 'NULL',
    project_id: 'NULL',
  };

  switch (m.kind) {
    case 'learning':
      // v3 learnings: no created_at_epoch; first_seen_epoch / last_promoted_epoch / updated_at_epoch (all SECONDS).
      fills.title = `substr(NEW.content, 1, 80)`;
      fills.body = `NEW.content`;
      fills.project_id = `NEW.project`;
      fills.created_at_epoch = `COALESCE(NEW.first_seen_epoch * 1000, unixepoch() * 1000)`;
      fills.updated_at_epoch = `COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000)`;
      break;
    case 'decision':
      // decisions: timestamp_epoch_ms (ms) + updated_at_epoch (seconds). No created_at_epoch column.
      fills.title = `substr(NEW.content, 1, 80)`;
      fills.body = `NEW.content`;
      fills.session_id = `NEW.session_id`;
      fills.project_id = `NEW.project`;
      fills.created_at_epoch = `COALESCE(NEW.timestamp_epoch_ms, unixepoch() * 1000)`;
      fills.updated_at_epoch = `COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000)`;
      break;
    case 'experience_pattern':
      // v3 experience_patterns: created_at_epoch (seconds), last_triggered_epoch (seconds).
      fills.title = `NEW.trigger_context`;
      fills.body = `CASE WHEN NEW.anti_pattern IS NOT NULL THEN NEW.lesson || char(10) || char(10) || 'What went wrong: ' || NEW.anti_pattern ELSE NEW.lesson END`;
      fills.session_id = `NEW.source_session`;
      fills.project_id = `NEW.source_project`;
      fills.confidence = `COALESCE(NEW.confidence, 0.5)`;
      fills.created_at_epoch = `COALESCE(NEW.created_at_epoch * 1000, unixepoch() * 1000)`;
      fills.updated_at_epoch = `COALESCE(NEW.created_at_epoch * 1000, unixepoch() * 1000)`;
      break;
    case 'angel_opinion':
      // v3 angel_opinions: created_at_epoch + updated_at_epoch (both seconds).
      fills.title = `NEW.subject || ' — opinion'`;
      fills.body = `NEW.opinion`;
      fills.confidence = `COALESCE(NEW.confidence, 0.5)`;
      fills.project_id = `NEW.project`;
      fills.created_at_epoch = `COALESCE(NEW.created_at_epoch * 1000, unixepoch() * 1000)`;
      fills.updated_at_epoch = `COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000)`;
      break;
    case 'critical_rule':
      // v3 critical_rules: created_at + updated_at are TEXT (datetime('now')). No epoch cols.
      fills.title = `substr(NEW.rule_text, 1, 80)`;
      fills.body = `NEW.rule_text`;
      fills.project_id = `NEW.project`;
      // Leave created_at_epoch/updated_at_epoch at their unixepoch() defaults.
      break;
    case 'mental_model':
      // v3 project_curated_context: created_at_epoch + updated_at_epoch (both seconds).
      fills.title = `COALESCE(NEW.type, '') || ' — ' || COALESCE(substr(NEW.content, 1, instr(NEW.content || char(10), char(10)) - 1), '')`;
      fills.body = `NEW.content`;
      fills.status = `COALESCE(NEW.status, 'active')`;
      fills.confidence = `CAST(NEW.trust_tier AS REAL) / 3.0`;
      fills.session_id = `NEW.source_session_id`;
      fills.project_id = `NEW.project`;
      fills.created_at_epoch = `COALESCE(NEW.created_at_epoch * 1000, unixepoch() * 1000)`;
      fills.updated_at_epoch = `COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000)`;
      break;
  }

  return fills;
}

function buildDataInsertPairs(m: KindMapping): string {
  // For each column in KIND_MAPPING that lives in data JSON, emit a (path, NEW.col) pair.
  const entries: string[] = [];
  for (const col of m.columns) {
    if (col.storage.kind === 'data') {
      entries.push(`'${pathKey(col.storage.path)}', NEW.${col.name}`);
    }
  }
  // project_curated_context: capture supersedes_id into _pending_supersedes for
  // lazy resolution through legacy_id_map on read.
  if (m.legacyTable === 'project_curated_context') {
    entries.push(`'_pending_supersedes', NEW.supersedes_id`);
  }
  if (entries.length === 0) return `json('{}')`;
  return `json_object(${entries.join(', ')})`;
}

function pathKey(path: string): string {
  // '$.agent_id' → 'agent_id'. Strip the '$.' prefix for json_object keys.
  return path.startsWith('$.') ? path.slice(2) : path;
}

// ─── UPDATE trigger generation ────────────────────────────────────────

function generateUpdateTriggerSql(m: KindMapping): string {
  const legacyTable = m.legacyTable;
  const triggerName = `${legacyTable}_instead_update`;

  // Build SET clauses.
  // Kernel columns set directly; data columns composed via chained json_set.
  const kernelSets: string[] = [];
  const dataPathSets: { path: string; valueExpr: string }[] = [];

  for (const col of m.columns) {
    if (col.storage.kind === 'kernel') {
      // Don't write legacy id column — that's immutable / mapped.
      if (col.storage.col === 'id') continue;
      kernelSets.push(kernelSetClause(m, col));
    } else if (col.storage.kind === 'data') {
      dataPathSets.push({ path: col.storage.path, valueExpr: `NEW.${col.name}` });
    }
    // computed and legacy_id_map — skip (not writable via UPDATE)
  }

  // project_curated_context.supersedes_id UPDATE path — store in _pending_supersedes
  // so the read-view's COALESCE picks it up. The next dry-run pass can resolve
  // lazily by populating legacy_id_map + kernel supersedes_id.
  if (legacyTable === 'project_curated_context') {
    dataPathSets.push({ path: '$._pending_supersedes', valueExpr: 'NEW.supersedes_id' });
  }

  let dataSet = '';
  if (dataPathSets.length > 0) {
    let expr = 'data';
    for (const { path, valueExpr } of dataPathSets) {
      expr = `json_set(${expr}, '${path}', ${valueExpr})`;
    }
    dataSet = `data = ${expr}`;
  }

  const allSets = [...kernelSets, ...(dataSet ? [dataSet] : []), `updated_at_epoch_ms = unixepoch() * 1000`];

  const whereClause =
    m.legacyIdType === 'TEXT_UUID'
      ? `WHERE id = OLD.${m.legacyIdCol}`
      : `WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = '${legacyTable}' AND legacy_id = OLD.${m.legacyIdCol})`;

  return `DROP TRIGGER IF EXISTS ${triggerName};
CREATE TRIGGER ${triggerName} INSTEAD OF UPDATE ON ${legacyTable}
BEGIN
  UPDATE artifact SET
    ${allSets.join(',\n    ')}
  ${whereClause};
END;`;
}

function kernelSetClause(m: KindMapping, col: LegacyColSpec): string {
  if (col.storage.kind !== 'kernel') return '';
  const kernelCol = col.storage.col;
  const legacyName = col.name;

  // Time columns in v3 are seconds; kernel is ms. Multiply.
  // kind-mapping.col values are still 'created_at_epoch'/'updated_at_epoch' (legacy names);
  // map to the canonical _ms column names in the artifact kernel.
  if (kernelCol === 'created_at_epoch' || kernelCol === 'updated_at_epoch') {
    return `${kernelCol}_ms = NEW.${legacyName} * 1000`;
  }

  // Body reconstruction for experience_patterns lesson/anti_pattern
  // is handled via computed view columns, so UPDATE is kernel-direct.
  if (kernelCol === 'body') {
    // For experience_patterns, writing `lesson` alone must preserve the
    // "\n\nWhat went wrong: <anti_pattern>" suffix if present.
    if (m.kind === 'experience_pattern' && legacyName === 'lesson') {
      return `body = CASE
        WHEN instr(artifact.body, char(10)||char(10)||'What went wrong: ') > 0
          THEN NEW.lesson || substr(artifact.body, instr(artifact.body, char(10)||char(10)||'What went wrong: '))
        ELSE NEW.lesson
      END`;
    }
    if (m.kind === 'experience_pattern' && legacyName === 'anti_pattern') {
      return `body = CASE
        WHEN NEW.anti_pattern IS NOT NULL AND instr(artifact.body, char(10)||char(10)||'What went wrong: ') > 0
          THEN substr(artifact.body, 1, instr(artifact.body, char(10)||char(10)||'What went wrong: ') - 1) || char(10)||char(10)||'What went wrong: ' || NEW.anti_pattern
        WHEN NEW.anti_pattern IS NOT NULL
          THEN artifact.body || char(10)||char(10)||'What went wrong: ' || NEW.anti_pattern
        WHEN instr(artifact.body, char(10)||char(10)||'What went wrong: ') > 0
          THEN substr(artifact.body, 1, instr(artifact.body, char(10)||char(10)||'What went wrong: ') - 1)
        ELSE artifact.body
      END`;
    }
    return `body = NEW.${legacyName}`;
  }

  return `${kernelCol} = NEW.${legacyName}`;
}

// ─── DELETE trigger generation ────────────────────────────────────────

function generateDeleteTriggerSql(m: KindMapping): string {
  const legacyTable = m.legacyTable;
  const triggerName = `${legacyTable}_instead_delete`;

  if (m.legacyIdType === 'TEXT_UUID') {
    return `DROP TRIGGER IF EXISTS ${triggerName};
CREATE TRIGGER ${triggerName} INSTEAD OF DELETE ON ${legacyTable}
BEGIN
  DELETE FROM artifact WHERE id = OLD.${m.legacyIdCol} AND kind = '${m.kind}';
END;`;
  }

  return `DROP TRIGGER IF EXISTS ${triggerName};
CREATE TRIGGER ${triggerName} INSTEAD OF DELETE ON ${legacyTable}
BEGIN
  DELETE FROM artifact
    WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = '${legacyTable}' AND legacy_id = OLD.${m.legacyIdCol})
      AND kind = '${m.kind}';
  DELETE FROM legacy_id_map
    WHERE legacy_table = '${legacyTable}' AND legacy_id = OLD.${m.legacyIdCol};
END;`;
}
