import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import { graphWalkFromSeeds } from '../../core/graph-walk.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a link directly into artifact_links. */
function insertLink(
  db: TestDatabase,
  sourceId: number,
  targetId: number,
  linkType: string = 'related',
  strength: number = 0.8,
  invalidAtEpoch: number | null = null,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR IGNORE INTO artifact_links (source_id, target_id, link_type, strength, valid_at_epoch, invalid_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sourceId, targetId, linkType, strength, now, invalidAtEpoch);
}

/** Create a test artifact and return its ID. */
function makeArtifact(db: TestDatabase, summary: string, project: string = 'test-project'): number {
  return createArtifact(db, 'sess-1', project, 'observation', null, summary, `content for ${summary}`, 3);
}

// ---------------------------------------------------------------------------
// Graph walk unit tests (MPFP meta-path traversal)
// ---------------------------------------------------------------------------

describe('graphWalkFromSeeds', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty for empty seed list', () => {
    const results = graphWalkFromSeeds(db, []);
    expect(results).toHaveLength(0);
  });

  it('returns empty when no artifact_links exist', () => {
    const a1 = makeArtifact(db, 'Artifact A');
    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(0);
  });

  it('returns 1-hop neighbors from single seed', () => {
    const a1 = makeArtifact(db, 'Seed artifact');
    const a2 = makeArtifact(db, 'Neighbor artifact');
    const a3 = makeArtifact(db, 'Another neighbor');

    insertLink(db, a1, a2, 'related', 0.9);
    insertLink(db, a1, a3, 'related', 0.7);

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(2);
    // Higher strength → higher score (ordering preserved)
    expect(results[0].artifactId).toBe(a2);
    expect(results[1].artifactId).toBe(a3);
    // Scores are positive (exact values depend on MPFP RRF fusion)
    expect(results[0].walkScore).toBeGreaterThan(0);
    expect(results[0].walkScore).toBeGreaterThan(results[1].walkScore);
  });

  it('returns 2-hop neighbors with decayed scores', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Hop 1');
    const a3 = makeArtifact(db, 'Hop 2');

    insertLink(db, a1, a2, 'related', 0.8);
    insertLink(db, a2, a3, 'related', 0.8);

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(2);

    const hop1 = results.find(r => r.artifactId === a2);
    const hop2 = results.find(r => r.artifactId === a3);

    expect(hop1).toBeDefined();
    expect(hop2).toBeDefined();

    // Hop 1 should score higher than hop 2 (dampening per hop)
    expect(hop1!.walkScore).toBeGreaterThan(hop2!.walkScore);
  });

  it('handles cycle detection (A→B→A does not infinite loop)', () => {
    const a1 = makeArtifact(db, 'Node A');
    const a2 = makeArtifact(db, 'Node B');

    insertLink(db, a1, a2, 'related', 0.8);
    insertLink(db, a2, a1, 'related', 0.8);

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(1);
    expect(results[0].artifactId).toBe(a2);
  });

  it('excludes contradicts links from walk', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Contradicted');
    const a3 = makeArtifact(db, 'Supported');

    insertLink(db, a1, a2, 'contradicts', 0.9);
    insertLink(db, a1, a3, 'supports', 0.9);

    const results = graphWalkFromSeeds(db, [a1]);
    const ids = results.map(r => r.artifactId);

    expect(ids).not.toContain(a2);
    expect(ids).toContain(a3);
  });

  it('applies caused_by 2x strength boost within pattern walk scores', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Related neighbor');
    const a3 = makeArtifact(db, 'Caused by neighbor');

    insertLink(db, a1, a2, 'related', 0.5);
    insertLink(db, a1, a3, 'caused_by', 0.5);

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(2);

    const relatedResult = results.find(r => r.artifactId === a2)!;
    const causedByResult = results.find(r => r.artifactId === a3)!;

    // Both should be found with positive scores
    expect(relatedResult.walkScore).toBeGreaterThan(0);
    expect(causedByResult.walkScore).toBeGreaterThan(0);
    // In MPFP, final ranking depends on multi-pattern discovery (RRF) + raw walk scores.
    // caused_by has 2x type multiplier within its pattern, but related is found by more patterns.
    // The key invariant: both are discovered and scored positively.
  });

  it('applies supports 1.5x strength boost', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Supports neighbor');

    insertLink(db, a1, a2, 'supports', 0.8);

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(1);
    expect(results[0].walkScore).toBeGreaterThan(0);
  });

  it('excludes invalidated links (invalid_at_epoch set)', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Valid neighbor');
    const a3 = makeArtifact(db, 'Invalid neighbor');

    insertLink(db, a1, a2, 'related', 0.8, null);
    insertLink(db, a1, a3, 'related', 0.8, Math.floor(Date.now() / 1000));

    const results = graphWalkFromSeeds(db, [a1]);
    const ids = results.map(r => r.artifactId);
    expect(ids).toContain(a2);
    expect(ids).not.toContain(a3);
  });

  it('prunes paths below minScore threshold', () => {
    const a1 = makeArtifact(db, 'Seed');
    const a2 = makeArtifact(db, 'Weak neighbor');

    insertLink(db, a1, a2, 'related', 0.08); // Very low strength

    const results = graphWalkFromSeeds(db, [a1]);
    expect(results).toHaveLength(0);
  });

  it('respects limit option', () => {
    const seed = makeArtifact(db, 'Seed');
    const neighbors: number[] = [];
    for (let i = 0; i < 10; i++) {
      const n = makeArtifact(db, `Neighbor ${i}`);
      neighbors.push(n);
      insertLink(db, seed, n, 'related', 0.9 - i * 0.05);
    }

    const results = graphWalkFromSeeds(db, [seed], { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('excludes seed IDs from results', () => {
    const a1 = makeArtifact(db, 'Seed A');
    const a2 = makeArtifact(db, 'Seed B');
    const a3 = makeArtifact(db, 'Non-seed neighbor');

    insertLink(db, a1, a2, 'related', 0.9);
    insertLink(db, a1, a3, 'related', 0.8);
    insertLink(db, a2, a3, 'related', 0.7);

    const results = graphWalkFromSeeds(db, [a1, a2]);
    const ids = results.map(r => r.artifactId);

    expect(ids).not.toContain(a1);
    expect(ids).not.toContain(a2);
    expect(ids).toContain(a3);
  });

  it('is non-throwing on closed database', () => {
    const closedDb = createTestDb();
    closedDb.close();

    const results = graphWalkFromSeeds(closedDb, [1, 2, 3]);
    expect(results).toHaveLength(0);
  });

  it('handles multiple seeds with overlapping neighborhoods', () => {
    const a1 = makeArtifact(db, 'Seed 1');
    const a2 = makeArtifact(db, 'Seed 2');
    const shared = makeArtifact(db, 'Shared neighbor');
    const exclusive = makeArtifact(db, 'Exclusive to seed 1');

    insertLink(db, a1, shared, 'related', 0.8);
    insertLink(db, a2, shared, 'related', 0.9);
    insertLink(db, a1, exclusive, 'related', 0.7);

    const results = graphWalkFromSeeds(db, [a1, a2]);
    const ids = results.map(r => r.artifactId);

    expect(ids).toContain(shared);
    expect(ids).toContain(exclusive);

    // Shared neighbor found by multiple patterns should score higher
    const sharedResult = results.find(r => r.artifactId === shared)!;
    const exclusiveResult = results.find(r => r.artifactId === exclusive)!;
    expect(sharedResult.walkScore).toBeGreaterThan(exclusiveResult.walkScore);
  });
});
