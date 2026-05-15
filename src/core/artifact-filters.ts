/**
 * Artifact substance predicate — single source of truth for "is this artifact
 * worth surfacing to an agent?"
 *
 * Two exports:
 *   1. `isSubstantive(artifact)` — pure JS function for in-process filtering
 *      of materialized rows (no DB calls, no side effects).
 *   2. `substantiveSqlClause(tableAlias)` — companion SQL fragment encoding
 *      the same predicate, for use in WHERE clauses to filter at the DB layer.
 *
 * JS and SQL must remain in lockstep. If you add a new substantive type or
 * change the rules here, update BOTH this function AND the SQL clause, then
 * add a fixture row to `src/tests/core/artifact-filters.test.ts` to cover the
 * new branch.
 *
 * ## Predicate rules (CONTEXT decision, locked 2026-05-16)
 *
 * (a) **Observation gate:** If `artifact_type === 'observation'` (legacy table)
 *     OR `kind === 'observation'` (V17 artifact table): require BOTH
 *     `importance >= 4` AND `summary.length >= 60`. Reject otherwise.
 *
 * (b) **Noise prefix reject:** Reject if summary matches
 *     `^(Read|Edit|Write|Bash|MultiEdit|Glob|Grep|NotebookEdit|TodoWrite):\s`
 *     — these are single-tool-call traces whose content is an artifact name,
 *     not transferable knowledge. The regex requires a colon immediately after
 *     the verb to minimize false positives (a legitimate artifact titled
 *     "Reading: how to interpret deprecation warnings" would NOT be rejected
 *     because the word is "Reading", not "Read").
 *
 * (c) **Certified-substantive types:** The following types passed through
 *     explicit promotion gates and are always considered substantive regardless
 *     of importance or summary length:
 *
 *     Legacy (`artifact_type`): learning, decision, memory_file, flow,
 *     milestone, entity_summary, handoff
 *
 *     V17 (`kind`): learning, decision, memory_file, flow, milestone,
 *     entity_summary, handoff, mental_model, directive_rule, critical_rule,
 *     angel_opinion, experience_pattern
 *
 * (d) **Unknown type / kind:** Default reject (conservative). This ensures
 *     that new artifact types added to the schema without explicit predicate
 *     coverage don't silently pollute surfaces.
 */

/**
 * Minimal shape needed to evaluate substantiveness. Both legacy (`artifact_type`)
 * and V17 (`kind`) fields are optional to support cross-table queries.
 */
export interface ArtifactSubstanceShape {
  /** Legacy artifacts table column. */
  artifact_type?: string;
  /** V17 artifact table column. */
  kind?: string;
  /** Human-readable summary (first ~200 chars typically). */
  summary?: string;
  /** Importance score 1–5. */
  importance?: number;
}

/**
 * Legacy `artifact_type` values that are always substantive — they require
 * an explicit promotion step before they enter the DB with this type.
 *
 * `observation` is intentionally NOT in this set — observations require the
 * importance + length gate (rule a).
 */
export const SUBSTANTIVE_TYPES_LEGACY: ReadonlySet<string> = new Set([
  'learning',
  'decision',
  'memory_file',
  'flow',
  'milestone',
  'entity_summary',
  'handoff',
]);

/**
 * V17 `kind` values that are always substantive. Superset of legacy — V17
 * added finer-grained types that map to dedicated promotion paths.
 *
 * `observation` is intentionally NOT in this set.
 */
export const SUBSTANTIVE_KINDS_V17: ReadonlySet<string> = new Set([
  'learning',
  'decision',
  'memory_file',
  'flow',
  'milestone',
  'entity_summary',
  'handoff',
  'mental_model',
  'directive_rule',
  'critical_rule',
  'angel_opinion',
  'experience_pattern',
]);

/**
 * Regex that matches single-tool-call-trace summaries. These start with a
 * CC tool verb followed by a colon and optional whitespace.
 *
 * Exported so callers can compose it with their own filters if needed.
 *
 * Note on false positives: the regex requires the EXACT verb (no trailing
 * characters before `:`), so "Reading: …" or "Edits: …" do NOT match.
 * The `:` must immediately follow the verb keyword.
 */
export const NOISE_PREFIX_REGEX: RegExp =
  /^(Read|Edit|Write|Bash|MultiEdit|Glob|Grep|NotebookEdit|TodoWrite):\s/;

/**
 * Pure predicate — returns `true` iff the artifact is considered substantive.
 *
 * No DB calls. No side effects. Safe to call in hot paths.
 *
 * Evaluation order:
 * 1. Noise prefix check (reject fast — most noise rows are caught here)
 * 2. Certified-substantive type check (accept fast — learnings, decisions, etc.)
 * 3. Observation gate (importance + length, applicable only to observation rows)
 * 4. Unknown type/kind → reject (conservative default)
 */
