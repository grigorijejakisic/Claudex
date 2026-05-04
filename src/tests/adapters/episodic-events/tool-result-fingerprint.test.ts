/**
 * Phase 2 Plan 02 — writeToolResult fingerprint integration tests (IDX-01).
 *
 * Asserts:
 *   - stack-trace content gets a populated metadata_json.error_fingerprint
 *   - non-error content omits the key (not present, not null)
 *   - flag-off (errorFingerprintEnabled=false) skips fingerprinting even on
 *     stack-trace content
 *   - atomicity preserved when computeErrorFingerprint throws — row written
 *     without error_fingerprint, telemetry row recorded with
 *     event_kind='episodic_write_failure' + detail.kind='fingerprint_error'
 *   - sidecar table is NOT written from writeToolResult — that's Plan 02-03
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import * as ErrorFingerprintModule from '../../../core/error-fingerprint.js';

const STACK_TRACE = `Error: something went wrong
    at fn1 (file.js:1:1)
    at fn2 (file.js:2:1)
    at fn3 (file.js:3:1)`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function readMetadata(sessionId: string): Record<string, unknown> {
  const row = db.prepare(
    `SELECT metadata_json FROM episodic_events WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(sessionId) as { metadata_json: string };
  return JSON.parse(row.metadata_json);
}

describe('Phase 2 Plan 02 — writeToolResult error_fingerprint wiring (IDX-01)', () => {
  it('attaches error_fingerprint to metadata_json when toolResult looks like a stack trace', () => {
    writeToolResult({
      db,
      sessionId: 'sess-trace',
      project: 'proj',
      toolName: 'Bash',
      toolInput: { command: 'failing-cmd' },
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: true,
    });

    const md = readMetadata('sess-trace');
    expect(md).toHaveProperty('tool_input');
    expect(md).toHaveProperty('error_fingerprint');
    const fp = md.error_fingerprint as Record<string, unknown>;
    expect(fp.outer_exception).toBe('Error');
    expect(Array.isArray(fp.shingles)).toBe(true);
    expect((fp.shingles as string[]).length).toBeGreaterThan(0);
  });

  it('OMITS the error_fingerprint key (not null) when toolResult is plain log content', () => {
    writeToolResult({
      db,
      sessionId: 'sess-plain',
      project: 'proj',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResult: 'hello world, just a normal log line',
      turnNumber: 0,
      errorFingerprintEnabled: true,
    });

    const md = readMetadata('sess-plain');
    expect(md).toHaveProperty('tool_input');
    expect('error_fingerprint' in md).toBe(false);
  });

  it('skips fingerprint computation when errorFingerprintEnabled=false even on stack-trace content', () => {
    writeToolResult({
      db,
      sessionId: 'sess-flagoff',
      project: 'proj',
      toolName: 'Bash',
      toolInput: { command: 'failing-cmd' },
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: false,
    });

    const md = readMetadata('sess-flagoff');
    expect(md).toHaveProperty('tool_input');
    expect('error_fingerprint' in md).toBe(false);
  });

  it('preserves atomicity if computeErrorFingerprint throws — row written w/o fingerprint, telemetry recorded', () => {
    vi.spyOn(ErrorFingerprintModule, 'computeErrorFingerprint').mockImplementation(() => {
      throw new Error('fingerprint compute exploded');
    });

    expect(() =>
      writeToolResult({
        db,
        sessionId: 'sess-throw',
        project: 'proj',
        toolName: 'Bash',
        toolInput: { command: 'failing-cmd' },
        toolResult: STACK_TRACE,
        turnNumber: 0,
        errorFingerprintEnabled: true,
      }),
    ).not.toThrow();

    // Row was written, but error_fingerprint was omitted.
    const md = readMetadata('sess-throw');
    expect('error_fingerprint' in md).toBe(false);

    // Telemetry row recorded the failure with detail.kind='fingerprint_error'.
    const telemetry = db.prepare(
      `SELECT detail FROM telemetry WHERE session_id = ? AND event_kind = 'episodic_write_failure'`,
    ).all('sess-throw') as Array<{ detail: string }>;
    expect(telemetry.length).toBeGreaterThan(0);
    const matched = telemetry.some(t => {
      const d = JSON.parse(t.detail) as Record<string, unknown>;
      return d.kind === 'fingerprint_error';
    });
    expect(matched).toBe(true);
  });

  it('does NOT write to the sidecar table from writeToolResult (Plan 02-03 owns sidecar population)', () => {
    writeToolResult({
      db,
      sessionId: 'sess-sidecar-check',
      project: 'proj',
      toolName: 'Bash',
      toolInput: { command: 'failing-cmd' },
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: true,
    });

    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint`,
    ).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('handles empty toolResult without throwing and without attaching error_fingerprint', () => {
    expect(() =>
      writeToolResult({
        db,
        sessionId: 'sess-empty',
        project: 'proj',
        toolName: 'Bash',
        toolInput: { command: 'noop' },
        toolResult: '',
        turnNumber: 0,
        errorFingerprintEnabled: true,
      }),
    ).not.toThrow();

    const md = readMetadata('sess-empty');
    expect('error_fingerprint' in md).toBe(false);
  });
});
