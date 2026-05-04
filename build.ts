import * as esbuild from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

/** Entry points that MUST exist for a valid build. */
const requiredEntryPoints = [
  'src/adapters/cc-hooks/session-start.ts',
  'src/adapters/cc-hooks/user-prompt-submit.ts',
  'src/adapters/cc-hooks/post-tool-use.ts',
  'src/adapters/cc-hooks/stop.ts',
  'src/adapters/cc-hooks/pre-compact.ts',
  'src/adapters/cc-hooks/session-end.ts',
  'src/cli/setup.ts',
  'src/cli/dashboard.ts',
  'src/cli/migrate.ts',
  'src/cli/health.ts',
  'src/cli/worker-context.ts',
  'src/cli/projects-touched.ts',
  'src/cli/recall.ts',
  'src/cli/update-recall.ts',
  'src/cli/list-session-pointers.ts',
  'src/cli/mark-pointers-helpful.ts',
  'src/cli/session-token-cost.ts',
  'src/cli/why.ts',
  'src/cli/doctor.ts',
];

/** Optional/scaffolding entry points — warn-and-skip if missing. */
const optionalEntryPoints = [
  'src/adapters/cc-hooks/pre-tool-use.ts',
  'src/adapters/openclaw-bridge/plugin-entry.ts',
  'src/mcp/recall-server.ts',
  'src/angel/index.ts',
  'src/benchmark/locomo-harness.ts',
  'src/benchmark/longmemeval-harness.ts',
  'src/benchmark/debug-locomo.ts',
  'src/benchmark/analyze-results.ts',
  'src/benchmark/memory-quality/cli.ts',
  'src/benchmark/vesna/cli.ts',
  'src/benchmark/episodic-density/cli.ts',
  'src/benchmarks/directive-detector/build-candidates.ts',
  'src/benchmarks/directive-detector/label-candidates.ts',
  'src/benchmarks/directive-detector/run-precision.ts',
  'src/benchmarks/directive-detector/compare-runs.ts',
  'src/indexer/codebase-indexer.ts',
  'src/adapters/cc-hooks/post-compact.ts',
  'src/adapters/cc-hooks/subagent-start.ts',
  'src/adapters/cc-hooks/subagent-stop.ts',
  'src/adapters/cc-hooks/task-created.ts',
  'src/adapters/cc-hooks/task-completed.ts',
  'src/adapters/cc-hooks/permission-request.ts',
  'src/adapters/cc-hooks/permission-denied.ts',
  'src/adapters/cc-hooks/elicitation.ts',
  'src/adapters/cc-hooks/elicitation-result.ts',
  'src/adapters/cc-hooks/post-tool-use-failure.ts',
  'src/adapters/cc-hooks/stop-failure.ts',
  'src/adapters/cc-hooks/config-change.ts',
  'src/adapters/cc-hooks/instructions-loaded.ts',
  'src/adapters/cc-hooks/cwd-changed.ts',
  'src/adapters/cc-hooks/setup.ts',
  'src/adapters/cc-hooks/worktree-create.ts',
  'src/adapters/cc-hooks/worktree-remove.ts',
  'src/adapters/cc-hooks/teammate-idle.ts',
  'scripts/phase-4-1-soak.ts',
  'scripts/p4-pre-backup.ts',
  'scripts/phase-5-soak.ts',
  'scripts/phase-11-curate-memory-md.ts',
];

/** Hook entry points to smoke test after build.
 * pre-compact excluded: Ollama detection has 8s timeout, causes spurious failures. */
