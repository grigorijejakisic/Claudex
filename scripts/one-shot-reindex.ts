import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanAndIndexSessions, getRegisteredProjectDirs } from '../src/angel/sessions-indexer.js';

(async () => {
  const dbPath = path.join(os.homedir(), '.claudex/db/claudex.db');
  const db = new Database(dbPath);

  console.log('=== registered projects ===');
  const projects = getRegisteredProjectDirs();
  console.log('count:', projects.length);
  const claudexV3 = projects.find(p => p.projectId === 'claudex-v3');
  console.log('claudex-v3 entry:', claudexV3);

  console.log('=== running scanAndIndexSessions ===');
  const result = await scanAndIndexSessions(db);
  console.log('result:', result);

  console.log('=== chunks for our session post-scan ===');
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM transcript_chunk_v6 WHERE session_id = '523e018e-299a-4be7-acb4-af625e7a9742'`).get();
  console.log('chunks:', cnt);
  const violets = db.prepare(`SELECT COUNT(*) AS n FROM transcript_chunk_v6 WHERE session_id = '523e018e-299a-4be7-acb4-af625e7a9742' AND body LIKE '%violets%'`).get();
  console.log('violets-bearing chunks:', violets);

  db.close();
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
