import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOOKS_DIR = path.join('src', 'hooks');
const OUT_DIR = 'dist';

// Find all hook entry points (files that don't start with _)
const hookFiles = fs.readdirSync(HOOKS_DIR)
  .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
  .map(f => path.join(HOOKS_DIR, f));

// CM adapter hook entry points (Context Manager CC adapter)
const CM_ADAPTER_HOOKS_DIR = path.join('src', 'cm-adapter', 'hooks');
const cmAdapterFiles = fs.existsSync(CM_ADAPTER_HOOKS_DIR)
  ? fs.readdirSync(CM_ADAPTER_HOOKS_DIR)
      .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
      .map(f => path.join(CM_ADAPTER_HOOKS_DIR, f))
  : [];

// Additional CLI entry points (not hooks, but built alongside them)
const cliEntryPoints = [
  path.join('src', 'gsd', 'phase-transition-cli.ts'),
  path.join('src', 'cli', 'setup.ts'),
].filter(f => fs.existsSync(f));

const allEntryPoints = [...hookFiles, ...cmAdapterFiles, ...cliEntryPoints];
const namedEntryPoints: Record<string, string> = {};

for (const file of allEntryPoints) {
  // CM adapter hooks get "cm-" prefix to avoid name collision with Claudex hooks
  const isCmAdapter = cmAdapterFiles.includes(file);
  const entryName = isCmAdapter
    ? `cm-${path.basename(file, '.ts')}`
    : path.basename(file, '.ts');
  if (namedEntryPoints[entryName]) {
    throw new Error(`Duplicate entry point name "${entryName}" for ${file}`);
  }
  namedEntryPoints[entryName] = file;
}

if (allEntryPoints.length === 0) {
  console.log('No entry points found. Skipping build.');
  process.exit(0);
}

console.log(`Building ${allEntryPoints.length} entry points:`);
allEntryPoints.forEach(f => console.log(`  ${f}`));

await esbuild.build({
  entryPoints: namedEntryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: OUT_DIR,
  outExtension: { '.js': '.mjs' },
  external: ['better-sqlite3'],
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

console.log('Build complete.');
