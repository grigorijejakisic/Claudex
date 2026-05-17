import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { getLearningsByProject } from '../../core/learnings.js';
import { promoteLearnings } from '../../intelligence/learnings-promoter.js';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { migrateV37toV38 } from '../../core/migration-steps.js';

describe('learnings promoter', () => {
  let db: TestDatabase;
  const project = 'test-project';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- Basic flow ---

  describe('basic flow', () => {
    it('inserts new learning with promotion_count 1', () => {
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['Always use boundary-only injection for context assembly'],
      });
      expect(result.inserted).toBe(1);
      expect(result.promoted).toBe(0);

      const learnings = getLearningsByProject(db, project);
      expect(learnings).toHaveLength(1);
      expect(learnings[0].promotion_count).toBe(1);
    });

    it('promotes existing learning (increments promotion_count)', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Always use boundary-only injection for context assembly'],
      });
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['Always use boundary-only injection for context assembly'],
      });
      expect(result.promoted).toBe(1);
      expect(result.inserted).toBe(0);

      const learnings = getLearningsByProject(db, project);
      expect(learnings).toHaveLength(1);
      expect(learnings[0].promotion_count).toBe(2);
    });

    it('returns correct promoted/inserted counts', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Existing learning about SQLite'],
      });
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: [
          'Existing learning about SQLite', // should promote
          'Completely new learning about testing', // should insert
        ],
      });
      expect(result.promoted).toBe(1);
      expect(result.inserted).toBe(1);
    });
  });

  // --- Dedup ---

  describe('dedup', () => {
    it('detects exact duplicate and promotes instead of inserting', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Use SQLite for storage!'],
      });
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['use sqlite for storage'],
      });
      expect(result.promoted).toBe(1);
      expect(result.inserted).toBe(0);
    });

    it('detects semantic near-duplicate (Jaccard) and promotes', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Use SQLite for the observation storage layer'],
      });
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['SQLite should be used as the storage layer for observations'],
      });
      expect(result.promoted).toBe(1);
    });

    it('inserts non-duplicate as new learning', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Use SQLite for storage'],
      });
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['Implement OAuth with PKCE for headless auth'],
      });
      expect(result.inserted).toBe(1);
      expect(getLearningsByProject(db, project)).toHaveLength(2);
    });
  });

  // --- Cap enforcement ---

  describe('cap enforcement', () => {
    // Use maximally distinct learnings to avoid Jaccard dedup
    const ANIMALS = [
      'aardvark', 'buffalo', 'cheetah', 'dolphin', 'elephant', 'falcon', 'giraffe',
      'hedgehog', 'iguana', 'jaguar', 'koala', 'lemur', 'mongoose', 'narwhal',
      'octopus', 'penguin', 'quail', 'raccoon', 'salamander', 'tapir', 'urchin',
      'vulture', 'walrus', 'xerus', 'yak', 'zebra', 'alpaca', 'bison', 'capybara',
      'dingo', 'emu', 'ferret', 'gecko', 'hamster', 'impala', 'jellyfish', 'kiwi',
      'llama', 'mantis', 'newt', 'ocelot', 'platypus', 'quokka', 'robin', 'starling',
      'toucan', 'urial', 'viper', 'wombat', 'xenops', 'yellowjacket', 'zebu',
      'axolotl', 'barracuda', 'chinchilla',
    ];
    function distinctLearning(i: number): string {
      return `${ANIMALS[i % ANIMALS.length]} migration pattern ${i} observed`;
    }

    it('enforces 50-per-project cap', () => {
      const learnings = Array.from({ length: 55 }, (_, i) => distinctLearning(i));
      promoteLearnings({ db, project, sessionLearnings: learnings });

      const stored = getLearningsByProject(db, project, { limit: 100 });
      expect(stored.length).toBeLessThanOrEqual(50);
    });

    it('prunes lowest promotion_count entries first', () => {
      // Insert 50 distinct learnings
      const initial = Array.from({ length: 50 }, (_, i) => distinctLearning(i));
      promoteLearnings({ db, project, sessionLearnings: initial });

      // Promote one of them
      promoteLearnings({
        db,
        project,
        sessionLearnings: [distinctLearning(25)],
      });

      // Insert one more — should prune a low-priority one, not #25
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['completely novel xylophone architecture discovered'],
      });

      const stored = getLearningsByProject(db, project, { limit: 100 });
      expect(stored.length).toBeLessThanOrEqual(50);

      // The promoted one should still exist
      const promoted = stored.find((l) => l.content === distinctLearning(25));
      expect(promoted).toBeDefined();
    });

    it('prunes oldest entries when promotion_count ties', () => {
      const learnings = Array.from({ length: 52 }, (_, i) => distinctLearning(i));
      const result = promoteLearnings({ db, project, sessionLearnings: learnings });
      expect(result.pruned).toBe(2);
    });

    it('returns correct pruned count', () => {
      const learnings = Array.from({ length: 55 }, (_, i) => distinctLearning(i));
      const result = promoteLearnings({ db, project, sessionLearnings: learnings });
      expect(result.pruned).toBe(5);
    });
  });

  // --- Cap scope alignment ---

  describe('cap scope alignment', () => {
    const ANIMALS = [
      'aardvark', 'buffalo', 'cheetah', 'dolphin', 'elephant', 'falcon', 'giraffe',
      'hedgehog', 'iguana', 'jaguar', 'koala', 'lemur', 'mongoose', 'narwhal',
      'octopus', 'penguin', 'quail', 'raccoon', 'salamander', 'tapir', 'urchin',
      'vulture', 'walrus', 'xerus', 'yak', 'zebra', 'alpaca', 'bison', 'capybara',
      'dingo', 'emu', 'ferret', 'gecko', 'hamster', 'impala', 'jellyfish', 'kiwi',
      'llama', 'mantis', 'newt', 'ocelot', 'platypus', 'quokka', 'robin', 'starling',
      'toucan', 'urial', 'viper', 'wombat', 'xenops', 'yellowjacket', 'zebu',
      'axolotl', 'barracuda', 'chinchilla',
    ];
    function distinctLearning(i: number): string {
      return `${ANIMALS[i % ANIMALS.length]} migration pattern ${i} observed`;
    }

    it('does not let global learnings inflate the project cap (no premature pruning)', () => {
      // Insert 20 global learnings directly into the DB
      for (let i = 0; i < 20; i++) {
        db.prepare(
          `INSERT INTO learnings (project, agent_id, fingerprint, content)
           VALUES ('__global__', 'default', ?, ?)`
        ).run(`global-fp-${i}`, `global learning ${i}`);
      }

      // Now insert exactly 48 project learnings via promoteLearnings
      const projectLearnings = Array.from({ length: 48 }, (_, i) => distinctLearning(i));
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: projectLearnings,
      });

      // With the bug: getLearningsByProject returns project+global rows (48+20=68),
      // so excess = 68-50 = 18, and 18 project learnings get pruned.
      // With the fix: scopedCount = 48 (project+agent only), excess = 48-50 = -2, no pruning.
      expect(result.pruned).toBe(0);

      // Verify all 48 project learnings are still present
      const projectRows = db.prepare(
        `SELECT COUNT(*) AS cnt FROM learnings WHERE project = ? AND agent_id = ?`
      ).get(project, 'default') as { cnt: number };
      expect(projectRows.cnt).toBe(48);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('handles empty sessionLearnings array', () => {
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: [],
      });
      expect(result).toEqual({ promoted: 0, inserted: 0, pruned: 0 });
    });

    it('is non-throwing (returns zero counts on error)', () => {
      db.close();
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: ['This should not crash'],
      });
      expect(result).toEqual({ promoted: 0, inserted: 0, pruned: 0 });
      // Reopen for afterEach
      db = createTestDb();
    });

    it('uses default agent_id when not provided', () => {
      promoteLearnings({
        db,
        project,
        sessionLearnings: ['Learning without explicit agent ID specified'],
      });
      const learnings = getLearningsByProject(db, project);
      expect(learnings[0].agent_id).toBe('default');
    });

    it('handles multiple learnings in single call', () => {
      const result = promoteLearnings({
        db,
        project,
        sessionLearnings: [
          'First learning about SQLite storage',
          'Second learning about checkpoint recovery',
          'Third learning about boundary injection',
        ],
      });
      expect(result.inserted).toBe(3);
      expect(getLearningsByProject(db, project)).toHaveLength(3);
    });
  });
});
