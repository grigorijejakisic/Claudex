/**
 * Unit tests for Phase 7.5 handoff schema module.
 *
 * Covers validateHandoffHeader, parseHandoffHeader, renderHandoffMarkdown,
 * writeHandoff (filesystem + atomicity), and round-trip render→parse stability.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import {
  HandoffHeader,
  HandoffInput,
  HandoffStatus,
  parseHandoffHeader,
  renderHandoffMarkdown,
  validateHandoffHeader,
  writeHandoff,
} from '../../angel/handoff-writer.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { migrateV37toV38 } from '../../core/migration-steps.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-writer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    status: 'active',
    phase: '5',
    whatWeFound: 'Phase 5 cache stability holds; one-line summary path landed.',
    whatWeDecided: 'Ship Plan 02 wave 4 next.',
    whatsNext: 'Run `bun run test src/tests/assembly/`.',
    whereToLook: 'src/assembly/sections.ts; .planning/STATE.md',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1 — validateHandoffHeader
// ---------------------------------------------------------------------------

describe('validateHandoffHeader', () => {
  it('returns [] for valid status=active + phase="5"', () => {
    expect(validateHandoffHeader({ status: 'active', phase: '5' })).toEqual([]);
  });

  it('flags invalid status value', () => {
    const errors = validateHandoffHeader({
      status: 'foo' as unknown as HandoffStatus,
      phase: '5',
    });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('status');
  });

  it('flags missing phase', () => {
    const errors = validateHandoffHeader({ status: 'active' });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('phase');
  });

  it('flags empty phase', () => {
    const errors = validateHandoffHeader({ status: 'active', phase: '' });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('phase');
  });

  it('returns [] for archived + decimal phase string', () => {
    expect(validateHandoffHeader({ status: 'archived', phase: '4.1' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — parseHandoffHeader
// ---------------------------------------------------------------------------

describe('parseHandoffHeader', () => {
  it('parses minimal header with status + phase', () => {
    const raw = `---\nstatus: active\nphase: 5\n---\n# title\n`;
    const parsed = parseHandoffHeader(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('active');
    expect(parsed!.phase).toBe('5');
    expect(parsed!.summary).toBeUndefined();
    expect(parsed!.topic).toBeUndefined();
    expect(parsed!.created_at_epoch_ms).toBeUndefined();
  });

  it('parses full header with all 5 fields', () => {
    const raw =
      `---\nstatus: paused\nphase: "4.1"\nsummary: "Resume: phase 5"\n` +
      `topic: phase-5-tier-deletion\ncreated_at_epoch_ms: 1777501858000\n---\n# title\n`;
    const parsed = parseHandoffHeader(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('paused');
    expect(parsed!.phase).toBe('4.1');
    expect(parsed!.summary).toBe('Resume: phase 5');
    expect(parsed!.topic).toBe('phase-5-tier-deletion');
    expect(typeof parsed!.created_at_epoch_ms).toBe('number');
    expect(parsed!.created_at_epoch_ms).toBe(1777501858000);
  });

  it('returns null for malformed (no closing ---)', () => {
    const raw = `---\nstatus: active\nphase: 5\n# missing closing\n`;
    expect(parseHandoffHeader(raw)).toBeNull();
  });

  it('returns null for invalid status value', () => {
    const raw = `---\nstatus: bogus\nphase: 5\n---\n`;
    expect(parseHandoffHeader(raw)).toBeNull();
  });

  it('parses quoted decimal phase', () => {
    const raw = `---\nstatus: active\nphase: "4.1"\n---\n`;
    const parsed = parseHandoffHeader(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.phase).toBe('4.1');
  });

  it('parses summary containing colon', () => {
    const raw = `---\nstatus: active\nphase: 5\nsummary: "Resume: phase 5"\n---\n`;
    const parsed = parseHandoffHeader(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('Resume: phase 5');
  });

  it('returns null on empty input', () => {
    expect(parseHandoffHeader('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — renderHandoffMarkdown
// ---------------------------------------------------------------------------

describe('renderHandoffMarkdown', () => {
  it('emits frontmatter starting with status, phase, then title', () => {
    const out = renderHandoffMarkdown(fixtureInput());
    expect(out.startsWith('---\nstatus: active\nphase: 5\n---\n# ')).toBe(true);
  });

  it('uses topic in title when provided', () => {
    const out = renderHandoffMarkdown(fixtureInput({ topic: 'my-topic' }));
    expect(out).toMatch(/# \d{4}-\d{2}-\d{2} — my-topic/);
  });

  it('uses summary in title when topic absent', () => {
    const out = renderHandoffMarkdown(fixtureInput({ summary: 'Resume work' }));
    expect(out).toMatch(/# \d{4}-\d{2}-\d{2} — Resume work/);
  });

  it('uses untitled when both topic and summary absent', () => {
    const out = renderHandoffMarkdown(fixtureInput());
    expect(out).toMatch(/# \d{4}-\d{2}-\d{2} — untitled/);
  });

  it('emits 4 sections in locked order', () => {
    const out = renderHandoffMarkdown(fixtureInput());
    const idxFound = out.indexOf('**What we found:**');
    const idxDecided = out.indexOf('**What we decided:**');
    const idxNext = out.indexOf("**What's next:**");
    const idxLook = out.indexOf('**Where to look:**');
    expect(idxFound).toBeGreaterThan(-1);
    expect(idxDecided).toBeGreaterThan(idxFound);
    expect(idxNext).toBeGreaterThan(idxDecided);
    expect(idxLook).toBeGreaterThan(idxNext);
  });

  it('emits decimal phase quoted', () => {
    const out = renderHandoffMarkdown(fixtureInput({ phase: '4.1' }));
    expect(out).toMatch(/^---\nstatus: active\nphase: "4\.1"\n/);
  });

  it('quotes summary containing a colon', () => {
    const out = renderHandoffMarkdown(fixtureInput({ summary: 'Resume: phase 5' }));
    expect(out).toMatch(/\nsummary: "Resume: phase 5"\n/);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — writeHandoff (filesystem)
// ---------------------------------------------------------------------------

describe('writeHandoff', () => {
  it('writes a valid file matching renderHandoffMarkdown output', () => {
    const target = path.join(tmpDir, 'ACTIVE.md');
    const input = fixtureInput({ created_at_epoch_ms: 1777501858000 });
    writeHandoff(target, input);
    const onDisk = fs.readFileSync(target, 'utf8');
    expect(onDisk).toBe(renderHandoffMarkdown(input));
  });

  it('creates parent directory when missing', () => {
    const target = path.join(tmpDir, 'nested', 'deeper', 'ACTIVE.md');
    writeHandoff(target, fixtureInput());
    expect(fs.existsSync(target)).toBe(true);
  });

  it('throws on missing phase', () => {
    const target = path.join(tmpDir, 'ACTIVE.md');
    expect(() => {
      writeHandoff(target, {
        ...fixtureInput(),
        phase: '' as unknown as string,
      });
    }).toThrow(/handoff validation failed/);
  });

  it('validation failure leaves pre-existing target file byte-identical', () => {
    const target = path.join(tmpDir, 'ACTIVE.md');
    const seed = '---\nstatus: archived\nphase: 1\n---\n# seed\n';
    fs.writeFileSync(target, seed, 'utf8');
    const before = fs.readFileSync(target, 'utf8');

    let threw = false;
    try {
      writeHandoff(target, {
        ...fixtureInput(),
        phase: '' as unknown as string,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const after = fs.readFileSync(target, 'utf8');
    expect(after).toBe(before);
  });

  it('uses tmp+rename pattern: tmp does not remain after success', () => {
    const target = path.join(tmpDir, 'ACTIVE.md');
    writeHandoff(target, fixtureInput());
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(target + '.tmp')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — round-trip render → parse stability
// ---------------------------------------------------------------------------

describe('round-trip render→parse', () => {
  const fixtures: HandoffInput[] = [
    fixtureInput({
      status: 'active',
      phase: '5',
      summary: 'Resume work',
      topic: 'phase-5',
      created_at_epoch_ms: 1777501858000,
    }),
    fixtureInput({
      status: 'paused',
      phase: '4.1',
      summary: 'Resume: phase 5',
      created_at_epoch_ms: 1700000000000,
    }),
    fixtureInput({
      status: 'archived',
      phase: '3',
    }),
    fixtureInput({
      status: 'active',
      phase: 7,
      topic: 'numeric-phase',
      created_at_epoch_ms: 1234567890000,
    }),
    fixtureInput({
      status: 'active',
      phase: '6.5',
      summary: 'Phase 6.5 close',
      topic: 'phase-6-5',
      created_at_epoch_ms: 1888888888000,
    }),
  ];

  for (const [i, input] of fixtures.entries()) {
    it(`fixture ${i + 1}: header round-trips losslessly`, () => {
      const rendered = renderHandoffMarkdown(input);
      const parsed = parseHandoffHeader(rendered);
      expect(parsed).not.toBeNull();
      expect(parsed!.status).toBe(input.status);
      expect(parsed!.phase).toBe(
        typeof input.phase === 'number' ? String(input.phase) : input.phase,
      );
      expect(parsed!.summary).toBe(input.summary);
      expect(parsed!.topic).toBe(input.topic);
      expect(parsed!.created_at_epoch_ms).toBe(input.created_at_epoch_ms);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 6 — Phase 14-01 telemetry-on-rejection (parseHandoffHeader overload)
// ---------------------------------------------------------------------------

/**
 * Helper: create a minimal in-memory DB with the telemetry table seeded,
 * including the handoff_parse_failed event_kind in the CHECK constraint.
 */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN (
        'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
        'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
        'reranker_fallback', 'cross_project_ambiguous', 'cross_project_query_expansion',
        'episodic_write_failure', 'signal_reread_after_surface', 'signal_retrieval_fallback',
        'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
        'handoff_parse_failed'
      )),
      detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
      latency_ms REAL,
      timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()),
      adapter TEXT DEFAULT 'unknown'
    );
  `);
  return db;
}

/**
 * Helper: count handoff_parse_failed rows in the test DB.
 */
function countFailures(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 'handoff_parse_failed'`
  ).get() as { n: number };
  return row.n;
}

