import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOOKS_DIR = path.join('src', 'hooks');
const OUT_DIR = 'dist';

// Find all hook entry points (files that don't start with _)
const hookFiles = fs.readdirSync(HOOKS_DIR)
  .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
  .map(f => path.join(HOOKS_DIR, f));

// Additional CLI entry points (not hooks, but built alongside them)
const cliEntryPoints = [
  path.join('src', 'gsd', 'phase-transition-cli.ts'),
].filter(f => fs.existsSync(f));

const allEntryPoints = [...hookFiles, ...cliEntryPoints];
const namedEntryPoints: Record<string, string> = {};

for (const file of allEntryPoints) {
  const entryName = path.basename(file, '.ts');
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
