import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';
import { applyGeneratedDDL, generateViewsAndTriggers } from '../../../core/migration/v17-triggers.js';
import { KIND_MAPPING } from '../../../core/migration/kind-mapping.js';

function mkMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  applyV17DDL(db);
  applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING));
  return db;
}

describe('V17 generator — structural', () => {
  it('emits 6 views and 18 triggers (6 × 3)', () => {
    const generated = generateViewsAndTriggers(KIND_MAPPING);
    expect(generated.length).toBe(6);
    const triggerNames = generated.flatMap((g) => [
      /CREATE TRIGGER (\w+)/.exec(g.insertTriggerSql)?.[1],
      /CREATE TRIGGER (\w+)/.exec(g.updateTriggerSql)?.[1],
      /CREATE TRIGGER (\w+)/.exec(g.deleteTriggerSql)?.[1],
    ]).filter(Boolean) as string[];
    expect(triggerNames.length).toBe(18);
  });

  it('all 6 legacy view names emitted', () => {
    const generated = generateViewsAndTriggers(KIND_MAPPING);
    const names = generated.map((g) => g.legacyTable).sort();
    expect(names).toEqual([
      'angel_opinions',
      'critical_rules',
      'decisions',
      'experience_patterns',
      'learnings',
      'project_curated_context',
    ]);
  });
});

describe('V17 learnings view — kernel + INSTEAD OF', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('INSERT through view creates artifact + legacy_id_map row', () => {
    db.prepare(`
      INSERT INTO learnings(project, agent_id, fingerprint, content)
      VALUES (?, ?, ?, ?)
    `).run('claudex-v3', 'crux', 'fp-1', 'test lesson');

    const art = db.prepare('SELECT id, kind, body, project FROM artifact').get() as {
      id: string; kind: string; body: string; project: string;
    };
    expect(art.kind).toBe('learning');
    expect(art.body).toBe('test lesson');
    expect(art.project).toBe('claudex-v3');

    const map = db.prepare('SELECT legacy_table, legacy_id, new_uuid FROM legacy_id_map').get() as {
      legacy_table: string; legacy_id: number; new_uuid: string;
    };
    expect(map.legacy_table).toBe('learnings');
    expect(map.new_uuid).toBe(art.id);
    expect(typeof map.legacy_id).toBe('number');
  });

  it('SELECT through view projects v3 INTEGER id back from legacy_id_map', () => {
    db.prepare(`
      INSERT INTO learnings(project, agent_id, fingerprint, content)
      VALUES (?, ?, ?, ?)
    `).run('p', 'a', 'fp', 'content');

    const row = db.prepare('SELECT id, project, agent_id, fingerprint, content, promotion_count FROM learnings').get() as {
      id: number; project: string; agent_id: string; fingerprint: string; content: string; promotion_count: number | null;
    };
    expect(typeof row.id).toBe('number');
    expect(row.project).toBe('p');
    expect(row.agent_id).toBe('a');
    expect(row.fingerprint).toBe('fp');
    expect(row.content).toBe('content');
  });

  it('UPDATE content through view propagates to artifact.body', () => {
    db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?, ?, ?, ?)`).run('p', 'a', 'fp', 'old');
    const { id } = db.prepare('SELECT id FROM learnings').get() as { id: number };
    db.prepare('UPDATE learnings SET content = ? WHERE id = ?').run('new-content', id);
    const { body } = db.prepare('SELECT body FROM artifact').get() as { body: string };
    expect(body).toBe('new-content');
  });

  it('DELETE through view removes artifact and legacy_id_map row', () => {
    db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?, ?, ?, ?)`).run('p', 'a', 'fp', 'x');
    const { id } = db.prepare('SELECT id FROM learnings').get() as { id: number };
    db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
    const artCount = (db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number }).n;
    const mapCount = (db.prepare('SELECT COUNT(*) AS n FROM legacy_id_map').get() as { n: number }).n;
    expect(artCount).toBe(0);
    expect(mapCount).toBe(0);
  });
});