const hookEntryPoints = [
  'dist/adapters/cc-hooks/session-start.cjs',
  'dist/adapters/cc-hooks/user-prompt-submit.cjs',
  'dist/adapters/cc-hooks/post-tool-use.cjs',
  'dist/adapters/cc-hooks/stop.cjs',
  'dist/adapters/cc-hooks/session-end.cjs',
  'dist/adapters/cc-hooks/subagent-start.cjs',
  'dist/adapters/cc-hooks/subagent-stop.cjs',
  'dist/adapters/cc-hooks/task-created.cjs',
  'dist/adapters/cc-hooks/task-completed.cjs',
  'dist/adapters/cc-hooks/permission-request.cjs',
  'dist/adapters/cc-hooks/permission-denied.cjs',
  'dist/adapters/cc-hooks/elicitation.cjs',
  'dist/adapters/cc-hooks/elicitation-result.cjs',
  'dist/adapters/cc-hooks/post-tool-use-failure.cjs',
  'dist/adapters/cc-hooks/stop-failure.cjs',
  'dist/adapters/cc-hooks/config-change.cjs',
  'dist/adapters/cc-hooks/instructions-loaded.cjs',
  'dist/adapters/cc-hooks/cwd-changed.cjs',
  'dist/adapters/cc-hooks/setup.cjs',
  'dist/adapters/cc-hooks/worktree-create.cjs',
  'dist/adapters/cc-hooks/worktree-remove.cjs',
  'dist/adapters/cc-hooks/teammate-idle.cjs',
  'dist/adapters/cc-hooks/pre-tool-use.cjs',
  'dist/adapters/cc-hooks/post-compact.cjs',
];

const allEntryPoints = [...requiredEntryPoints, ...optionalEntryPoints];

async function build() {
  // Fail hard if any required entry point is missing
  const missingRequired = requiredEntryPoints.filter((ep) => !existsSync(ep));
  if (missingRequired.length > 0) {
    console.error(`Build FAILED: ${missingRequired.length} required entry point(s) missing:`);
    for (const ep of missingRequired) {
      console.error(`  - ${ep}`);
    }
    process.exit(1);
  }

  const entryPoints = allEntryPoints.filter((ep) => existsSync(ep));

  // Warn about missing optional entry points
  const missingOptional = optionalEntryPoints.filter((ep) => !existsSync(ep));
  if (missingOptional.length > 0) {
    console.warn(`Build: skipping ${missingOptional.length} optional entry point(s):`);
    for (const ep of missingOptional) {
      console.warn(`  - ${ep}`);
    }
  }

  // Split entries by their source root so esbuild's outbase preserves the
  // expected layout in `dist/` (e.g., `src/cli/foo.ts` → `dist/cli/foo.cjs`,
  // `scripts/bar.ts` → `dist/scripts/bar.cjs`). When entries from multiple
  // roots are mixed in one esbuild call, the implicit outbase becomes the
  // common ancestor (project root) and artifacts land at `dist/src/cli/...` —
  // breaking setup.ts, the smoke-test loop, and skill commands that all
  // assume the historical `dist/{adapters,cli,...}/...` layout.
  const srcEntries = entryPoints.filter((ep) => ep.startsWith('src/'));
  const scriptsEntries = entryPoints.filter((ep) => ep.startsWith('scripts/'));
  const otherEntries = entryPoints.filter(
    (ep) => !ep.startsWith('src/') && !ep.startsWith('scripts/'),
  );

  const commonOpts = {
    bundle: true,
    format: 'cjs' as const,
    platform: 'node' as const,
    target: 'node20',
    outdir: 'dist',
    outExtension: { '.js': '.cjs' },
    external: ['better-sqlite3', '@modelcontextprotocol/sdk', 'zod'],
    logLevel: 'info' as const,
  };

  const builds: Array<Promise<unknown>> = [];
  if (srcEntries.length > 0) {
    builds.push(esbuild.build({ ...commonOpts, entryPoints: srcEntries, outbase: 'src' }));
  }
  if (scriptsEntries.length > 0) {
    builds.push(esbuild.build({ ...commonOpts, entryPoints: scriptsEntries, outbase: 'scripts' }));
  }
  if (otherEntries.length > 0) {
    builds.push(esbuild.build({ ...commonOpts, entryPoints: otherEntries }));
  }

  await Promise.all(builds);
}

/**
 * Post-build smoke tests: invoke each hook with minimal payload via
 * child_process.spawn (no shell — Windows-safe). Uses a temp DB via
 * CLAUDEX_DB_PATH to avoid polluting production data.
 *
 * Catches: missing imports, undefined references, schema mismatches.
 * Does NOT validate business logic — that's what unit tests are for.
 */
