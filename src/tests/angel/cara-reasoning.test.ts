import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { formOpinion, reinforceOpinion, weakenOpinion, contradictOpinion, getStrongOpinions, getRelevantOpinions, formatOpinionsForInjection } from '../../angel/cara-reasoning.js';

describe('cara-reasoning', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('forms a new opinion', () => {
    const id = formOpinion(db, 'proj-1', 'SQLite vs PostgreSQL', 'SQLite is better for local-first');
    expect(id).toBeGreaterThan(0);

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions.length).toBe(1);
    expect(opinions[0].subject).toBe('SQLite vs PostgreSQL');
    expect(opinions[0].confidence).toBe(0.5);
  });

  it('reinforces an opinion — confidence increases', () => {
    const id = formOpinion(db, 'proj-1', 'testing', 'always test');
    reinforceOpinion(db, id);
    reinforceOpinion(db, id);

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions[0].confidence).toBeGreaterThan(0.5);
    expect(opinions[0].reinforced_count).toBe(2);
  });

  it('weakens an opinion — confidence decreases', () => {
    const id = formOpinion(db, 'proj-1', 'approach', 'use X');
    weakenOpinion(db, id);
    weakenOpinion(db, id);

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions[0].confidence).toBeLessThan(0.5);
    expect(opinions[0].weakened_count).toBe(2);
  });

  it('contradicts an opinion — opinion flips, confidence resets', () => {
    const id = formOpinion(db, 'proj-1', 'db choice', 'use PostgreSQL');
    reinforceOpinion(db, id); // push confidence up
    contradictOpinion(db, id, 'use SQLite instead');

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions[0].opinion).toBe('use SQLite instead');
    expect(opinions[0].confidence).toBe(0.5); // reset
    expect(opinions[0].contradicted_count).toBe(1);
  });

  it('forming same opinion on same subject reinforces', () => {
    formOpinion(db, 'proj-1', 'testing', 'always test');
    formOpinion(db, 'proj-1', 'testing', 'always test');

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions.length).toBe(1);
    expect(opinions[0].reinforced_count).toBe(1);
  });

  it('forming different opinion on same subject contradicts', () => {
    formOpinion(db, 'proj-1', 'testing', 'always test');
    formOpinion(db, 'proj-1', 'testing', 'test only critical paths');

    const opinions = getStrongOpinions(db, 'proj-1', 0.0);
    expect(opinions.length).toBe(1);
    expect(opinions[0].opinion).toBe('test only critical paths');
  });

  it('getStrongOpinions filters by confidence threshold', () => {
    const id = formOpinion(db, 'proj-1', 'high conf', 'opinion A');
    reinforceOpinion(db, id);
    reinforceOpinion(db, id);
    reinforceOpinion(db, id);
    formOpinion(db, 'proj-1', 'low conf', 'opinion B');

    const strong = getStrongOpinions(db, 'proj-1', 0.6);
    expect(strong.length).toBe(1);
    expect(strong[0].subject).toBe('high conf');
  });

  it('getRelevantOpinions matches by topic keyword', () => {
    formOpinion(db, 'proj-1', 'SQLite performance tuning', 'use WAL mode');
    formOpinion(db, 'proj-1', 'React hooks best practices', 'avoid useEffect');

    const relevant = getRelevantOpinions(db, 'proj-1', 'SQLite');
    expect(relevant.length).toBe(1);
    expect(relevant[0].subject).toContain('SQLite');
  });

  it('formats opinions for injection', () => {
    const id = formOpinion(db, 'p1', 'testing approach', 'always write tests first');
    reinforceOpinion(db, id);
    reinforceOpinion(db, id);

    const opinions = getStrongOpinions(db, 'p1', 0.0);
    const formatted = formatOpinionsForInjection(opinions);

    expect(formatted).toContain('## Angel Insights');
    expect(formatted).toContain('testing approach');
    expect(formatted).toContain('always write tests first');
    expect(formatted).toContain('% confidence');
  });
});
