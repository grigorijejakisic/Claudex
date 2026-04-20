import { describe, it, expect } from 'vitest';
import { composeBody } from '../../../core/migration/v17-compose.js';
import { KIND_MAPPING, P1_KINDS } from '../../../core/migration/kind-mapping.js';

describe('composeBody — V17 migration payload composition', () => {
  describe('kind: learning', () => {
    it('composes from a fully-populated learnings row', () => {
      const row = {
        id: 42,
        project: 'claudex-v3',
        agent_id: 'crux',
        fingerprint: 'fp-abc',
        content: 'Never call CC CLIProxyAPI from a hook (deadlock).',
        promotion_count: 3,
        first_seen_epoch: 1700000000,
        last_promoted_epoch: 1710000000,
        updated_at_epoch: 1720000000,
      };
      const out = composeBody('learning', row);
      expect(out.title).toBe('Never call CC CLIProxyAPI from a hook (deadlock).');
      expect(out.body).toBe('Never call CC CLIProxyAPI from a hook (deadlock).');
      expect(out.data).toEqual({
        agent_id: 'crux',
        fingerprint: 'fp-abc',
        promotion_count: 3,
        first_seen_epoch: 1700000000,
        last_promoted_epoch: 1710000000,
      });
      expect(out.scope).toBe('project');
      expect(out.status).toBe('active');
      expect(out.confidence).toBeNull();
      expect(out.session_id).toBeNull();
      expect(out.project_id).toBe('claudex-v3');
    });

    it('handles missing optional fields without throwing', () => {
      const row = { project: 'p', agent_id: 'a', fingerprint: 'f', content: 'c' };
      const out = composeBody('learning', row);
      expect(out.body).toBe('c');
      expect(out.data.promotion_count).toBeNull();
      expect(out.data.first_seen_epoch).toBeNull();
    });
  });

  describe('kind: decision', () => {
    it('composes from a fully-populated decisions row', () => {
      const row = {
        id: 7,
        session_id: 'sess-1',
        project: 'claudex-v3',
        content: 'Use sqlite-vec. It ships with the same file. No Qdrant.',
        source: 'explicit',
        fingerprint: 'dec-fp',
        timestamp_epoch: 1700000000,
        updated_at_epoch: 1700000100,
      };
      const out = composeBody('decision', row);
      expect(out.title).toBe('Use sqlite-vec.');
      expect(out.body).toBe('Use sqlite-vec. It ships with the same file. No Qdrant.');
      expect(out.data).toEqual({
        source: 'explicit',
        fingerprint: 'dec-fp',
        timestamp_epoch: 1700000000,
        alternatives: null,
      });
      expect(out.session_id).toBe('sess-1');
      expect(out.project_id).toBe('claudex-v3');
    });

    it('falls back to first line when no sentence boundary', () => {
      const row = { session_id: 's', project: 'p', content: 'no punctuation here', source: 'explicit', fingerprint: 'x' };
      const out = composeBody('decision', row);
      expect(out.title).toBe('no punctuation here');
    });
  });

  describe('kind: experience_pattern', () => {
    it('composes body as lesson + "\\n\\nWhat went wrong: " + anti_pattern', () => {
      const row = {
        id: 'uuid-abc',
        pattern_type: 'correction',
        trigger_context: 'user asked about scaling',
        lesson: 'Always ask about scale before implementing.',
        anti_pattern: 'Assumed single-node was fine.',
        severity: 'important',
        score: 5,
        times_triggered: 2,
        times_useful: 1,
        source_session: 'sess-9',
        source_project: 'claudex-v3',
        created_at_epoch: 1700000000,
        confidence: 0.75,
      };
      const out = composeBody('experience_pattern', row);
      expect(out.title).toBe('user asked about scaling');
      expect(out.body).toBe(
        'Always ask about scale before implementing.\n\nWhat went wrong: Assumed single-node was fine.'
      );
      expect(out.confidence).toBe(0.75);
      expect(out.session_id).toBe('sess-9');
      expect(out.project_id).toBe('claudex-v3');
      expect(out.data.pattern_type).toBe('correction');
      expect(out.data.score).toBe(5);
    });

    it('omits the "What went wrong" suffix when anti_pattern is null', () => {
      const row = {
        id: 'u',
        pattern_type: 'behavioral',
        trigger_context: 't',
        lesson: 'Do the thing.',
        anti_pattern: null,
        source_project: 'p',
        created_at_epoch: 0,
      };
      const out = composeBody('experience_pattern', row);
      expect(out.body).toBe('Do the thing.');
      expect(out.body).not.toContain('What went wrong');
    });
  });

  describe('kind: angel_opinion', () => {
    it('synthesizes title as subject + " — opinion"', () => {
      const row = {
        id: 3,
        project: 'claudex-v3',
        subject: 'test_harness_reliability',
        opinion: 'Tests must not mock Ollama.',
        confidence: 0.9,
        evidence_count: 5,
        reinforced_count: 2,
        weakened_count: 0,
        contradicted_count: 0,
        source_type: 'inferred',
        created_at_epoch: 1700000000,
        updated_at_epoch: 1700000100,
      };
      const out = composeBody('angel_opinion', row);
      expect(out.title).toBe('test_harness_reliability — opinion');
      expect(out.body).toBe('Tests must not mock Ollama.');
      expect(out.confidence).toBe(0.9);
      expect(out.data.subject).toBe('test_harness_reliability');
      expect(out.data.evidence_count).toBe(5);
      expect(out.project_id).toBe('claudex-v3');
      expect(out.session_id).toBeNull();
    });

    it('returns null title when subject is missing', () => {
      const row = { project: 'p', opinion: 'o' };
      const out = composeBody('angel_opinion', row);
      expect(out.title).toBeNull();
    });
  });

  describe('kind: critical_rule', () => {
    it('truncates title to 80 chars for long rule_text', () => {
      const longRule = 'A'.repeat(150);
      const row = {
        id: 1,
        project: 'p',
        rule_text: longRule,
        variants: null,
        source: 'author',
        drift_risk: 'safety',
        domain_tags: null,
        base_ttl: 10,
        current_ttl: 5,
      };
      const out = composeBody('critical_rule', row);
      expect(out.title).not.toBeNull();
      expect(out.title!.length).toBe(80);
      expect(out.body).toBe(longRule);
      expect(out.data.drift_risk).toBe('safety');
      expect(out.data.source).toBe('author');
    });

    it('preserves title under 80 chars unchanged', () => {
      const row = {
        id: 2,
        project: 'p',
        rule_text: 'short rule',
        source: 'system-promoted',
        drift_risk: 'style',
        base_ttl: 1,
      };
      const out = composeBody('critical_rule', row);
      expect(out.title).toBe('short rule');
    });
  });

  describe('kind: mental_model', () => {
    it('stores legacy supersedes_id in data._legacy_supersedes_id for Pass 2 resolution', () => {
      const row = {
        id: 10,
        project: 'p',
        type: 'mental_model',
        content: 'First line of model\nSecond line',
        tags: 'foo,bar',
        supersedes_id: 42,
        curator: 'agent',
        trust_tier: 3,
        status: 'active',
        source_session_id: 'sess-x',
        created_at_epoch: 1700000000,
        updated_at_epoch: 1700000100,
      };
      const out = composeBody('mental_model', row);
      expect(out.data._legacy_supersedes_id).toBe(42);
      expect(out.title).toBe('mental_model — First line of model');
      expect(out.body).toBe('First line of model\nSecond line');
      expect(out.status).toBe('active');
      expect(out.confidence).toBeCloseTo(1.0);
      expect(out.session_id).toBe('sess-x');
      expect(out.project_id).toBe('p');
      expect(out.data.type).toBe('mental_model');
      expect(out.data.curator).toBe('agent');
      expect(out.data.trust_tier).toBe(3);
    });

    it('omits _legacy_supersedes_id when supersedes_id is null', () => {
      const row = {
        id: 11,
        project: 'p',
        type: 'workspace_map',
        content: 'only line',
        supersedes_id: null,
        curator: 'angel',
        trust_tier: 2,
        status: 'active',
      };
      const out = composeBody('mental_model', row);
      expect(out.data).not.toHaveProperty('_legacy_supersedes_id');
    });

    it('normalizes trust_tier 2 → confidence 0.667', () => {
      const row = { id: 1, project: 'p', type: 'shipped', content: 'c', curator: 'agent', trust_tier: 2, status: 'active' };
      const out = composeBody('mental_model', row);
      expect(out.confidence).toBeCloseTo(2 / 3);
    });

    it('passes stale status through verbatim', () => {
      const row = { id: 1, project: 'p', type: 't', content: 'c', curator: 'agent', trust_tier: 2, status: 'stale' };
      const out = composeBody('mental_model', row);
      expect(out.status).toBe('stale');
    });
  });

  describe('structural invariants', () => {
    it('KIND_MAPPING has exactly 6 entries (no entity_summary per Amendment 1)', () => {
      expect(Object.keys(KIND_MAPPING).length).toBe(6);
      expect(Object.keys(KIND_MAPPING)).not.toContain('artifacts');
    });

    it('P1_KINDS matches KIND_MAPPING values', () => {
      const mappedKinds = Object.values(KIND_MAPPING).map((m) => m.kind).sort();
      const p1Sorted = [...P1_KINDS].sort();
      expect(mappedKinds).toEqual(p1Sorted);
    });

    it('every kind returns a non-null body even with minimum-data legacy row', () => {
      for (const kind of P1_KINDS) {
        const row = { content: 'placeholder', rule_text: 'r', opinion: 'o', lesson: 'l', trigger_context: 't' };
        const out = composeBody(kind, row);
        expect(typeof out.body).toBe('string');
      }
    });

    it('throws on unknown kind', () => {
      expect(() => composeBody('unknown_kind' as never, {})).toThrow();
    });
  });
});
