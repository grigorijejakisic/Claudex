import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  addJournalEntry,
  getJournalBySession,
  getRecentFlow,
  getSessionMilestones,
  getLatestSummary,
  deleteJournalBySession,
} from '../../core/journal.js';

describe('session journal CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('addJournalEntry inserts a flow entry', () => {
    const id = addJournalEntry(db, 's1', 'myapp', 'flow', 'pivoted from REST to gRPC');
    expect(id).toBeGreaterThan(0);

    const entries = getJournalBySession(db, 's1');
    expect(entries).toHaveLength(1);
    expect(entries[0].session_id).toBe('s1');
    expect(entries[0].project).toBe('myapp');
    expect(entries[0].entry_type).toBe('flow');
    expect(entries[0].content).toBe('pivoted from REST to gRPC');
    expect(entries[0].timestamp_epoch).toBeGreaterThan(0);
  });

  it('addJournalEntry inserts a milestone entry', () => {
    const id = addJournalEntry(db, 's1', 'myapp', 'milestone', '1073/1073 tests pass');
    expect(id).toBeGreaterThan(0);

    const entries = getJournalBySession(db, 's1');
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_type).toBe('milestone');
    expect(entries[0].content).toBe('1073/1073 tests pass');
  });

  it('addJournalEntry inserts a summary entry', () => {
    const id = addJournalEntry(db, 's1', 'myapp', 'summary', 'Completed auth refactor');
    expect(id).toBeGreaterThan(0);

    const entries = getJournalBySession(db, 's1');
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_type).toBe('summary');
  });

  it('rejects invalid entry_type via CHECK constraint', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content)
         VALUES (?, ?, ?, ?)`
      ).run('s1', 'myapp', 'invalid_type', 'should fail');
    }).toThrow();
  });

  it('getJournalBySession returns entries for specific session', () => {
    addJournalEntry(db, 's1', 'myapp', 'flow', 'entry 1');
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'entry 2');
    addJournalEntry(db, 's2', 'myapp', 'flow', 'other session');

    const entries = getJournalBySession(db, 's1');
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.session_id === 's1')).toBe(true);
  });

  it('getJournalBySession filters by entry_type', () => {
    addJournalEntry(db, 's1', 'myapp', 'flow', 'flow entry');
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'milestone entry');
    addJournalEntry(db, 's1', 'myapp', 'summary', 'summary entry');

    const flows = getJournalBySession(db, 's1', { entryType: 'flow' });
    expect(flows).toHaveLength(1);
    expect(flows[0].entry_type).toBe('flow');

    const milestones = getJournalBySession(db, 's1', { entryType: 'milestone' });
    expect(milestones).toHaveLength(1);
    expect(milestones[0].entry_type).toBe('milestone');
  });

  it('getJournalBySession respects limit', () => {
    for (let i = 0; i < 5; i++) {
      addJournalEntry(db, 's1', 'myapp', 'flow', `entry ${i}`);
    }

    const entries = getJournalBySession(db, 's1', { limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('getJournalBySession returns newest first', () => {
    // Insert with explicit timestamps to guarantee order
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s1', 'myapp', 'flow', 'older', 1000);
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s1', 'myapp', 'flow', 'newer', 2000);

    const entries = getJournalBySession(db, 's1');
    expect(entries[0].content).toBe('newer');
    expect(entries[1].content).toBe('older');
  });

  it('getJournalBySession returns empty array for non-existent session', () => {
    const entries = getJournalBySession(db, 'nonexistent');
    expect(entries).toEqual([]);
  });

  it('getRecentFlow returns flow entries for project, newest first', () => {
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s1', 'myapp', 'flow', 'old flow', 1000);
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s2', 'myapp', 'flow', 'new flow', 2000);
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'not a flow');
    addJournalEntry(db, 's1', 'other-project', 'flow', 'wrong project');

    const flows = getRecentFlow(db, 'myapp');
    expect(flows).toHaveLength(2);
    expect(flows[0].content).toBe('new flow');
    expect(flows[1].content).toBe('old flow');
    expect(flows.every(e => e.entry_type === 'flow')).toBe(true);
    expect(flows.every(e => e.project === 'myapp')).toBe(true);
  });

  it('getRecentFlow respects limit', () => {
    for (let i = 0; i < 10; i++) {
      addJournalEntry(db, 's1', 'myapp', 'flow', `flow ${i}`);
    }

    const flows = getRecentFlow(db, 'myapp', 3);
    expect(flows).toHaveLength(3);
  });

  it('getRecentFlow returns empty array for non-existent project', () => {
    const flows = getRecentFlow(db, 'nonexistent');
    expect(flows).toEqual([]);
  });

  it('getSessionMilestones returns milestones for session', () => {
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'tests pass');
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'committed abc123');
    addJournalEntry(db, 's1', 'myapp', 'flow', 'not a milestone');
    addJournalEntry(db, 's2', 'myapp', 'milestone', 'wrong session');

    const milestones = getSessionMilestones(db, 's1');
    expect(milestones).toHaveLength(2);
    expect(milestones.every(e => e.entry_type === 'milestone')).toBe(true);
    expect(milestones.every(e => e.session_id === 's1')).toBe(true);
  });

  it('getSessionMilestones respects limit', () => {
    for (let i = 0; i < 10; i++) {
      addJournalEntry(db, 's1', 'myapp', 'milestone', `milestone ${i}`);
    }

    const milestones = getSessionMilestones(db, 's1', 3);
    expect(milestones).toHaveLength(3);
  });

  it('getLatestSummary returns most recent summary for project', () => {
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s1', 'myapp', 'summary', 'old summary', 1000);
    db.prepare(
      `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?)`
    ).run('s2', 'myapp', 'summary', 'latest summary', 2000);

    const summary = getLatestSummary(db, 'myapp');
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('latest summary');
    expect(summary!.session_id).toBe('s2');
  });

  it('getLatestSummary returns null for non-existent project', () => {
    const summary = getLatestSummary(db, 'nonexistent');
    expect(summary).toBeNull();
  });

  it('getLatestSummary ignores non-summary entry types', () => {
    addJournalEntry(db, 's1', 'myapp', 'flow', 'not a summary');
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'also not a summary');

    const summary = getLatestSummary(db, 'myapp');
    expect(summary).toBeNull();
  });

  it('deleteJournalBySession removes all entries for session', () => {
    addJournalEntry(db, 's1', 'myapp', 'flow', 'entry 1');
    addJournalEntry(db, 's1', 'myapp', 'milestone', 'entry 2');
    addJournalEntry(db, 's1', 'myapp', 'summary', 'entry 3');
    addJournalEntry(db, 's2', 'myapp', 'flow', 'other session');

    const deleted = deleteJournalBySession(db, 's1');
    expect(deleted).toBe(3);

    const s1Entries = getJournalBySession(db, 's1');
    expect(s1Entries).toEqual([]);

    // s2 entries should be untouched
    const s2Entries = getJournalBySession(db, 's2');
    expect(s2Entries).toHaveLength(1);
  });

  it('deleteJournalBySession returns 0 for non-existent session', () => {
    const deleted = deleteJournalBySession(db, 'nonexistent');
    expect(deleted).toBe(0);
  });

  it('multiple entries across sessions and projects', () => {
    addJournalEntry(db, 's1', 'proj-a', 'flow', 'flow in proj-a');
    addJournalEntry(db, 's1', 'proj-b', 'flow', 'flow in proj-b');
    addJournalEntry(db, 's2', 'proj-a', 'milestone', 'milestone in proj-a');

    const projAFlows = getRecentFlow(db, 'proj-a');
    expect(projAFlows).toHaveLength(1);
    expect(projAFlows[0].content).toBe('flow in proj-a');

    const projBFlows = getRecentFlow(db, 'proj-b');
    expect(projBFlows).toHaveLength(1);
    expect(projBFlows[0].content).toBe('flow in proj-b');
  });
});
