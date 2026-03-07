import { describe, it, expect } from 'vitest';
import { validateLearningsStore } from '../../src/cm-adapter/learnings.js';

describe('validateLearningsStore', () => {
  it('returns valid store unchanged', () => {
    const input = {
      version: 1,
      max_entries: 50,
      learnings: [
        {
          id: 'abc',
          text: 'test learning',
          source_session: 's1',
          created_at: '2026-01-01T00:00:00Z',
          last_promoted_at: '2026-01-01T00:00:00Z',
          promotion_count: 1,
          last_checkpoint_id: 'cp1',
        },
      ],
    };

    const result = validateLearningsStore(input);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].text).toBe('test learning');
    expect(result.max_entries).toBe(50);
  });

  it('returns empty store for null', () => {
    const result = validateLearningsStore(null);
    expect(result.learnings).toEqual([]);
    expect(result.version).toBe(1);
    expect(result.max_entries).toBe(50);
  });

  it('returns empty store for undefined', () => {
    const result = validateLearningsStore(undefined);
    expect(result.learnings).toEqual([]);
  });

  it('returns empty store for a string', () => {
    const result = validateLearningsStore('not an object');
    expect(result.learnings).toEqual([]);
  });

  it('returns empty store when learnings is not an array', () => {
    const result = validateLearningsStore({ version: 1, max_entries: 50, learnings: 'bad' });
    expect(result.learnings).toEqual([]);
  });

  it('returns empty store for empty object (no learnings key)', () => {
    const result = validateLearningsStore({});
    expect(result.learnings).toEqual([]);
  });

  it('fixes invalid max_entries (zero)', () => {
    const result = validateLearningsStore({ version: 1, max_entries: 0, learnings: [] });
    expect(result.max_entries).toBe(50);
  });

  it('fixes invalid max_entries (negative)', () => {
    const result = validateLearningsStore({ version: 1, max_entries: -5, learnings: [] });
    expect(result.max_entries).toBe(50);
  });

  it('fixes invalid max_entries (string)', () => {
    const result = validateLearningsStore({ version: 1, max_entries: 'bad', learnings: [] });
    expect(result.max_entries).toBe(50);
  });

  it('fixes missing max_entries', () => {
    const result = validateLearningsStore({ version: 1, learnings: [] });
    expect(result.max_entries).toBe(50);
  });

  it('preserves valid max_entries', () => {
    const result = validateLearningsStore({ version: 1, max_entries: 50, learnings: [] });
    expect(result.max_entries).toBe(50);
  });

  it('accepts object with learnings array even if missing other fields', () => {
    const result = validateLearningsStore({ learnings: [] });
    expect(result.learnings).toEqual([]);
    expect(result.max_entries).toBe(50);
  });
});
