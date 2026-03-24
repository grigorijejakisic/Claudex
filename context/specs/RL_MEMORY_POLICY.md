# RL-Trained Memory Policies — Spec

## Goal
Extract hard-coded memory management rules into a pluggable policy interface. Implement a default policy (current rules) and an RL-trained policy that learns from reward signals already in the DB.

## Level 1: Policy Interface + Default Implementation

### New Files
- `src/intelligence/memory-policy.ts` — interface definition
- `src/intelligence/default-policy.ts` — current rules as a policy
- `src/intelligence/policy-registry.ts` — singleton, config-driven policy selection

### Interface

```typescript
export interface MemoryPolicy {
  /** Should this observation be stored? Returns action + reasoning. */
  shouldStore(obs: ObservationCandidate, context: PolicyContext): StoreAction;

  /** Score an artifact for retrieval given current query context. */
  scoreForRetrieval(artifact: ArtifactRow, query: string, context: PolicyContext): number;

  /** Should this cluster of observations be consolidated? */
  shouldConsolidate(cluster: ObservationCluster): ConsolidateAction;

  /** What confidence threshold for proactive injection? */
  getPredictionThreshold(context: PolicyContext): number;

  /** Evaluate pattern after feedback — promote, demote, invert, or keep? */
  evaluatePattern(pattern: PatternFeedback): PatternAction;

  /** Get decay half-life for an observation. */
  getHalfLife(category: string, importance: number, stabilityClass: string): number;

  /** Should RIF be applied to this non-selected candidate? */
  shouldSuppressCandidate(artifact: ArtifactRow, rrfScore: number): boolean;
}

export type StoreAction = { action: 'add' } | { action: 'update'; targetId: number } | { action: 'skip'; reason: string };
export type ConsolidateAction = 'merge' | 'keep' | 'skip';
export type PatternAction = 'promote' | 'demote' | 'invert' | 'keep';

export interface PolicyContext {
  sessionId: string;
  project: string;
  hourOfDay: number;
  dayOfWeek: number;
  hoursSinceLastSession: number;
  activeThreadTopic?: string;
  recentIntentType?: string;
}
```

### Default Policy
Extracts these constants/rules into methods:
- `DEDUP_COSINE_THRESHOLD = 0.85` → shouldStore()
- `SUPPRESSION_THRESHOLD = 3` unreferenced → scoreForRetrieval()
- `CLUSTER_MIN_SIZE = 3` for LLM consolidation → shouldConsolidate()
- `PREDICTION_CONFIDENCE_THRESHOLD = 0.4` → getPredictionThreshold()
- `HARMFUL_MULTIPLIER = 4` → evaluatePattern()
- `STABILITY_HALF_LIVES` table → getHalfLife()
- `RIF_MIN_RRF = 0.01` → shouldSuppressCandidate()

### Wiring
Each decision point imports from policy-registry instead of using local constants:
- `observations.ts:insertObservationWithDedup()` → `policy.shouldStore()`
- `hybrid-retrieval.ts` scoring → `policy.scoreForRetrieval()`
- `consolidator.ts` → `policy.shouldConsolidate()`
- `intent-predictor.ts` → `policy.getPredictionThreshold()`
- `experience-patterns.ts` stop hook logic → `policy.evaluatePattern()`
- `decay-engine.ts` → `policy.getHalfLife()`
- `hybrid-retrieval.ts` RIF → `policy.shouldSuppressCandidate()`

## Level 2: RL Training Pipeline

### New Files
- `src/intelligence/rl-policy.ts` — RL-trained policy implementation
- `src/intelligence/rl-trainer.ts` — training loop using historical data
- `src/intelligence/rl-reward.ts` — reward signal computation from DB

### Training Data (already in DB)
- `retrieval_events.was_referenced` — did surfaced content get used?
- `experience_patterns.helpful_count/harmful_count` — pattern quality signals
- `session_events.intent_prediction_accuracy` — prediction quality
- `observations.access_count` — what gets retrieved often?
- `observations.consolidated_into` — what was noise?

### Model Architecture
Small MLP (not an LLM) that takes state features and outputs action probabilities:
- Input: ~20 features (artifact metadata, context, temporal, history)
- Hidden: 2 layers, 64 units each
- Output: action probabilities per method

### Training Loop (in Angel heartbeat, low priority)
1. Sample batch of historical decisions from retrieval_events
2. Compute reward: was_referenced=1 → +1, was_referenced=0 → -1
3. Update policy weights via policy gradient
4. Compare RL policy score vs default policy score
5. Switch to RL policy when it outperforms default on holdout set

### Implementation: Pure TypeScript, No ML Framework
Use a simple MLP implemented in ~100 lines of TypeScript:
- Forward pass: matrix multiply + ReLU
- Backward pass: policy gradient (REINFORCE algorithm)
- Weights stored as Float32Arrays in SQLite (new table: `policy_weights`)
- No PyTorch, no TensorFlow, no external deps
