/**
 * Phase 8.5 — Self-instrumentation probe runtime.
 *
 * Backs the two Vesna probes:
 *   - recall-observability-gap-detection (OBS-02 gold template)
 *   - recall-observability-empty-surface (OBS-02 empty template)
 *
 * Probes assert on the directive *surface* (CLAUDEX_INSTRUCTIONS payload
 * content), NOT the agent's actual narration output. Behavioral output
 * is non-deterministic and out of scope for v1; Phase 10 may add
 * spot-checks if the full suite needs them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  buildNarrationDirective,
  isNarrationSilent,
  setNarrationSilent,
  NARRATION_DIRECTIVE_BODY,
} from '../../intelligence/narration-directive.js';
import {
  recordRetrieval,
  listSessionRetrievals,
  aggregateSessionCost,
} from '../../intelligence/retrieval-log.js';

describe('Phase 8.5 — self-instrumentation probes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Probe — recall-observability-gap-detection', () => {
    it('directive surfaces gold-result template when narration is on', () => {
      const directive = buildNarrationDirective(false);
      expect(directive).toContain('## When You Recall — Narrate (advisory)');
      expect(directive).toContain('checking');
      expect(directive).toContain('applying');
    });

    it('advisory voice — no imperative line starts in directive body', () => {
      for (const ln of NARRATION_DIRECTIVE_BODY.split('\n')) {
        expect(ln).not.toMatch(/^You must /);
        expect(ln).not.toMatch(/^You shall /);
        expect(ln).not.toMatch(/^Always /);
        expect(ln).not.toMatch(/^Never /);
      }
    });
  });

  describe('Probe — recall-observability-empty-surface', () => {
    it('directive surfaces empty-surface template', () => {
      const directive = buildNarrationDirective(false);
      expect(directive).toContain('no prior experience');
      expect(directive).toContain('going in cold');
    });

    it('directive surfaces ambiguous-result template', () => {
      const directive = buildNarrationDirective(false);
      expect(directive).toContain('some prior context');
      expect(directive).toContain('proceeding with caution');
    });
  });

  describe('Silent toggle suppresses directive', () => {
    it('buildNarrationDirective(true) returns empty', () => {
      expect(buildNarrationDirective(true)).toBe('');
    });

    it('setNarrationSilent persists per-session', () => {
      expect(isNarrationSilent(db, 'sess-1')).toBe(false);
      setNarrationSilent(db, 'sess-1', true);
      expect(isNarrationSilent(db, 'sess-1')).toBe(true);
      expect(isNarrationSilent(db, 'sess-2')).toBe(false);
    });
  });

  describe('Retrieval log integration', () => {
    it('recordRetrieval inserts a row visible to listSessionRetrievals', () => {
      const id = recordRetrieval(db, {
        sessionId: 'sess-x',
        surface: 'claudex_search',
        query: 'rate-limit shadowban',
        topKResults: [{ id: 1, source: 'artifacts', score: 0.9 }],
        responseText: 'rate-limit shadowban content goes here',
      });
      expect(id).toBeGreaterThan(0);
      const rows = listSessionRetrievals(db, 'sess-x');
      expect(rows.length).toBe(1);
      expect(rows[0].surface).toBe('claudex_search');
      expect(rows[0].token_cost).toBeGreaterThan(0);
    });

    it('aggregateSessionCost reports invocations + tokens', () => {
      recordRetrieval(db, {
        sessionId: 'sess-y',
        surface: 'claudex_search',
        query: 'q1',
        topKResults: [],
        responseText: 'short',
      });
      recordRetrieval(db, {
        sessionId: 'sess-y',
        surface: 'claudex_recall',
        query: 'id:1',
        topKResults: [{ id: 1, source: 'artifacts', score: 1.0 }],
        responseText: 'longer response text here for token cost',
      });
      const agg = aggregateSessionCost(db, 'sess-y');
      expect(agg.invocations).toBe(2);
      expect(agg.totalTokens).toBeGreaterThan(0);
      expect(agg.bySurface.claudex_search.count).toBe(1);
      expect(agg.bySurface.claudex_recall.count).toBe(1);
    });
  });
});
