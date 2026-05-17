/**
 * Recursive-hook short-circuit — when claudex spawns `claude` as a generation
 * subprocess, the child must not run any claudex hook side effects. The
 * `CLAUDEX_GENERATION_CHILD=1` env var (set by callClaudeSubprocess) causes
 * every wrapHook-wrapped hook to short-circuit before any DB / stdin work.
 *
 * Verifies the guard fires across multiple hook bundles by running them as
 * subprocesses with the env var set and confirming:
 *   - stdout = empty JSON object
 *   - exit code 0
 *   - no telemetry rows written (no DB side effects)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';

const HOOKS_TO_GUARD = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
  'session-end',
  'subagent-start',
  'task-created',
  'config-change',
];

function runHookWithChildEnv(hookName: string, dbPath: string, payload: object): { stdout: string; stderr: string; exitCode: number | null } {
  const hookPath = path.join(process.cwd(), 'dist', 'adapters', 'cc-hooks', `${hookName}.cjs`);
  if (!fs.existsSync(hookPath)) {
    return { stdout: '', stderr: `hook bundle missing: ${hookPath}`, exitCode: -1 };
  }
  const result = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDEX_GENERATION_CHILD: '1',
      CLAUDEX_DB_PATH: dbPath,
    },
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}

describe('CLAUDEX_GENERATION_CHILD recursive-hook guard', () => {
  it('every wrapHook-wrapped hook short-circuits when env var is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-child-guard-'));
    const dbPath = path.join(tmpDir, 'smoke.db');

    // Pre-create DB with full schema so post-call telemetry check is meaningful.
    const initDb = new Database(dbPath);
    initializeSchema(initDb);
    initDb.close();

    const cwd = process.cwd();
    const payloads: Record<string, object> = {
      'session-start': { session_id: '__child__', cwd },
      'user-prompt-submit': { session_id: '__child__', prompt: 'x', cwd },
      'post-tool-use': { session_id: '__child__', tool_name: 'Read', tool_input: {}, tool_response: {}, cwd },
      'stop': { session_id: '__child__', last_assistant_message: 'x', cwd },
      'session-end': { session_id: '__child__', cwd },
      'subagent-start': { session_id: '__child__', agent_id: 'a', agent_type: 'g', cwd },
      'task-created': { session_id: '__child__', task_id: 't', task_subject: 's', cwd },
      'config-change': { session_id: '__child__', source: 'project', file_path: '/tmp/c', cwd },
    };

    for (const hook of HOOKS_TO_GUARD) {
      const payload = payloads[hook] ?? { session_id: '__child__', cwd };
      const result = runHookWithChildEnv(hook, dbPath, payload);

      if (result.exitCode === -1) {
        // Skip if the bundle doesn't exist in this build.
        continue;
      }

      expect(result.exitCode, `${hook} should exit 0 when CHILD env set`).toBe(0);

      // stdout should parse as {} or empty
      const out = result.stdout.trim();
      if (out.length > 0) {
        const parsed = JSON.parse(out) as object;
        expect(Object.keys(parsed).length, `${hook} should emit empty object`).toBe(0);
      }
    }

    // Verify NO writes occurred: a fresh-init DB has known baseline row counts.
    const db = new Database(dbPath, { readonly: true });
    const telCount = (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE session_id='__child__'").get() as { n: number }).n;
    const sessCount = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='__child__'").get() as { n: number }).n;
    const evtCount = (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id='__child__'").get() as { n: number }).n;
    db.close();

    expect(telCount, 'no telemetry rows for child session').toBe(0);
    expect(sessCount, 'no session row created').toBe(0);
    expect(evtCount, 'no session_events rows').toBe(0);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }, 60_000);
});