export function isSubstantive(artifact: ArtifactSubstanceShape): boolean {
  const summary = artifact.summary ?? '';
  const type = artifact.artifact_type;
  const kind = artifact.kind;

  // Rule (b): reject noise-prefix summaries regardless of type.
  if (NOISE_PREFIX_REGEX.test(summary)) return false;

  // Rule (c): certified-substantive legacy types.
  if (type !== undefined && SUBSTANTIVE_TYPES_LEGACY.has(type)) return true;

  // Rule (c): certified-substantive V17 kinds.
  if (kind !== undefined && SUBSTANTIVE_KINDS_V17.has(kind)) return true;

  // Rule (a): observation gate — both legacy artifact_type and V17 kind.
  const isObservation =
    type === 'observation' || kind === 'observation';
  if (isObservation) {
    const importance = artifact.importance ?? 0;
    return importance >= 4 && summary.length >= 60;
  }

  // Rule (d): unknown type/kind — conservative reject.
  return false;
}

/**
 * Returns a SQL WHERE-clause fragment (no leading WHERE keyword) that encodes
 * the same predicate as `isSubstantive`, scoped to the supplied table alias.
 *
 * Example:
 * ```ts
 * const sql = `SELECT * FROM artifacts a WHERE ${substantiveSqlClause('a')}`;
 * ```
 *
 * The fragment assumes the table has at minimum these columns:
 *   - `artifact_type TEXT` (legacy) or `kind TEXT` (V17)
 *   - `summary TEXT`
 *   - `importance INTEGER`
 *
 * Callers are responsible for correct parenthesisation when combining this
 * fragment with other WHERE conditions using AND/OR.
 *
 * The SQL is parameterless — all thresholds are inlined as literals. This
 * makes the clause safe to embed in cached prepared statements without
 * placeholder injection concerns.
 *
 * @throws {Error} If `tableAlias` is empty or contains non-identifier characters.
 */
export function substantiveSqlClause(tableAlias: string): string {
  if (!tableAlias || tableAlias.trim().length === 0) {
    throw new Error('substantiveSqlClause: tableAlias must be a non-empty string');
  }
  // Guard against SQL injection via alias (aliases must be safe identifiers).
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(tableAlias)) {
    throw new Error(
      `substantiveSqlClause: tableAlias "${tableAlias}" contains invalid characters. ` +
      'Only letters, digits, underscores, and dots are allowed.'
    );
  }

  const a = tableAlias;

  // Certified-substantive type list (legacy artifact_type).
  const legacyTypes = [
    "'learning'",
    "'decision'",
    "'memory_file'",
    "'flow'",
    "'milestone'",
    "'entity_summary'",
    "'handoff'",
  ].join(', ');

  // Certified-substantive kind list (V17).
  const v17Kinds = [
    "'learning'",
    "'decision'",
    "'memory_file'",
    "'flow'",
    "'milestone'",
    "'entity_summary'",
    "'handoff'",
    "'mental_model'",
    "'directive_rule'",
    "'critical_rule'",
    "'angel_opinion'",
    "'experience_pattern'",
  ].join(', ');

  // Noise prefix GLOB pattern (SQLite GLOB is case-sensitive, unlike LIKE).
  // We match any summary that starts with one of the CC verb prefixes.
  // SQLite GLOB '*' matches any sequence; we match prefix via [A-Z]* pattern.
  // Pattern: 'Read: *' etc — using GLOB for prefix match (case-sensitive).
  // We use the OR chain because GLOB doesn't support alternation natively.
  const noiseGlobCondition = [
    `${a}.summary GLOB 'Read: *'`,
    `${a}.summary GLOB 'Edit: *'`,
    `${a}.summary GLOB 'Write: *'`,
    `${a}.summary GLOB 'Bash: *'`,
    `${a}.summary GLOB 'MultiEdit: *'`,
    `${a}.summary GLOB 'Glob: *'`,
    `${a}.summary GLOB 'Grep: *'`,
    `${a}.summary GLOB 'NotebookEdit: *'`,
    `${a}.summary GLOB 'TodoWrite: *'`,
  ].join(' OR ');

  return (
    // Not a noise prefix
    `NOT (${noiseGlobCondition})` +
    // AND (is a certified-substantive legacy type OR V17 kind OR passes observation gate)
    ` AND (` +
      `${a}.artifact_type IN (${legacyTypes})` +
      ` OR ${a}.kind IN (${v17Kinds})` +
      ` OR (` +
        `(${a}.artifact_type = 'observation' OR ${a}.kind = 'observation')` +
        ` AND ${a}.importance >= 4` +
        ` AND LENGTH(${a}.summary) >= 60` +
      `)` +
    `)`
  );
}
