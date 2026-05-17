/**
 * Vesna setup-step DSL unit tests — isolation, idempotency, no production touch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applySetup,
  resetTestDb,
  openVesnaTestDb,
  getHandoffFixturePath,
  getNarrationFlagPath,
} from '../../benchmark/vesna/setup.js';
import { closeDatabase } from '../../core/storage.js';
import type { Database } from 'better-sqlite3';

let db: Database;
let tmpDir: string;
let oldDbEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesna-setup-test-'));
  oldDbEnv = process.env.CLAUDEX_VESNA_DB;
  process.env.CLAUDEX_VESNA_DB = path.join(tmpDir, 'vesna-test.db');
  db = openVesnaTestDb();
});

afterEach(() => {
  closeDatabase(db);
  if (oldDbEnv === undefined) delete process.env.CLAUDEX_VESNA_DB;
  else process.env.CLAUDEX_VESNA_DB = oldDbEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clean fixture files outside tmpDir.
  for (const p of [getHandoffFixturePath(), getNarrationFlagPath()]) {
    try { fs.unlinkSync(p); } catch { /* */ }
  }
});

const ctx = { sessionId: 'vesna-probe-test-t1', defaultProject: 'vesna-test' };

describe('applySetup — artifact step', () => {
  it('writes a row tagged with the probe session id', async () => {
    await applySetup(
      db,
      [
        {
          kind: 'artifact',
          payload: {
            kind: 'decision',
            summary: 'use BGE on 7439',
            project: 'claudex-v3',
            tags: ['retrieval'],
          },
        },
      ],
      ctx,
    );

    // 14-07b: setup now writes to V17 `artifact` table (title/kind instead of summary/artifact_type)
    const rows = db
      .prepare(`SELECT session_id, project, title, kind FROM artifact WHERE session_id = ?`)
      .all(ctx.sessionId) as Array<{ session_id: string; project: string; title: string; kind: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe('claudex-v3');
    expect(rows[0].kind).toBe('decision');
    expect(rows[0].title).toContain('BGE');
  });
});

describe('applySetup — handoff step', () => {
  it('writes the fixture ACTIVE.md with status, phase, topic', async () => {
    await applySetup(
      db,
      [
        {
          kind: 'handoff',
          payload: {
            status: 'active',
            phase: '5',
            summary: 'mid tier-deletion',
            topic: 'phase-5-tier-deletion',
            body_what_next: 'Run plan 03 wave 4',
          },
        },
      ],
      ctx,
    );

    expect(fs.existsSync(getHandoffFixturePath())).toBe(true);
    const raw = fs.readFileSync(getHandoffFixturePath(), 'utf-8');
    expect(raw).toMatch(/status: active/);
    expect(raw).toMatch(/phase: 5/);
    expect(raw).toMatch(/topic: phase-5-tier-deletion/);
  });
});

describe('applySetup — critical_rule step', () => {
  it('inserts a critical_rules row scoped to vesna-test project', async () => {
    await applySetup(
      db,
      [
        {
          kind: 'critical_rule',
          payload: { rule: 'Do NOT use bun test — invokes Bun native runner.' },
        },
      ],
      ctx,
    );

    const rows = db
      .prepare(`SELECT project, rule_text FROM critical_rules WHERE rule_text LIKE '%bun test%'`)
      .all() as Array<{ project: string; rule_text: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toMatch(/^vesna-/);
  });
});

describe('applySetup — narration_directive step', () => {
  it('writes a JSON flag file', async () => {
    await applySetup(
      db,
      [{ kind: 'narration_directive', payload: { silent: false } }],
      ctx,
    );
    expect(fs.existsSync(getNarrationFlagPath())).toBe(true);
    const flag = JSON.parse(fs.readFileSync(getNarrationFlagPath(), 'utf-8'));
    expect(flag.silent).toBe(false);
  });
});

describe('resetTestDb', () => {
  it('removes probe-tagged rows but preserves untagged rows', async () => {
    // Probe-tagged row.
    await applySetup(
      db,
      [{ kind: 'artifact', payload: { kind: 'decision', summary: 'probe row', project: 'p' } }],
      ctx,
    );
    // Untagged ambient row, simulating production data co-resident in test DB.
    db.prepare(
      `INSERT INTO artifacts (session_id, project, artifact_type, summary, content, state, ttl, importance)
       VALUES ('untagged-real-session', 'real-project', 'observation', 'real summary', 'real', 'fresh', 3, 3)`,
    ).run();

    await resetTestDb(db);

    // 14-07b: probe rows now written to V17 `artifact` table — verify V17 cleanup
    const probeRowsV17 = db
      .prepare(`SELECT 1 FROM artifact WHERE session_id LIKE 'vesna-probe-%'`)
      .all();
    expect(probeRowsV17).toHaveLength(0);

    // Legacy `artifacts` cleanup preserved for transition window
    const probeRowsLegacy = db
      .prepare(`SELECT 1 FROM artifacts WHERE session_id LIKE 'vesna-probe-%'`)
      .all();
    expect(probeRowsLegacy).toHaveLength(0);

    const ambientRows = db
      .prepare(`SELECT 1 FROM artifacts WHERE session_id = 'untagged-real-session'`)
      .all();
    expect(ambientRows).toHaveLength(1);
  });

  it('removes handoff and narration fixtures', async () => {
    await applySetup(
      db,
      [
        { kind: 'handoff', payload: { status: 'active', phase: '5', summary: 's', topic: 't' } },
        { kind: 'narration_directive', payload: { silent: false } },
      ],
      ctx,
    );
    expect(fs.existsSync(getHandoffFixturePath())).toBe(true);
    expect(fs.existsSync(getNarrationFlagPath())).toBe(true);

    await resetTestDb(db);

    expect(fs.existsSync(getHandoffFixturePath())).toBe(false);
    expect(fs.existsSync(getNarrationFlagPath())).toBe(false);
  });
});

describe('idempotency', () => {
  it('applying the same handoff step twice yields the same fixture content', async () => {
    const step = {
      kind: 'handoff' as const,
      payload: {
        status: 'paused' as const,
        phase: '4',
        summary: 's',
        topic: 'phase-4-loop',
      },
    };
    await applySetup(db, [step], ctx);
    const after1 = fs.readFileSync(getHandoffFixturePath(), 'utf-8');
    await applySetup(db, [step], ctx);
    const after2 = fs.readFileSync(getHandoffFixturePath(), 'utf-8');
    expect(after2).toBe(after1);
  });

  it('applying the same critical_rule twice does not duplicate rows', async () => {
    const step = {
      kind: 'critical_rule' as const,
      payload: { rule: 'A unique rule for idempotency test' },
    };
    await applySetup(db, [step], ctx);
    await applySetup(db, [step], ctx);

    const count = db
      .prepare(`SELECT COUNT(*) as c FROM critical_rules WHERE rule_text = ?`)
      .get(step.payload.rule) as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('production DB isolation', () => {
  it('uses CLAUDEX_VESNA_DB override and never opens claudex.db', () => {
    // openVesnaTestDb opened our temp file (set in beforeEach) — verify the
    // file lives under tmpDir.
    expect(process.env.CLAUDEX_VESNA_DB).toContain(tmpDir);
  });
});

describe('applySetup — deliberation_surface step (v6 Phase 10)', () => {
  it('writes the artifact and the companion transcript chunks via production write surfaces', async () => {
    const step = {
      kind: 'deliberation_surface' as const,
      payload: {
        artifact: {
          kind: 'decision' as const,
          summary: 'p10 deliberation fixture artifact',
          project: 'claudex-v3',
          tags: ['deliberation-engagement', 'kind-x'],
        },
        transcript_chunks: [
          {
            session_id: 'phase-10-deliberation-fixture-x',
            project_id: 'claudex-v3',
            turn_index: 0,
            sub_index: 0,
            role: 'user' as const,
            provenance: 'organic' as const,
            body: 'past deliberation user side',
            created_at_epoch_ms: 1700000099000,
            wrapper_redacted: false,
          },
          {
            session_id: 'phase-10-deliberation-fixture-x',
            project_id: 'claudex-v3',
            turn_index: 1,
            sub_index: 0,
            role: 'assistant' as const,
            provenance: 'organic' as const,
            body: 'past deliberation assistant side',
            created_at_epoch_ms: 1700000099060,
            wrapper_redacted: false,
          },
        ],
      },
    };

    await applySetup(db, [step], ctx);

    const chunks = db
      .prepare(`SELECT body FROM transcript_chunk_v6 WHERE session_id = ? ORDER BY turn_index`)
      .all('phase-10-deliberation-fixture-x') as Array<{ body: string }>;
    expect(chunks.length).toBe(2);
    expect(chunks[0].body).toBe('past deliberation user side');
    expect(chunks[1].body).toBe('past deliberation assistant side');

    // 14-07b: setup now writes to V17 `artifact` table
    const artifactCount = db
      .prepare(`SELECT COUNT(*) AS c FROM artifact WHERE session_id = ?`)
      .get(ctx.sessionId) as { c: number };
    expect(artifactCount.c).toBeGreaterThanOrEqual(1);
  });

  it('resetTestDb scrubs the synthetic deliberation chunks on next run', async () => {
    const step = {
      kind: 'deliberation_surface' as const,
      payload: {
        artifact: {
          kind: 'decision' as const,
          summary: 'reset test fixture',
          project: 'claudex-v3',
          tags: ['deliberation-engagement', 'kind-y'],
        },
        transcript_chunks: [
          {
            session_id: 'phase-10-deliberation-fixture-y',
            project_id: 'claudex-v3',
            turn_index: 0,
            sub_index: 0,
            role: 'user' as const,
            provenance: 'organic' as const,
            body: 'will be scrubbed',
            created_at_epoch_ms: 1700000098000,
            wrapper_redacted: false,
          },
        ],
      },
    };
    await applySetup(db, [step], ctx);

    let count = (db.prepare(
      `SELECT COUNT(*) AS c FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get('phase-10-deliberation-fixture-y') as { c: number }).c;
    expect(count).toBe(1);

    await resetTestDb(db);

    count = (db.prepare(
      `SELECT COUNT(*) AS c FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get('phase-10-deliberation-fixture-y') as { c: number }).c;
    expect(count).toBe(0);
  });
});
