/**
 * Tests for src/core/artifact-filters.ts
 *
 * Three describe blocks:
 *   1. isSubstantive — predicate truth table (12+ fixture rows)
 *   2. substantiveSqlClause — SQL fragment structural tests
 *   3. JS ↔ SQL lockstep — in-memory SQLite equivalence on fixture set
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSubstantive,
  substantiveSqlClause,
  NOISE_PREFIX_REGEX,
  SUBSTANTIVE_TYPES_LEGACY,
  SUBSTANTIVE_KINDS_V17,
  type ArtifactSubstanceShape,
} from '../../core/artifact-filters.js';

// ---------------------------------------------------------------------------
// Fixture set — shared between truth-table tests and lockstep test
// Each row has an `id` for the lockstep query + the predicate input + expected result.
// ---------------------------------------------------------------------------

interface Fixture extends ArtifactSubstanceShape {
  id: number;
  label: string;
  expected: boolean;
}

const FIXTURES: Fixture[] = [
  // 1. learning (legacy) + any importance + any summary → substantive
  {
    id: 1,
    label: 'learning (legacy) always substantive',
    artifact_type: 'learning',
    summary: 'Short',
    importance: 1,
    expected: true,
  },
  // 2. decision (legacy) → substantive
  {
    id: 2,
    label: 'decision (legacy) always substantive',
    artifact_type: 'decision',
    summary: 'Decision to refactor the auth module to use JWT tokens',
    importance: 3,
    expected: true,
  },
  // 3. memory_file (legacy) → substantive
  {
    id: 3,
    label: 'memory_file (legacy) always substantive',
    artifact_type: 'memory_file',
    summary: 'Architecture overview',
    importance: 2,
    expected: true,
  },
  // 4. observation + importance=5 + 200-char summary → substantive
  {
    id: 4,
    label: 'observation: high importance + long summary → substantive',
    artifact_type: 'observation',
    summary: 'Investigated the cascading failure in the bet365 pipeline. Root cause was a stale connection pool not being recycled after a network partition, leading to a 100% error rate for 12 minutes.',
    importance: 5,
    expected: true,
  },
  // 5. observation + importance=3 + 200-char summary → noise (importance gate)
  {
    id: 5,
    label: 'observation: importance=3 → noise (below threshold)',
    artifact_type: 'observation',
    summary: 'Investigated the cascading failure in the bet365 pipeline. Root cause was a stale connection pool not being recycled after a network partition, leading to a 100% error rate for 12 minutes.',
    importance: 3,
    expected: false,
  },
  // 6. observation + importance=5 + 30-char summary → noise (length gate)
  {
    id: 6,
    label: 'observation: importance=5 + short summary → noise (below 60 chars)',
    artifact_type: 'observation',
    summary: 'Rate limit hit on API calls',
    importance: 5,
    expected: false,
  },
  // 7. observation + importance=5 + noise-prefix summary 'Read: file.ts' → noise
  {
    id: 7,
    label: 'observation: Read: prefix → noise (noise prefix regex)',
    artifact_type: 'observation',
    summary: 'Read: config.ts',
    importance: 5,
    expected: false,
  },
  // 8. observation + importance=5 + noise-prefix 'Bash: ...' → noise
  {
    id: 8,
    label: 'observation: Bash: prefix → noise',
    artifact_type: 'observation',
    summary: 'Bash: for p in 09-01 09-02 09-03 09-04; do echo $p; done',
    importance: 5,
    expected: false,
  },
  // 9. handoff (legacy) → substantive
  {
    id: 9,
    label: 'handoff (legacy) always substantive',
    artifact_type: 'handoff',
    summary: 'Session handoff: Phase 14 Wave 3 in progress',
    importance: 4,
    expected: true,
  },
  // 10. unknown artifact_type → noise (conservative default)
  {
    id: 10,
    label: 'unknown artifact_type → noise (conservative)',
    artifact_type: 'hot_file',
    summary: 'This is a hot file reference that should not surface in experience tier',
    importance: 5,
    expected: false,
  },
  // 11. V17 kind=mental_model → substantive
  {
    id: 11,
    label: 'V17 kind=mental_model → substantive',
    kind: 'mental_model',
    summary: 'The good child heeds the warning before the burn',
    importance: 3,
    expected: true,
  },
  // 12. V17 kind=observation + importance=5 + 30 chars → noise (short)
  {
    id: 12,
    label: 'V17 kind=observation + short summary → noise (below 60 chars)',
    kind: 'observation',
    summary: 'Short observation text here',
    importance: 5,
    expected: false,
  },
  // Extra fixtures for additional branch coverage:
  // 13. entity_summary (legacy) → substantive
  {
    id: 13,
    label: 'entity_summary (legacy) always substantive',
    artifact_type: 'entity_summary',
    summary: 'Entity: bet365 API behavior under high load',
    importance: 3,
    expected: true,
  },
  // 14. V17 kind=angel_opinion → substantive
  {
    id: 14,
    label: 'V17 kind=angel_opinion → substantive',
    kind: 'angel_opinion',
    summary: 'Substrate coherence is the foundation of reliable session continuity',
    importance: 2,
    expected: true,
  },
  // 15. Edit: prefix on a learning → noise (prefix rule overrides type)
  {
    id: 15,
    label: 'learning with Edit: prefix → noise (prefix rule overrides type)',
    artifact_type: 'learning',
    summary: 'Edit: auth-extract.ts',
    importance: 5,
    expected: false,
  },
  // 16. V17 kind=observation + importance=4 + exactly 60-char summary → substantive (boundary)
  {
    id: 16,
    label: 'V17 kind=observation: importance=4 + exactly 60-char summary → substantive (boundary)',
    kind: 'observation',
    // Exactly 60 characters:
    summary: 'Cascade failure: connection pool exhaustion at 22:00 UTC ok!',
    importance: 4,
    expected: true,
  },
];

// Verify fixture #16 summary is exactly 60 chars (assertion at module load time).
if (FIXTURES[15].summary!.length !== 60) {
  throw new Error(
    `Fixture 16 summary length is ${FIXTURES[15].summary!.length}, expected 60. Fix the fixture.`
  );
}

// ---------------------------------------------------------------------------
// 1. isSubstantive — predicate truth table
// ---------------------------------------------------------------------------

describe('isSubstantive — predicate truth table', () => {
  for (const f of FIXTURES) {
    it(`fixture ${f.id}: ${f.label}`, () => {
      const result = isSubstantive(f);
      expect(result).toBe(f.expected);
    });
  }

  it('returns false when artifact has no type or kind', () => {
    // No artifact_type, no kind → unknown type → conservative reject
    expect(isSubstantive({ summary: 'Some summary text that is quite long at sixty chars', importance: 5 })).toBe(false);
  });

  it('handles undefined summary gracefully (treats as empty string)', () => {
    // observation with no summary fails length gate (0 < 60)
    expect(isSubstantive({ artifact_type: 'observation', importance: 5 })).toBe(false);
  });

  it('handles undefined importance gracefully (defaults to 0)', () => {
    // observation with no importance fails gate (0 < 4)
    const longSummary = 'A'.repeat(60);
    expect(isSubstantive({ artifact_type: 'observation', summary: longSummary })).toBe(false);
  });

  it('MultiEdit: prefix is rejected as noise', () => {
    expect(isSubstantive({
      artifact_type: 'observation',
      summary: 'MultiEdit: auth.ts, config.ts',
      importance: 5,
    })).toBe(false);
  });

  it('Write: prefix is rejected as noise', () => {
    expect(isSubstantive({
      artifact_type: 'learning',
      summary: 'Write: important-output.json',
      importance: 5,
    })).toBe(false);
  });

  it('NOISE_PREFIX_REGEX does not match "Reading: ..." (false-positive guard)', () => {
    // The regex requires exact verb — "Reading:" should not match "Read:"
    expect(NOISE_PREFIX_REGEX.test('Reading: this is not a noise prefix')).toBe(false);
  });

  it('NOISE_PREFIX_REGEX does not match "Edits: ..." (false-positive guard)', () => {
    expect(NOISE_PREFIX_REGEX.test('Edits: plural form not matched')).toBe(false);
  });

  it('SUBSTANTIVE_TYPES_LEGACY contains expected types and excludes observation', () => {
    expect(SUBSTANTIVE_TYPES_LEGACY.has('learning')).toBe(true);
    expect(SUBSTANTIVE_TYPES_LEGACY.has('decision')).toBe(true);
    expect(SUBSTANTIVE_TYPES_LEGACY.has('observation')).toBe(false);
    expect(SUBSTANTIVE_TYPES_LEGACY.has('hot_file')).toBe(false);
  });

  it('SUBSTANTIVE_KINDS_V17 contains V17-specific kinds and excludes observation', () => {
    expect(SUBSTANTIVE_KINDS_V17.has('mental_model')).toBe(true);
    expect(SUBSTANTIVE_KINDS_V17.has('directive_rule')).toBe(true);
    expect(SUBSTANTIVE_KINDS_V17.has('angel_opinion')).toBe(true);
    expect(SUBSTANTIVE_KINDS_V17.has('experience_pattern')).toBe(true);
    expect(SUBSTANTIVE_KINDS_V17.has('observation')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. substantiveSqlClause — SQL fragment structural tests
// ---------------------------------------------------------------------------

describe('substantiveSqlClause — SQL fragment', () => {
  it('returns a non-empty string', () => {
    const clause = substantiveSqlClause('a');
    expect(typeof clause).toBe('string');
    expect(clause.length).toBeGreaterThan(0);
  });

  it('uses the supplied alias at every column reference', () => {
    const clause = substantiveSqlClause('myalias');
    // Every column reference should use 'myalias.'
    expect(clause).toContain('myalias.');
    // Should not contain the default 'a.' alias when a different one is supplied
    // (this is a soft check — allow 'a' inside string literals like 'angel_opinion')
    const withoutStringLiterals = clause.replace(/'[^']*'/g, "''");
    expect(withoutStringLiterals).not.toContain(' a.');
  });

  it('is deterministic — same alias → same output', () => {
    const c1 = substantiveSqlClause('artifacts');
    const c2 = substantiveSqlClause('artifacts');
    expect(c1).toBe(c2);
  });

  it('different aliases produce different but structurally equivalent clauses', () => {
    const c1 = substantiveSqlClause('a');
    const c2 = substantiveSqlClause('b');
    expect(c1).not.toBe(c2);
    // Same structure just with different alias prefix
    expect(c1.replace(/\ba\./g, 'b.')).toBe(c2);
  });

  it('throws on empty alias', () => {
    expect(() => substantiveSqlClause('')).toThrow(/non-empty/);
  });

  it('throws on whitespace-only alias', () => {
    expect(() => substantiveSqlClause('   ')).toThrow(/non-empty/);
  });

  it('throws on alias with special characters (SQL injection guard)', () => {
    expect(() => substantiveSqlClause("a; DROP TABLE artifacts; --")).toThrow(/invalid/i);
  });

  it('throws on alias with spaces', () => {
    expect(() => substantiveSqlClause('my alias')).toThrow(/invalid/i);
  });

  it('allows qualified aliases (table.column prefix style)', () => {
    // Some callers may use 'artifacts' as a full table name
    expect(() => substantiveSqlClause('artifacts')).not.toThrow();
  });

  it('clause contains noise-prefix GLOB conditions', () => {
    const clause = substantiveSqlClause('a');
    expect(clause).toContain("GLOB 'Read: *'");
    expect(clause).toContain("GLOB 'Edit: *'");
    expect(clause).toContain("GLOB 'Bash: *'");
  });

  it('clause contains observation gate with importance and length', () => {
    const clause = substantiveSqlClause('a');
    expect(clause).toContain('importance >= 4');
    expect(clause).toContain('LENGTH(');
    expect(clause).toContain('>= 60');
  });

  it('clause contains certified-substantive legacy type list (no V17 kinds — legacy table only)', () => {
    const clause = substantiveSqlClause('a');
    // Legacy types that must be present
    expect(clause).toContain("'learning'");
    expect(clause).toContain("'decision'");
    expect(clause).toContain("'memory_file'");
    expect(clause).toContain("'handoff'");
    // V17 kinds are JS-only; the SQL clause targets the legacy artifacts table
    // which does not have a `kind` column. Document this intentional design:
    expect(clause).not.toContain("'mental_model'");
    expect(clause).not.toContain("'angel_opinion'");
  });
});

// ---------------------------------------------------------------------------
// 3. JS ↔ SQL lockstep
// ---------------------------------------------------------------------------

/**
 * Seeds a temporary :memory: SQLite table with the fixture rows and verifies
 * that the SQL clause selects exactly the same rows as `isSubstantive()`.
 *
 * This is the contract guarantor: any change to either the JS predicate or
 * the SQL clause that causes divergence will fail this test.
 *
 * Scope note: `substantiveSqlClause` targets the legacy `artifacts` table
 * which has `artifact_type` but NOT `kind`. The lockstep test therefore only
 * includes fixtures that use `artifact_type` (legacy schema). Fixtures with
 * only `kind` set (V17-style rows like mental_model, angel_opinion) are
 * tested in the JS truth-table describe block above; the SQL clause does not
 * cover them because it cannot reference the V17 `kind` column.
 */
