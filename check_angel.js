const Database = require('better-sqlite3');
const os = require('os');
const path = require('path');
const fs = require('fs');

const db = Database(path.join(os.homedir(), '.claudex', 'db', 'claudex.db'), {readonly: true});

// Check if Angel processed our pending event
const done = db.prepare(`
  SELECT * FROM session_events 
  WHERE event_type = 'memory_curation_done' 
    AND project = 'soak-test-p4b-1df6c0f2' 
  ORDER BY id DESC LIMIT 5
`).all();
console.log('memory_curation_done events:', done.length);
done.forEach(r => console.log(' -', r.id, r.session_id, r.detail));

// Check latest Angel events
const latest = db.prepare(`
  SELECT id, event_type, entity, action, detail, timestamp_epoch 
  FROM session_events 
  WHERE entity = 'angel' 
  ORDER BY id DESC LIMIT 10
`).all();
console.log('\nLatest angel events:');
latest.forEach(r => console.log(' -', new Date(r.timestamp_epoch * 1000).toISOString(), r.event_type, r.action));

// Check if any MEMORY.md was written recently
const written = db.prepare(`
  SELECT id, project, event_type, detail, timestamp_epoch 
  FROM session_events 
  WHERE event_type = 'memory_curation_refused' 
  ORDER BY id DESC LIMIT 5
`).all();
console.log('\nRecent curation refusals:', written.length);

db.close();
