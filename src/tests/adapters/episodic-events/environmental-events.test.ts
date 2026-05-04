/**
 * Phase 1 Plan 01-03 — writeEnvironmentalEvent tests.
 *
 * Environmental events: session_boundary + environmental_event types,
 * provenance='environmental', turn_number=NULL, parent_event_id=NULL.
 * No legacy mirror — environmental events are not turns.
 *
 * EPI-03.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeEnvironmentalEvent } from '../../../core/episodic-events.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('Phase 1 Plan 01-03 — writeEnvironmentalEvent (EPI-03)', () => {
  it('shape: provenance=environmental, turn_number=NULL, parent_event_id=NULL', () => {
    writeEnvironmentalEvent({
      db,
      sessionId: 'sess-A',
      project: 'proj',
      type: 'session_boundary',
      source: 'cc-hooks/session-start',
      content: 'Session opened: sess-A',
    });

    const row = db.prepare(
      `SELECT type, provenance, turn_number, parent_event_id, source, content
         FROM episodic_events WHERE session_id = ?`,
    ).get('sess-A') as {
      type: string; provenance: string; turn_number: number | null;
      parent_event_id: number | null; source: string; content: string;
    };
    expect(row.provenance).toBe('environmental');
    expect(row.turn_number).toBeNull();
    expect(row.parent_event_id).toBeNull();
    expect(row.type).toBe('session_boundary');
    expect(row.source).toBe('cc-hooks/session-start');
    expect(row.content).toBe('Session opened: sess-A');
  });

  it('type=environmental_event preserved', () => {
    writeEnvironmentalEvent({
      db,
      sessionId: 'angel-heartbeat',
      project: '__global__',
      type: 'environmental_event',
      source: 'angel/heartbeat',
      content: 'Heartbeat tick',
      metadata: { tick_started_epoch_ms: 1700000000000 },
    });
    const row = db.prepare(
      `SELECT type FROM episodic_events WHERE session_id = ?`,
    ).get('angel-heartbeat') as { type: string };
    expect(row.type).toBe('environmental_event');
  });

  it('metadata serialized to metadata_json', () => {
    writeEnvironmentalEvent({
      db,
      sessionId: 'sess-meta',
      project: 'proj',
      type: 'session_boundary',
      source: 'cc-hooks/session-end',
      content: 'Session closed: sess-meta',
      metadata: { session_id: 'sess-meta', reason: 'completed', cwd: '/x' },
    });
    const row = db.prepare(`SELECT metadata_json FROM episodic_events WHERE session_id='sess-meta'`).get() as { metadata_json: string };
    const parsed = JSON.parse(row.metadata_json);
    expect(parsed.session_id).toBe('sess-meta');
    expect(parsed.reason).toBe('completed');
    expect(parsed.cwd).toBe('/x');
  });

  it('no metadata -> metadata_json IS NULL', () => {
    writeEnvironmentalEvent({
      db,
      sessionId: 'sess-nomet',
      project: 'proj',
      type: 'environmental_event',
      source: 'angel/heartbeat',
      content: 'tick',
    });
    const row = db.prepare(`SELECT metadata_json FROM episodic_events WHERE session_id='sess-nomet'`).get() as { metadata_json: string | null };
    expect(row.metadata_json).toBeNull();
  });

  it('environmental events do NOT insert into conversation_turns', () => {
    const ctBefore = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    writeEnvironmentalEvent({
      db,
      sessionId: 'sess-noct',
      project: 'proj',
      type: 'session_boundary',
      source: 'cc-hooks/session-start',
      content: 'Session opened',
    });
    const ctAfter = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    expect(ctAfter).toBe(ctBefore);
  });

  it('Atomicity: failure path writes one telemetry row', () => {
    db.exec('DROP TABLE episodic_events;');
    const telBefore = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;
    expect(() => writeEnvironmentalEvent({
      db,
      sessionId: 'sess-fail',
      project: 'proj',
      type: 'session_boundary',
      source: 'cc-hooks/session-start',
      content: 'will fail',
    })).toThrow();
    const telAfter = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;
    expect(telAfter - telBefore).toBe(1);

    const detail = JSON.parse(
      (db.prepare("SELECT detail FROM telemetry WHERE event_kind='episodic_write_failure' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail,
    );
    expect(detail.hook).toBe('cc-hooks/session-start');
    expect(detail.kind).toBe('environmental');
    expect(detail.type).toBe('session_boundary');
  });

  it('back-to-back session_boundary writes (start + end) yield 2 rows visible to a turn-bound filter EXCLUDING them', () => {
    writeEnvironmentalEvent({
      db, sessionId: 'sess-pair', project: 'proj',
      type: 'session_boundary', source: 'cc-hooks/session-start',
      content: 'Session opened: sess-pair',
    });
    writeEnvironmentalEvent({
      db, sessionId: 'sess-pair', project: 'proj',
      type: 'session_boundary', source: 'cc-hooks/session-end',
      content: 'Session closed: sess-pair',
    });

    const all = db.prepare(`SELECT type, source FROM episodic_events WHERE session_id='sess-pair' ORDER BY id`).all() as Array<{ type: string; source: string }>;
    expect(all).toHaveLength(2);
    expect(all[0].source).toBe('cc-hooks/session-start');
    expect(all[1].source).toBe('cc-hooks/session-end');

    // turn-bound filter (e.g. retrieval) excludes them via WHERE turn_number IS NOT NULL.
    const turnBound = db.prepare(
      `SELECT COUNT(*) AS c FROM episodic_events WHERE session_id='sess-pair' AND turn_number IS NOT NULL`,
    ).get() as { c: number };
    expect(turnBound.c).toBe(0);
  });
});
