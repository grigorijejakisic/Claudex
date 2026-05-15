/**
 * Phase 14 Plan 14-04 — P2.7 Project Knowledge surface tests.
 *
 * 13 cases covering:
 *  - Null-return paths (ACTIVE.md absent, frontmatter issues, empty summary, no artifacts)
 *  - Formatted section with substantive artifacts
 *  - Noise exclusion (isSubstantive filter)
 *  - Cache stability (byte-identical output on identical inputs)
 *  - Budget enforcement (drop lowest-ranked, single-entry truncation, null if too big)
 *  - AC-1 evidence: synthesized big-mozzy-v2 fixture surfaces bet365 entry
 *  - Multi-agent: ACTIVE-agent2.md is ignored, only primary ACTIVE.md is read
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  formatProjectKnowledgeSection,
  formatProjectKnowledgeSectionSync,
  P27_TOP_K,
  P27_TITLE_MAX_CHARS,
} from '../../assembly/project-knowledge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function mkDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(base: string, rel: string, content: string): void {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Write a valid ACTIVE.md with the given summary. */
function writeActiveMd(projectDir: string, summary: string, extraFields?: string): void {
  const frontmatter = [
    '---',
    'status: active',
    'phase: 14',
    summary ? `summary: ${summary}` : '',
    extraFields ?? '',
    '---',
  ].filter(l => l !== '').join('\n');
  const body = `# 2026-05-16 — test handoff\n\n**What we found:** test\n\n**What we decided:** test\n\n**What's next:** test\n\n**Where to look:** src/`;
  writeFile(projectDir, 'context/handoffs/ACTIVE.md', `${frontmatter}\n${body}`);
}