async function smokeTest(): Promise<boolean> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'claudex-smoke-'));
  const tmpDb = join(tmpDir, 'smoke.db');
  const cwd = process.cwd();
  let allPassed = true;

  const payloads: Record<string, object> = {
    'session-start': { session_id: '__smoke__', cwd },
    'user-prompt-submit': { session_id: '__smoke__', prompt: 'smoke', cwd },
    'post-tool-use': { session_id: '__smoke__', tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: {}, cwd },
    'stop': { session_id: '__smoke__', last_assistant_message: 'smoke', stop_assistant_turn: 'smoke', cwd },
    'pre-compact': { session_id: '__smoke__', cwd },
    'session-end': { session_id: '__smoke__', cwd },
    'subagent-start': { session_id: '__smoke__', agent_id: 'smoke-agent', agent_type: 'general-purpose', cwd },
    'subagent-stop': { session_id: '__smoke__', agent_id: 'smoke-agent', agent_type: 'general-purpose', agent_transcript_path: '', cwd },
    'task-created': { session_id: '__smoke__', task_id: 'smoke-task', task_subject: 'smoke test', cwd },
    'task-completed': { session_id: '__smoke__', task_id: 'smoke-task', task_subject: 'smoke test', cwd },
    'permission-request': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd },
    'permission-denied': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'smoke-id', reason: 'User denied', cwd },
    'elicitation': { session_id: '__smoke__', mcp_server_name: 'test-server', message: 'Enter value', cwd },
    'elicitation-result': { session_id: '__smoke__', mcp_server_name: 'test-server', action: 'accept', cwd },
    'post-tool-use-failure': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'fail' }, tool_use_id: 'smoke-id', error: 'command failed', cwd },
    'stop-failure': { session_id: '__smoke__', error: 'rate_limit', error_details: 'Rate limited', cwd },
    'config-change': { session_id: '__smoke__', source: 'project_settings', file_path: '/tmp/CLAUDE.md', cwd },
    'instructions-loaded': { session_id: '__smoke__', file_path: '/tmp/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start', cwd },
    'cwd-changed': { session_id: '__smoke__', old_cwd: cwd, new_cwd: cwd, cwd },
    'setup': { session_id: '__smoke__', trigger: 'init', cwd },
    'worktree-create': { session_id: '__smoke__', name: 'smoke-worktree', cwd },
    'worktree-remove': { session_id: '__smoke__', worktree_path: '/tmp/smoke-worktree', cwd },
    'teammate-idle': { session_id: '__smoke__', teammate_name: 'smoke-teammate', team_name: 'smoke-team', cwd },
    'pre-tool-use': { session_id: '__smoke__', tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd },
    'post-compact': { session_id: '__smoke__', trigger: 'auto', compact_summary: 'smoke compaction', cwd },
  };

  for (const hookPath of hookEntryPoints) {
    if (!existsSync(hookPath)) continue;

    const hookName = hookPath.split('/').pop()!.replace('.cjs', '');
    const payload = payloads[hookName];
    if (!payload) continue;

    try {
      const result = await runHookSmoke(hookPath, payload, tmpDb);
      if (result.ok) {
        console.log(`  ✓ ${hookName} (${result.ms}ms)`);
      } else {
        console.error(`  ✗ ${hookName}: ${result.error}`);
        allPassed = false;
      }
    } catch (e) {
      console.error(`  ✗ ${hookName}: ${e instanceof Error ? e.message : String(e)}`);
      allPassed = false;
    }
  }

  // Cleanup temp DB
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  return allPassed;
}

function runHookSmoke(
  hookPath: string,
  payload: object,
  dbPath: string,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [hookPath], {
      env: { ...process.env, CLAUDEX_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on('close', (code) => {
      const ms = Date.now() - start;
      if (code !== 0) {
        resolve({ ok: false, ms, error: `exit ${code}: ${stderr.slice(0, 200)}` });
      } else if (stderr.includes('Error') || stderr.includes('Cannot find module')) {
        resolve({ ok: false, ms, error: stderr.slice(0, 200) });
      } else {
        // Verify stdout is valid JSON
        try {
          if (stdout.trim()) JSON.parse(stdout.trim());
          resolve({ ok: true, ms });
        } catch {
          resolve({ ok: false, ms, error: `invalid JSON output: ${stdout.slice(0, 100)}` });
        }
      }
    });

    child.on('error', (e) => {
      resolve({ ok: false, ms: Date.now() - start, error: e.message });
    });
  });
}

build().then(async () => {
  console.log('\nSmoke testing hooks...');
  const passed = await smokeTest();
  if (!passed) {
    console.error('\nSmoke test FAILED — fix before registering hooks.');
    process.exit(1);
  }
  console.log('\nTo register hooks in Claude Code: bun run setup');
});