describe('JS ↔ SQL lockstep', () => {
  /**
   * Fixtures that can be represented in the legacy artifacts schema.
   * These have `artifact_type` set (not V17-kind-only).
   */
  const LEGACY_FIXTURES = FIXTURES.filter(f => f.artifact_type !== undefined);

  function buildLockstepDb(): Database.Database {
    const db = new Database(':memory:');
    // Create a minimal test_artifacts table matching the legacy artifacts shape.
    // Note: no `kind` column — legacy schema only.
    db.exec(`
      CREATE TABLE test_artifacts (
        id INTEGER PRIMARY KEY,
        artifact_type TEXT,
        summary TEXT,
        importance INTEGER
      )
    `);
    return db;
  }

  it('JS predicate and SQL clause agree on all legacy-schema fixture rows', () => {
    const db = buildLockstepDb();

    // Insert legacy-compatible fixtures.
    const insert = db.prepare(
      `INSERT INTO test_artifacts (id, artifact_type, summary, importance)
       VALUES (?, ?, ?, ?)`
    );

    for (const f of LEGACY_FIXTURES) {
      insert.run(
        f.id,
        f.artifact_type ?? null,
        f.summary ?? null,
        f.importance ?? null,
      );
    }

    // Run SQL query with substantiveSqlClause.
    const clause = substantiveSqlClause('test_artifacts');
    const sqlRows = db.prepare(
      `SELECT id FROM test_artifacts WHERE ${clause}`
    ).all() as Array<{ id: number }>;

    const sqlIds = new Set(sqlRows.map(r => r.id));

    // Compute expected IDs from JS predicate (same input as SQL).
    const jsIds = new Set(
      LEGACY_FIXTURES.filter(f => isSubstantive(f)).map(f => f.id)
    );

    // Both sets must match exactly.
    const sqlOnly = [...sqlIds].filter(id => !jsIds.has(id));
    const jsOnly = [...jsIds].filter(id => !sqlIds.has(id));

    expect(sqlOnly).toEqual(
      [],
      `SQL selected IDs that JS rejected: ${sqlOnly.join(', ')}`
    );
    expect(jsOnly).toEqual(
      [],
      `JS selected IDs that SQL rejected: ${jsOnly.join(', ')}`
    );

    // Double-check: both sets are equal.
    expect(sqlIds).toEqual(jsIds);

    db.close();
  });

  it('adding a row with a new noise prefix is rejected by both JS and SQL', () => {
    const db = buildLockstepDb();
    db.prepare(
      `INSERT INTO test_artifacts (id, artifact_type, summary, importance)
       VALUES (999, 'learning', 'Glob: src/**/*.ts', 5)`
    ).run();

    // JS predicate: Glob: prefix is rejected
    expect(isSubstantive({ artifact_type: 'learning', summary: 'Glob: src/**/*.ts', importance: 5 })).toBe(false);

    // SQL clause: same rejection
    const clause = substantiveSqlClause('test_artifacts');
    const rows = db.prepare(
      `SELECT id FROM test_artifacts WHERE ${clause}`
    ).all() as Array<{ id: number }>;
    expect(rows.map(r => r.id)).not.toContain(999);

    db.close();
  });

  it('substantive observation passes both JS and SQL', () => {
    const db = buildLockstepDb();
    const longSummary = 'The cascade failure was traced to a stale connection pool in the bet365 integration layer, caused by a network partition event at 22:00 UTC that was not properly handled.';
    expect(longSummary.length).toBeGreaterThan(60);

    db.prepare(
      `INSERT INTO test_artifacts (id, artifact_type, summary, importance)
       VALUES (998, 'observation', ?, 4)`
    ).run(longSummary);

    // JS predicate: should pass
    expect(isSubstantive({ artifact_type: 'observation', summary: longSummary, importance: 4 })).toBe(true);

    // SQL clause: should include this row
    const clause = substantiveSqlClause('test_artifacts');
    const rows = db.prepare(
      `SELECT id FROM test_artifacts WHERE ${clause}`
    ).all() as Array<{ id: number }>;
    expect(rows.map(r => r.id)).toContain(998);

    db.close();
  });
});
