/**
 * Phase 13 Plan 04: session-start auto-orient injection tests.
 *
 * The full SessionStart hook is verified by the smoke-test suite already
 * (bun run build covers the wrapHook entry points). These tests focus on the
 * load-bearing data-layer and formatter pieces:
 *  - nowIso() format (timestamp injection)
 *  - getLatestHighlights DESC ordering across multiple sessions
 *  - Frame Extraction Degraded health-line condition
 *  - Recent Session Frames token-budget truncation cascade
 *  - Empty-Sessions graceful fallback
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  upsertHighlights,
  getLatestHighlights,
} from '../../../intelligence/session-highlights.js';
import {
  formatFrameExtractionDegradedSection,
  formatRecentSessionFramesSection,
} from '../../../assembly/sections.js';
import { nowIso } from '../../../adapters/cc-hooks/session-writer.js';

const V33_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, project TEXT NOT NULL,
  mental_model TEXT, open_questions TEXT, reframes TEXT,
  tools_introduced TEXT, decisions_not_made TEXT, posture_context TEXT,
  degraded INTEGER NOT NULL DEFAULT 0, degraded_reason TEXT, degraded_model TEXT,
  created_at_epoch_ms INTEGER NOT NULL, re_extracted_at_epoch_ms INTEGER,
  UNIQUE(session_id, project)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  status TEXT DEFAULT 'active',
  created_at_epoch INTEGER DEFAULT 0
);
`;

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(V33_SCHEMA);
  return db;
}

// Phase 13.1 Fix #4 (2026-05-15): getLatestHighlights now JOINs sessions, so
// tests must seed a sessions row for any highlight they expect to retrieve.
function seedSession(db: DatabaseType, session_id: string, project: string): void {
  db.prepare(`INSERT INTO sessions (session_id, project) VALUES (?, ?)`).run(session_id, project);
}

describe('nowIso — timestamp format injected at every turn', () => {
  it('produces ISO 8601 with timezone offset', () => {
    const ts = nowIso();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('does not end with Z (always has explicit offset)', () => {
    const ts = nowIso();
    expect(ts.endsWith('Z')).toBe(false);
  });
});

describe('getLatestHighlights — assembly read path', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns rows DESC by created_at_epoch_ms (latest first)', () => {
    seedSession(db, 's1', 'p1');
    seedSession(db, 's2', 'p1');
    seedSession(db, 's3', 'p1');
    upsertHighlights(db, { session_id: 's1', project: 'p1', mental_model: 'model-1', created_at_epoch_ms: 1000 });
    upsertHighlights(db, { session_id: 's2', project: 'p1', mental_model: 'model-2', created_at_epoch_ms: 2000 });
    upsertHighlights(db, { session_id: 's3', project: 'p1', mental_model: 'model-3', created_at_epoch_ms: 3000 });
    const rows = getLatestHighlights(db, 'p1', 3);
    expect(rows[0].mental_model).toBe('model-3');
    expect(rows[1].mental_model).toBe('model-2');
    expect(rows[2].mental_model).toBe('model-1');
  });

  it('returns [] for an empty project (graceful empty-Sessions/ fallback)', () => {
    expect(getLatestHighlights(db, 'empty-project', 3)).toEqual([]);
  });
});

describe('formatFrameExtractionDegradedSection — health line', () => {
  it('returns null when no highlights are degraded', () => {
    const rows = [
      { degraded: false },
      { degraded: false },
    ];
    expect(formatFrameExtractionDegradedSection(rows)).toBeNull();
  });

  it('returns null when given empty array', () => {
    expect(formatFrameExtractionDegradedSection([])).toBeNull();
  });

  it('returns the health line when any of the latest highlights are degraded', () => {
    const rows = [
      { degraded: true },
      { degraded: false },
      { degraded: false },
    ];
    const section = formatFrameExtractionDegradedSection(rows);
    expect(section).not.toBeNull();
    expect(section).toContain('## Frame Extraction Degraded');
    expect(section).toContain('1 of the last 3');
  });

  it('reports the correct degraded count', () => {
    const rows = [
      { degraded: true },
      { degraded: true },
      { degraded: false },
    ];
    const section = formatFrameExtractionDegradedSection(rows);
    expect(section).toContain('2 of the last 3');
  });
});

describe('formatRecentSessionFramesSection — budget cap + truncation cascade', () => {
  const sampleHighlight = {
    session_id: 'session-abcdef',
    created_at_epoch_ms: new Date('2026-05-14T10:00:00Z').getTime(),
    mental_model: 'The substrate carries what /starthere was doing manually',
    open_questions: [
      { question: 'mtime-skip race?', context: 'heartbeat tick vs. file write' },
    ],
    tools_introduced: [
      { path: 'src/angel/sessions-indexer.ts', purpose: 'Indexes Sessions/ markdown' },
    ],
    decisions_not_made: [
      { gray_area: 'Should we add chokidar?', why_deferred: 'Windows fragility' },
    ],
    posture_context: 'Operator was energized, moving fast',
  };

  it('returns null for empty input (graceful empty-Sessions/ fallback)', () => {
    expect(formatRecentSessionFramesSection([], 1000)).toBeNull();
  });

  it('renders all fields when budget is generous', () => {
    const section = formatRecentSessionFramesSection([sampleHighlight], 10_000);
    expect(section).toContain('## Recent Session Frames');
    expect(section).toContain('Mental model');
    expect(section).toContain('Open questions');
    expect(section).toContain('Tools introduced');
    expect(section).toContain('Decisions deferred');
    expect(section).toContain('Posture');
  });

  it('drops posture_context first when budget is tight', () => {
    // Pick a budget large enough for everything except posture.
    const full = formatRecentSessionFramesSection([sampleHighlight], 10_000) ?? '';
    const tokenBudget = Math.floor((full.length / 4) - 5); // a hair under full size in tokens
    const truncated = formatRecentSessionFramesSection([sampleHighlight], tokenBudget);
    if (truncated) {
      expect(truncated).not.toContain('Posture');
    }
  });

  it('renders multiple highlights as separate sub-sections', () => {
    const second = { ...sampleHighlight, session_id: 'second-session' };
    const section = formatRecentSessionFramesSection([sampleHighlight, second], 10_000);
    expect(section).toContain('session-');
    expect(section?.split('### Session').length).toBeGreaterThan(2);
  });

  it('formats session prefix as date + first-8 of session-id', () => {
    const section = formatRecentSessionFramesSection([sampleHighlight], 10_000);
    expect(section).toContain('2026-05-14');
    expect(section).toContain('session-');
  });
});
