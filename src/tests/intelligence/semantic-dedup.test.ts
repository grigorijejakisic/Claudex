import {
  normalizeForDedup,
  porterStem,
  extractKeywords,
  keywordJaccard,
  isDuplicate,
  findDuplicate,
} from '../../intelligence/semantic-dedup.js';

describe('normalizeForDedup', () => {
  it('strips punctuation and lowercases', () => {
    expect(normalizeForDedup('We should use SQLite!')).toBe('we should use sqlite');
  });

  it('collapses whitespace', () => {
    expect(normalizeForDedup('use   SQLite   for   storage')).toBe('use sqlite for storage');
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeForDedup('')).toBe('');
    expect(normalizeForDedup(null as unknown as string)).toBe('');
    expect(normalizeForDedup(undefined as unknown as string)).toBe('');
  });
});

describe('porterStem', () => {
  it('stems -ing words', () => {
    expect(porterStem('running')).toBe('run');
  });

  it('stems -ed words', () => {
    expect(porterStem('configured')).toBe('configur');
  });

  it('stems -tion words', () => {
    // relational -> relat (ational -> ate, then no further)
    expect(porterStem('relational')).toBe('relat');
  });

  it('stems -ies words', () => {
    expect(porterStem('ponies')).toBe('poni');
  });

  it('returns short words unchanged', () => {
    expect(porterStem('go')).toBe('go');
    expect(porterStem('a')).toBe('a');
  });

  it('is non-throwing on empty input', () => {
    expect(porterStem('')).toBe('');
    expect(porterStem(null as unknown as string)).toBe(null);
  });
});

describe('extractKeywords', () => {
  it('removes stop words', () => {
    const keywords = extractKeywords('use SQLite for the storage');
    expect(keywords).toContain(porterStem('use'));
    expect(keywords).toContain(porterStem('sqlite'));
    expect(keywords).toContain(porterStem('storage'));
    expect(keywords).not.toContain('for');
    expect(keywords).not.toContain('the');
  });

  it('returns unique keywords', () => {
    const keywords = extractKeywords('use use use');
    expect(keywords).toEqual([porterStem('use')]);
  });

  it('returns empty array for empty input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(null as unknown as string)).toEqual([]);
  });
});

describe('keywordJaccard', () => {
  it('returns 1.0 for identical text', () => {
    expect(keywordJaccard('use SQLite for storage', 'use SQLite for storage')).toBe(1.0);
  });

  it('returns 0.0 for completely different text', () => {
    expect(keywordJaccard('implement OAuth flow', 'fix database migration')).toBe(0);
  });

  it('returns ~0.5 for partial overlap', () => {
    // "use sqlite storage" keywords overlap partially with "sqlite storage layer"
    const score = keywordJaccard('use SQLite storage', 'SQLite storage layer');
    expect(score).toBeGreaterThanOrEqual(0.4);
    expect(score).toBeLessThanOrEqual(0.8);
  });

  it('returns 0 for empty inputs', () => {
    expect(keywordJaccard('', '')).toBe(0);
    expect(keywordJaccard('hello', '')).toBe(0);
  });
});

describe('isDuplicate — Tier 1 (exact)', () => {
  it('matches case/punctuation variants', () => {
    expect(isDuplicate('Use SQLite!', 'use sqlite')).toBe(true);
  });

  it('rejects clearly different text', () => {
    expect(isDuplicate('Use SQLite', 'Use PostgreSQL')).toBe(false);
  });
});

describe('isDuplicate — Tier 2 (Jaccard)', () => {
  it('matches semantic near-duplicates', () => {
    expect(isDuplicate('Use SQLite for storage', 'SQLite should be the storage layer')).toBe(true);
  });

  it('rejects low-overlap texts', () => {
    expect(isDuplicate('Implement OAuth flow', 'Fix database migration')).toBe(false);
  });
});

describe('isDuplicate — Tier 3 (substring)', () => {
  it('matches when one contains the other', () => {
    expect(isDuplicate('Use SQLite', 'Use SQLite for the observation store')).toBe(true);
  });

  it('rejects non-contained different texts', () => {
    expect(isDuplicate('Deploy to production', 'Run the test suite')).toBe(false);
  });
});

describe('findDuplicate', () => {
  const items = [
    { content: 'Use SQLite for storage', id: 1 },
    { content: 'Implement OAuth with PKCE', id: 2 },
    { content: 'Deploy to staging first', id: 3 },
  ];

  it('returns matching existing item', () => {
    const match = findDuplicate('SQLite should be the storage layer', items);
    expect(match).not.toBeNull();
    expect(match!.id).toBe(1);
  });

  it('returns null when no match', () => {
    const match = findDuplicate('Something completely different and unrelated to any item', items);
    expect(match).toBeNull();
  });

  it('returns first match when multiple exist', () => {
    const dupes = [
      { content: 'Use SQLite', id: 10 },
      { content: 'Use SQLite for storage', id: 11 },
    ];
    const match = findDuplicate('use sqlite', dupes);
    expect(match).not.toBeNull();
    expect(match!.id).toBe(10);
  });
});

describe('edge cases', () => {
  it('isDuplicate is non-throwing on bad input', () => {
    // Passing non-string values should not throw — returns boolean safely
    expect(() => isDuplicate(null as unknown as string, 'test')).not.toThrow();
    expect(() => isDuplicate('test', undefined as unknown as string)).not.toThrow();
  });

  it('findDuplicate handles empty list', () => {
    expect(findDuplicate('test', [])).toBeNull();
  });
});
