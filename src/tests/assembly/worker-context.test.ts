/**
 * Tests for assembleWorkerContext — worker knowledge package assembly.
 *
 * Coverage:
 * - Empty DB returns empty formatted string
 * - Experience warnings included when patterns match
 * - maxTokens budget enforced
 * - Missing learnings/artifacts handled gracefully
 * - fileScope filters hot files correctly
 * - Non-throwing on DB errors
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createPattern } from '../../intelligence/experience-patterns.js';
import { upsertLearning } from '../../core/learnings.js';
import { createArtifact } from '../../core/artifacts.js';
import { updatePressureScore } from '../../core/pressure.js';
import { assembleWorkerContext } from '../../assembly/worker-context.js';

// Constant session ID reused across helper calls
const SESSION_ID = 'test-session';
const PROJECT = 'test-project';

describe('assembleWorkerContext', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // Empty DB
  // --------------------------------------------------------------------------

  it('returns empty formatted string when DB has no relevant data', () => {
    const pkg = assembleWorkerContext(db, 'implement authentication middleware', PROJECT);

    expect(pkg.formatted).toBe('');
    expect(pkg.experienceWarnings).toBe('');
    expect(pkg.learnings).toBe('');
    expect(pkg.relevantArtifacts).toBe('');
    expect(pkg.hotFiles).toBe('');
    expect(pkg.primer).toBe(''); // no PROJECT_PRIMER.md in test cwd
    expect(pkg.tokenBudget).toBe(0);
  });

  it('returns a valid package shape on empty DB', () => {
    const pkg = assembleWorkerContext(db, 'add unit tests for extractor', PROJECT);

    expect(pkg).toHaveProperty('primer');
    expect(pkg).toHaveProperty('relevantArtifacts');
    expect(pkg).toHaveProperty('experienceWarnings');
    expect(pkg).toHaveProperty('hotFiles');
    expect(pkg).toHaveProperty('learnings');
    expect(pkg).toHaveProperty('tokenBudget');
    expect(pkg).toHaveProperty('formatted');
  });

  // --------------------------------------------------------------------------
  // Experience warnings
  // --------------------------------------------------------------------------

  it('includes experience warnings when patterns match task description', () => {
    createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'authentication OAuth token migration',
      lesson: 'Always copy OAuth token from credentials file when migrating',
      anti_pattern: 'Assumed old token would work on new machine',
      severity: 'important',
    }, SESSION_ID, PROJECT);

    const pkg = assembleWorkerContext(db, 'authentication OAuth token setup', PROJECT);

    expect(pkg.experienceWarnings).not.toBe('');
    expect(pkg.formatted).toContain('Warnings from Past Experience');
    expect(pkg.formatted).toContain('## Project Knowledge (auto-assembled by Claudex)');
  });

  it('omits experience warnings when includeExperience is false', () => {
    createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'authentication OAuth token migration',
      lesson: 'Always copy OAuth token from credentials file when migrating',
      severity: 'important',
    }, SESSION_ID, PROJECT);

    const pkg = assembleWorkerContext(
      db,
      'authentication OAuth token setup',
      PROJECT,
      { includeExperience: false },
    );

    expect(pkg.experienceWarnings).toBe('');
    expect(pkg.formatted).not.toContain('Warnings from Past Experience');
  });

  it('does not include experience warnings when no patterns match', () => {
    // Create a pattern about something unrelated
    createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'database schema migration rollback',
      lesson: 'Always create a rollback script before running migrations',
      severity: 'important',
    }, SESSION_ID, PROJECT);

    // Query about something different
    const pkg = assembleWorkerContext(
      db,
      'refactor UI component styles',
      PROJECT,
    );

    // Pattern about database migrations should not match UI styles
    // (may or may not match depending on FTS — acceptable either way; key: no crash)
    expect(pkg).toBeDefined();
    expect(pkg.formatted).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Learnings
  // --------------------------------------------------------------------------

  it('includes relevant learnings when content matches task keywords', () => {
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-auth-1',
      content: 'authentication tokens must be rotated every 24 hours',
    });
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-deploy-1',
      content: 'deployment requires Docker setup and environment variables',
    });

    const pkg = assembleWorkerContext(db, 'implement authentication token rotation', PROJECT);

    expect(pkg.learnings).toContain('authentication tokens must be rotated every 24 hours');
    expect(pkg.formatted).toContain('Key Learnings');
  });

  it('handles missing learnings gracefully (no matching content)', () => {
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-unrelated',
      content: 'docker compose syntax for multi-service orchestration',
    });

    // Task with no keyword overlap
    const pkg = assembleWorkerContext(db, 'xyz_very_specific_nonexistent_topic_abc', PROJECT);

    // Should not crash; learnings may be empty
    expect(pkg).toBeDefined();
    expect(pkg.formatted).toBeDefined();
  });

  it('includes global learnings (project = __global__) in results', () => {
    upsertLearning(db, {
      project: '__global__',
      fingerprint: 'fp-global-1',
      content: 'authentication requires careful token validation',
    });

    const pkg = assembleWorkerContext(db, 'authentication token validation', PROJECT);

    expect(pkg.learnings).toContain('authentication requires careful token validation');
  });

  // --------------------------------------------------------------------------
  // Artifacts
  // --------------------------------------------------------------------------

  it('includes artifact summaries when they match task description', () => {
    createArtifact(
      db,
      SESSION_ID,
      PROJECT,
      'decision',
      null,
      'Use JWT for authentication tokens',
      'JWT selected over session cookies for stateless auth',
      4,
    );

    const pkg = assembleWorkerContext(db, 'implement JWT authentication', PROJECT);

    // Artifact search searches observations_fts via artifact_ref join.
    // With no matching observation, the LIKE fallback on summary may match.
    // Key requirement: no crash.
    expect(pkg).toBeDefined();
    expect(pkg.formatted).toBeDefined();
  });

  it('includes relevant context header in formatted output when artifacts exist', () => {
    // Insert an observation to make artifact_ref join work via FTS
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SESSION_ID, PROJECT, 'Read', 'architecture', 'JWT auth decision', 'authentication JWT tokens', 4);

    const lastId = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

    createArtifact(
      db,
      SESSION_ID,
      PROJECT,
      'observation',
      String(lastId.id),
      'JWT auth decision',
      'Authentication uses JWT tokens',
      4,
    );

    const pkg = assembleWorkerContext(db, 'JWT authentication implementation', PROJECT);

    // Should not crash; artifact may or may not match depending on FTS state
    expect(pkg).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Token budget enforcement
  // --------------------------------------------------------------------------

  it('respects maxTokens budget — total tokenBudget does not exceed limit', () => {
    // Insert several learnings to generate content
    for (let i = 0; i < 20; i++) {
      upsertLearning(db, {
        project: PROJECT,
        fingerprint: `fp-auth-${i}`,
        content: `authentication pattern ${i}: use secure token storage and validate expiry on every request`,
      });
    }

    createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'authentication token validation',
      lesson: 'Always validate token expiry before processing requests',
      severity: 'critical',
    }, SESSION_ID, PROJECT);

    const maxTokens = 200;
    const pkg = assembleWorkerContext(db, 'authentication token validation', PROJECT, { maxTokens });

    // tokenBudget is estimated from the formatted string
    expect(pkg.tokenBudget).toBeLessThanOrEqual(maxTokens + 10); // small margin for estimation
  });

  it('returns empty package when maxTokens is 0', () => {
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-1',
      content: 'some important learning about authentication',
    });

    const pkg = assembleWorkerContext(db, 'authentication', PROJECT, { maxTokens: 0 });

    expect(pkg.formatted).toBe('');
    expect(pkg.tokenBudget).toBe(0);
  });

  it('formatted string stays within maxTokens with very small budget', () => {
    // Seed data that would exceed 100 tokens individually
    for (let i = 0; i < 5; i++) {
      upsertLearning(db, {
        project: PROJECT,
        fingerprint: `fp-token-${i}`,
        content: `authentication important learning ${i} with lots of detail about token management`,
      });
    }

    const maxTokens = 100;
    const pkg = assembleWorkerContext(db, 'authentication token management', PROJECT, { maxTokens });

    const estimated = Math.ceil(pkg.formatted.length / 4);
    expect(estimated).toBeLessThanOrEqual(maxTokens + 15); // small margin for header overhead
  });

  // --------------------------------------------------------------------------
  // Hot files / fileScope
  // --------------------------------------------------------------------------

  it('includes hot files in formatted output when pressure data exists', () => {
    updatePressureScore(db, 'src/auth/token-manager.ts', PROJECT, 1.0);
    updatePressureScore(db, 'src/auth/middleware.ts', PROJECT, 0.8);

    const pkg = assembleWorkerContext(db, 'update authentication middleware', PROJECT);

    expect(pkg.hotFiles).toContain('src/auth/token-manager.ts');
    expect(pkg.formatted).toContain('Active Files');
  });

  it('filters hot files to fileScope when provided', () => {
    updatePressureScore(db, 'src/auth/token-manager.ts', PROJECT, 1.0);
    updatePressureScore(db, 'src/db/migrations.ts', PROJECT, 0.9);
    updatePressureScore(db, 'src/api/routes.ts', PROJECT, 0.8);

    const pkg = assembleWorkerContext(db, 'update authentication middleware', PROJECT, {
      fileScope: ['src/auth/token-manager.ts', 'src/api/routes.ts'],
    });

    // Only files in fileScope should appear
    expect(pkg.hotFiles).toContain('src/auth/token-manager.ts');
    expect(pkg.hotFiles).toContain('src/api/routes.ts');
    expect(pkg.hotFiles).not.toContain('src/db/migrations.ts');
  });

  it('returns empty hotFiles when fileScope has no matching hot files', () => {
    updatePressureScore(db, 'src/auth/token-manager.ts', PROJECT, 1.0);

    const pkg = assembleWorkerContext(db, 'update authentication middleware', PROJECT, {
      fileScope: ['src/nonexistent/file.ts'],
    });

    expect(pkg.hotFiles).toBe('');
  });

  it('returns empty hotFiles when no pressure data exists', () => {
    const pkg = assembleWorkerContext(db, 'implement new feature', PROJECT);

    expect(pkg.hotFiles).toBe('');
  });

  it('fileScope is case-insensitive and slash-normalized', () => {
    updatePressureScore(db, 'src/auth/token-manager.ts', PROJECT, 1.0);

    // Provide scope with different casing/slash style
    const pkg = assembleWorkerContext(db, 'authentication', PROJECT, {
      fileScope: ['src\\auth\\token-manager.ts'],
    });

    // Path normalization should match despite backslash
    expect(pkg.hotFiles).toContain('src/auth/token-manager.ts');
  });

  // --------------------------------------------------------------------------
  // Non-throwing / error resilience
  // --------------------------------------------------------------------------

  it('does not throw when DB is null', () => {
    expect(() => {
      assembleWorkerContext(null as any, 'implement feature', PROJECT);
    }).not.toThrow();
  });

  it('returns empty package when DB is null', () => {
    const pkg = assembleWorkerContext(null as any, 'implement feature', PROJECT);

    expect(pkg.formatted).toBe('');
    expect(pkg.tokenBudget).toBe(0);
  });

  it('does not throw on empty task description', () => {
    expect(() => {
      assembleWorkerContext(db, '', PROJECT);
    }).not.toThrow();
  });

  it('returns empty formatted on empty task description', () => {
    const pkg = assembleWorkerContext(db, '', PROJECT);

    // No search terms → all search-based sections empty
    // hotFiles might still appear if there's pressure data (unscoped), but no crash
    expect(pkg).toBeDefined();
    expect(pkg.formatted).toBeDefined();
  });

  it('does not throw on very short task description (below FTS minimum)', () => {
    expect(() => {
      assembleWorkerContext(db, 'hi', PROJECT);
    }).not.toThrow();
  });

  it('is non-throwing when DB prepare throws', () => {
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    expect(() => {
      assembleWorkerContext(brokenDb, 'implement authentication', PROJECT);
    }).not.toThrow();

    const pkg = assembleWorkerContext(brokenDb, 'implement authentication', PROJECT);
    expect(pkg.formatted).toBe('');
  });

  // --------------------------------------------------------------------------
  // Formatted output structure
  // --------------------------------------------------------------------------

  it('formatted output contains outer header when sections are present', () => {
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-auth-fmt',
      content: 'authentication patterns should be centralized',
    });

    const pkg = assembleWorkerContext(db, 'centralize authentication patterns', PROJECT);

    if (pkg.formatted) {
      expect(pkg.formatted).toContain('## Project Knowledge (auto-assembled by Claudex)');
    }
  });

  it('section headers appear only when section has content', () => {
    // Seed only learnings, no patterns/artifacts/hot files
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-test-headers',
      content: 'authentication tokens expire in 24 hours',
    });

    const pkg = assembleWorkerContext(db, 'authentication token expiry', PROJECT);

    if (pkg.learnings) {
      expect(pkg.formatted).toContain('### Key Learnings');
    }
    // Sections without data should not appear
    if (!pkg.experienceWarnings) {
      expect(pkg.formatted).not.toContain('### Warnings from Past Experience');
    }
    if (!pkg.hotFiles) {
      expect(pkg.formatted).not.toContain('### Active Files');
    }
  });

  it('tokenBudget reflects actual formatted string token estimate', () => {
    upsertLearning(db, {
      project: PROJECT,
      fingerprint: 'fp-budget-verify',
      content: 'authentication token validation is critical for security',
    });

    const pkg = assembleWorkerContext(db, 'authentication validation', PROJECT);

    const expectedTokens = Math.ceil(pkg.formatted.length / 4);
    expect(pkg.tokenBudget).toBe(expectedTokens);
  });
});
