import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = 'dist';

function discoverEntryPoints(dir: string, prefix?: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const entries: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.startsWith('_')) continue;
    const name = (prefix || '') + path.basename(f, '.ts');
    entries[name] = path.join(dir, f);
  }
  return entries;
}

// Additional CLI entry points (not hooks, but built alongside them)
const cliEntryPoints: Record<string, string> = {};
for (const file of [
  path.join('src', 'gsd', 'phase-transition-cli.ts'),
  path.join('src', 'cli', 'setup.ts'),
]) {
  if (fs.existsSync(file)) {
    cliEntryPoints[path.basename(file, '.ts')] = file;
  }
}

const hookEntries = discoverEntryPoints(path.join('src', 'hooks'));
// CM adapter hooks — includes cm-stop.mjs which is built for future use
// when Claude Code supports Stop hook registration via settings.json
const cmEntries = discoverEntryPoints(path.join('src', 'cm-adapter', 'hooks'), 'cm-');

// Check for duplicate names (prefix collision between hook dirs)
for (const name of Object.keys(cmEntries)) {
  if (name in hookEntries || name in cliEntryPoints) {
    throw new Error(`Entry point name collision: "${name}" exists in multiple directories: ${cmEntries[name]} and ${hookEntries[name] || cliEntryPoints[name]}`);
  }
}
for (const name of Object.keys(cliEntryPoints)) {
  if (name in hookEntries) {
    throw new Error(`Entry point name collision: "${name}" exists in multiple directories: ${cliEntryPoints[name]} and ${hookEntries[name]}`);
  }
}

const namedEntryPoints: Record<string, string> = { ...hookEntries, ...cmEntries, ...cliEntryPoints };
const allEntryPoints = Object.values(namedEntryPoints);

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
