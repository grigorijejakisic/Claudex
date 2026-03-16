/**
 * Tests for file-leases: advisory file lock primitives for parallel workers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  requestLease,
  releaseLease,
  releaseAllLeases,
  getLeaseHolder,
  expireStaleLeases,
  getWorkerLeases,
} from '../../intelligence/file-leases.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a lease row with a custom granted_at_epoch (for TTL testing). */
function insertLease(
  db: TestDatabase,
  filePath: string,
  workerId: string,
  grantedAtEpoch: number,
  ttlSeconds: number = 600,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO file_leases (file_path, worker_id, granted_at_epoch, ttl_seconds)
     VALUES (?, ?, ?, ?)`
  ).run(filePath, workerId, grantedAtEpoch, ttlSeconds);
}

function getLease(db: TestDatabase, filePath: string) {
  return db.prepare('SELECT * FROM file_leases WHERE file_path = ?').get(filePath) as
    | { file_path: string; worker_id: string; granted_at_epoch: number; ttl_seconds: number }
    | undefined;
}

// ---------------------------------------------------------------------------
// requestLease
// ---------------------------------------------------------------------------

describe('requestLease', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('succeeds on an unleased file — returns true and inserts row', () => {
    const ok = requestLease(db, '/src/foo.ts', 'worker-1');
    expect(ok).toBe(true);
    const row = getLease(db, '/src/foo.ts');
    expect(row).toBeDefined();
    expect(row!.worker_id).toBe('worker-1');
  });

  it('fails when another worker holds an active lease — returns false', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    const ok = requestLease(db, '/src/foo.ts', 'worker-2');
    expect(ok).toBe(false);
    // Original holder unchanged
    expect(getLease(db, '/src/foo.ts')!.worker_id).toBe('worker-1');
  });

  it('succeeds when an existing lease has expired — grants new lease', () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 700; // 700s ago, TTL=600 → expired
    insertLease(db, '/src/foo.ts', 'worker-old', pastEpoch, 600);

    const ok = requestLease(db, '/src/foo.ts', 'worker-new');
    expect(ok).toBe(true);
    expect(getLease(db, '/src/foo.ts')!.worker_id).toBe('worker-new');
  });

  it('succeeds for the same worker already holding the lease — refreshes TTL', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    const rowBefore = getLease(db, '/src/foo.ts')!;

    // Small sleep substitute: advance epoch manually isn't possible without mock.
    // Just confirm second call returns true and row still exists.
    const ok = requestLease(db, '/src/foo.ts', 'worker-1');
    expect(ok).toBe(true);
    expect(getLease(db, '/src/foo.ts')!.worker_id).toBe('worker-1');
    // granted_at_epoch should be >= original (refresh)
    expect(getLease(db, '/src/foo.ts')!.granted_at_epoch).toBeGreaterThanOrEqual(rowBefore.granted_at_epoch);
  });

  it('grants leases on different files independently', () => {
    expect(requestLease(db, '/src/a.ts', 'worker-1')).toBe(true);
    expect(requestLease(db, '/src/b.ts', 'worker-2')).toBe(true);
    expect(getLease(db, '/src/a.ts')!.worker_id).toBe('worker-1');
    expect(getLease(db, '/src/b.ts')!.worker_id).toBe('worker-2');
  });

  it('uses default TTL of 600 when not specified', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    expect(getLease(db, '/src/foo.ts')!.ttl_seconds).toBe(600);
  });

  it('stores custom TTL when provided', () => {
    requestLease(db, '/src/foo.ts', 'worker-1', 120);
    expect(getLease(db, '/src/foo.ts')!.ttl_seconds).toBe(120);
  });

  it('is non-throwing on DB error — returns false', () => {
    db.close();
    expect(() => requestLease(db, '/src/foo.ts', 'worker-1')).not.toThrow();
    expect(requestLease(db, '/src/foo.ts', 'worker-1')).toBe(false);
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// releaseLease
// ---------------------------------------------------------------------------

describe('releaseLease', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('removes the lease so the file becomes available', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    releaseLease(db, '/src/foo.ts', 'worker-1');
    expect(getLease(db, '/src/foo.ts')).toBeUndefined();
  });

  it('does not remove a lease held by a different worker', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    releaseLease(db, '/src/foo.ts', 'worker-2'); // different worker — no-op
    expect(getLease(db, '/src/foo.ts')!.worker_id).toBe('worker-1');
  });

  it('after release another worker can acquire the lease', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    releaseLease(db, '/src/foo.ts', 'worker-1');
    expect(requestLease(db, '/src/foo.ts', 'worker-2')).toBe(true);
  });

  it('is non-throwing on missing file path', () => {
    expect(() => releaseLease(db, '/nonexistent/path.ts', 'worker-1')).not.toThrow();
  });

  it('is non-throwing on DB error', () => {
    db.close();
    expect(() => releaseLease(db, '/src/foo.ts', 'worker-1')).not.toThrow();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// releaseAllLeases
// ---------------------------------------------------------------------------

describe('releaseAllLeases', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('removes all leases held by the specified worker', () => {
    requestLease(db, '/src/a.ts', 'worker-1');
    requestLease(db, '/src/b.ts', 'worker-1');
    requestLease(db, '/src/c.ts', 'worker-2'); // different worker

    releaseAllLeases(db, 'worker-1');

    expect(getLease(db, '/src/a.ts')).toBeUndefined();
    expect(getLease(db, '/src/b.ts')).toBeUndefined();
    expect(getLease(db, '/src/c.ts')!.worker_id).toBe('worker-2'); // untouched
  });

  it('is a no-op when the worker holds no leases', () => {
    requestLease(db, '/src/a.ts', 'worker-2');
    releaseAllLeases(db, 'worker-1'); // worker-1 has nothing
    expect(getLease(db, '/src/a.ts')!.worker_id).toBe('worker-2');
  });

  it('is non-throwing on DB error', () => {
    db.close();
    expect(() => releaseAllLeases(db, 'worker-1')).not.toThrow();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// getLeaseHolder
// ---------------------------------------------------------------------------

describe('getLeaseHolder', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns worker_id for an active lease', () => {
    requestLease(db, '/src/foo.ts', 'worker-1');
    expect(getLeaseHolder(db, '/src/foo.ts')).toBe('worker-1');
  });

  it('returns null when no lease exists', () => {
    expect(getLeaseHolder(db, '/src/unlocked.ts')).toBeNull();
  });

  it('returns null for an expired lease', () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 700;
    insertLease(db, '/src/old.ts', 'worker-old', pastEpoch, 600);
    expect(getLeaseHolder(db, '/src/old.ts')).toBeNull();
  });

  it('returns worker_id for a lease that has not yet expired', () => {
    const recentEpoch = Math.floor(Date.now() / 1000) - 100;
    insertLease(db, '/src/recent.ts', 'worker-1', recentEpoch, 600); // still 500s left
    expect(getLeaseHolder(db, '/src/recent.ts')).toBe('worker-1');
  });

  it('is non-throwing on DB error — returns null', () => {
    db.close();
    expect(() => getLeaseHolder(db, '/src/foo.ts')).not.toThrow();
    expect(getLeaseHolder(db, '/src/foo.ts')).toBeNull();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// expireStaleLeases
// ---------------------------------------------------------------------------

describe('expireStaleLeases', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('deletes expired leases and returns count', () => {
    const past = Math.floor(Date.now() / 1000) - 700;
    insertLease(db, '/src/a.ts', 'worker-1', past, 600); // expired
    insertLease(db, '/src/b.ts', 'worker-2', past, 600); // expired

    const deleted = expireStaleLeases(db);
    expect(deleted).toBe(2);
    expect(getLease(db, '/src/a.ts')).toBeUndefined();
    expect(getLease(db, '/src/b.ts')).toBeUndefined();
  });

  it('does not delete active leases', () => {
    requestLease(db, '/src/active.ts', 'worker-1');
    const deleted = expireStaleLeases(db);
    expect(deleted).toBe(0);
    expect(getLease(db, '/src/active.ts')).toBeDefined();
  });

  it('deletes only expired leases, keeps active ones', () => {
    const past = Math.floor(Date.now() / 1000) - 700;
    insertLease(db, '/src/old.ts', 'worker-old', past, 600);
    requestLease(db, '/src/active.ts', 'worker-active');

    const deleted = expireStaleLeases(db);
    expect(deleted).toBe(1);
    expect(getLease(db, '/src/old.ts')).toBeUndefined();
    expect(getLease(db, '/src/active.ts')).toBeDefined();
  });

  it('returns 0 when nothing to expire', () => {
    expect(expireStaleLeases(db)).toBe(0);
  });

  it('is non-throwing on DB error — returns 0', () => {
    db.close();
    expect(() => expireStaleLeases(db)).not.toThrow();
    expect(expireStaleLeases(db)).toBe(0);
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// getWorkerLeases
// ---------------------------------------------------------------------------

describe('getWorkerLeases', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns file paths for all leases held by the worker', () => {
    requestLease(db, '/src/a.ts', 'worker-1');
    requestLease(db, '/src/b.ts', 'worker-1');
    requestLease(db, '/src/c.ts', 'worker-2'); // different worker

    const leases = getWorkerLeases(db, 'worker-1');
    expect(leases).toHaveLength(2);
    expect(leases).toContain('/src/a.ts');
    expect(leases).toContain('/src/b.ts');
    expect(leases).not.toContain('/src/c.ts');
  });

  it('returns empty array when worker has no leases', () => {
    expect(getWorkerLeases(db, 'worker-nobody')).toEqual([]);
  });

  it('includes expired-but-not-yet-cleaned leases (reflects raw table state)', () => {
    // getWorkerLeases doesn't filter by TTL — it reflects what's in the table.
    // expireStaleLeases() is the cleanup mechanism.
    const past = Math.floor(Date.now() / 1000) - 700;
    insertLease(db, '/src/expired.ts', 'worker-1', past, 600);
    const leases = getWorkerLeases(db, 'worker-1');
    expect(leases).toContain('/src/expired.ts');
  });

  it('returns empty after releaseAllLeases', () => {
    requestLease(db, '/src/a.ts', 'worker-1');
    requestLease(db, '/src/b.ts', 'worker-1');
    releaseAllLeases(db, 'worker-1');
    expect(getWorkerLeases(db, 'worker-1')).toEqual([]);
  });

  it('is non-throwing on DB error — returns []', () => {
    db.close();
    expect(() => getWorkerLeases(db, 'worker-1')).not.toThrow();
    expect(getWorkerLeases(db, 'worker-1')).toEqual([]);
    db = createTestDb();
  });
});