/**
 * Helper: get the first handoff_parse_failed row's parsed detail.
 */
function getFailureDetail(db: Database.Database): { reason: string; source_path: string | null } | null {
  const row = db.prepare(
    `SELECT detail FROM telemetry WHERE event_kind = 'handoff_parse_failed' ORDER BY id LIMIT 1`
  ).get() as { detail: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.detail);
}

/**
 * Helper: get the first handoff_parse_failed row's session_id.
 */
function getFailureSessionId(db: Database.Database): string | null {
  const row = db.prepare(
    `SELECT session_id FROM telemetry WHERE event_kind = 'handoff_parse_failed' ORDER BY id LIMIT 1`
  ).get() as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

describe('parseHandoffHeader — Phase 14 telemetry on rejection', () => {

  it('test 1: db not supplied — existing single-arg behavior unchanged, no telemetry', () => {
    // Single-arg invocation should still return null and not throw.
    const raw = `---\nstatus: bogus\nphase: 5\n---\n`;
    const result = parseHandoffHeader(raw);
    expect(result).toBeNull();
    // No db available — just confirm no exception is thrown.
  });

  it('test 2: no frontmatter — emits handoff_parse_failed with reason=no_frontmatter', () => {
    const db = makeTestDb();
    const raw = `# Just a heading\n\nSome body content with no frontmatter block.`;
    const result = parseHandoffHeader(raw, { db });
    expect(result).toBeNull();
    expect(countFailures(db)).toBe(1);
    const detail = getFailureDetail(db);
    expect(detail?.reason).toBe('no_frontmatter');
    db.close();
  });

  it('test 3: frontmatter missing status — emits with reason=missing_status', () => {
    const db = makeTestDb();
    const raw = `---\nphase: 5\n---\n# title\n`;
    const result = parseHandoffHeader(raw, { db });
    expect(result).toBeNull();
    expect(countFailures(db)).toBe(1);
    const detail = getFailureDetail(db);
    expect(detail?.reason).toBe('missing_status');
    db.close();
  });

  it('test 4: frontmatter status=invalid — emits with reason=invalid_status', () => {
    const db = makeTestDb();
    const raw = `---\nstatus: ACTIVE\nphase: 5\n---\n# title\n`;
    const result = parseHandoffHeader(raw, { db });
    expect(result).toBeNull();
    expect(countFailures(db)).toBe(1);
    const detail = getFailureDetail(db);
    expect(detail?.reason).toBe('invalid_status');
    db.close();
  });

  it('test 5: frontmatter missing phase — emits with reason=missing_phase', () => {
    const db = makeTestDb();
    const raw = `---\nstatus: active\n---\n# title\n`;
    const result = parseHandoffHeader(raw, { db });
    expect(result).toBeNull();
    expect(countFailures(db)).toBe(1);
    const detail = getFailureDetail(db);
    expect(detail?.reason).toBe('missing_phase');
    db.close();
  });

  it('test 6: valid input — emits NO telemetry row', () => {
    const db = makeTestDb();
    const raw = `---\nstatus: active\nphase: 5\n---\n# title\n`;
    const result = parseHandoffHeader(raw, { db });
    expect(result).not.toBeNull();
    expect(countFailures(db)).toBe(0);
    db.close();
  });

  it('test 7: db write failure (closed db) — does NOT throw; returns null normally', () => {
    const db = makeTestDb();
    db.close(); // close before use to simulate DB failure
    const raw = `---\nstatus: bogus\nphase: 5\n---\n`;
    let threw = false;
    let result: ReturnType<typeof parseHandoffHeader> = null;
    try {
      result = parseHandoffHeader(raw, { db });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });

  it('test 8: sourcePath populated in detail.source_path when supplied', () => {
    const db = makeTestDb();
    const raw = `---\nstatus: active\n---\n# title\n`; // missing phase
    const result = parseHandoffHeader(raw, { db, sourcePath: '/projects/foo/ACTIVE.md' });
    expect(result).toBeNull();
    const detail = getFailureDetail(db);
    expect(detail?.source_path).toBe('/projects/foo/ACTIVE.md');
    db.close();
  });

  it('test 9: sessionId populated in row session_id column when supplied', () => {
    const db = makeTestDb();
    const raw = `# just body, no frontmatter`;
    const result = parseHandoffHeader(raw, { db, sessionId: 'sess-abc-123' });
    expect(result).toBeNull();
    const sessionId = getFailureSessionId(db);
    expect(sessionId).toBe('sess-abc-123');
    db.close();
  });

});
