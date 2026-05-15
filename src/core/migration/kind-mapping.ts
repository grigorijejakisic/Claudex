/**
 * V17 KIND_MAPPING — authoritative source-of-truth for legacy → artifact migration.
 *
 * Consumed by:
 * - composeBody (this dir) — Phase A pre-embed + Phase B INSERT use the same composition.
 * - Trigger code generator (v17-triggers.ts) — emits 6 views + 18 INSTEAD OF triggers.
 *
 * Changes to this table MUST be reviewed — drift breaks migration + embedding alignment.
 */

export type ArtifactKind =
  | 'learning'
  | 'decision'
  | 'experience_pattern'
  | 'angel_opinion'
  | 'critical_rule'
  | 'mental_model';

export type LegacyTable =
  | 'learnings'
  | 'decisions'
  | 'experience_patterns'
  | 'angel_opinions'
  | 'critical_rules'
  | 'project_curated_context';

export type SqliteType = 'INTEGER' | 'TEXT' | 'REAL' | 'BLOB';

export type KernelCol =
  | 'id'
  | 'kind'
  | 'title'
  | 'body'
  | 'scope'
  | 'status'
  | 'confidence'
  | 'created_at_epoch'
  | 'updated_at_epoch'
  | 'session_id'
  | 'project'
  | 'embedding_ref'
  | 'supersedes_id'
  | 'data';

export interface LegacyColSpec {
  /** Legacy column name as it appears in the v3 table. */
  name: string;
  /** SQLite type for CAST preservation in the view projection. */
  type: SqliteType;
  /** Where the value lives on the unified `artifact` row. */
  storage:
    | { kind: 'kernel'; col: Exclude<KernelCol, 'data'> }
    | { kind: 'data'; path: string }
    | { kind: 'legacy_id_map' } // integer legacy id resolved via legacy_id_map
    | { kind: 'computed'; note: string }; // composed/synthesized — view only
}

export interface KindMapping {
  kind: ArtifactKind;
  legacyTable: LegacyTable;
  /** Whether legacy id is TEXT UUID (preserved) or INTEGER (mapped via legacy_id_map). */
  legacyIdType: 'INTEGER' | 'TEXT_UUID';
  /** Column name of the legacy primary key. */
  legacyIdCol: string;
  /**
   * v3 column list in the exact order the legacy table exposed them.
   * Used to render the view projection and to enumerate INSERT trigger columns.
   */
  columns: LegacyColSpec[];
  /**
   * Legacy-column name carrying session_id (if any) — for the INSERT trigger mapping.
   * Not every legacy table had one.
   */
  sessionIdCol: string | null;
  /**
   * Legacy-column name carrying project_id (if any).
   */
  projectIdCol: string | null;
  /**
   * Pure function that builds the {title, body, data, ...} payload for a legacy row.
   * Used by both Phase A (pre-embed) and Phase B (INSERT) paths.
   */
  compose: (row: Record<string, unknown>) => ComposedPayload;
}

export interface ComposedPayload {
  title: string | null;
  body: string;
  data: Record<string, unknown>;
  scope: 'session' | 'project' | 'universal';
  status: 'active' | 'stale' | 'archived' | 'superseded';
  confidence: number | null;
  session_id: string | null;
  /** The value for the `project` column on artifact (formerly project_id). */
  project_id: string | null;
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?\n]+[.!?]/);
  return m ? m[0].trim() : firstLine(s);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

function asNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStringOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

