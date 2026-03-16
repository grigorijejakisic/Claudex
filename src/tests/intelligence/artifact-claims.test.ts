/**
 * Tests for artifact-claims: retrieved-set coordination for parallel workers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  claimArtifacts,
  getUnclaimedArtifactIds,
  releaseAllClaims,
  expireStaleClaims,
} from '../../intelligence/artifact-claims.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: TestDatabase;
let sessionId: string;
let project: string;

function setup() {
  const result = createTestDbWithSession('sess-1', 'proj-a');
  db = result.db;
  sessionId = result.sessionId;
  project = result.project;
}

/** Creates an artifact and returns its id as a string (artifact_claims uses TEXT ids). */
function makeArtifact(importance: number = 3): string {
  const id = createArtifact(db, sessionId, project, 'observation', null, 'summary', 'content', importance);
  return String(id);
}

function getClaim(artifactId: string, workerId: string) {
  return db.prepare(
    'SELECT * FROM artifact_claims WHERE artifact_id = ? AND worker_id = ?'
  ).get(artifactId, workerId) as
    | { artifact_id: string; worker_id: string; claimed_at_epoch: number; ttl_seconds: number }
    | undefined;
}

function insertClaim(
  artifactId: string,
  workerId: string,
  claimedAtEpoch: number,
  ttlSeconds: number = 300,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO artifact_claims (artifact_id, worker_id, claimed_at_epoch, ttl_seconds)
     VALUES (?, ?, ?, ?)`
  ).run(artifactId, workerId, claimedAtEpoch, ttlSeconds);
}

// ---------------------------------------------------------------------------
// claimArtifacts
// ---------------------------------------------------------------------------

describe('claimArtifacts', () => {
  beforeEach(setup);
  afterEach(() => { db.close(); });

  it('successfully claims unclaimed artifacts — returns all IDs', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    const claimed = claimArtifacts(db, [id1, id2], 'worker-1');
    expect(claimed).toHaveLength(2);
    expect(claimed).toContain(id1);
    expect(claimed).toContain(id2);
  });

  it('stores claim rows in artifact_claims table', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-1');
    const row = getClaim(id, 'worker-1');
    expect(row).toBeDefined();
    expect(row!.worker_id).toBe('worker-1');
    expect(row!.ttl_seconds).toBe(300); // default
  });

  it('does not claim artifacts already claimed by another worker', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-1');
    const claimed = claimArtifacts(db, [id], 'worker-2');
    expect(claimed).toHaveLength(0);
    // Original claimant unchanged
    expect(getClaim(id, 'worker-1')).toBeDefined();
    expect(getClaim(id, 'worker-2')).toBeUndefined();
  });

  it('claims artifact when existing claim by another worker has expired', () => {
    const id = makeArtifact();
    const pastEpoch = Math.floor(Date.now() / 1000) - 400; // 400s ago, TTL=300 → expired
    insertClaim(id, 'worker-old', pastEpoch, 300);

    const claimed = claimArtifacts(db, [id], 'worker-new');
    expect(claimed).toContain(id);
    expect(getClaim(id, 'worker-new')).toBeDefined();
    expect(getClaim(id, 'worker-old')).toBeUndefined();
  });

  it('renews claim for same worker — returns id and updates row', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-1');
    const first = getClaim(id, 'worker-1')!;

    const claimed = claimArtifacts(db, [id], 'worker-1');
    expect(claimed).toContain(id);
    const second = getClaim(id, 'worker-1')!;
    expect(second.claimed_at_epoch).toBeGreaterThanOrEqual(first.claimed_at_epoch);
  });

  it('uses custom TTL when provided', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-1', 120);
    expect(getClaim(id, 'worker-1')!.ttl_seconds).toBe(120);
  });

  it('returns empty array for empty input', () => {
    expect(claimArtifacts(db, [], 'worker-1')).toEqual([]);
  });

  it('partially claims — skips already-claimed, returns only newly claimed', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    const id3 = makeArtifact();

    claimArtifacts(db, [id1, id2], 'worker-1'); // claim 1 and 2
    const claimed = claimArtifacts(db, [id1, id2, id3], 'worker-2');
    // id1 and id2 are claimed by worker-1; only id3 should be claimed by worker-2
    expect(claimed).toEqual([id3]);
  });

  it('is non-throwing on DB error — returns []', () => {
    db.close();
    expect(() => claimArtifacts(db, ['1'], 'worker-1')).not.toThrow();
    expect(claimArtifacts(db, ['1'], 'worker-1')).toEqual([]);
    db = createTestDbWithSession().db;
  });
});

// ---------------------------------------------------------------------------
// getUnclaimedArtifactIds
// ---------------------------------------------------------------------------

describe('getUnclaimedArtifactIds', () => {
  beforeEach(setup);
  afterEach(() => { db.close(); });

  it('returns all artifact IDs when nothing is claimed', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).toContain(id1);
    expect(unclaimed).toContain(id2);
  });

  it('excludes artifacts with active claims', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    claimArtifacts(db, [id1], 'worker-1');
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).not.toContain(id1);
    expect(unclaimed).toContain(id2);
  });

  it('includes artifacts whose claims have expired', () => {
    const id = makeArtifact();
    const pastEpoch = Math.floor(Date.now() / 1000) - 400;
    insertClaim(id, 'worker-old', pastEpoch, 300);
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).toContain(id);
  });

  it('returns empty array when all artifacts are claimed', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    claimArtifacts(db, [id1, id2], 'worker-1');
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).toHaveLength(0);
  });

  it('returns empty array when no artifacts exist for the project', () => {
    const unclaimed = getUnclaimedArtifactIds(db, 'nonexistent-project');
    expect(unclaimed).toEqual([]);
  });

  it('only returns artifacts scoped to the given project', () => {
    // Artifacts for project-a and project-b in same DB
    const { db: db2, sessionId: sid2 } = createTestDbWithSession('sess-b', 'proj-b');
    // Use the same db instance (test-db creates :memory: — need to share)
    const idA = makeArtifact(); // in project 'proj-a'
    const idB = String(createArtifact(db, sid2, 'proj-b', 'observation', null, 'b-summary', null, 3));
    db2.close();

    const unclaimedA = getUnclaimedArtifactIds(db, project);
    expect(unclaimedA).toContain(idA);
    // idB was inserted into db2 which is a separate :memory: DB — idB doesn't exist in db.
    // This test just verifies isolation by confirming idA is present.
    expect(unclaimedA).not.toContain(idB);
  });

  it('is non-throwing on DB error — returns []', () => {
    db.close();
    expect(() => getUnclaimedArtifactIds(db, project)).not.toThrow();
    expect(getUnclaimedArtifactIds(db, project)).toEqual([]);
    db = createTestDbWithSession().db;
  });
});

// ---------------------------------------------------------------------------
// releaseAllClaims
// ---------------------------------------------------------------------------

describe('releaseAllClaims', () => {
  beforeEach(setup);
  afterEach(() => { db.close(); });

  it('removes all claims held by the specified worker', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    const id3 = makeArtifact();
    claimArtifacts(db, [id1, id2], 'worker-1');
    claimArtifacts(db, [id3], 'worker-2');

    releaseAllClaims(db, 'worker-1');

    expect(getClaim(id1, 'worker-1')).toBeUndefined();
    expect(getClaim(id2, 'worker-1')).toBeUndefined();
    expect(getClaim(id3, 'worker-2')).toBeDefined(); // untouched
  });

  it('after release, artifacts are unclaimed', () => {
    const id1 = makeArtifact();
    claimArtifacts(db, [id1], 'worker-1');
    releaseAllClaims(db, 'worker-1');
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).toContain(id1);
  });

  it('is a no-op when worker has no claims', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-2');
    releaseAllClaims(db, 'worker-1'); // worker-1 has nothing
    expect(getClaim(id, 'worker-2')).toBeDefined();
  });

  it('is non-throwing on DB error', () => {
    db.close();
    expect(() => releaseAllClaims(db, 'worker-1')).not.toThrow();
    db = createTestDbWithSession().db;
  });
});

// ---------------------------------------------------------------------------
// expireStaleClaims
// ---------------------------------------------------------------------------

describe('expireStaleClaims', () => {
  beforeEach(setup);
  afterEach(() => { db.close(); });

  it('deletes expired claims and returns count', () => {
    const id1 = makeArtifact();
    const id2 = makeArtifact();
    const past = Math.floor(Date.now() / 1000) - 400;
    insertClaim(id1, 'worker-1', past, 300); // expired
    insertClaim(id2, 'worker-2', past, 300); // expired

    const deleted = expireStaleClaims(db);
    expect(deleted).toBe(2);
    expect(getClaim(id1, 'worker-1')).toBeUndefined();
    expect(getClaim(id2, 'worker-2')).toBeUndefined();
  });

  it('does not delete active claims', () => {
    const id = makeArtifact();
    claimArtifacts(db, [id], 'worker-1');
    const deleted = expireStaleClaims(db);
    expect(deleted).toBe(0);
    expect(getClaim(id, 'worker-1')).toBeDefined();
  });

  it('deletes only expired claims, keeps active ones', () => {
    const idActive = makeArtifact();
    const idExpired = makeArtifact();
    const past = Math.floor(Date.now() / 1000) - 400;
    claimArtifacts(db, [idActive], 'worker-active');
    insertClaim(idExpired, 'worker-expired', past, 300);

    const deleted = expireStaleClaims(db);
    expect(deleted).toBe(1);
    expect(getClaim(idActive, 'worker-active')).toBeDefined();
    expect(getClaim(idExpired, 'worker-expired')).toBeUndefined();
  });

  it('after expiry, artifact is unclaimed and available', () => {
    const id = makeArtifact();
    const past = Math.floor(Date.now() / 1000) - 400;
    insertClaim(id, 'worker-old', past, 300);

    expireStaleClaims(db);
    const unclaimed = getUnclaimedArtifactIds(db, project);
    expect(unclaimed).toContain(id);
  });

  it('returns 0 when nothing to expire', () => {
    expect(expireStaleClaims(db)).toBe(0);
  });

  it('is non-throwing on DB error — returns 0', () => {
    db.close();
    expect(() => expireStaleClaims(db)).not.toThrow();
    expect(expireStaleClaims(db)).toBe(0);
    db = createTestDbWithSession().db;
  });
});
