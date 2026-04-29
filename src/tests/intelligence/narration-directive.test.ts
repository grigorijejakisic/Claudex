/**
 * Phase 8.5 — narration-directive module tests.
 *
 * Covers:
 *   - buildNarrationDirective (content / advisory voice / silent branch)
 *   - isNarrationSilent / setNarrationSilent (per-session persistence)
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

describe('narration-directive helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // buildNarrationDirective
  // -------------------------------------------------------------------------

  it('buildNarrationDirective(false) returns the directive body containing all 3 templates', () => {
    const out = buildNarrationDirective(false);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('no prior experience');
    expect(out).toContain('going in cold');
    expect(out).toContain('checking');
    expect(out).toContain('applying');
    expect(out).toContain('some prior context');
    expect(out).toContain('proceeding with caution');
  });

  it('buildNarrationDirective(true) returns empty string (suppressed)', () => {
    expect(buildNarrationDirective(true)).toBe('');
  });

  it('directive body contains the section header', () => {
    const out = buildNarrationDirective(false);
    expect(out).toContain('## When You Recall — Narrate (advisory)');
  });

  it('directive body uses advisory voice (no imperative line starts)', () => {
    for (const ln of NARRATION_DIRECTIVE_BODY.split('\n')) {
      expect(ln).not.toMatch(/^You must /);
      expect(ln).not.toMatch(/^You shall /);
      expect(ln).not.toMatch(/^Always /);
      expect(ln).not.toMatch(/^Never /);
    }
  });

  it('directive body cites the advisory voice (Phase 7 alignment cue)', () => {
    expect(NARRATION_DIRECTIVE_BODY.toLowerCase()).toContain('advisory');
  });

  // -------------------------------------------------------------------------
  // silent flag persistence
  // -------------------------------------------------------------------------

  it('isNarrationSilent: returns false on a fresh session (no row)', () => {
    expect(isNarrationSilent(db, 'sess-1')).toBe(false);
  });

  it('setNarrationSilent: setting true → isNarrationSilent returns true', () => {
    setNarrationSilent(db, 'sess-1', true);
    expect(isNarrationSilent(db, 'sess-1')).toBe(true);
  });

  it('setNarrationSilent: setting false → isNarrationSilent returns false', () => {
    setNarrationSilent(db, 'sess-1', true);
    setNarrationSilent(db, 'sess-1', false);
    expect(isNarrationSilent(db, 'sess-1')).toBe(false);
  });

  it('setNarrationSilent: per-session scope', () => {
    setNarrationSilent(db, 'sess-1', true);
    expect(isNarrationSilent(db, 'sess-1')).toBe(true);
    expect(isNarrationSilent(db, 'sess-2')).toBe(false);
  });

  it('setNarrationSilent: idempotent — re-setting same value does not throw', () => {
    expect(() => {
      setNarrationSilent(db, 'sess-1', true);
      setNarrationSilent(db, 'sess-1', true);
      setNarrationSilent(db, 'sess-1', true);
    }).not.toThrow();
    expect(isNarrationSilent(db, 'sess-1')).toBe(true);
  });
});
