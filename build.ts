import * as esbuild from 'esbuild';
import { existsSync } from 'fs';

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
];

/** Optional/scaffolding entry points — warn-and-skip if missing. */
const optionalEntryPoints = [
  'src/adapters/openclaw-bridge/plugin-entry.ts',
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
    external: ['better-sqlite3'],
    logLevel: 'info',
  });
}

build();
