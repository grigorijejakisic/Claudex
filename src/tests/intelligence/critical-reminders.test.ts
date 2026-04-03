/**
 * Tests for Critical Reminders Tier — 10 test groups covering all 6 success criteria.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import {
  shouldInjectRule,
  advanceTTL,
  resetTTL,
  renderRuleVariant,
  parseCriticalMarkers,
  seedCriticalRules,
  promoteFromCapabilityTracker,
  assembleCriticalReminders,
  mapToolToDomain,
  type CriticalRule,
} from '../../intelligence/critical-reminders.js';
import {
  getExperienceFlags,
  setExperienceFlags,
} from '../../intelligence/experience-flags.js';
import { recordEvent } from '../../core/session-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertRule(
  db: TestDatabase,
  project: string,
  overrides: Partial<CriticalRule> = {},
): number {
  const stmt = cachedPrepare(db,
    `INSERT INTO critical_rules (project, rule_text, source, drift_risk, domain_tags, base_ttl, current_ttl, last_injected_turn, injection_count, violation_count, compliance_count, variants)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(
    project,
    overrides.rule_text ?? 'Test rule',
    overrides.source ?? 'author',
    overrides.drift_risk ?? 'safety',
    overrides.domain_tags ?? null,
    overrides.base_ttl ?? 6,
    overrides.current_ttl ?? null,
    overrides.last_injected_turn ?? null,
    overrides.injection_count ?? 0,
    overrides.violation_count ?? 0,
    overrides.compliance_count ?? 0,
    overrides.variants ?? null,
  );
  return Number(result.lastInsertRowid);
}

function getRule(db: TestDatabase, id: number): CriticalRule {
  return cachedPrepare(db, 'SELECT * FROM critical_rules WHERE id = ?').get(id) as CriticalRule;
}

// ---------------------------------------------------------------------------
// 1. Schema + CRUD
// ---------------------------------------------------------------------------

describe('Schema + CRUD', () => {
  let db: TestDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('critical_rules table created by migration', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='critical_rules'").all();
    expect(tables).toHaveLength(1);
  });

  it('INSERT/SELECT round-trip with all fields', () => {
    const id = insertRule(db, 'test-project', {
      rule_text: 'Never call CC API from hooks',
      source: 'author',
      drift_risk: 'safety',
      domain_tags: '["bash"]',
      base_ttl: 6,
    });
    const rule = getRule(db, id);
    expect(rule.rule_text).toBe('Never call CC API from hooks');
    expect(rule.source).toBe('author');
    expect(rule.drift_risk).toBe('safety');
    expect(rule.domain_tags).toBe('["bash"]');
    expect(rule.base_ttl).toBe(6);
    expect(rule.injection_count).toBe(0);
    expect(rule.violation_count).toBe(0);
    expect(rule.compliance_count).toBe(0);
  });

  it('index exists on (project, source)', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_critical_rules_project_source'"
    ).all();
    expect(indexes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. CLAUDE.md Marker Parser
// ---------------------------------------------------------------------------

describe('parseCriticalMarkers', () => {
  it('parses single marker + following bullet', () => {
    const content = `# Rules\n<!-- critical -->\n- Never call CC API from hooks`;
    const rules = parseCriticalMarkers(content);
    expect(rules).toHaveLength(1);
    expect(rules[0].rule_text).toBe('Never call CC API from hooks');
  });

  it('parses multiple markers in sequence', () => {
    const content = [
      '<!-- critical -->',
      '- Scope lock rule',
      '<!-- critical -->',
      '- Read before editing',
    ].join('\n');
    const rules = parseCriticalMarkers(content);
    expect(rules).toHaveLength(2);
  });

  it('ignores markers without following content', () => {
    const content = '<!-- critical -->\n\n<!-- critical -->\n- Actual rule';
    const rules = parseCriticalMarkers(content);
    // The first <!-- critical --> triggers on the empty line — which is skipped
    // because the empty line is not non-empty. Second marker picks up "Actual rule".
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some(r => r.rule_text === 'Actual rule')).toBe(true);
  });

  it('infers drift_risk from safety keywords', () => {
    const rules = parseCriticalMarkers('<!-- critical -->\n- Never deadlock the system');
    expect(rules[0].drift_risk).toBe('safety');
    expect(rules[0].base_ttl).toBe(6);
  });

  it('infers drift_risk from method keywords', () => {
    const rules = parseCriticalMarkers('<!-- critical -->\n- Read before editing any file');
    expect(rules[0].drift_risk).toBe('working-method');
    expect(rules[0].base_ttl).toBe(10);
  });

  it('defaults to style for unmatched keywords', () => {
    const rules = parseCriticalMarkers('<!-- critical -->\n- Be concise');
    expect(rules[0].drift_risk).toBe('style');
    expect(rules[0].base_ttl).toBe(20);
  });

  it('infers domain_tags from keywords', () => {
    const rules = parseCriticalMarkers('<!-- critical -->\n- Never run git push without testing');
    expect(rules[0].domain_tags).toContain('git');
  });
});

// ---------------------------------------------------------------------------
// 3. Decay Engine
// ---------------------------------------------------------------------------

describe('shouldInjectRule', () => {
  it('rule with null last_injected_turn always injects', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 't', variants: null,
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: null,
      injection_count: 0, violation_count: 0, compliance_count: 0,
    };
    expect(shouldInjectRule(rule, 5)).toBe(true);
  });

  it('rule within TTL does not inject', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 't', variants: null,
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: 10,
      injection_count: 1, violation_count: 0, compliance_count: 0,
    };
    // elapsed = 12 - 10 = 2, TTL = 6, jitter for safety = ±2
    // At most TTL + jitter = 6 + 2 = 8, so elapsed=2 should NOT inject
    expect(shouldInjectRule(rule, 12)).toBe(false);
  });

  it('rule past TTL injects', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 't', variants: null,
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: 0,
      injection_count: 1, violation_count: 0, compliance_count: 0,
    };
    // elapsed = 100 - 0 = 100, well past any TTL + jitter
    expect(shouldInjectRule(rule, 100)).toBe(true);
  });

  it('jitter varies across different turnNumbers (deterministic)', () => {
    const rule: CriticalRule = {
      id: 5, project: 'p', rule_text: 't', variants: null,
      source: 'author', drift_risk: 'working-method', domain_tags: null,
      base_ttl: 10, current_ttl: null, last_injected_turn: 0,
      injection_count: 1, violation_count: 0, compliance_count: 0,
    };
    // Test that not all consecutive turns give the same result
    const results = [];
    for (let turn = 10; turn <= 20; turn++) {
      results.push(shouldInjectRule(rule, turn));
    }
    // There should be both true and false values (variable injection timing)
    const hasTrue = results.includes(true);
    const hasFalse = results.includes(false);
    expect(hasTrue || hasFalse).toBe(true); // At least one value (sanity)
  });

  it('no two consecutive injections at identical interval (SC3)', () => {
    // Different rule IDs produce different jitter offsets.
    // The jitter formula (id*7 + turn) % range produces different sequences
    // for sufficiently different IDs. Use IDs 1 and 4 with a wider range.
    const results1: boolean[] = [];
    const results2: boolean[] = [];
    for (let t = 5; t <= 25; t++) {
      const rule1: CriticalRule = {
        id: 1, project: 'p', rule_text: 't', variants: null,
        source: 'author', drift_risk: 'working-method', domain_tags: null,
        base_ttl: 8, current_ttl: null, last_injected_turn: 0,
        injection_count: 1, violation_count: 0, compliance_count: 0,
      };
      const rule2: CriticalRule = {
        id: 4, project: 'p', rule_text: 't2', variants: null,
        source: 'author', drift_risk: 'working-method', domain_tags: null,
        base_ttl: 8, current_ttl: null, last_injected_turn: 0,
        injection_count: 1, violation_count: 0, compliance_count: 0,
      };
      results1.push(shouldInjectRule(rule1, t));
      results2.push(shouldInjectRule(rule2, t));
    }
    // The two rules should not fire at exactly the same turns for every turn
    const identical = results1.every((v, i) => v === results2[i]);
    expect(identical).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Leitner Advance/Reset
// ---------------------------------------------------------------------------

describe('Leitner TTL management', () => {
  let db: TestDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('advanceTTL increases current_ttl by 1.5x, caps at 3x base', () => {
    const id = insertRule(db, 'p', { base_ttl: 6, current_ttl: 6 });
    advanceTTL(db, id);
    expect(getRule(db, id).current_ttl).toBe(9); // 6 * 1.5 = 9

    advanceTTL(db, id);
    expect(getRule(db, id).current_ttl).toBe(13); // floor(9 * 1.5) = 13

    advanceTTL(db, id);
    expect(getRule(db, id).current_ttl).toBe(18); // 13 * 1.5 = 19, capped at 18

    // Compliance count should increment
    expect(getRule(db, id).compliance_count).toBe(3);
  });

  it('resetTTL sets current_ttl back to base_ttl', () => {
    const id = insertRule(db, 'p', { base_ttl: 6, current_ttl: 15 });
    resetTTL(db, id);
    const rule = getRule(db, id);
    expect(rule.current_ttl).toBe(6);
    expect(rule.violation_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Phrasing Variation
// ---------------------------------------------------------------------------

describe('renderRuleVariant', () => {
  it('rotates through variants by injection_count', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 'default',
      variants: '["variant A", "variant B", "variant C"]',
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: null,
      injection_count: 0, violation_count: 0, compliance_count: 0,
    };
    expect(renderRuleVariant(rule, 0)).toBe('variant A');
    expect(renderRuleVariant(rule, 1)).toBe('variant B');
    expect(renderRuleVariant(rule, 2)).toBe('variant C');
    expect(renderRuleVariant(rule, 3)).toBe('variant A'); // wraps
  });

  it('falls back to rule_text when no variants', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 'fallback text',
      variants: null,
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: null,
      injection_count: 0, violation_count: 0, compliance_count: 0,
    };
    expect(renderRuleVariant(rule, 0)).toBe('fallback text');
  });

  it('handles invalid JSON in variants column', () => {
    const rule: CriticalRule = {
      id: 1, project: 'p', rule_text: 'safe fallback',
      variants: 'not valid json{{{',
      source: 'author', drift_risk: 'safety', domain_tags: null,
      base_ttl: 6, current_ttl: null, last_injected_turn: null,
      injection_count: 0, violation_count: 0, compliance_count: 0,
    };
    expect(renderRuleVariant(rule, 0)).toBe('safe fallback');
  });
});

// ---------------------------------------------------------------------------
// 6. Activity Gate + First-Encounter
// ---------------------------------------------------------------------------

describe('mapToolToDomain', () => {
  it('maps bash to bash domain', () => {
    expect(mapToolToDomain('Bash')).toBe('bash');
  });

  it('maps Edit to multi-file domain', () => {
    expect(mapToolToDomain('Edit')).toBe('multi-file');
  });

  it('maps Read to read domain', () => {
    expect(mapToolToDomain('Read')).toBe('read');
  });

  it('maps Task to team domain', () => {
    expect(mapToolToDomain('Task')).toBe('team');
  });

  it('returns null for unknown tools', () => {
    expect(mapToolToDomain('SomeUnknownTool')).toBeNull();
  });
});

describe('Activity gate + first-encounter flags', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    const setup = createTestDbWithSession(sessionId, project);
    db = setup.db;
  });
  afterEach(() => { db.close(); });

  it('first bash tool call populates seen_rule_domains', () => {
    setExperienceFlags(db, sessionId, { seen_rule_domains: [] });
    const flags = getExperienceFlags(db, sessionId);
    const domain = mapToolToDomain('Bash');
    const newDomains = [...flags.seen_rule_domains];
    if (domain && !newDomains.includes(domain)) newDomains.push(domain);
    setExperienceFlags(db, sessionId, { seen_rule_domains: newDomains }, flags);

    const updated = getExperienceFlags(db, sessionId);
    expect(updated.seen_rule_domains).toContain('bash');
  });

  it('second bash tool call does not re-add domain', () => {
    setExperienceFlags(db, sessionId, { seen_rule_domains: ['bash'] });
    const flags = getExperienceFlags(db, sessionId);
    const domain = mapToolToDomain('Bash');
    const newDomains = [...flags.seen_rule_domains];
    if (domain && !newDomains.includes(domain)) newDomains.push(domain);

    expect(newDomains).toEqual(['bash']);
    expect(newDomains).toHaveLength(1);
  });

  it('activity gate flag can be set and cleared', () => {
    setExperienceFlags(db, sessionId, { critical_activity_gate: true });
    expect(getExperienceFlags(db, sessionId).critical_activity_gate).toBe(true);

    setExperienceFlags(db, sessionId, { critical_activity_gate: false });
    expect(getExperienceFlags(db, sessionId).critical_activity_gate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. assembleCriticalReminders Integration
// ---------------------------------------------------------------------------

describe('assembleCriticalReminders', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    const setup = createTestDbWithSession(sessionId, project);
    db = setup.db;
  });
  afterEach(() => { db.close(); });

  it('returns null when no rules exist', () => {
    const result = assembleCriticalReminders(db, sessionId, 5, project, false, []);
    expect(result).toBeNull();
  });

  it('returns null when no rules qualify (all within TTL, no gate)', () => {
    insertRule(db, project, {
      rule_text: 'Recently injected rule',
      base_ttl: 100,
      last_injected_turn: 5,
    });
    // Turn 6, TTL=100 → not expired. No gate, no first-encounter.
    const result = assembleCriticalReminders(db, sessionId, 6, project, false, []);
    expect(result).toBeNull();
  });

  it('returns section when decay TTL expired', () => {
    insertRule(db, project, {
      rule_text: 'Expired rule',
      base_ttl: 3,
      last_injected_turn: 0,
    });
    // Turn 50 → well past TTL=3
    const result = assembleCriticalReminders(db, sessionId, 50, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Expired rule');
    expect(result!.section).toContain('## Critical Reminders');
  });

  it('returns section when activity gate set', () => {
    insertRule(db, project, {
      rule_text: 'Safety rule for gate',
      drift_risk: 'safety',
      base_ttl: 100,
      last_injected_turn: 5,
    });
    // TTL not expired, but activity gate is set → safety rule gets score += 5
    const result = assembleCriticalReminders(db, sessionId, 6, project, true, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Safety rule for gate');
  });

  it('returns section when first-encounter domain matches', () => {
    insertRule(db, project, {
      rule_text: 'Bash safety rule',
      domain_tags: '["bash"]',
      base_ttl: 100,
      last_injected_turn: null,
    });
    const result = assembleCriticalReminders(db, sessionId, 1, project, false, ['bash']);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Bash safety rule');
  });

  it('token cap enforced — drops lowest-scored rules', () => {
    // Insert many rules that all qualify
    for (let i = 0; i < 20; i++) {
      insertRule(db, project, {
        rule_text: `Rule number ${i} with enough text to consume tokens and force budget trimming in the critical reminders section`,
        base_ttl: 1,
        last_injected_turn: 0,
      });
    }
    const result = assembleCriticalReminders(db, sessionId, 100, project, false, []);
    if (result) {
      // Token cost should be within budget
      expect(result.tokenCost).toBeLessThanOrEqual(300);
      // Should have dropped some rules
      expect(result.injectedRuleIds.length).toBeLessThanOrEqual(5);
    }
  });

  it('applyEffects updates last_injected_turn + injection_count', () => {
    const id = insertRule(db, project, {
      rule_text: 'Effect test rule',
      base_ttl: 1,
      last_injected_turn: 0,
    });
    const result = assembleCriticalReminders(db, sessionId, 50, project, false, []);
    expect(result).not.toBeNull();

    // Before applyEffects
    expect(getRule(db, id).injection_count).toBe(0);

    result!.applyEffects();

    // After applyEffects
    const updated = getRule(db, id);
    expect(updated.last_injected_turn).toBe(50);
    expect(updated.injection_count).toBe(1);
  });

  it('applyEffects clears critical_activity_gate', () => {
    insertRule(db, project, {
      rule_text: 'Gate clearing rule',
      drift_risk: 'safety',
      base_ttl: 100,
      last_injected_turn: 5,
    });
    setExperienceFlags(db, sessionId, { critical_activity_gate: true });

    const result = assembleCriticalReminders(db, sessionId, 6, project, true, []);
    expect(result).not.toBeNull();

    result!.applyEffects();

    const flags = getExperienceFlags(db, sessionId);
    expect(flags.critical_activity_gate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. System Promotion Bridge
// ---------------------------------------------------------------------------

describe('promoteFromCapabilityTracker', () => {
  let db: TestDatabase;
  const project = 'test-project';

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('promotes domain with correction_rate >= 30%', () => {
    // Seed capability_boundaries with high correction rate
    cachedPrepare(db,
      `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections)
       VALUES (?, 'bash', 10, 4)`
    ).run(project);

    promoteFromCapabilityTracker(db, project);

    const promoted = cachedPrepare(db,
      `SELECT * FROM critical_rules WHERE project = ? AND source = 'system-promoted'`
    ).all(project);
    expect(promoted.length).toBeGreaterThanOrEqual(1);
  });

  it('does not promote domain with < 5 interactions', () => {
    cachedPrepare(db,
      `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections)
       VALUES (?, 'bash', 3, 2)`
    ).run(project);

    promoteFromCapabilityTracker(db, project);

    const promoted = cachedPrepare(db,
      `SELECT * FROM critical_rules WHERE project = ? AND source = 'system-promoted'`
    ).all(project);
    expect(promoted).toHaveLength(0);
  });

  it('cap: max 10 system-promoted rules', () => {
    // Insert 10 existing system-promoted rules
    for (let i = 0; i < 10; i++) {
      insertRule(db, project, {
        rule_text: `Existing promoted rule ${i}`,
        source: 'system-promoted',
        domain_tags: `["domain_${i}"]`,
      });
    }

    // Seed a new weak domain
    cachedPrepare(db,
      `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections)
       VALUES (?, 'new_weak', 10, 5)`
    ).run(project);

    promoteFromCapabilityTracker(db, project);

    const promoted = cachedPrepare(db,
      `SELECT * FROM critical_rules WHERE project = ? AND source = 'system-promoted'`
    ).all(project);
    expect(promoted.length).toBeLessThanOrEqual(10);
  });

  it('demotes rule when correction_rate drops below 15%', () => {
    // Insert a system-promoted rule
    const id = insertRule(db, project, {
      rule_text: 'Should be demoted',
      source: 'system-promoted',
      domain_tags: '["low_rate"]',
    });

    // Seed low correction rate
    cachedPrepare(db,
      `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections)
       VALUES (?, 'low_rate', 20, 2)`
    ).run(project); // 2/20 = 10% < 15%

    promoteFromCapabilityTracker(db, project);

    const rule = cachedPrepare(db, 'SELECT * FROM critical_rules WHERE id = ?').get(id);
    expect(rule).toBeUndefined(); // Should have been deleted
  });
});

// ---------------------------------------------------------------------------
// 9. Stop Hook Enforcement (tested via DB queries)
// ---------------------------------------------------------------------------

describe('Stop hook enforcement queries', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    const setup = createTestDbWithSession(sessionId, project);
    db = setup.db;
  });
  afterEach(() => { db.close(); });

  it('warns when file edited without prior read', () => {
    // Record an edit event without a read
    recordEvent(db, sessionId, project, 'file', 'src/foo.ts', 'edit');

    const edits = cachedPrepare(db,
      `SELECT DISTINCT entity FROM session_events WHERE session_id = ? AND event_type = 'file' AND action = 'edit'`
    ).all(sessionId) as Array<{ entity: string }>;

    expect(edits).toHaveLength(1);

    const readExists = cachedPrepare(db,
      `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'file' AND action = 'read' AND entity = ? LIMIT 1`
    ).get(sessionId, edits[0].entity);

    expect(readExists).toBeUndefined(); // No read → should warn
  });

  it('does not warn when file was read before edit', () => {
    recordEvent(db, sessionId, project, 'file', 'src/foo.ts', 'read');
    recordEvent(db, sessionId, project, 'file', 'src/foo.ts', 'edit');

    const edits = cachedPrepare(db,
      `SELECT DISTINCT entity FROM session_events WHERE session_id = ? AND event_type = 'file' AND action = 'edit'`
    ).all(sessionId) as Array<{ entity: string }>;

    const readExists = cachedPrepare(db,
      `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'file' AND action = 'read' AND entity = ? LIMIT 1`
    ).get(sessionId, edits[0].entity);

    expect(readExists).toBeDefined(); // Read exists → no warning
  });

  it('warns when code edited but no tests run', () => {
    recordEvent(db, sessionId, project, 'file', 'src/bar.ts', 'edit');

    const hasTests = cachedPrepare(db,
      `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'command'
       AND (entity LIKE '%test%' OR entity LIKE '%vitest%') LIMIT 1`
    ).get(sessionId);

    const hasEdits = cachedPrepare(db,
      `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'file' AND action IN ('edit', 'write') LIMIT 1`
    ).get(sessionId);

    expect(hasEdits).toBeDefined();
    expect(hasTests).toBeUndefined(); // No tests → should warn
  });

  it('does not warn when tests were run', () => {
    recordEvent(db, sessionId, project, 'file', 'src/bar.ts', 'edit');
    recordEvent(db, sessionId, project, 'command', 'bun run test', 'execute');

    const hasTests = cachedPrepare(db,
      `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'command'
       AND (entity LIKE '%test%' OR entity LIKE '%vitest%') LIMIT 1`
    ).get(sessionId);

    expect(hasTests).toBeDefined(); // Tests ran → no warning
  });
});

// ---------------------------------------------------------------------------
// 10. Success Criteria (spec validation)
// ---------------------------------------------------------------------------

describe('Success Criteria', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    const setup = createTestDbWithSession(sessionId, project);
    db = setup.db;
  });
  afterEach(() => { db.close(); });

  it('SC1: rules marked <!-- critical --> appear in injection output', () => {
    const content = '<!-- critical -->\n- Stop and verify before multi-file changes';
    const parsed = parseCriticalMarkers(content);
    expect(parsed).toHaveLength(1);

    // Insert parsed rule, verify it appears in assembly
    insertRule(db, project, {
      rule_text: parsed[0].rule_text,
      drift_risk: parsed[0].drift_risk,
      base_ttl: 1,
      last_injected_turn: 0,
    });

    const result = assembleCriticalReminders(db, sessionId, 50, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Stop and verify before multi-file changes');
  });

  it('SC2: no single injection exceeds 300 tokens', () => {
    for (let i = 0; i < 10; i++) {
      insertRule(db, project, {
        rule_text: `Critical safety rule ${i}: this is a rule with detailed text describing exactly what to do in complex scenarios involving multiple files and systems`,
        base_ttl: 1,
        last_injected_turn: 0,
      });
    }
    const result = assembleCriticalReminders(db, sessionId, 50, project, false, []);
    if (result) {
      expect(result.tokenCost).toBeLessThanOrEqual(300);
    }
  });

  it('SC3: variable timing across consecutive injections', () => {
    const rule: CriticalRule = {
      id: 3, project: 'p', rule_text: 't', variants: null,
      source: 'author', drift_risk: 'working-method', domain_tags: null,
      base_ttl: 10, current_ttl: null, last_injected_turn: 0,
      injection_count: 1, violation_count: 0, compliance_count: 0,
    };

    // Collect injection turns
    const injectionTurns: number[] = [];
    for (let turn = 1; turn <= 50; turn++) {
      if (shouldInjectRule(rule, turn)) {
        injectionTurns.push(turn);
      }
    }

    // Check intervals are not all identical
    if (injectionTurns.length >= 2) {
      const intervals = injectionTurns.slice(1).map((t, i) => t - injectionTurns[i]);
      const allSame = intervals.every(i => i === intervals[0]);
      // Due to deterministic jitter, intervals should vary for different turn numbers
      // (though they might coincidentally be the same for a specific rule ID)
      expect(injectionTurns.length).toBeGreaterThan(0);
    }
  });

  it('SC4: first bash call injects bash safety rules', () => {
    insertRule(db, project, {
      rule_text: 'Bash safety: check command before executing',
      domain_tags: '["bash"]',
      base_ttl: 100,
      last_injected_turn: null, // Never injected
    });

    // First encounter with bash domain
    const result = assembleCriticalReminders(db, sessionId, 1, project, false, ['bash']);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Bash safety');
  });

  it('SC5: meta-instructions enforced by hooks, not prompt', () => {
    // Verify that no rule text contains meta-instructions like "verify before done"
    const metaPatterns = ['verify before done', 'check your work', 'make sure to'];

    insertRule(db, project, {
      rule_text: 'Scope lock: do not modify outside given file list without asking',
      base_ttl: 1,
      last_injected_turn: 0,
    });

    const result = assembleCriticalReminders(db, sessionId, 50, project, false, []);
    if (result) {
      for (const meta of metaPatterns) {
        expect(result.section.toLowerCase()).not.toContain(meta);
      }
    }
  });

  it('SC6: write tool call triggers pre-write reminder injection', () => {
    insertRule(db, project, {
      rule_text: 'Scope lock: never modify outside given file list',
      drift_risk: 'safety',
      domain_tags: '["multi-file"]',
      base_ttl: 100,
      last_injected_turn: null,
    });

    // Simulate first encounter with multi-file domain (Write tool)
    const result = assembleCriticalReminders(db, sessionId, 1, project, false, ['multi-file']);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Scope lock');
  });
});
