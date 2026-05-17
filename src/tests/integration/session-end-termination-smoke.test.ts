/**
 * Phase 14-09 — end-to-end smoke: session-end hook writes session_termination row.
 *
 * Runs the actual built `dist/adapters/cc-hooks/session-end.cjs` as a subprocess
 * with a smoke-shaped payload against a temp DB. Verifies that after the hook
 * returns, a `session_termination` row exists with `end_reason='endsession'`.
 *
 * This is the gap that unit tests cannot cover: the hook is a separate process
 * that reads stdin, opens a DB via CLAUDEX_DB_PATH, and exits — we can only
 * trust the wiring by spawning it for real.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';

describe('session-end hook → session_termination row (e2e smoke)', () => {
  it('writes an endsession row to session_termination when the hook fires', () => {
    const hookPath = path.join(process.cwd(), 'dist', 'adapters', 'cc-hooks', 'session-end.cjs');
    if (!fs.existsSync(hookPath)) {
      throw new Error(`hook bundle missing: ${hookPath} (run \`bun run build\`)`);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-e2e-'));
    const dbPath = path.join(tmpDir, 'smoke.db');

    // Pre-init schema (the hook will reopen with runMigrations and add nothing
    // new; the table needs to exist for our post-check query).
    const initDb = new Database(dbPath);
    initializeSchema(initDb);

    // Seed a session and a conversation_turn so readLastTurnTexts has data.
    const sessionId = '__smoke-e2e-session__';
    const project = '__smoke-e2e-project__';
    initDb.prepare(
      `INSERT INTO sessions (session_id, scope, project, cwd, source, status, observation_count, created_at_epoch_ms)
       VALUES (?, 'main', ?, '/tmp', 'test', 'active', 5, ?)`,
    ).run(sessionId, project, Date.now() - 60_000);

    // Find the turn-table's actual timestamp column shape (varies V40/V43).
    const turnCols = (initDb.pragma('table_info(conversation_turns)') as Array<{ name: string }>).map((c) => c.name);
    const tsCol = turnCols.find((c) => c.startsWith('timestamp')) ?? null;
    if (tsCol) {
      initDb.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, ${tsCol})
         VALUES (?, ?, 1, ?, ?, ?)`,
      ).run(sessionId, project, 'final user directive', 'final assistant reply', Date.now());
    }
    initDb.close();

    // Run the hook with smoke payload. The hook reads stdin JSON and writes
    // {} to stdout. We don't care about stdout; we care about side effects.
    const payload = JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      transcript_path: '/nonexistent/transcript.jsonl',
    });

    const result = spawnSync('node', [hookPath], {
      input: payload,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDEX_DB_PATH: dbPath,
        // Force the session-end hook's project routing to our smoke project.
        CLAUDEX_PROJECT_OVERRIDE: project,
      },
      timeout: 30_000,
    });

    // Hook must complete cleanly. Non-zero exit = wiring failure.
    if (result.status !== 0) {
      throw new Error(
        `session-end hook exited ${result.status}\nstderr: ${result.stderr.slice(0, 500)}`,
      );
    }

    // Verify the session_termination row exists.
    const readDb = new Database(dbPath, { readonly: true });
    const row = readDb.prepare(
      `SELECT session_id, project, end_reason, last_user_directive, last_assistant_text
       FROM session_termination WHERE session_id = ?`,
    ).get(sessionId) as
      | {
          session_id: string;
          project: string;
          end_reason: string;
          last_user_directive: string | null;
          last_assistant_text: string | null;
        }
      | undefined;
    readDb.close();

    expect(row, 'session_termination row must be written by session-end hook').toBeTruthy();
    expect(row!.end_reason).toBe('endsession');
    // Last directive should be the seeded turn's user text when present, null otherwise.
    if (tsCol) {
      expect(row!.last_user_directive).toBe('final user directive');
      expect(row!.last_assistant_text).toBe('final assistant reply');
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }, 60_000);
});
