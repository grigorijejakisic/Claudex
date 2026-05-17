import { describe, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { migrateV39toV40 } from '../../../core/migration-steps.js';

describe('diag V40 DEFAULT fix', () => {
  it('check session_signals DEFAULT after V40 runs on same connection', () => {
    const db = new Database(':memory:');
    
    // First run initializeSchema normally 
    initializeSchema(db);
    
    // Force back to V39 and rerun V40 to simulate the scenario
    db.pragma('user_version = 39');
    migrateV39toV40(db);
    
    // Now insert without explicit value — relies on DEFAULT
    const before = Date.now();
    db.prepare("INSERT INTO session_signals (session_id, project, signal_type, target) VALUES ('test', 'p', 'wip', 't')").run();
    const row = db.prepare("SELECT created_at_epoch_ms FROM session_signals WHERE session_id='test'").get() as any;
    console.log('V40 session_signals.created_at_epoch_ms:', row?.created_at_epoch_ms, 'Date.now():', Date.now());
    db.close();
  });
  
  it('check after rename+writable_schema on same connection', () => {
    const db = new Database(':memory:');
    
    // Create a simple table with old column name
    db.exec(`CREATE TABLE test_table (id INTEGER PRIMARY KEY, old_epoch INTEGER DEFAULT (unixepoch()))`);
    
    // Rename column
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE test_table RENAME COLUMN old_epoch TO old_epoch_ms`);
    });
    tx();
    
    // Fix DEFAULT via writable_schema
    const anyDb = db as any;
    if (anyDb.unsafeMode) anyDb.unsafeMode(true);
    db.pragma('writable_schema = 1');
    db.prepare(`UPDATE sqlite_master SET sql = replace(sql, 'DEFAULT (unixepoch())', 'DEFAULT (unixepoch() * 1000)') WHERE type='table' AND name='test_table'`).run();
    db.pragma('writable_schema = 0');
    if (anyDb.unsafeMode) anyDb.unsafeMode(false);
    
    // Insert and check
    db.prepare(`INSERT INTO test_table (id) VALUES (1)`).run();
    const row = db.prepare(`SELECT old_epoch_ms FROM test_table WHERE id=1`).get() as any;
    console.log('Inserted old_epoch_ms:', row?.old_epoch_ms, 'Date.now():', Date.now());
    
    db.close();
  });
});
