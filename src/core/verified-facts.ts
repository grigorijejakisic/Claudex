/**
 * Verified facts CRUD — session-scoped facts for checkpoint inclusion.
 * Extracted from checkpoint/writer.ts to break intelligence↔checkpoint coupling.
 */

import type { Database } from 'better-sqlite3';

/**
 * Records a verified fact for the current session.
 * Facts are persisted in the verified_facts table and included in subsequent checkpoints.
 * Non-throwing — silently fails if table doesn't exist.
 */
export function addVerifiedFact(db: Database, sessionId: string, fact: string): void {
  try {
    db.prepare(
      `INSERT INTO verified_facts (session_id, fact, created_at_epoch_ms)
       VALUES (?, ?, unixepoch() * 1000)`
    ).run(sessionId, fact.slice(0, 500));
  } catch {
    // Table may not exist yet or other DB error — non-fatal
  }
}
