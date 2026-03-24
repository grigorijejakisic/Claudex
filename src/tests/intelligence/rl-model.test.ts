/**
 * Tests for RL memory policy pipeline:
 * - SimpleMLP forward pass, backward pass, serialization
 * - Feature extraction dimensionality
 * - Reward signal extraction from empty DB
 * - Training convergence on synthetic data
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeSchema } from '../../core/migrations.js';
import { SimpleMLP } from '../../intelligence/rl-model.js';
import { buildFeatureVector, FEATURE_DIM, extractRetrievalRewards, extractPatternRewards } from '../../intelligence/rl-reward.js';
import { RLMemoryPolicy } from '../../intelligence/rl-policy.js';
import { trainPolicyBatch, evaluatePolicy, loadRLPolicy } from '../../intelligence/rl-trainer.js';
import { createArtifact } from '../../core/artifacts.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  db.prepare(
    `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch, project)
     VALUES ('test-sess', 'active', 0, ?, 'test-project')`
  ).run(Math.floor(Date.now() / 1000));
  return db;
}

// ---------------------------------------------------------------------------
// SimpleMLP tests
// ---------------------------------------------------------------------------

describe('SimpleMLP', () => {
  it('forward pass produces valid probabilities (sum to ~1)', () => {
    const model = new SimpleMLP(20, 64, 3);
    const input = new Float32Array(20);
    for (let i = 0; i < 20; i++) input[i] = Math.random();

    const probs = model.forward(input);

    expect(probs.length).toBe(3);

    // All probabilities >= 0
    for (let i = 0; i < probs.length; i++) {
      expect(probs[i]).toBeGreaterThanOrEqual(0);
    }

    // Sum to ~1.0
    let sum = 0;
    for (let i = 0; i < probs.length; i++) sum += probs[i];
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('forward pass handles zero input', () => {
    const model = new SimpleMLP(20, 64, 2);
    const input = new Float32Array(20); // all zeros

    const probs = model.forward(input);

    expect(probs.length).toBe(2);
    let sum = 0;
    for (let i = 0; i < probs.length; i++) sum += probs[i];
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('backward pass changes weights', () => {
    const model = new SimpleMLP(20, 64, 2);
    const input = new Float32Array(20);
    for (let i = 0; i < 20; i++) input[i] = Math.random() * 2 - 1;

    const weightsBefore = new Float32Array(new Float32Array(model.getWeights()));
    model.backward(input, 0, 1.0, 0.01);
    const weightsAfter = new Float32Array(model.getWeights());

    // At least some weights should differ
    let changed = false;
    for (let i = 0; i < weightsBefore.length; i++) {
      if (weightsBefore[i] !== weightsAfter[i]) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });

  it('backward pass with zero reward does not change weights', () => {
    const model = new SimpleMLP(10, 32, 2);
    const input = new Float32Array(10);
    for (let i = 0; i < 10; i++) input[i] = Math.random();

    const weightsBefore = new Float32Array(new Float32Array(model.getWeights()));
    model.backward(input, 0, 0, 0.01);
    const weightsAfter = new Float32Array(model.getWeights());

    let changed = false;
    for (let i = 0; i < weightsBefore.length; i++) {
      if (Math.abs(weightsBefore[i] - weightsAfter[i]) > 1e-10) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(false);
  });

  it('weight serialization/deserialization roundtrips', () => {
    const model = new SimpleMLP(20, 64, 3);
    const input = new Float32Array(20);
    for (let i = 0; i < 20; i++) input[i] = Math.random();

    // Get output before serialization
    const outputBefore = model.forward(input);

    // Serialize and load into new model
    const buffer = model.getWeights();
    const model2 = new SimpleMLP(20, 64, 3);
    model2.loadWeights(buffer);

    const outputAfter = model2.forward(input);

    // Outputs should match exactly
    expect(outputAfter.length).toBe(outputBefore.length);
    for (let i = 0; i < outputBefore.length; i++) {
      expect(outputAfter[i]).toBeCloseTo(outputBefore[i], 6);
    }
  });

  it('loadWeights rejects wrong-sized buffer', () => {
    const model = new SimpleMLP(20, 64, 3);
    const outputBefore = model.forward(new Float32Array(20));

    // Try loading a too-small buffer
    model.loadWeights(new ArrayBuffer(16));

    // Weights should be unchanged
    const outputAfter = model.forward(new Float32Array(20));
    for (let i = 0; i < outputBefore.length; i++) {
      expect(outputAfter[i]).toBeCloseTo(outputBefore[i], 6);
    }
  });

  it('training on synthetic data improves reward over random', () => {
    const model = new SimpleMLP(4, 16, 2);

    // Synthetic data: feature[0] > 0.5 → action=0, else action=1
    const data: Array<{ state: Float32Array; action: number; reward: number }> = [];
    for (let i = 0; i < 200; i++) {
      const state = new Float32Array(4);
      state[0] = Math.random();
      state[1] = Math.random();
      state[2] = Math.random();
      state[3] = Math.random();
      const correctAction = state[0] > 0.5 ? 0 : 1;
      data.push({ state, action: correctAction, reward: 1.0 });
    }

    // Measure pre-training accuracy
    let preCorrect = 0;
    for (const d of data) {
      const probs = model.forward(d.state);
      const predicted = probs[0] >= probs[1] ? 0 : 1;
      if (predicted === d.action) preCorrect++;
    }
    const preAccuracy = preCorrect / data.length;

    // Train for 50 epochs
    for (let epoch = 0; epoch < 50; epoch++) {
      for (const d of data) {
        model.backward(d.state, d.action, d.reward, 0.01);
      }
    }

    // Measure post-training accuracy
    let postCorrect = 0;
    for (const d of data) {
      const probs = model.forward(d.state);
      const predicted = probs[0] >= probs[1] ? 0 : 1;
      if (predicted === d.action) postCorrect++;
    }
    const postAccuracy = postCorrect / data.length;

    // Post-training should be significantly better than pre-training
    expect(postAccuracy).toBeGreaterThan(preAccuracy);
    // And should achieve reasonable accuracy on this simple task
    expect(postAccuracy).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// Feature extraction tests
// ---------------------------------------------------------------------------

describe('Feature extraction', () => {
  it('produces correct dimensionality', () => {
    const features = buildFeatureVector(
      {
        importance: 3,
        timestamp_epoch: Math.floor(Date.now() / 1000) - 86400,
        access_count: 5,
        activation_score: 1.2,
        confidence: 0.8,
        retrieval_score: 1.5,
        novelty_score: 0.7,
        stability_class: 'stable',
        artifact_type: 'observation',
      },
      {
        now: Math.floor(Date.now() / 1000),
        hourOfDay: 14,
        dayOfWeek: 3,
        hoursSinceLastSession: 2,
      },
    );

    expect(features.length).toBe(FEATURE_DIM);
    expect(features.length).toBe(20);
  });

  it('normalizes importance correctly', () => {
    const features1 = buildFeatureVector(
      { importance: 1, timestamp_epoch: 0 },
      { now: 1000 },
    );
    const features5 = buildFeatureVector(
      { importance: 5, timestamp_epoch: 0 },
      { now: 1000 },
    );

    expect(features1[0]).toBeCloseTo(0.0, 5);
    expect(features5[0]).toBeCloseTo(1.0, 5);
  });

  it('encodes stability_class as one-hot', () => {
    const features = buildFeatureVector(
      { importance: 3, timestamp_epoch: 0, stability_class: 'permanent' },
      { now: 1000 },
    );

    // permanent is index 3 → feature[10] should be 1
    expect(features[7]).toBe(0);  // transient
    expect(features[8]).toBe(0);  // standard
    expect(features[9]).toBe(0);  // stable
    expect(features[10]).toBe(1); // permanent
  });

  it('encodes artifact_type as one-hot', () => {
    const features = buildFeatureVector(
      { importance: 3, timestamp_epoch: 0, artifact_type: 'decision' },
      { now: 1000 },
    );

    // decision is index 2 → feature[18] should be 1
    expect(features[16]).toBe(0);  // observation
    expect(features[17]).toBe(0);  // learning
    expect(features[18]).toBe(1);  // decision
    expect(features[19]).toBe(0);  // hot_file
  });

  it('handles missing optional fields gracefully', () => {
    const features = buildFeatureVector(
      { importance: 3, timestamp_epoch: 0 },
      { now: 1000 },
    );

    expect(features.length).toBe(FEATURE_DIM);
    // Should not contain NaN
    for (let i = 0; i < features.length; i++) {
      expect(Number.isNaN(features[i])).toBe(false);
    }
  });

  it('cyclical encoding for hour_of_day wraps correctly', () => {
    const features0 = buildFeatureVector(
      { importance: 3, timestamp_epoch: 0 },
      { now: 1000, hourOfDay: 0 },
    );
    const features24 = buildFeatureVector(
      { importance: 3, timestamp_epoch: 0 },
      { now: 1000, hourOfDay: 24 },
    );

    // hour 0 and hour 24 should produce the same encoding
    expect(features0[11]).toBeCloseTo(features24[11], 5);
    expect(features0[12]).toBeCloseTo(features24[12], 5);
  });
});

// ---------------------------------------------------------------------------
// Reward signal extraction (empty DB)
// ---------------------------------------------------------------------------

describe('Reward signal extraction', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('empty DB → graceful empty results for retrieval rewards', () => {
    const signals = extractRetrievalRewards(db, 'test-project');
    expect(signals).toEqual([]);
  });

  it('empty DB → graceful empty results for pattern rewards', () => {
    const signals = extractPatternRewards(db, 'test-project');
    expect(signals).toEqual([]);
  });

  it('extracts correct reward from retrieval_events', () => {
    // Insert an artifact
    const artId = createArtifact(db, 'test-sess', 'test-project', 'observation', null, 'test obs', null, 3);

    // Insert retrieval events
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch)
       VALUES (?, 'test-sess', 1, ?)`
    ).run(artId, now);
    db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch)
       VALUES (?, 'test-sess', 0, ?)`
    ).run(artId, now + 1);

    const signals = extractRetrievalRewards(db, 'test-project');

    expect(signals.length).toBe(2);
    // Most recent first (ORDER BY timestamp DESC)
    expect(signals[0].reward).toBe(-1); // was_referenced=0
    expect(signals[0].action).toBe(1);
    expect(signals[1].reward).toBe(1);  // was_referenced=1
    expect(signals[1].action).toBe(0);

    // State vectors should have correct dimensionality
    expect(signals[0].state.length).toBe(FEATURE_DIM);
    expect(signals[1].state.length).toBe(FEATURE_DIM);
  });
});

// ---------------------------------------------------------------------------
// RLMemoryPolicy tests
// ---------------------------------------------------------------------------

describe('RLMemoryPolicy', () => {
  it('shouldStore returns valid action', () => {
    const policy = new RLMemoryPolicy();
    const result = policy.shouldStore(
      { title: 'test', content: 'test content', category: 'code', importance: 4, tool_name: 'Edit' },
      { sessionId: 's1', project: 'p1', hourOfDay: 14, dayOfWeek: 3, hoursSinceLastSession: 2 },
    );
    expect(['add', 'skip', 'update']).toContain(result.action);
  });

  it('scoreForRetrieval returns value in [0, 1]', () => {
    const policy = new RLMemoryPolicy();
    const score = policy.scoreForRetrieval(
      { id: 1, importance: 4, timestamp_epoch: Math.floor(Date.now() / 1000) - 3600 },
      'test query',
      { sessionId: 's1', project: 'p1', hourOfDay: 14, dayOfWeek: 3, hoursSinceLastSession: 2 },
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('shouldConsolidate returns valid action', () => {
    const policy = new RLMemoryPolicy();
    const result = policy.shouldConsolidate({
      ids: [1, 2, 3],
      category: 'code',
      averageImportance: 3,
      size: 3,
    });
    expect(['merge', 'keep', 'skip']).toContain(result);
  });

  it('getPredictionThreshold returns value in [0.3, 0.5]', () => {
    const policy = new RLMemoryPolicy();
    const threshold = policy.getPredictionThreshold(
      { sessionId: 's1', project: 'p1', hourOfDay: 14, dayOfWeek: 3, hoursSinceLastSession: 2 },
    );
    expect(threshold).toBeGreaterThanOrEqual(0.3);
    expect(threshold).toBeLessThanOrEqual(0.5);
  });

  it('evaluatePattern returns valid action', () => {
    const policy = new RLMemoryPolicy();
    const result = policy.evaluatePattern({
      patternId: 'p1',
      helpfulCount: 5,
      harmfulCount: 1,
      timesTriggered: 10,
      score: 4,
    });
    expect(['promote', 'demote', 'invert', 'keep']).toContain(result);
  });

  it('getHalfLife returns positive seconds', () => {
    const policy = new RLMemoryPolicy();
    const hl = policy.getHalfLife('code', 3, 'standard');
    expect(hl).toBeGreaterThan(0);
  });

  it('shouldSuppressCandidate returns boolean', () => {
    const policy = new RLMemoryPolicy();
    const result = policy.shouldSuppressCandidate(
      { id: 1, importance: 2, timestamp_epoch: Math.floor(Date.now() / 1000) - 86400 },
      0.005,
    );
    expect(typeof result).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Trainer tests
// ---------------------------------------------------------------------------

describe('RL Trainer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('trainPolicyBatch returns zero result on empty DB', async () => {
    const result = await trainPolicyBatch(db, 'test-project');
    expect(result.episodes).toBe(0);
    expect(result.avgReward).toBe(0);
    expect(result.policyImprovement).toBe(0);
  });

  it('trainPolicyBatch trains when sufficient data exists', async () => {
    // Insert enough data for training (MIN_SIGNALS = 10)
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i++) {
      const artId = createArtifact(
        db, 'test-sess', 'test-project', 'observation', null,
        `obs ${i}`, null, i % 5 === 0 ? 1 : 4
      );
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch)
         VALUES (?, 'test-sess', ?, ?)`
      ).run(artId, i % 3 === 0 ? 0 : 1, now + i);
    }

    const result = await trainPolicyBatch(db, 'test-project');
    expect(result.episodes).toBeGreaterThan(0);
  });

  it('evaluatePolicy returns safe defaults on empty DB', () => {
    const policy = new RLMemoryPolicy();
    const result = evaluatePolicy(db, 'test-project', policy);
    expect(result.rlScore).toBe(0);
    expect(result.defaultScore).toBe(0);
    expect(result.shouldSwitch).toBe(false);
  });

  it('loadRLPolicy returns a usable policy', () => {
    const policy = loadRLPolicy(db, 'test-project');
    // Should work even with no persisted weights
    const score = policy.scoreForRetrieval(
      { id: 1, importance: 3, timestamp_epoch: Math.floor(Date.now() / 1000) },
      'test',
      { sessionId: 's1', project: 'p1', hourOfDay: 12, dayOfWeek: 1, hoursSinceLastSession: 0 },
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('policy_weights table exists after schema init', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='policy_weights'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('weight persistence roundtrips through DB', async () => {
    // Train once to persist weights
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 15; i++) {
      const artId = createArtifact(
        db, 'test-sess', 'test-project', 'observation', null,
        `obs ${i}`, null, 3
      );
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch)
         VALUES (?, 'test-sess', ?, ?)`
      ).run(artId, i % 2, now + i);
    }

    await trainPolicyBatch(db, 'test-project');

    // Verify weights were saved
    const row = db.prepare(
      `SELECT training_episodes FROM policy_weights WHERE project = 'test-project'`
    ).get() as { training_episodes: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.training_episodes).toBeGreaterThan(0);

    // Load into a new policy and verify it works
    const policy = loadRLPolicy(db, 'test-project');
    const score = policy.scoreForRetrieval(
      { id: 1, importance: 4, timestamp_epoch: now },
      'test',
      { sessionId: 's1', project: 'test-project', hourOfDay: 12, dayOfWeek: 1, hoursSinceLastSession: 0 },
    );
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
