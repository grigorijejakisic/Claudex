import { describe, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { hasColumn } from '../../core/migration-steps.js';

function tableSql(db: Database.Database, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined;
  return row?.sql ?? '';
}

describe('diag V43', () => {
  it('check session_events DDL after fresh init', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const v = (db.pragma('user_version') as any)[0].user_version;
    console.log('user_version:', v);
    
    const hasOldCol = hasColumn(db, 'session_events', 'timestamp_epoch');
    const hasNewCol = hasColumn(db, 'session_events', 'timestamp_epoch_ms');
    console.log('session_events.timestamp_epoch:', hasOldCol);
    console.log('session_events.timestamp_epoch_ms:', hasNewCol);
    
    const sql = tableSql(db, 'session_events');
    console.log('session_events DDL:', sql);
    
    // Test INSERT default
    const before = Date.now();
    db.prepare("INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('x', 'p', 't', 'e', 'a')").run();
    const colName = hasNewCol ? 'timestamp_epoch_ms' : 'timestamp_epoch';
    const row = db.prepare(`SELECT ${colName} AS ts FROM session_events WHERE session_id='x'`).get() as any;
    console.log('Inserted ts value:', row?.ts, 'Date.now():', Date.now());
    
    db.close();
  });
});