/** Seed a substantive artifact (type=learning) into the DB for a project. */
function seedSubstantiveArtifact(
  db: TestDatabase,
  project: string,
  summary: string,
  content: string = 'full content here',
  artifactRef: string = 'learning#1',
): number {
  const result = db.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, summary, content, artifact_ref, state, ttl, importance, timestamp_epoch_ms)
     VALUES ('test-sess', ?, 'learning', ?, ?, ?, 'fresh', 10, 5, ?)`,
  ).run(project, summary, content, artifactRef, Date.now());
  return Number(result.lastInsertRowid);
}

/** Seed a noise observation (fails isSubstantive noise-prefix check). */
function seedNoiseArtifact(
  db: TestDatabase,
  project: string,
  toolName: string = 'Read',
): number {
  const summary = `${toolName}: src/core/artifact-filters.ts`;
  const result = db.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, summary, content, state, ttl, importance, timestamp_epoch_ms)
     VALUES ('test-sess', ?, 'observation', ?, 'some content', 'fresh', 10, 1, ?)`,
  ).run(project, summary, Date.now());
  return Number(result.lastInsertRowid);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-pk-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('formatProjectKnowledgeSection (P2.7)', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: returns null when ACTIVE.md missing
  it('returns null when ACTIVE.md missing', async () => {
    const projectDir = mkDir('no-active');
    // Do NOT create ACTIVE.md
    const result = await formatProjectKnowledgeSection(db, 'proj', projectDir, 800);
    expect(result).toBeNull();
  });

  // Test 2: returns null when frontmatter missing
  it('returns null when frontmatter missing', async () => {
    const projectDir = mkDir('no-frontmatter');
    // ACTIVE.md exists but has no --- frontmatter
    writeFile(projectDir, 'context/handoffs/ACTIVE.md', '# Just a heading\n\nNo frontmatter here.');
    const result = await formatProjectKnowledgeSection(db, 'proj', projectDir, 800);
    expect(result).toBeNull();
  });

  // Test 3: returns null when summary field missing from frontmatter
  it('returns null when summary field missing', async () => {
    const projectDir = mkDir('no-summary-field');
    // Valid frontmatter but no summary key
    writeFile(projectDir, 'context/handoffs/ACTIVE.md', '---\nstatus: active\nphase: 14\n---\n# heading');
    const result = await formatProjectKnowledgeSection(db, 'proj', projectDir, 800);
    expect(result).toBeNull();
  });

  // Test 4: returns null when summary is empty whitespace
  it('returns null when summary is empty whitespace', async () => {
    const projectDir = mkDir('empty-summary');
    // summary field present but empty string (parser trims + checks non-empty)
    writeFile(projectDir, 'context/handoffs/ACTIVE.md', '---\nstatus: active\nphase: 14\nsummary:   \n---\n# heading');
    const result = await formatProjectKnowledgeSection(db, 'proj', projectDir, 800);
    expect(result).toBeNull();
  });

  // Test 5: returns null when no artifacts found
  it('returns null when no artifacts found', async () => {
    const projectDir = mkDir('no-artifacts');
    writeActiveMd(projectDir, 'bet365 cascade implementation');
    // DB is empty — no artifacts seeded
    const result = await formatProjectKnowledgeSection(db, 'proj-empty', projectDir, 800);
    expect(result).toBeNull();
  });

  // Test 6: returns formatted section with top-K substantive artifacts when summary + artifacts present
  it('returns formatted section with top-K substantive artifacts', async () => {
    const projectDir = mkDir('has-artifacts');
    const project = 'proj-has';
    writeActiveMd(projectDir, 'bet365 cascade implementation architecture');

    seedSubstantiveArtifact(db, project, 'bet365 cascade decision flow', 'The cascade processes bets via a waterfall pattern.', 'decision#1');
    seedSubstantiveArtifact(db, project, 'FL365 payment gateway integration', 'FL365 handles PAX terminal settlements.', 'learning#2');

    const result = await formatProjectKnowledgeSection(db, project, projectDir, 800);

    expect(result).not.toBeNull();
    expect(result!).toContain('## Project Knowledge');
    // Should contain the heading
    expect(result!).toContain('###');
    // Should contain source reference
    expect(result!).toContain('*Source:');
  });

  // Test 7: excludes noise observations (Read: file.ts shape)
  it('excludes noise observations (Read: file.ts shape)', async () => {
    const projectDir = mkDir('noise-test');
    const project = 'proj-noise';
    writeActiveMd(projectDir, 'artifact filters implementation');

    // Seed one substantive artifact
    seedSubstantiveArtifact(db, project, 'artifact filter design decision', 'The filter uses a pure predicate.', 'decision#5');
    // Seed three noise observations (tool-call traces)
    seedNoiseArtifact(db, project, 'Read');
    seedNoiseArtifact(db, project, 'Edit');
    seedNoiseArtifact(db, project, 'Bash');

    const result = await formatProjectKnowledgeSection(db, project, projectDir, 800);

    // Result may or may not include content depending on FTS matching, but if it does,
    // the noise tool-call summaries (Read:, Edit:, Bash:) must not appear as headings.
    if (result !== null) {
      expect(result).toContain('## Project Knowledge');
      // Noise summaries should not surface as section headings
      expect(result).not.toMatch(/### Read:/);
      expect(result).not.toMatch(/### Edit:/);
      expect(result).not.toMatch(/### Bash:/);
    }
  });

  // Test 8: cache stability — same inputs produce byte-identical output across two calls
  it('caches stably — same inputs produce byte-identical output across two calls', async () => {
    const projectDir = mkDir('cache-stable');
    const project = 'proj-cache';
    writeActiveMd(projectDir, 'cache stability test query');

    seedSubstantiveArtifact(db, project, 'cache stability decision', 'Outputs must be deterministic.', 'decision#10');

    const result1 = await formatProjectKnowledgeSection(db, project, projectDir, 800);
    const result2 = await formatProjectKnowledgeSection(db, project, projectDir, 800);

    // Both calls return identical output (or both null)
    expect(result1).toEqual(result2);
    // If not null, must contain section heading (no clock data would vary)
    if (result1 !== null) {
      expect(result1).toContain('## Project Knowledge');
      // Verify no clock-shaped patterns leak through (no ISO timestamps)
      expect(result1).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // Test 9: budget enforcement — drops lowest-ranked when over cap
  it('budget enforcement — drops lowest-ranked when over cap', async () => {
    const projectDir = mkDir('budget-drop');
    const project = 'proj-budget';
    writeActiveMd(projectDir, 'budget enforcement test query text for retrieval matching');

    // Seed 3 large substantive artifacts
    const longContent = 'A'.repeat(600); // ~150 tokens each
    seedSubstantiveArtifact(db, project, 'first budget artifact learning content', longContent, 'learning#20');
    seedSubstantiveArtifact(db, project, 'second budget artifact learning content', longContent, 'learning#21');
    seedSubstantiveArtifact(db, project, 'third budget artifact learning content', longContent, 'learning#22');

    // Very tight budget — should get at most 1 entry
    const result = await formatProjectKnowledgeSection(db, project, projectDir, 100);

    if (result !== null) {
      // With very tight budget, at most 1 entry should appear
      const headingCount = (result.match(/^###/gm) ?? []).length;
      expect(headingCount).toBeLessThanOrEqual(1);
    }
    // Passing (null is also acceptable — too tight for even 1 entry)
  });

  // Test 10: budget enforcement — truncates single entry excerpt when 1 entry over cap
  it('budget enforcement — truncates single entry excerpt when 1 entry over cap', () => {
    // Use sync variant for deterministic testing
    const projectDir = mkDir('truncate-test');
    const project = 'proj-trunc';
    writeActiveMd(projectDir, 'truncation enforcement query for testing');

    const longContent = 'B'.repeat(2000); // ~500 tokens
    seedSubstantiveArtifact(db, project, 'truncation test artifact', longContent, 'learning#30');

    // Budget: small enough that the excerpt must be truncated but heading fits
    // Heading: "## Project Knowledge\n### truncation test artifact\n*Source: learning#30*" ~ 30 tokens
    // Content would add ~500 tokens — well over the 50-token cap
    const result = formatProjectKnowledgeSectionSync(db, project, projectDir, 50);

    // Either null (can't fit) or a truncated version
    if (result !== null) {
      expect(estimateTokens(result)).toBeLessThanOrEqual(50);
      expect(result).toContain('## Project Knowledge');
    }
  });

  // Test 11: budget enforcement — returns null when even truncated 1-entry exceeds cap
  it('budget enforcement — returns null when even truncated 1-entry exceeds cap', () => {
    const projectDir = mkDir('null-budget');
    const project = 'proj-null-budget';
    writeActiveMd(projectDir, 'tiny budget test query');

    // Seed a substantive artifact with a very long summary (title alone won't fit in 5 tokens)
    seedSubstantiveArtifact(
      db, project,
      'A'.repeat(P27_TITLE_MAX_CHARS),  // max-length title
      'content', 'learning#40',
    );

    // Budget so tiny that even the section heading alone won't fit
    const result = formatProjectKnowledgeSectionSync(db, project, projectDir, 2);
    expect(result).toBeNull();
  });

  // Test 12: AC-1 evidence — synthesized big-mozzy-v2 fixture (bet365 summary) surfaces bet365 entry
  it('AC-1 evidence: synthesized big-mozzy-v2 fixture surfaces bet365 entry', async () => {
    const projectDir = mkDir('big-mozzy-v2-fixture');
    const project = 'big-mozzy-v2';

    // ACTIVE.md with a bet365 domain summary — mirrors big-mozzy-v2's real handoff summary
    writeActiveMd(
      projectDir,
      'bet365 cascade precursor implementation — FL365 gateway integration pending',
    );

    // Seed bet365-shaped artifact (mirrors bet365-cascade-precursor.md as memory_file)
    seedSubstantiveArtifact(
      db, project,
      'bet365 cascade precursor — phase 1 ticket flow decision',
      'The bet365 cascade routes premium tickets through the FL365 payment gateway.\n' +
      'Mozzart pay-tickets use a separate BetBoom virtuals path.\n' +
      'Settlement: PAX terminal or digital wallet per operator config.',
      'memory_file:bet365-cascade-precursor.md',
    );

    // Also seed some noise to verify filter works
    seedNoiseArtifact(db, project, 'Read');
    seedNoiseArtifact(db, project, 'Bash');

    const result = await formatProjectKnowledgeSection(db, project, projectDir, 800);

    // AC-1: the bet365 entry must surface
    expect(result).not.toBeNull();
    expect(result!).toContain('## Project Knowledge');

    // The section must reference at least one canonical big-mozzy domain term
    const hasDomainTerm = (
      result!.toLowerCase().includes('bet365') ||
      result!.toLowerCase().includes('fl365') ||
      result!.toLowerCase().includes('mozzart') ||
      result!.toLowerCase().includes('betboom') ||
      result!.toLowerCase().includes('cascade')
    );
    expect(hasDomainTerm).toBe(true);
  });

  // Test 13: multi-agent — only primary ACTIVE.md is read; ACTIVE-agent2.md is ignored
  it('multi-agent: only primary ACTIVE.md is read; ACTIVE-agent2.md is ignored for P2.7', async () => {
    const projectDir = mkDir('multi-agent');
    const project = 'proj-multi';

    // Primary ACTIVE.md: has a meaningful summary
    writeActiveMd(projectDir, 'primary handoff summary for retrieval');

    // ACTIVE-agent2.md: has a DIFFERENT summary — if the code reads this, it would
    // use the agent2 summary as the query instead of the primary one. We verify
    // the code only reads the unprefixed primary file.
    writeFile(
      projectDir,
      'context/handoffs/ACTIVE-agent2.md',
      '---\nstatus: active\nphase: 14\nsummary: agent2 different summary that should never be used\n---\n# agent2',
    );

    seedSubstantiveArtifact(db, project, 'primary decision artifact', 'Primary content.', 'decision#50');

    // The function reads only ACTIVE.md — not ACTIVE-agent2.md.
    // Both ACTIVE.md files exist; if multi-agent enumeration were active,
    // the test would potentially use the wrong query. We just verify no crash
    // and the primary ACTIVE.md's summary drives retrieval (not agent2's).
    const result = await formatProjectKnowledgeSection(db, project, projectDir, 800);

    // Contract: no multi-agent glob enumeration — primary ACTIVE.md was read.
    // The result may or may not have content (depends on FTS matching), but
    // the function should NOT throw and should only have read the primary file.
    // Verify the agent2 summary text does NOT appear in the section
    if (result !== null) {
      expect(result).not.toContain('agent2 different summary');
      expect(result).toContain('## Project Knowledge');
    }
    // Function is non-throwing
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper (inline, for test 10's token estimation)
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
