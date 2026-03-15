#!/usr/bin/env node
/**
 * Retroactive content-aware routing migration.
 * Re-evaluates project assignment for all observations, artifacts,
 * decisions, and learnings using content-based routing.
 *
 * Usage: node scripts/migrate-routing.cjs [--dry-run]
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DRY_RUN = process.argv.includes('--dry-run');
const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const projectsJsonPath = path.join(os.homedir(), '.claudex', 'projects.json');
const projectsBaseDir = path.join(os.homedir(), 'Desktop', 'Projects');

// --- Embedded content router (mirrors src/shared/content-router.ts) ---

const MAX_CONTENT_SCAN = 5000;
const MIN_ALIAS_LENGTH = 3;
const MIN_NAME_SCORE = 20;

// FNV-1a hash — mirrors scope-detector.ts simpleHash
function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function deriveProjectId(cwd) {
  const baseName = path.basename(cwd);
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  let normalized = path.normalize(path.resolve(cwd));
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  normalized = normalized.replace(/[/\\]+$/, '');
  if (normalized === '' || /^[a-zA-Z]:$/.test(normalized)) normalized += path.sep;
  const hash = simpleHash(normalized);
  return `${sanitized}-${hash}`;
}

function buildAliases(id, dirName) {
  const aliases = new Set();
  aliases.add(id.toLowerCase());
  aliases.add(dirName.toLowerCase());
  for (const base of [id.toLowerCase(), dirName.toLowerCase()]) {
    const stripped = base
      .replace(/[-_\s](main|fix|master|dev)$/i, '')
      .replace(/[-_\s]v\d+$/i, '');
    if (stripped && stripped.length >= MIN_ALIAS_LENGTH) aliases.add(stripped);
  }
  const collapsed = dirName.toLowerCase().replace(/[-_\s]/g, '');
  if (collapsed && collapsed.length >= MIN_ALIAS_LENGTH) aliases.add(collapsed);
  return [...aliases].filter(a => a.length >= MIN_ALIAS_LENGTH);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildProjectIndex() {
  const signatures = [];
  const seenDirs = new Set();

  try {
    const raw = fs.readFileSync(projectsJsonPath, 'utf-8');
    const registry = JSON.parse(raw);
    if (registry?.projects) {
      for (const [key, entry] of Object.entries(registry.projects)) {
        let projId, projPath;
        if (typeof entry === 'string') {
          projPath = key; projId = entry; // Legacy: key=path, value=id
        } else {
          projId = key; projPath = entry?.path; // Standard: key=id, value.path
        }
        if (!projPath) continue;
        const dirName = path.basename(projPath);
        const pathFwd = projPath.toLowerCase().replace(/\\/g, '/');
        const aliases = buildAliases(projId, dirName);
        signatures.push({
          id: projId, dirName, fullPath: projPath, pathFwd,
          msysPath: pathFwd.replace(/^([a-z]):/, '/$1'),
          aliases,
          aliasPatterns: aliases.map(a => ({ pattern: new RegExp(`\\b${escapeRegex(a)}\\b`, 'gi'), length: a.length })),
        });
        seenDirs.add(dirName.toLowerCase());
      }
    }
  } catch {}

  try {
    const entries = fs.readdirSync(projectsBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seenDirs.has(entry.name.toLowerCase())) continue;
      const dirName = entry.name;
      const fullPath = path.join(projectsBaseDir, dirName);
      const id = deriveProjectId(fullPath);
      const aliases = buildAliases(id, dirName);
      const pathFwd = fullPath.toLowerCase().replace(/\\/g, '/');
      signatures.push({
        id, dirName, fullPath, pathFwd,
        msysPath: pathFwd.replace(/^([a-z]):/, '/$1'),
        aliases,
        aliasPatterns: aliases.map(a => ({ pattern: new RegExp(`\\b${escapeRegex(a)}\\b`, 'gi'), length: a.length })),
      });
    }
  } catch {}

  signatures.sort((a, b) => b.pathFwd.length - a.pathFwd.length);
  return signatures;
}

function isPathBoundaryMatch(content, matchPath) {
  const idx = content.indexOf(matchPath);
  if (idx < 0) return false;
  const afterIdx = idx + matchPath.length;
  if (afterIdx >= content.length) return true;
  const ch = content[afterIdx];
  return ch === '/' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '"' || ch === '\'' || ch === ')';
}

function routeByContent(content, cwdProject, projectIndex) {
  if (!content || projectIndex.length === 0) return cwdProject;
  try {
    const contentLower = content.substring(0, MAX_CONTENT_SCAN).toLowerCase();
    const contentFwd = contentLower.replace(/\\/g, '/');

    for (const proj of projectIndex) {
      if (proj.id === cwdProject) continue;
      if (isPathBoundaryMatch(contentFwd, proj.pathFwd)) return proj.id;
      if (isPathBoundaryMatch(contentFwd, proj.msysPath)) return proj.id;
    }

    let cwdScore = 0;
    let bestMatch = null;
    for (const proj of projectIndex) {
      let score = 0;
      for (const { pattern, length } of proj.aliasPatterns) {
        pattern.lastIndex = 0;
        const matches = contentLower.match(pattern);
        if (matches) score += matches.length * length;
      }
      if (proj.id === cwdProject) {
        cwdScore = score;
      } else if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { id: proj.id, score };
      }
    }
    if (bestMatch && bestMatch.score > cwdScore && bestMatch.score >= MIN_NAME_SCORE) return bestMatch.id;
    return cwdProject;
  } catch {
    return cwdProject;
  }
}

// --- Migration logic ---

function migrate() {
  const db = new Database(dbPath);
  try {
    const projectIndex = buildProjectIndex();

    console.log(`Project index: ${projectIndex.length} projects`);
    projectIndex.forEach(p => console.log(`  ${p.id.padEnd(25)} ${p.aliases.join(', ')}`));
    console.log(`\nMode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will update DB)'}\n`);

    const stats = { observations: { checked: 0, rerouted: 0 }, artifacts: { checked: 0, rerouted: 0 }, decisions: { checked: 0, rerouted: 0 }, learnings: { checked: 0, rerouted: 0 } };
    const moves = {};

    function trackMove(from, to) {
      const key = `${from} -> ${to}`;
      moves[key] = (moves[key] || 0) + 1;
    }

    const updateObs = DRY_RUN ? null : db.prepare('UPDATE observations SET project = ? WHERE id = ?');
    const updateArt = DRY_RUN ? null : db.prepare('UPDATE artifacts SET project = ? WHERE id = ?');
    const updateDec = DRY_RUN ? null : db.prepare('UPDATE decisions SET project = ? WHERE id = ?');
    const updateLearn = DRY_RUN ? null : db.prepare('UPDATE learnings SET project = ? WHERE id = ?');

    const runInTransaction = db.transaction(() => {
      for (const [table, update, contentCol] of [
        ['observations', updateObs, 'content'],
        ['artifacts', updateArt, 'content'],
        ['decisions', updateDec, 'content'],
        ['learnings', updateLearn, 'content'],
      ]) {
        console.log(`Processing ${table}...`);
        const iter = db.prepare(`SELECT id, project, ${contentCol}${table === 'artifacts' ? ', summary' : ''} FROM ${table}`).iterate();
        for (const row of iter) {
          stats[table].checked++;
          const content = table === 'artifacts' ? ((row.summary || '') + ' ' + (row[contentCol] || '')) : (row[contentCol] || '');
          const routed = routeByContent(content, row.project, projectIndex);
          if (routed !== row.project) {
            stats[table].rerouted++;
            trackMove(row.project, routed);
            if (update) update.run(routed, row.id);
          }
        }
      }
    });

    runInTransaction();

    console.log('\n=== Migration Results ===\n');
    for (const [table, s] of Object.entries(stats)) {
      console.log(`${table}: ${s.rerouted}/${s.checked} rerouted`);
    }
    console.log('\nRouting moves:');
    const sorted = Object.entries(moves).sort((a, b) => b[1] - a[1]);
    for (const [move, count] of sorted) {
      console.log(`  ${move.padEnd(45)} ${count}`);
    }

    if (!DRY_RUN) {
      console.log('\n=== Post-Migration Counts ===\n');
      for (const t of ['observations', 'artifacts', 'decisions', 'learnings']) {
        const byProj = db.prepare(`SELECT project, COUNT(*) as c FROM ${t} GROUP BY project ORDER BY c DESC`).all();
        console.log(`${t}:`);
        byProj.forEach(r => console.log(`  ${r.project.padEnd(25)} ${r.c}`));
      }
    }
  } finally {
    db.close();
  }
}

migrate();
