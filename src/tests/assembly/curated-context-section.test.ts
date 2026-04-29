/**
 * Tests for formatCuratedContextSection in src/assembly/sections.ts.
 *
 * Covers: empty state, project-only, global-only, mixed, grouping order,
 * provenance rendering, proposed markers, token-cap eviction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { writeEntry } from '../../core/curated-context.js';
import { formatCuratedContextSection } from '../../assembly/sections.js';
import { GLOBAL_PROJECT_SCOPE } from '../../shared/constants.js';

describe('formatCuratedContextSection', () => {
  let db: TestDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null when there are no entries', () => {
    const out = formatCuratedContextSection(db, 'proj-a');
    expect(out).toBeNull();
  });

  it('renders a single mental model entry', () => {
    writeEntry(db, {
      project: 'proj-a',
      type: 'mental_model',
      content: 'Racing the stale feed, not courtsiding settlement lag.',
      curator: 'agent',
    });
    const out = formatCuratedContextSection(db, 'proj-a');
    expect(out).not.toBeNull();
    expect(out).toContain('## Project Curated Context');
    expect(out).toContain('### Mental Model');
    expect(out).toContain('Racing the stale feed');
    expect(out).toContain('Supersedes CLAUDE.md on conflict');
  });

  it('renders global section before project section', () => {
    writeEntry(db, {
      project: 'proj-a',
      type: 'mental_model',
      content: 'project theory',
      curator: 'agent',
    });
    writeEntry(db, {
      project: GLOBAL_PROJECT_SCOPE,
      type: 'preference',
      content: 'global preference',
      curator: 'agent',
    });

    const out = formatCuratedContextSection(db, 'proj-a');
    expect(out).not.toBeNull();
    const globalIdx = out!.indexOf('Global');
    const mentalIdx = out!.indexOf('Mental Model');
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(mentalIdx).toBeGreaterThanOrEqual(0);
    expect(globalIdx).toBeLessThan(mentalIdx);
  });

  it('renders project groups in canonical order: mental → reframe → preference → constraint → workspace → shipped', () => {
    writeEntry(db, { project: 'proj-a', type: 'shipped', content: 'shipped item', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'workspace_map', content: 'code: /tmp', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'constraint', content: 'do not touch X', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'preference', content: 'prefer Y', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'reframe', content: 'new reframe', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'mental_model', content: 'the theory', curator: 'agent' });

    const out = formatCuratedContextSection(db, 'proj-a')!;
    const order = [
      out.indexOf('### Mental Model'),
      out.indexOf('### Reframes'),
      out.indexOf('### Preferences'),
      out.indexOf('### Constraints'),
      out.indexOf('### Workspace Map'),
      out.indexOf('### Shipped'),
    ];
    // All must be present
    expect(order.every(i => i >= 0)).toBe(true);
    // Ascending monotonic
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });

  it('marks proposed entries with [proposed]', () => {
    writeEntry(db, {
      project: 'proj-a',
      type: 'mental_model',
      content: 'unconfirmed angel theory',
      curator: 'angel',
    });
    const out = formatCuratedContextSection(db, 'proj-a')!;
    expect(out).toContain('[proposed]');
    expect(out).toContain('unconfirmed angel theory');
  });

  it('marks promoted entries with [promoted]', async () => {
    const { promoteEntry } = await import('../../core/curated-context.js');
    const id = writeEntry(db, {
      project: GLOBAL_PROJECT_SCOPE,
      type: 'preference',
      content: 'permanent rule',
      curator: 'agent',
    });
    promoteEntry(db, id);
    const out = formatCuratedContextSection(db, 'proj-a')!;
    expect(out).toContain('[promoted]');
  });

  it('omits session-id provenance from rendered text (CACH-03)', () => {
    writeEntry(db, {
      project: 'proj-a',
      type: 'mental_model',
      content: 'with provenance',
      curator: 'agent',
      source_session_id: 'deadbeef12345678',
    });
    const out = formatCuratedContextSection(db, 'proj-a')!;
    // CACH-03: session UUID slice is volatile state — must not leak into rendered output.
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('with provenance');
  });

  it('does not leak entries from other projects', () => {
    writeEntry(db, { project: 'proj-a', type: 'mental_model', content: 'theory-A', curator: 'agent' });
    writeEntry(db, { project: 'proj-b', type: 'mental_model', content: 'theory-B', curator: 'agent' });
    const outA = formatCuratedContextSection(db, 'proj-a')!;
    expect(outA).toContain('theory-A');
    expect(outA).not.toContain('theory-B');
  });

  it('evicts proposed entries first when over token cap', () => {
    // Set a tiny cap so eviction is forced.
    // Mental model entries → auto-evictable if not reframe/constraint.
    writeEntry(db, { project: 'proj-a', type: 'reframe', content: 'load-bearing reframe', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'mental_model', content: 'lower priority active entry that has some length to it so eviction actually matters', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'mental_model', content: 'angel proposed entry that has some length to it so eviction actually matters', curator: 'angel' });

    // 30-token cap — tight enough to force eviction
    const out = formatCuratedContextSection(db, 'proj-a', 30)!;
    // Proposed entry should be evicted first
    expect(out).not.toContain('[proposed]');
    // Load-bearing reframe should survive
    expect(out).toContain('load-bearing reframe');
  });

  it('never auto-evicts reframe or constraint entries', () => {
    writeEntry(db, { project: 'proj-a', type: 'reframe', content: 'reframe R', curator: 'agent' });
    writeEntry(db, { project: 'proj-a', type: 'constraint', content: 'constraint C', curator: 'agent' });

    // Extremely tight cap — even these should survive because they're load-bearing
    const out = formatCuratedContextSection(db, 'proj-a', 10)!;
    expect(out).toContain('reframe R');
    expect(out).toContain('constraint C');
  });

  it('falls back to pathological shell when even load-bearing entries exceed cap', () => {
    // Construct a case where only evictable entries are present and cap is too small.
    writeEntry(db, {
      project: 'proj-a',
      type: 'mental_model',
      content: 'a very long mental model that cannot possibly fit in a 5-token cap no matter how we try to evict',
      curator: 'agent',
    });
    const out = formatCuratedContextSection(db, 'proj-a', 5)!;
    expect(out).toContain('## Project Curated Context');
  });
});
