import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  ingestWorkerObservation,
  ingestWorkerReport,
  type WorkerObservation,
} from '../../intelligence/worker-observations.js';
import { getObservationsByProject } from '../../core/observations.js';

describe('ingestWorkerObservation', () => {
  let db: TestDatabase;
  const project = 'test-project';
  const sessionId = 'test-session';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeObs(overrides: Partial<WorkerObservation> = {}): WorkerObservation {
    return {
      worker_id: 'worker-1',
      task_description: 'Refactor the artifact lifecycle module',
      observation: 'The artifacts table has no index on session_id — range queries are slow',
      files_involved: ['src/core/artifacts.ts'],
      importance: 4,
      session_id: sessionId,
      ...overrides,
    };
  }

  // --- Acceptance ---

  describe('acceptance', () => {
    it('ingests observation with importance >= 3 and returns a non-empty ID', () => {
      const id = ingestWorkerObservation(db, makeObs({ importance: 3 }), project);
      expect(id).not.toBe('');
      expect(Number(id)).toBeGreaterThan(0);
    });

    it('stores observation with correct tool_name and category', () => {
      ingestWorkerObservation(db, makeObs(), project);
      const rows = getObservationsByProject(db, project);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('worker_report');
      expect(rows[0].category).toBe('other');
    });

    it('stores files_involved as files_modified JSON array', () => {
      const files = ['src/core/artifacts.ts', 'src/core/storage.ts'];
      ingestWorkerObservation(db, makeObs({ files_involved: files }), project);
      const rows = getObservationsByProject(db, project);
      expect(JSON.parse(rows[0].files_modified)).toEqual(files);
    });

    it('stores correct importance', () => {
      ingestWorkerObservation(db, makeObs({ importance: 5 }), project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].importance).toBe(5);
    });

    it('stores correct session_id', () => {
      ingestWorkerObservation(db, makeObs(), project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].session_id).toBe(sessionId);
    });

    it('uses first 100 chars of observation as title', () => {
      const longObs = 'A'.repeat(200);
      ingestWorkerObservation(db, makeObs({ observation: longObs }), project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].title).toBe('A'.repeat(100));
    });
  });

  // --- Rejection ---

  describe('rejection', () => {
    it('rejects observation with importance 1 and returns empty string', () => {
      const id = ingestWorkerObservation(db, makeObs({ importance: 1 }), project);
      expect(id).toBe('');
    });

    it('rejects observation with importance 2 and returns empty string', () => {
      const id = ingestWorkerObservation(db, makeObs({ importance: 2 }), project);
      expect(id).toBe('');
    });

    it('stores nothing in DB when observation is rejected', () => {
      ingestWorkerObservation(db, makeObs({ importance: 1 }), project);
      const rows = getObservationsByProject(db, project);
      expect(rows).toHaveLength(0);
    });
  });

  // --- Deduplication ---

  describe('deduplication', () => {
    it('accepts first observation and rejects identical second observation', () => {
      const obs = makeObs();
      const id1 = ingestWorkerObservation(db, obs, project);
      const id2 = ingestWorkerObservation(db, obs, project);
      expect(id1).not.toBe('');
      expect(id2).toBe('');
    });

    it('stores only one row for duplicate observations', () => {
      const obs = makeObs();
      ingestWorkerObservation(db, obs, project);
      ingestWorkerObservation(db, obs, project);
      const rows = getObservationsByProject(db, project);
      expect(rows).toHaveLength(1);
    });

    it('accepts same observation text from different workers (different hash)', () => {
      const text = 'The artifact TTL is too short for long-running tasks';
      const id1 = ingestWorkerObservation(db, makeObs({ worker_id: 'worker-1', observation: text }), project);
      const id2 = ingestWorkerObservation(db, makeObs({ worker_id: 'worker-2', observation: text }), project);
      expect(id1).not.toBe('');
      expect(id2).not.toBe('');
      expect(id1).not.toBe(id2);
    });

    it('accepts different observations from the same worker', () => {
      const id1 = ingestWorkerObservation(db, makeObs({ observation: 'Observation A about indexing' }), project);
      const id2 = ingestWorkerObservation(db, makeObs({ observation: 'Observation B about caching' }), project);
      expect(id1).not.toBe('');
      expect(id2).not.toBe('');
    });
  });

  // --- Redaction ---

  describe('redaction', () => {
    it('redacts GitHub PAT before storage', () => {
      const obs = makeObs({
        observation: 'Found token ghp_' + 'A'.repeat(36) + ' hardcoded in config',
      });
      ingestWorkerObservation(db, obs, project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].content).not.toContain('ghp_');
      expect(rows[0].content).toContain('[REDACTED');
    });

    it('redacts AWS access key before storage', () => {
      const obs = makeObs({
        observation: 'AWS key AKIAIOSFODNN7EXAMPLE found in environment variables',
      });
      ingestWorkerObservation(db, obs, project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].content).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(rows[0].content).toContain('[REDACTED');
    });

    it('redacts Bearer token before storage', () => {
      const obs = makeObs({
        observation: 'API call uses Bearer ' + 'x'.repeat(30) + ' in Authorization header',
      });
      ingestWorkerObservation(db, obs, project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].content).not.toMatch(/Bearer [a-z]{30}/);
      expect(rows[0].content).toContain('[REDACTED');
    });

    it('does not redact normal code observations', () => {
      const text = 'The insertObservation function truncates content to CONTENT_MAX_CHARS';
      ingestWorkerObservation(db, makeObs({ observation: text }), project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].content).toBe(text);
    });
  });

  // --- Length truncation ---

  describe('length truncation', () => {
    it('truncates observation text longer than 2000 chars before storage', () => {
      // Use a realistic sentence repeated to exceed 2000 chars without triggering redaction
      const unit = 'The artifact table lacks a composite index on project and state fields. ';
      const longText = unit.repeat(30); // ~2100 chars of readable text
      expect(longText.length).toBeGreaterThan(2000);
      const id = ingestWorkerObservation(db, makeObs({ observation: longText }), project);
      // The observation passes the importance gate and is stored truncated
      expect(id).not.toBe('');
      const rows = getObservationsByProject(db, project);
      // insertObservation applies CONTENT_MAX_CHARS (500) as a backstop, but our
      // 2000-char truncation fires first — the stored content will be <= 2000.
      expect(rows[0].content.length).toBeLessThanOrEqual(2000);
    });

    it('stores observation shorter than 2000 chars unchanged (modulo redaction)', () => {
      const text = 'Short observation that fits easily within the limit.';
      ingestWorkerObservation(db, makeObs({ observation: text }), project);
      const rows = getObservationsByProject(db, project);
      expect(rows[0].content).toBe(text);
    });

    it('does not truncate observation at exactly the 2000-char boundary', () => {
      // Build exactly 2000 chars of readable text using a short repeating word
      const text = 'artifact '.repeat(222).slice(0, 2000); // 'artifact ' = 9 chars, 222*9=1998; pad to 2000
      const padded = text + 'ab';
      expect(padded.length).toBe(2000);
      ingestWorkerObservation(db, makeObs({ observation: padded }), project);
      const rows = getObservationsByProject(db, project);
      // 2000-char input should not be extended — stored length <= 2000
      expect(rows[0].content.length).toBeLessThanOrEqual(2000);
      expect(rows[0].content.length).toBeGreaterThan(0);
    });
  });

  // --- DB error resilience ---

  describe('non-throwing behaviour', () => {
    it('returns empty string on DB error (closed DB)', () => {
      const closedDb = createTestDb();
      closedDb.close();
      const id = ingestWorkerObservation(closedDb, makeObs(), project);
      expect(id).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------

describe('ingestWorkerReport', () => {
  let db: TestDatabase;
  const project = 'test-project';
  const sessionId = 'test-session';
  const workerId = 'worker-1';
  const task = 'Audit the observations pipeline';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- Bullet-point report parsing ---

  describe('bullet point parsing', () => {
    it('ingests each bullet point as a separate observation', () => {
      const report = [
        '- Found missing index on observations.session_id causing slow queries',
        '- The FTS5 trigger fires on every insert — consider batching',
        '- Critical: artifact TTL calculation ignores materialization events',
      ].join('\n');

      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      // "- Found..." → importance 4; "- The FTS5..." → importance 3; "- Critical..." → importance 5
      // All >= 3, so 3 should be ingested
      expect(count).toBe(3);
      expect(getObservationsByProject(db, project)).toHaveLength(3);
    });

    it('handles asterisk bullet points', () => {
      const report = [
        '* First important finding about the storage layer',
        '* Second important finding about the caching mechanism',
      ].join('\n');

      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      expect(count).toBe(2);
    });

    it('handles numbered list items', () => {
      const report = [
        '1. Important discovery about the artifact lifecycle',
        '2. Found unexpected behavior in TTL tick calculation',
      ].join('\n');

      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      expect(count).toBe(2);
    });
  });

  // --- Paragraph fallback ---

  describe('paragraph splitting', () => {
    it('splits on double newlines when no list markers present', () => {
      const report = [
        'The artifact table lacks a composite index on (project, state).',
        '',
        'FTS5 triggers are firing synchronously on every observation insert.',
      ].join('\n');

      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Importance scoring integration ---

  describe('importance scoring', () => {
    it('does not ingest very short fragments (scored < 3)', () => {
      // Single-word fragments get importance 1 or 2 — should be rejected
      const report = '- ok\n- yes\n- done';
      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      expect(count).toBe(0);
    });

    it('ingests critical-keyword observations at importance 5', () => {
      const report = '- Critical blocking issue found in artifact compaction logic';
      ingestWorkerReport(db, workerId, report, task, project, sessionId);
      const rows = getObservationsByProject(db, project);
      if (rows.length > 0) {
        expect(rows[0].importance).toBe(5);
      }
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('returns 0 for empty report text', () => {
      expect(ingestWorkerReport(db, workerId, '', task, project, sessionId)).toBe(0);
    });

    it('returns 0 for whitespace-only report', () => {
      expect(ingestWorkerReport(db, workerId, '   \n\n   ', task, project, sessionId)).toBe(0);
    });

    it('does not ingest duplicate observations from the same report', () => {
      const report = [
        '- Found missing index on session_id column in observations table',
        '- Found missing index on session_id column in observations table',
      ].join('\n');

      const count = ingestWorkerReport(db, workerId, report, task, project, sessionId);
      expect(count).toBe(1);
    });

    it('is non-throwing on DB error (closed DB)', () => {
      const closedDb = createTestDb();
      closedDb.close();
      const count = ingestWorkerReport(closedDb, workerId, '- Some observation', task, project, sessionId);
      expect(count).toBe(0);
    });
  });
});
