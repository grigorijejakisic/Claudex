/**
 * Unit tests for Angel MEMORY.md writer (Plan 04-01).
 *
 * Covers:
 *   - Preamble rendering from sibling user-memory files
 *   - Entities / Active Projects / Recent Threads SQL + formatters
 *   - Handoff distillation from ACTIVE.md
 *   - Normalization + sha256 sentinel determinism
 *   - Full curateMemoryMd pipeline: write, idempotency, user-tail
 *     preservation, sentinel-missing refusal, cold start, oversize trim,
 *     CRLF → LF normalization across the handoff boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../../core/migrations.js';
import { pathToCcSlug } from '../../shared/cc-slug.js';

import {
  curateMemoryMd,
  renderPreamble,
  renderEntities,
  renderActiveProjects,
  renderRecentThreads,
  renderHandoff,
  normalize,
  sentinelLine,
  parseSentinelHash,
  computeMemoryMdPath,
  toSlug,
  HOW_TO_QUERY_STATIC,
  USER_TAIL_DEFAULT,
  MAX_BYTES,
  MAX_LINES,
} from '../../angel/memory-md-writer.js';

// ---------------------------------------------------------------------------
// Test harness: temp HOME that redirects ~/.claude/projects/<slug>/memory/*
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

/** Project ID used across tests — matches what `toSlug` will return unchanged. */
const PROJECT = 'test-proj';

/** Current unix epoch in seconds. */
const now = () => Math.floor(Date.now() / 1000);

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  initializeSchema(d);
  return d;
}

function memoryDirFor(project = PROJECT): string {
  return path.join(tmpHome, '.claude', 'projects', toSlug(project), 'memory');
}

