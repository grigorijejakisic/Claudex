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
];

/** Optional/scaffolding entry points — warn-and-skip if missing. */
const optionalEntryPoints = [
  'src/adapters/openclaw-bridge/plugin-entry.ts',
  'src/mcp/recall-server.ts',
];

/** Hook entry points to smoke test after build.
 * pre-compact excluded: Ollama detection has 8s timeout, causes spurious failures. */
const hookEntryPoints = [
  'dist/adapters/cc-hooks/session-start.cjs',
  'dist/adapters/cc-hooks/user-prompt-submit.cjs',
  'dist/adapters/cc-hooks/post-tool-use.cjs',
  'dist/adapters/cc-hooks/stop.cjs',
  'dist/adapters/cc-hooks/session-end.cjs',
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

  await esbuild.build({
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outdir: 'dist',
    outExtension: { '.js': '.cjs' },
    external: ['better-sqlite3', '@modelcontextprotocol/sdk', 'zod'],
    logLevel: 'info',
  });
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