describe('V17 decisions view', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('INSERT + SELECT round-trip preserves session_id + source', () => {
    db.prepare(`
      INSERT INTO decisions(session_id, project, content, source, fingerprint, timestamp_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('sess-1', 'p', 'we decided to use jose', 'explicit', 'fp-d', 1700000000);

    const row = db.prepare('SELECT id, session_id, project, content, source, fingerprint FROM decisions').get() as Record<string, unknown>;
    expect(typeof row.id).toBe('number');
    expect(row.session_id).toBe('sess-1');
    expect(row.project).toBe('p');
    expect(row.content).toBe('we decided to use jose');
    expect(row.source).toBe('explicit');
    expect(row.fingerprint).toBe('fp-d');
  });
});

describe('V17 experience_patterns view — UUID id preservation + computed body', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('preserves UUID id verbatim (no legacy_id_map entry)', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('uuid-abc-123', 'correction', 'ctx', 'lesson text', 'p', 1000, 5);

    const art = db.prepare('SELECT id FROM artifact').get() as { id: string };
    expect(art.id).toBe('uuid-abc-123');
    const mapRows = db.prepare("SELECT * FROM legacy_id_map WHERE legacy_table = 'experience_patterns'").all();
    expect(mapRows.length).toBe(0);
  });

  it('composes body as lesson + "\\n\\nWhat went wrong: " + anti_pattern', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, anti_pattern, source_project, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('u1', 'correction', 't', 'do X', 'assumed Y', 'p', 0);

    const art = db.prepare('SELECT body FROM artifact').get() as { body: string };
    expect(art.body).toBe('do X\n\nWhat went wrong: assumed Y');
  });

  it('splits body back into lesson + anti_pattern on SELECT', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, anti_pattern, source_project, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('u2', 'correction', 't', 'the lesson', 'the anti', 'p', 0);

    const row = db.prepare('SELECT lesson, anti_pattern FROM experience_patterns').get() as { lesson: string; anti_pattern: string };
    expect(row.lesson).toBe('the lesson');
    expect(row.anti_pattern).toBe('the anti');
  });

  it('null anti_pattern round-trips as null', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('u3', 'behavioral', 't', 'just the lesson', 'p', 0);

    const row = db.prepare('SELECT lesson, anti_pattern FROM experience_patterns').get() as { lesson: string; anti_pattern: string | null };
    expect(row.lesson).toBe('just the lesson');
    expect(row.anti_pattern).toBeNull();
  });
});

describe('V17 computed-UPDATE: score = score + 2 through INSTEAD OF UPDATE (caveat #4)', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('propagates NEW.score post-evaluation to data.$.score', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p1', 'correction', 't', 'l', 'proj', 0, 5);

    db.prepare("UPDATE experience_patterns SET score = score + 2 WHERE id = ?").run('p1');

    const { score } = db.prepare(`SELECT json_extract(data, '$.score') AS score FROM artifact WHERE id = ?`).get('p1') as { score: number };
    expect(score).toBe(7);
  });

  it('propagates string concat on root_cause via NEW', () => {
    db.prepare(`
      INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, root_cause)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p2', 'correction', 't', 'l', 'proj', 0, 'initial');
    db.prepare("UPDATE experience_patterns SET root_cause = COALESCE(root_cause, '') || ' more' WHERE id = ?").run('p2');
    const { rc } = db.prepare(`SELECT json_extract(data, '$.root_cause') AS rc FROM artifact WHERE id = ?`).get('p2') as { rc: string };
    expect(rc).toBe('initial more');
  });
});

describe('V17 angel_opinions view', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('synthesizes title and preserves confidence', () => {
    db.prepare(`INSERT INTO angel_opinions(project, subject, opinion, confidence, source_type) VALUES (?, ?, ?, ?, ?)`)
      .run('p', 'X', 'Y', 0.9, 'inferred');
    const art = db.prepare('SELECT title, body, confidence FROM artifact').get() as { title: string; body: string; confidence: number };
    expect(art.title).toBe('X — opinion');
    expect(art.body).toBe('Y');
    expect(art.confidence).toBeCloseTo(0.9);
  });
});

describe('V17 critical_rules view', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('INSERT populates drift_risk in data JSON', () => {
    db.prepare(`
      INSERT INTO critical_rules(project, rule_text, source, drift_risk, base_ttl)
      VALUES (?, ?, ?, ?, ?)
    `).run('p', 'the rule', 'author', 'safety', 10);
    const { drift_risk } = db.prepare(`SELECT json_extract(data, '$.drift_risk') AS drift_risk FROM artifact`).get() as { drift_risk: string };
    expect(drift_risk).toBe('safety');
  });
});

describe('V17 project_curated_context view — mental_model + supersedes lazy resolution', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('INSERT + SELECT round-trip', () => {
    db.prepare(`
      INSERT INTO project_curated_context(project, type, content, curator, trust_tier, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('p', 'mental_model', 'content', 'agent', 3, 'active');
    const row = db.prepare('SELECT id, project, type, content, curator, trust_tier, status FROM project_curated_context').get() as Record<string, unknown>;
    expect(typeof row.id).toBe('number');
    expect(row.type).toBe('mental_model');
    expect(row.curator).toBe('agent');
    expect(row.trust_tier).toBe(3);
    expect(row.status).toBe('active');
  });

  it('supersedes_id stashed in _pending_supersedes on INSERT, visible on SELECT', () => {
    db.prepare(`
      INSERT INTO project_curated_context(project, type, content, supersedes_id, curator, trust_tier, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p', 'mental_model', 'c', 42, 'agent', 2, 'active');

    // Since legacy_id_map has no entry for id=42, the view reads from _pending_supersedes.
    const row = db.prepare('SELECT supersedes_id FROM project_curated_context').get() as { supersedes_id: number | null };
    expect(row.supersedes_id).toBe(42);
  });
});

describe('V17 cross-kind isolation', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('INSERT into learnings does not appear in decisions', () => {
    db.prepare(`INSERT INTO learnings(project, agent_id, fingerprint, content) VALUES (?, ?, ?, ?)`).run('p', 'a', 'fp', 'x');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(n).toBe(0);
  });

  it('INSERT into decisions does not appear in learnings', () => {
    db.prepare(`INSERT INTO decisions(session_id, project, content, source, fingerprint) VALUES (?, ?, ?, ?, ?)`)
      .run('s', 'p', 'c', 'explicit', 'fp');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM learnings').get() as { n: number };
    expect(n).toBe(0);
  });
});