function ensureMemoryDir(project = PROJECT): string {
  const dir = memoryDirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryMdPathFor(project = PROJECT): string {
  return path.join(memoryDirFor(project), 'MEMORY.md');
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedEntities(
  d: Database.Database,
  project: string,
  rows: Array<{ ref: string; summary: string; importance?: number; ts?: number }>,
): void {
  const stmt = d.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, importance, timestamp_epoch)
     VALUES ('angel', ?, 'entity_summary', ?, ?, 'fresh', ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(project, row.ref, row.summary, row.importance ?? 3, row.ts ?? now());
  }
}

function seedActiveProjects(
  d: Database.Database,
  rows: Array<{ project_id: string; edits: number; last_touch?: number }>,
): void {
  // Insert `edits` artifact rows per project; the GROUP BY COUNT(*) will
  // reflect these. Use unique IDs to satisfy the PRIMARY KEY on V17.artifact.
  let seq = 0;
  const stmt = d.prepare(
    `INSERT INTO artifact (id, kind, title, body, status, created_at_epoch, updated_at_epoch, project, data)
     VALUES (?, 'test_seed', ?, 'body', 'active', ?, ?, ?, '{}')`,
  );
  for (const row of rows) {
    for (let i = 0; i < row.edits; i++) {
      const id = `seed-ap-${row.project_id}-${seq++}`;
      stmt.run(id, `t${seq}`, now(), row.last_touch ?? now(), row.project_id); // JS prop → project column
    }
  }
}

function seedTranscriptChunks(
  d: Database.Database,
  project: string,
  chunks: Array<{ session_id: string; topic_label: string; created_at?: number }>,
): void {
  let seq = 0;
  const stmt = d.prepare(
    `INSERT INTO artifact (id, kind, title, body, status, created_at_epoch, updated_at_epoch, project, session_id, data)
     VALUES (?, 'transcript_chunk', ?, 'chunk body', 'active', ?, ?, ?, ?, ?)`,
  );
  for (const c of chunks) {
    const id = `seed-tc-${seq++}`;
    const ts = c.created_at ?? now();
    stmt.run(id, c.topic_label, ts, ts, project, c.session_id, JSON.stringify({ topic_label: c.topic_label }));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-memmd-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = makeDb();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Preamble renderer (Task 04-01-02)
// ---------------------------------------------------------------------------

describe('renderPreamble', () => {
  it('renders only type: user files, description-first, sorted by filename', () => {
    const dir = ensureMemoryDir();
    fs.writeFileSync(
      path.join(dir, 'user_b.md'),
      '---\nname: beta\ndescription: beta\ntype: user\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(dir, 'user_a.md'),
      '---\nname: alpha\ndescription: alpha\ntype: user\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(dir, 'feedback.md'),
      '---\ntype: feedback\ndescription: not included\n---\n\nbody\n',
    );

    expect(renderPreamble(toSlug(PROJECT))).toBe('- alpha\n- beta\n\n');
  });

  it('returns empty string when no memory dir exists', () => {
    expect(renderPreamble(toSlug(PROJECT))).toBe('');
  });

  it('falls back to filename stem when description is missing', () => {
    const dir = ensureMemoryDir();
    fs.writeFileSync(path.join(dir, 'user_pc_specs.md'), '---\ntype: user\n---\n\nbody\n');
    expect(renderPreamble(toSlug(PROJECT))).toBe('- user_pc_specs\n\n');
  });

  it('caps at 5 lines even if more user files exist', () => {
    const dir = ensureMemoryDir();
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(
        path.join(dir, `user_${i}.md`),
        `---\ntype: user\ndescription: desc${i}\n---\n\nbody\n`,
      );
    }
    const out = renderPreamble(toSlug(PROJECT));
    expect(out.trim().split('\n')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Entities / Active Projects / Recent Threads (Task 04-01-03)
// ---------------------------------------------------------------------------

describe('renderEntities', () => {
  it('orders by importance DESC, then timestamp DESC, then id ASC', () => {
    const t = now();
    seedEntities(db, PROJECT, [
      { ref: 'entity:low', summary: 'low-importance', importance: 1, ts: t },
      { ref: 'entity:high', summary: 'high-importance', importance: 5, ts: t - 1000 },
      { ref: 'entity:mid', summary: 'mid', importance: 3, ts: t },
    ]);
    const out = renderEntities(db, PROJECT);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('## Entities');
    expect(lines[1]).toBe('- entity:high — high-importance');
    expect(lines[2]).toBe('- entity:mid — mid');
    expect(lines[3]).toBe('- entity:low — low-importance');
  });

  it('renders empty-section header when no entities exist', () => {
    expect(renderEntities(db, PROJECT)).toBe('## Entities\n\n');
  });

  it('id ASC tiebreaker is deterministic across runs', () => {
    const t = now();
    seedEntities(db, PROJECT, [
      { ref: 'entity:a', summary: 'a', importance: 3, ts: t },
      { ref: 'entity:b', summary: 'b', importance: 3, ts: t },
      { ref: 'entity:c', summary: 'c', importance: 3, ts: t },
    ]);
    const first = renderEntities(db, PROJECT);
    const second = renderEntities(db, PROJECT);
    expect(first).toBe(second);
  });
});

describe('renderActiveProjects', () => {
  it('ranks by activity count DESC, ties broken by last-touched DESC', () => {
    seedActiveProjects(db, [
      { project_id: 'p1', edits: 2 },
      { project_id: 'p2', edits: 5 },
      { project_id: 'p3', edits: 5, last_touch: now() - 100 },
    ]);
    const out = renderActiveProjects(db);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('## Active Projects');
    expect(lines[1]).toBe('- p2 — 5 edits in last 7d');
    expect(lines[2]).toBe('- p3 — 5 edits in last 7d');
    expect(lines[3]).toBe('- p1 — 2 edits in last 7d');
  });

  it('top-5 cap is respected', () => {
    seedActiveProjects(db, [
      { project_id: 'a', edits: 10 },
      { project_id: 'b', edits: 9 },
      { project_id: 'c', edits: 8 },
      { project_id: 'd', edits: 7 },
      { project_id: 'e', edits: 6 },
      { project_id: 'f', edits: 5 },
    ]);
    const out = renderActiveProjects(db);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
  });

  it('renders empty-section header when no artifacts exist', () => {
    expect(renderActiveProjects(db)).toBe('## Active Projects\n\n');
  });
});

describe('renderRecentThreads', () => {
  it('dedups by topic_label and returns the 5 most recent', () => {
    const t = now();
    seedTranscriptChunks(db, PROJECT, [
      { session_id: 's1', topic_label: 'auth', created_at: t - 60 },
      { session_id: 's1', topic_label: 'auth', created_at: t - 30 }, // dedup — same label
      { session_id: 's2', topic_label: 'retrieval', created_at: t - 20 },
      { session_id: 's3', topic_label: 'indexing', created_at: t - 10 },
      { session_id: 's4', topic_label: 'telemetry', created_at: t - 5 },
      { session_id: 's5', topic_label: 'docs', created_at: t - 4 },
      { session_id: 's6', topic_label: 'bench', created_at: t - 3 },
    ]);
    const out = renderRecentThreads(db, PROJECT);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('## Recent Threads');
    const bullets = lines.filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(5);
    const labels = bullets.map((l) => l.split(' — ')[0].slice(2));
    expect(labels).toEqual(['bench', 'docs', 'telemetry', 'indexing', 'retrieval']);
  });

  it('limits to most recent 10 sessions before dedup', () => {
    // 11 old sessions + 1 new, each with a distinct topic label. Only the
    // newest 10 sessions should contribute candidates.
    const t = now();
    const chunks: Array<{ session_id: string; topic_label: string; created_at?: number }> = [];
    for (let i = 0; i < 11; i++) {
      chunks.push({ session_id: `old-${i}`, topic_label: `old-topic-${i}`, created_at: t - 10000 - i });
    }
    chunks.push({ session_id: 'new-1', topic_label: 'new-topic', created_at: t });
    seedTranscriptChunks(db, PROJECT, chunks);

    const out = renderRecentThreads(db, PROJECT);
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    const labels = bullets.map((l) => l.split(' — ')[0].slice(2));
    // Oldest (`old-topic-10`) falls outside the 10-session window.
    expect(labels).not.toContain('old-topic-10');
    expect(labels).toContain('new-topic');
  });

  it('cold start: no transcript_chunk rows → empty section', () => {
    expect(renderRecentThreads(db, PROJECT)).toBe('## Recent Threads\n\n');
  });
});

// ---------------------------------------------------------------------------
// Handoff + How-to-Query (Task 04-01-04)
// ---------------------------------------------------------------------------

describe('renderHandoff', () => {
  function makeProject(handoffBody: string | null, projectId = 'CLAUDEXv3'): void {
    // Register a synthetic project in projects.json so resolveProjectPath
    // returns our tmpHome project dir.
    const projDir = path.join(tmpHome, 'projects', projectId);
    fs.mkdirSync(projDir, { recursive: true });
    if (handoffBody !== null) {
      const handoffsDir = path.join(projDir, 'context', 'handoffs');
      fs.mkdirSync(handoffsDir, { recursive: true });
      fs.writeFileSync(path.join(handoffsDir, 'ACTIVE.md'), handoffBody);
    }
    const claudexDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(claudexDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudexDir, 'projects.json'),
      JSON.stringify({
        schema: 'claudex/project-registry',
        version: 1,
        projects: { [projectId]: { path: projDir } },
      }),
    );
  }

  it('missing ACTIVE.md renders the No active handoff fallback', () => {
    makeProject(null);
    expect(renderHandoff('CLAUDEXv3')).toBe('## Handoff\n\nNo active handoff.\n');
  });

  it('status=active + phase + topic renders one-line summary + See pointer', () => {
    const body =
      '---\nstatus: active\nphase: 5\ntopic: Test\n---\n# 2026-04-29 — Test\n\n**What we found:** highly specific phrase XYZ\n';
    makeProject(body);
    const out = renderHandoff('CLAUDEXv3');
    expect(out).toBe(
      '## Handoff\n\nActive handoff at phase 5: Test.\nSee: context/handoffs/ACTIVE.md\n',
    );
  });

  it('status=active with summary but no topic uses summary as the title slot', () => {
    const body =
      '---\nstatus: active\nphase: "4.1"\nsummary: Resume foo\n---\n# title\n';
    makeProject(body);
    const out = renderHandoff('CLAUDEXv3');
    expect(out).toContain('Active handoff at phase 4.1: Resume foo.');
  });

  it('status=paused renders the paused-at-phase line', () => {
    const body = '---\nstatus: paused\nphase: 3\n---\n# title\n';
    makeProject(body);
    const out = renderHandoff('CLAUDEXv3');
    expect(out).toBe(
      '## Handoff\n\nHandoff paused at phase 3.\nSee: context/handoffs/ACTIVE.md\n',
    );
  });

  it('status=archived renders the No active handoff line', () => {
    const body = '---\nstatus: archived\nphase: 1\n---\n# title\n';
    makeProject(body);
    expect(renderHandoff('CLAUDEXv3')).toBe('## Handoff\n\nNo active handoff.\n');
  });

  it('malformed YAML (no closing ---) renders No active handoff', () => {
    const body = "---\nstatus: active\nphase: 5\n# missing closing\n";
    makeProject(body);
    expect(renderHandoff('CLAUDEXv3')).toBe('## Handoff\n\nNo active handoff.\n');
  });

  it("legacy body shape (## Commander's Intent) without YAML header renders No active handoff", () => {
    const body = "## Commander's Intent\nintent\n\n## What's Left To Do\n- a\n";
    makeProject(body);
    expect(renderHandoff('CLAUDEXv3')).toBe('## Handoff\n\nNo active handoff.\n');
  });

  it('renders one-line summary, never body content (XYZ leak check)', () => {
    const body =
      '---\nstatus: active\nphase: 5\ntopic: Test\n---\n# title\n\n**What we found:** highly specific phrase XYZ\n\n**What we decided:** decided\n\n**What\'s next:** next\n\n**Where to look:** here\n';
    makeProject(body);
    const out = renderHandoff('CLAUDEXv3');
    expect(out).not.toContain('XYZ');
    expect(out).not.toContain('What we found');
  });
});

// ---------------------------------------------------------------------------
// Normalization + sentinel (Task 04-01-05)
// ---------------------------------------------------------------------------

describe('normalize / sentinelLine / parseSentinelHash', () => {
  it('normalize converts CRLF → LF, strips trailing whitespace, collapses blanks, exactly one trailing newline', () => {
    expect(normalize('a   \r\nb\r\n\r\n\r\nc')).toBe('a\nb\n\nc\n');
    expect(normalize('x\n')).toBe('x\n');
    expect(normalize('x\n\n\n\n')).toBe('x\n');
  });

  it('sentinelLine is stable across identical inputs', () => {
    const body = normalize('## Entities\n- a\n');
    expect(sentinelLine(body)).toBe(sentinelLine(body));
  });

  it('sentinelLine changes on content change, not on normalization-equivalent whitespace', () => {
    const a = normalize('## Entities\n- alpha\n');
    const b = normalize('## Entities   \n- alpha   \n\n\n');
    expect(sentinelLine(a)).toBe(sentinelLine(b));

    const c = normalize('## Entities\n- beta\n');
    expect(sentinelLine(a)).not.toBe(sentinelLine(c));
  });

  it('parseSentinelHash returns hex or null', () => {
    const line = sentinelLine('body\n');
    expect(parseSentinelHash(line)).toMatch(/^[0-9a-f]{64}$/);
    expect(parseSentinelHash('not a sentinel')).toBeNull();
    expect(
      parseSentinelHash('<!-- CLAUDEX-MANAGED: do not edit above user section. hash=nothex -->'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: curateMemoryMd (Task 04-01-06)
// ---------------------------------------------------------------------------

describe('curateMemoryMd — happy path + idempotency', () => {
  it('creates the file with valid sentinel on first run; second run is idempotent_noop', () => {
    ensureMemoryDir();
    seedEntities(db, PROJECT, [{ ref: 'entity:x', summary: 'x', importance: 5 }]);

    const first = curateMemoryMd(db, PROJECT);
    expect(first.written).toBe(true);
    expect(first.reason).toBe('wrote');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);

    const fileBytes = fs.readFileSync(memoryMdPathFor(), 'utf8');
    expect(fileBytes.startsWith('<!-- CLAUDEX-MANAGED:')).toBe(true);
    // Phase 4.1 CUR-09: ## Entities and ## Recent Threads dropped; ## Lessons added.
    expect(fileBytes).not.toContain('## Entities');
    expect(fileBytes).not.toContain('## Recent Threads');
    expect(fileBytes).toContain('## Active Projects');
    expect(fileBytes).toContain('## Lessons');
    expect(fileBytes).toContain('## Handoff');
    expect(fileBytes).toContain('## How to Query');
    expect(fileBytes).toContain('<!-- USER EDITABLE -->');
    expect(fileBytes).toContain('## User Notes');

    const second = curateMemoryMd(db, PROJECT);
    expect(second.written).toBe(false);
    expect(second.reason).toBe('idempotent_noop');
    expect(fs.readFileSync(memoryMdPathFor(), 'utf8')).toBe(fileBytes);
  });
});

describe('curateMemoryMd — user tail preservation', () => {
  it('preserves user content below <!-- USER EDITABLE --> byte-for-byte when inputs change', () => {
    ensureMemoryDir();
    // Phase 4.1 CUR-09: ## Entities is no longer rendered, so changing entity
    // seeds doesn't trigger a write. Use Active Projects (still rendered) to
    // drive a managed-section diff.
    seedActiveProjects(db, [{ project_id: 'test-proj-A', edits: 5 }]);
    curateMemoryMd(db, PROJECT);

    // User appends a note under ## User Notes.
    const initial = fs.readFileSync(memoryMdPathFor(), 'utf8');
    const withUserNote = initial.replace('## User Notes\n\n', '## User Notes\n\nmy note\n');
    fs.writeFileSync(memoryMdPathFor(), withUserNote);

    // Change an Angel input, re-run.
    seedActiveProjects(db, [{ project_id: 'test-proj-B', edits: 7 }]);
    const result = curateMemoryMd(db, PROJECT);
    expect(result.written).toBe(true);

    const after = fs.readFileSync(memoryMdPathFor(), 'utf8');
    expect(after).toContain('my note');
    expect(after).toContain('## User Notes');
    expect(after).toContain('test-proj-B');
  });

  it('user edits to the tail do not change the Angel-owned hash', () => {
    ensureMemoryDir();
    seedEntities(db, PROJECT, [{ ref: 'entity:x', summary: 'x', importance: 5 }]);
    const first = curateMemoryMd(db, PROJECT);
    const initialHash = first.hash;

    const current = fs.readFileSync(memoryMdPathFor(), 'utf8');
    fs.writeFileSync(memoryMdPathFor(), current.replace('## User Notes\n\n', '## User Notes\n\nuser line\n'));

    // Inputs unchanged — writer should no-op (file already matches what it
    // would produce, including the user's added line).
    const second = curateMemoryMd(db, PROJECT);
    expect(second.reason).toBe('idempotent_noop');
    expect(second.hash).toBe(initialHash);
    expect(fs.readFileSync(memoryMdPathFor(), 'utf8')).toContain('user line');
  });
});

describe('curateMemoryMd — refuse path', () => {
  it('file with USER EDITABLE marker but stripped sentinel → sentinel_missing + event', () => {
    ensureMemoryDir();
    const corrupted = `# Stripped top\n\nsome body\n\n<!-- USER EDITABLE -->\n\n## User Notes\n\nkeep me\n`;
    fs.writeFileSync(memoryMdPathFor(), corrupted);
    const mtimeBefore = fs.statSync(memoryMdPathFor()).mtimeMs;

    const result = curateMemoryMd(db, PROJECT);
    expect(result.written).toBe(false);
    expect(result.reason).toBe('sentinel_missing');

    // File not modified.
    expect(fs.readFileSync(memoryMdPathFor(), 'utf8')).toBe(corrupted);
    const mtimeAfter = fs.statSync(memoryMdPathFor()).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    // Refusal event recorded.
    const rows = db.prepare(
      `SELECT event_type, entity, detail FROM session_events
       WHERE event_type = 'memory_curation_refused' AND entity = ?`,
    ).all(memoryMdPathFor()) as Array<{ event_type: string; entity: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe('sentinel_missing');
  });
});

describe('curateMemoryMd — cold start + dir presence', () => {
  it('no memory dir → no_project_dir', () => {
    const result = curateMemoryMd(db, PROJECT);
    expect(result.written).toBe(false);
    expect(result.reason).toBe('no_project_dir');
  });

  it('memory dir but no existing MEMORY.md → creates one with empty user tail', () => {
    ensureMemoryDir();
    const result = curateMemoryMd(db, PROJECT);
    expect(result.written).toBe(true);
    const content = fs.readFileSync(memoryMdPathFor(), 'utf8');
    expect(content).toContain(USER_TAIL_DEFAULT.trim());
  });
});

describe('curateMemoryMd — size cap', () => {
  it('oversized inputs trim to ≤ 25KB and ≤ 200 lines, preserving all 5 section headers', () => {
    ensureMemoryDir();
    // Seed 30 entities, 20 projects (edits), and 20 threads.
    const longSummary = 'x'.repeat(200);
    const entRows: Array<{ ref: string; summary: string; importance: number }> = [];
    for (let i = 0; i < 30; i++) entRows.push({ ref: `e${i}`, summary: longSummary, importance: 3 });
    seedEntities(db, PROJECT, entRows);

    const apRows: Array<{ project_id: string; edits: number }> = [];
    for (let i = 0; i < 20; i++) apRows.push({ project_id: `proj${i}`, edits: i + 1 });
    seedActiveProjects(db, apRows);

    const chunks: Array<{ session_id: string; topic_label: string; created_at: number }> = [];
    const t = now();
    for (let i = 0; i < 20; i++) chunks.push({ session_id: `sess${i}`, topic_label: `topic${i}`, created_at: t - i });
    seedTranscriptChunks(db, PROJECT, chunks);

    const result = curateMemoryMd(db, PROJECT);
    expect(result.written).toBe(true);
    const content = fs.readFileSync(memoryMdPathFor(), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(content.split('\n').length).toBeLessThanOrEqual(MAX_LINES);

    // Phase 4.1 CUR-09: ## Entities and ## Recent Threads dropped; ## Lessons added.
    for (const header of ['## Active Projects', '## Lessons', '## Handoff', '## How to Query']) {
      expect(content).toContain(header);
    }
    expect(content).not.toContain('## Entities');
    expect(content).not.toContain('## Recent Threads');
  });
});

describe('curateMemoryMd — CRLF normalization', () => {
  it('CRLF in ACTIVE.md → written MEMORY.md has only LF line endings', () => {
    // Set up a project whose ACTIVE.md uses CRLF.
    const projDir = path.join(tmpHome, 'projects', 'LineEnds');
    fs.mkdirSync(path.join(projDir, 'context', 'handoffs'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'context', 'handoffs', 'ACTIVE.md'),
      "## Commander's Intent\r\nline A\r\nline B\r\n\r\n## What's Left To Do\r\n- t1\r\n",
    );
    const claudexDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(claudexDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudexDir, 'projects.json'),
      JSON.stringify({ schema: 'claudex/project-registry', version: 1, projects: { LineEnds: { path: projDir } } }),
    );

    // With the project-ID resolution fix, computeMemoryMdPath('LineEnds') now
    // resolves 'LineEnds' → projDir → pathToCcSlug(projDir). We must create
    // the memory dir at that resolved slug, not the raw 'LineEnds' slug.
    const resolvedMemDir = path.join(tmpHome, '.claude', 'projects', pathToCcSlug(projDir), 'memory');
    fs.mkdirSync(resolvedMemDir, { recursive: true });

    const result = curateMemoryMd(db, 'LineEnds');
    expect(result.written).toBe(true);
    const raw = fs.readFileSync(path.join(resolvedMemDir, 'MEMORY.md'));
    expect(raw.includes(0x0d)).toBe(false); // no CR anywhere
  });
});

// ---------------------------------------------------------------------------
// Path helpers + static block
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('computeMemoryMdPath places file under ~/.claude/projects/<slug>/memory/', () => {
    const p = computeMemoryMdPath(PROJECT);
    expect(p.endsWith(path.join('.claude', 'projects', toSlug(PROJECT), 'memory', 'MEMORY.md'))).toBe(true);
  });

  it('HOW_TO_QUERY_STATIC is stable and contains tool pointers', () => {
    expect(HOW_TO_QUERY_STATIC).toContain('claudex_search');
    expect(HOW_TO_QUERY_STATIC).toContain('claudex_events');
    expect(HOW_TO_QUERY_STATIC).toContain('claudex_recall');
    expect(HOW_TO_QUERY_STATIC).toContain('~/.claude/CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// 04-08-02: computeMemoryMdPath project-ID resolution fix
// ---------------------------------------------------------------------------

describe('computeMemoryMdPath — project-ID resolution (04-08-02)', () => {
  /**
   * Register a synthetic project in the temp HOME's projects.json so that
   * resolveProjectPath returns the given fsPath for the given projectId.
   */
  function registerProject(projectId: string, fsPath: string): void {
    const claudexDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(claudexDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudexDir, 'projects.json'),
      JSON.stringify({
        schema: 'claudex/project-registry',
        version: 1,
        projects: {
          [projectId]: { path: fsPath, created: '2026-01-01', status: 'active' },
        },
      }),
    );
  }

  it('registered project ID resolves to CC slug, not raw project ID', () => {
    // Simulate: project ID "claudex-v3" maps to a Windows-style absolute path.
    // The CC slug for that path (via pathToCcSlug) must appear in the result —
    // NOT the raw project ID "claudex-v3".
    // Path is arbitrary; resolveProjectPath returns it from the registry directly.
    const fakeProjectPath = path.join(tmpHome, 'Projects', 'CLAUDEXv3');
    registerProject('claudex-v3', fakeProjectPath);

    const result = computeMemoryMdPath('claudex-v3');

    // The resolved path must NOT use 'claudex-v3' as the slug directly
    // (that's the broken old behavior).
    // Check: the path must not contain '.claude/projects/claudex-v3/'
    const badSlugSegment = path.join('.claude', 'projects', 'claudex-v3', 'memory', 'MEMORY.md');
    expect(result).not.toContain(badSlugSegment);

    // The result must end with the correct MEMORY.md tail.
    expect(result.endsWith(path.join('memory', 'MEMORY.md'))).toBe(true);

    // The slug portion must contain 'CLAUDEXv3' (derived from the project path
    // via pathToCcSlug, which replaces separators/colons with dashes but keeps
    // alphanumeric chars and tildes intact).
    expect(result).toContain('CLAUDEXv3');
  });

  it('path-shaped input (contains separator) falls through to pathToCcSlug without registry lookup', () => {
    // No projects.json registered — resolveProjectPath returns null for a
    // path-shaped string. The heuristic must still apply pathToCcSlug.
    const pathInput = '/home/user/projects/MyApp';
    const result = computeMemoryMdPath(pathInput);
    expect(result.endsWith(path.join('memory', 'MEMORY.md'))).toBe(true);
    // No separator-containing segment in the slug portion
    const parts = result.split(path.sep);
    const projectsIdx = parts.lastIndexOf('.claude') + 2;
    const slugInPath = parts[projectsIdx];
    expect(slugInPath).not.toContain('/');
    expect(slugInPath).not.toContain('\\');
  });

  it('unresolvable project ID falls back to raw-ID slug (old behavior preserved)', () => {
    // No projects.json, no matching projects-dir scan entry.
    // resolveProjectPath returns null → falls back to using the ID verbatim.
    const unknownId = 'some-unknown-project-id';
    const result = computeMemoryMdPath(unknownId);
    expect(result).toContain(path.join('.claude', 'projects', unknownId, 'memory', 'MEMORY.md'));
  });
});
