import * as esbuild from 'esbuild';
import { existsSync } from 'fs';

const allEntryPoints = [
  'src/adapters/cc-hooks/session-start.ts',
  'src/adapters/cc-hooks/user-prompt-submit.ts',
  'src/adapters/cc-hooks/post-tool-use.ts',
  'src/adapters/cc-hooks/stop.ts',
  'src/adapters/cc-hooks/pre-compact.ts',
  'src/adapters/cc-hooks/session-end.ts',
  'src/cli/setup.ts',
  'src/cli/dashboard.ts',
  'src/cli/migrate.ts',
  'src/adapters/openclaw-bridge/plugin-entry.ts',
];

async function build() {
  const entryPoints = allEntryPoints.filter((ep) => existsSync(ep));

  if (entryPoints.length === 0) {
    console.warn('Build: no entry points exist yet (scaffolding phase). Skipping.');
    return;
  }

  const missing = allEntryPoints.filter((ep) => !existsSync(ep));
  if (missing.length > 0) {
    console.warn(`Build: skipping ${missing.length} missing entry point(s).`);
  }

  await esbuild.build({
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outdir: 'dist',
    outExtension: { '.js': '.cjs' },
    external: ['better-sqlite3'],
    logLevel: 'info',
  });
}

build();
