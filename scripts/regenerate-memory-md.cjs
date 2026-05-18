// Regenerate MEMORY.md for claudex-v3 against the new writer schema.
// Drops the now-retired '## How to Query' section; preserves user-tail
// (everything below <!-- USER EDITABLE -->) byte-for-byte.

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const entryPath = path.join(__dirname, '..', '.tmp-memmd-entry.mjs');
const outPath = path.join(__dirname, '..', '.tmp-memmd.cjs');
fs.writeFileSync(entryPath, `
import { curateMemoryMd } from './src/angel/memory-md-writer.js';
import { runMigrations } from './src/core/migrations.js';
export { curateMemoryMd, runMigrations };
`);
execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --outfile=${outPath} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const mod = require(outPath);
const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);
mod.runMigrations(db);

const result = mod.curateMemoryMd(db, 'claudex-v3');
console.log('curateMemoryMd result:', JSON.stringify(result));

db.close();
