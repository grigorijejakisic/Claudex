import Database from 'better-sqlite3';
import { initializeSchema } from '../src/core/migrations.ts';
import { createSession } from '../src/core/sessions.ts';
import { hybridSearchSync, isEpisodicQuery } from '../src/core/hybrid-retrieval.ts';

const db = new Database(':memory:');
initializeSchema(db);
createSession(db, { session_id: 'sess-d', project: 'claudex-v3', cwd: 'C:/test', source: 'test' });
const cols = db.prepare('PRAGMA table_info(session_events)').all();
const tsCol = cols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';
const hasMs = tsCol === 'timestamp_epoch_ms';
const now = Math.floor(Date.now() / 1000);
const tsVal = hasMs ? (now - 1800) * 1000 : (now - 1800);
db.prepare(`INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol}) VALUES ('sess-d','claudex-v3','user_framing','prompt','framed','production stopped because the cutover gate refused', ?)`).run(tsVal);
const nowMs = Date.now();
db.prepare(`INSERT INTO artifact (id, kind, project, title, body, scope, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, session_id, data) VALUES ('decoy-x','decision','claudex-v3','Production deployment strategy for v8','When production goes live we should batch the rollout', 'project', 'active', 0.7, ?, ?, 'sess-d', '{}')`).run(nowMs, nowMs);

console.log('isEpisodicQuery:', isEpisodicQuery('why did production stop'));
const r = hybridSearchSync(db, 'why did production stop', 'claudex-v3', { limit: 5 });
for (const [i, x] of r.entries()) {
  console.log(`${i}: id=${x.id} artifact_id=${x.artifact_id} kind=${x.artifact_type} score=${x.hybrid_score.toFixed(4)} match_kind=${x.match_kind} title=${(x.summary||'').slice(0,60)}`);
  console.log('   breakdown:', JSON.stringify(x.score_breakdown));
  console.log('   confidence:', x.confidence, ' importance:', x.importance);
}