export const KIND_MAPPING: Record<LegacyTable, KindMapping> = {
  learnings: {
    kind: 'learning',
    legacyTable: 'learnings',
    legacyIdType: 'INTEGER',
    legacyIdCol: 'id',
    sessionIdCol: null,
    projectIdCol: 'project',
    columns: [
      { name: 'id', type: 'INTEGER', storage: { kind: 'legacy_id_map' } },
      { name: 'project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'agent_id', type: 'TEXT', storage: { kind: 'data', path: '$.agent_id' } },
      { name: 'fingerprint', type: 'TEXT', storage: { kind: 'data', path: '$.fingerprint' } },
      { name: 'content', type: 'TEXT', storage: { kind: 'kernel', col: 'body' } },
      { name: 'promotion_count', type: 'INTEGER', storage: { kind: 'data', path: '$.promotion_count' } },
      { name: 'first_seen_epoch', type: 'INTEGER', storage: { kind: 'data', path: '$.first_seen_epoch' } },
      { name: 'last_promoted_epoch', type: 'INTEGER', storage: { kind: 'data', path: '$.last_promoted_epoch' } },
      { name: 'updated_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'updated_at_epoch' } },
    ],
    compose: (row) => {
      const content = asString(row.content);
      return {
        title: truncate(content, 80) || null,
        body: content,
        data: {
          agent_id: asStringOrNull(row.agent_id),
          fingerprint: asStringOrNull(row.fingerprint),
          promotion_count: asNumberOrNull(row.promotion_count),
          first_seen_epoch: asNumberOrNull(row.first_seen_epoch),
          last_promoted_epoch: asNumberOrNull(row.last_promoted_epoch),
        },
        scope: 'project',
        status: 'active',
        confidence: null,
        session_id: null,
        project_id: asStringOrNull(row.project),
      };
    },
  },

  decisions: {
    kind: 'decision',
    legacyTable: 'decisions',
    legacyIdType: 'INTEGER',
    legacyIdCol: 'id',
    sessionIdCol: 'session_id',
    projectIdCol: 'project',
    columns: [
      { name: 'id', type: 'INTEGER', storage: { kind: 'legacy_id_map' } },
      { name: 'session_id', type: 'TEXT', storage: { kind: 'kernel', col: 'session_id' } },
      { name: 'project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'content', type: 'TEXT', storage: { kind: 'kernel', col: 'body' } },
      { name: 'source', type: 'TEXT', storage: { kind: 'data', path: '$.source' } },
      { name: 'fingerprint', type: 'TEXT', storage: { kind: 'data', path: '$.fingerprint' } },
      { name: 'timestamp_epoch', type: 'INTEGER', storage: { kind: 'data', path: '$.timestamp_epoch' } },
      { name: 'updated_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'updated_at_epoch' } },
    ],
    compose: (row) => {
      const content = asString(row.content);
      return {
        title: firstSentence(content) || null,
        body: content,
        data: {
          source: asStringOrNull(row.source),
          fingerprint: asStringOrNull(row.fingerprint),
          timestamp_epoch: asNumberOrNull(row.timestamp_epoch),
          alternatives: null,
        },
        scope: 'project',
        status: 'active',
        confidence: null,
        session_id: asStringOrNull(row.session_id),
        project_id: asStringOrNull(row.project),
      };
    },
  },

  experience_patterns: {
    kind: 'experience_pattern',
    legacyTable: 'experience_patterns',
    legacyIdType: 'TEXT_UUID',
    legacyIdCol: 'id',
    sessionIdCol: 'source_session',
    projectIdCol: 'source_project',
    columns: [
      { name: 'id', type: 'TEXT', storage: { kind: 'kernel', col: 'id' } },
      { name: 'pattern_type', type: 'TEXT', storage: { kind: 'data', path: '$.pattern_type' } },
      { name: 'trigger_context', type: 'TEXT', storage: { kind: 'kernel', col: 'title' } },
      { name: 'lesson', type: 'TEXT', storage: { kind: 'computed', note: 'body = lesson + suffix' } },
      { name: 'anti_pattern', type: 'TEXT', storage: { kind: 'computed', note: 'body contains anti_pattern after suffix' } },
      { name: 'severity', type: 'TEXT', storage: { kind: 'data', path: '$.severity' } },
      { name: 'score', type: 'INTEGER', storage: { kind: 'data', path: '$.score' } },
      { name: 'times_triggered', type: 'INTEGER', storage: { kind: 'data', path: '$.times_triggered' } },
      { name: 'times_useful', type: 'INTEGER', storage: { kind: 'data', path: '$.times_useful' } },
      { name: 'source_session', type: 'TEXT', storage: { kind: 'kernel', col: 'session_id' } },
      { name: 'source_project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'created_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'created_at_epoch' } },
      { name: 'last_triggered_epoch', type: 'INTEGER', storage: { kind: 'data', path: '$.last_triggered_epoch' } },
      { name: 'trigger_glob', type: 'TEXT', storage: { kind: 'data', path: '$.trigger_glob' } },
      { name: 'trigger_command', type: 'TEXT', storage: { kind: 'data', path: '$.trigger_command' } },
      { name: 'embedding', type: 'BLOB', storage: { kind: 'computed', note: 'legacy embedding discarded; re-embedded via artifact_embeddings' } },
      { name: 'assumption', type: 'TEXT', storage: { kind: 'data', path: '$.assumption' } },
      { name: 'reality', type: 'TEXT', storage: { kind: 'data', path: '$.reality' } },
      { name: 'root_cause', type: 'TEXT', storage: { kind: 'data', path: '$.root_cause' } },
      { name: 'generalized_rule', type: 'TEXT', storage: { kind: 'data', path: '$.generalized_rule' } },
      { name: 'abstraction_level', type: 'TEXT', storage: { kind: 'data', path: '$.abstraction_level' } },
      { name: 'verified', type: 'INTEGER', storage: { kind: 'data', path: '$.verified' } },
      { name: 'verification_count', type: 'INTEGER', storage: { kind: 'data', path: '$.verification_count' } },
      { name: 'helpful_count', type: 'INTEGER', storage: { kind: 'data', path: '$.helpful_count' } },
      { name: 'harmful_count', type: 'INTEGER', storage: { kind: 'data', path: '$.harmful_count' } },
      { name: 'escalation_level', type: 'TEXT', storage: { kind: 'data', path: '$.escalation_level' } },
      { name: 'maturity', type: 'TEXT', storage: { kind: 'data', path: '$.maturity' } },
      { name: 'confidence', type: 'REAL', storage: { kind: 'kernel', col: 'confidence' } },
      { name: 'retrieval_mode', type: 'TEXT', storage: { kind: 'data', path: '$.retrieval_mode' } },
      { name: 'trigger_intents', type: 'TEXT', storage: { kind: 'data', path: '$.trigger_intents' } },
      { name: 'needs_reembed', type: 'INTEGER', storage: { kind: 'data', path: '$.needs_reembed' } },
    ],
    compose: (row) => {
      const lesson = asString(row.lesson);
      const antiPattern = row.anti_pattern;
      const body = antiPattern
        ? lesson + '\n\nWhat went wrong: ' + asString(antiPattern)
        : lesson;
      const title = asStringOrNull(row.trigger_context);
      return {
        title,
        body,
        data: {
          pattern_type: asStringOrNull(row.pattern_type),
          severity: asStringOrNull(row.severity),
          score: asNumberOrNull(row.score),
          times_triggered: asNumberOrNull(row.times_triggered),
          times_useful: asNumberOrNull(row.times_useful),
          last_triggered_epoch: asNumberOrNull(row.last_triggered_epoch),
          trigger_glob: asStringOrNull(row.trigger_glob),
          trigger_command: asStringOrNull(row.trigger_command),
          assumption: asStringOrNull(row.assumption),
          reality: asStringOrNull(row.reality),
          root_cause: asStringOrNull(row.root_cause),
          generalized_rule: asStringOrNull(row.generalized_rule),
          abstraction_level: asStringOrNull(row.abstraction_level),
          verified: asNumberOrNull(row.verified),
          verification_count: asNumberOrNull(row.verification_count),
          helpful_count: asNumberOrNull(row.helpful_count),
          harmful_count: asNumberOrNull(row.harmful_count),
          escalation_level: asStringOrNull(row.escalation_level),
          maturity: asStringOrNull(row.maturity),
          retrieval_mode: asStringOrNull(row.retrieval_mode),
          trigger_intents: asStringOrNull(row.trigger_intents),
          needs_reembed: asNumberOrNull(row.needs_reembed),
        },
        scope: 'project',
        status: 'active',
        confidence: asNumberOrNull(row.confidence),
        session_id: asStringOrNull(row.source_session),
        project_id: asStringOrNull(row.source_project),
      };
    },
  },

  angel_opinions: {
    kind: 'angel_opinion',
    legacyTable: 'angel_opinions',
    legacyIdType: 'INTEGER',
    legacyIdCol: 'id',
    sessionIdCol: null,
    projectIdCol: 'project',
    columns: [
      { name: 'id', type: 'INTEGER', storage: { kind: 'legacy_id_map' } },
      { name: 'project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'subject', type: 'TEXT', storage: { kind: 'data', path: '$.subject' } },
      { name: 'opinion', type: 'TEXT', storage: { kind: 'kernel', col: 'body' } },
      { name: 'confidence', type: 'REAL', storage: { kind: 'kernel', col: 'confidence' } },
      { name: 'evidence_count', type: 'INTEGER', storage: { kind: 'data', path: '$.evidence_count' } },
      { name: 'reinforced_count', type: 'INTEGER', storage: { kind: 'data', path: '$.reinforced_count' } },
      { name: 'weakened_count', type: 'INTEGER', storage: { kind: 'data', path: '$.weakened_count' } },
      { name: 'contradicted_count', type: 'INTEGER', storage: { kind: 'data', path: '$.contradicted_count' } },
      { name: 'source_type', type: 'TEXT', storage: { kind: 'data', path: '$.source_type' } },
      { name: 'created_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'created_at_epoch' } },
      { name: 'updated_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'updated_at_epoch' } },
    ],
    compose: (row) => {
      const subject = asString(row.subject);
      const opinion = asString(row.opinion);
      return {
        title: subject ? subject + ' — opinion' : null,
        body: opinion,
        data: {
          subject: subject || null,
          evidence_count: asNumberOrNull(row.evidence_count),
          reinforced_count: asNumberOrNull(row.reinforced_count),
          weakened_count: asNumberOrNull(row.weakened_count),
          contradicted_count: asNumberOrNull(row.contradicted_count),
          source_type: asStringOrNull(row.source_type),
        },
        scope: 'project',
        status: 'active',
        confidence: asNumberOrNull(row.confidence),
        session_id: null,
        project_id: asStringOrNull(row.project),
      };
    },
  },

  critical_rules: {
    kind: 'critical_rule',
    legacyTable: 'critical_rules',
    legacyIdType: 'INTEGER',
    legacyIdCol: 'id',
    sessionIdCol: null,
    projectIdCol: 'project',
    columns: [
      { name: 'id', type: 'INTEGER', storage: { kind: 'legacy_id_map' } },
      { name: 'project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'rule_text', type: 'TEXT', storage: { kind: 'kernel', col: 'body' } },
      { name: 'variants', type: 'TEXT', storage: { kind: 'data', path: '$.variants' } },
      { name: 'source', type: 'TEXT', storage: { kind: 'data', path: '$.source' } },
      { name: 'drift_risk', type: 'TEXT', storage: { kind: 'data', path: '$.drift_risk' } },
      { name: 'domain_tags', type: 'TEXT', storage: { kind: 'data', path: '$.domain_tags' } },
      { name: 'base_ttl', type: 'INTEGER', storage: { kind: 'data', path: '$.base_ttl' } },
      { name: 'current_ttl', type: 'INTEGER', storage: { kind: 'data', path: '$.current_ttl' } },
      { name: 'last_injected_turn', type: 'INTEGER', storage: { kind: 'data', path: '$.last_injected_turn' } },
      { name: 'injection_count', type: 'INTEGER', storage: { kind: 'data', path: '$.injection_count' } },
      { name: 'violation_count', type: 'INTEGER', storage: { kind: 'data', path: '$.violation_count' } },
      { name: 'compliance_count', type: 'INTEGER', storage: { kind: 'data', path: '$.compliance_count' } },
      { name: 'created_at', type: 'TEXT', storage: { kind: 'data', path: '$.created_at' } },
      { name: 'updated_at', type: 'TEXT', storage: { kind: 'data', path: '$.updated_at' } },
    ],
    compose: (row) => {
      const ruleText = asString(row.rule_text);
      return {
        title: truncate(ruleText, 80) || null,
        body: ruleText,
        data: {
          variants: asStringOrNull(row.variants),
          source: asStringOrNull(row.source),
          drift_risk: asStringOrNull(row.drift_risk),
          domain_tags: asStringOrNull(row.domain_tags),
          base_ttl: asNumberOrNull(row.base_ttl),
          current_ttl: asNumberOrNull(row.current_ttl),
          last_injected_turn: asNumberOrNull(row.last_injected_turn),
          injection_count: asNumberOrNull(row.injection_count),
          violation_count: asNumberOrNull(row.violation_count),
          compliance_count: asNumberOrNull(row.compliance_count),
          created_at: asStringOrNull(row.created_at),
          updated_at: asStringOrNull(row.updated_at),
        },
        scope: 'project',
        status: 'active',
        confidence: null,
        session_id: null,
        project_id: asStringOrNull(row.project),
      };
    },
  },

  project_curated_context: {
    kind: 'mental_model',
    legacyTable: 'project_curated_context',
    legacyIdType: 'INTEGER',
    legacyIdCol: 'id',
    sessionIdCol: 'source_session_id',
    projectIdCol: 'project',
    columns: [
      { name: 'id', type: 'INTEGER', storage: { kind: 'legacy_id_map' } },
      { name: 'project', type: 'TEXT', storage: { kind: 'kernel', col: 'project' } },
      { name: 'type', type: 'TEXT', storage: { kind: 'data', path: '$.type' } },
      { name: 'content', type: 'TEXT', storage: { kind: 'kernel', col: 'body' } },
      { name: 'tags', type: 'TEXT', storage: { kind: 'data', path: '$.tags' } },
      { name: 'supersedes_id', type: 'INTEGER', storage: { kind: 'computed', note: 'resolved via legacy_id_map → kernel supersedes_id; lazy via data._pending_supersedes' } },
      { name: 'curator', type: 'TEXT', storage: { kind: 'data', path: '$.curator' } },
      { name: 'trust_tier', type: 'INTEGER', storage: { kind: 'data', path: '$.trust_tier' } },
      { name: 'status', type: 'TEXT', storage: { kind: 'kernel', col: 'status' } },
      { name: 'source_session_id', type: 'TEXT', storage: { kind: 'kernel', col: 'session_id' } },
      { name: 'created_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'created_at_epoch' } },
      { name: 'updated_at_epoch', type: 'INTEGER', storage: { kind: 'kernel', col: 'updated_at_epoch' } },
    ],
    compose: (row) => {
      const type = asString(row.type);
      const content = asString(row.content);
      const trustTier = asNumberOrNull(row.trust_tier);
      const data: Record<string, unknown> = {
        type: type || null,
        tags: asStringOrNull(row.tags),
        curator: asStringOrNull(row.curator),
        trust_tier: trustTier,
      };
      // Preserve legacy integer supersedes_id for Pass 2 resolution via legacy_id_map.
      if (row.supersedes_id != null) {
        data._legacy_supersedes_id = asNumberOrNull(row.supersedes_id);
      }
      const statusRaw = asStringOrNull(row.status);
      const status: 'active' | 'stale' | 'archived' | 'superseded' =
        statusRaw === 'archived' || statusRaw === 'superseded'
          ? statusRaw
          : statusRaw === 'stale'
            ? 'stale'
            : 'active';
      return {
        title: type && content ? type + ' — ' + firstLine(content) : firstLine(content) || null,
        body: content,
        data,
        scope: 'project',
        status,
        confidence: trustTier != null ? trustTier / 3.0 : null,
        session_id: asStringOrNull(row.source_session_id),
        project_id: asStringOrNull(row.project),
      };
    },
  },
};

/** Convenience helper — map legacy table name to kind. */
export function kindForTable(tbl: LegacyTable): ArtifactKind {
  return KIND_MAPPING[tbl].kind;
}

/** All 6 kinds seeded by P1 migration. */
export const P1_KINDS: readonly ArtifactKind[] = [
  'learning',
  'decision',
  'experience_pattern',
  'angel_opinion',
  'critical_rule',
  'mental_model',
] as const;
