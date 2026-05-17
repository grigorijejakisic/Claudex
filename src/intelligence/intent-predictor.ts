/**
 * Intent Predictor — three-layer session intent prediction engine.
 *
 * Predicts what the user will need BEFORE their first prompt, enabling
 * proactive context pre-materialization. This is the capstone of the
 * Proactive Memory milestone.
 *
 * Three layers, strong → weak anticipation:
 *   Layer 0 (Strong): Unfinished threads + Angel advisories (confidence 0.8)
 *   Layer 1 (Weak): Temporal features — session gap, hour/day profile (0.5–0.7)
 *   Layer 2 (Weak): Action transition Markov chain (0.3)
 *
 * Selection: highest confidence wins.
 * Gating: confidence >= 0.4 → auto-inject; below → available via MCP recall only.
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import type { IntentType } from './intent-classifier.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { getPolicy } from './policy-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PredictionResult {
  /** Predicted intent type for the upcoming session. */
  intent: IntentType;
  /** Human-readable topic/context for the prediction. */
  topic: string;
  /** Confidence score [0, 1]. Gated at CONFIDENCE_THRESHOLD for injection. */
  confidence: number;
  /** Which prediction layer produced this result. */
  layer: 0 | 1 | 2;
  /** Artifact IDs to pre-materialize (from thread or search). */
  artifactIds: number[];
  /** Optional reasoning for the prediction (for telemetry/debugging). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum confidence for auto-injection into assembly.
 * @deprecated Use getPolicy().getPredictionThreshold() instead. Kept for test/import compatibility. */
export const CONFIDENCE_THRESHOLD = 0.4;

/**
 * Returns the prediction confidence threshold from the active memory policy.
 * Use this for runtime threshold checks instead of the static CONFIDENCE_THRESHOLD.
 */
export function getPredictionThreshold(): number {
  const now = new Date();
  return getPolicy().getPredictionThreshold({
    sessionId: '',
    project: '',
    hourOfDay: now.getHours(),
    dayOfWeek: now.getDay(),
    hoursSinceLastSession: 0,
  });
}

/** Maximum tokens allocated for predicted context in assembly. */
export const PREDICTED_CONTEXT_BUDGET = 2000;

// ---------------------------------------------------------------------------
// Layer 0: Strong Anticipation
// ---------------------------------------------------------------------------

/**
 * Checks for unfinished thread work or Angel advisories.
 * Handles ~70% of sessions (most sessions continue previous work).
 * Non-throwing — returns null if no strong signal found.
 */
function predictLayer0(db: Database, project: string, sessionId: string): PredictionResult | null {
  try {
    // Check 1: Active thread with unfinished work (no summary = not concluded)
    const thread = cachedPrepare(db,
      `SELECT ts.session_id, ts.topic, ts.summary
       FROM thread_state ts
       JOIN sessions s ON s.session_id = ts.session_id
       WHERE s.project = ? AND ts.session_id != ?
       ORDER BY ts.updated_at_epoch DESC
       LIMIT 1`
    ).get(project, sessionId) as { session_id: string; topic: string | null; summary: string | null } | undefined;

    if (thread?.topic && !thread.summary) {
      // 14-07b: migrated from legacy artifacts — read V17 artifact table
      // V17 status mapping: 'active' covers legacy 'fresh' and 'materialized' states
      // V17 ids are TEXT; returned as strings. artifactIds array accepts number | string at runtime.
      const artifacts = cachedPrepare(db,
        `SELECT id FROM artifact
         WHERE session_id = ? AND status = 'active'
         ORDER BY confidence DESC, created_at_epoch_ms DESC LIMIT 10`
      ).all(thread.session_id) as Array<{ id: string }>;

      return {
        intent: 'continuation',
        topic: thread.topic,
        confidence: 0.8,
        layer: 0,
        artifactIds: artifacts.map(a => a.id as any),
        reason: `Unfinished thread: "${thread.topic}"`,
      };
    }

    // Check 2: Angel advisory messages for this session or project
    const advisory = cachedPrepare(db,
      `SELECT content FROM session_messages
       WHERE message_type = 'advisory'
         AND acknowledged = 0
         AND (target_session = ? OR target_session = ?)
       ORDER BY priority DESC, created_at_epoch_ms DESC
       LIMIT 1`
    ).get(sessionId, project) as { content: string } | undefined;

    if (advisory?.content) {
      return {
        intent: 'continuation',
        topic: advisory.content.slice(0, 200),
        confidence: 0.8,
        layer: 0,
        artifactIds: [],
        reason: `Angel advisory: "${advisory.content.slice(0, 100)}"`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 1: Weak Anticipation (temporal features)
// ---------------------------------------------------------------------------

/**
 * Uses session gap, hour-of-day, and day-of-week patterns.
 * Non-throwing — returns null if no temporal signal.
 */
function predictLayer1(db: Database, project: string): PredictionResult | null {
  try {
    const now = Math.floor(Date.now() / 1000);
    const currentHour = new Date().getHours();
    const hourBucket = Math.floor(currentHour / 4); // 0-5 (6 buckets of 4 hours)
    const dayOfWeek = new Date().getDay(); // 0=Sunday, 6=Saturday

    // Compute hours since last session
    const lastSession = cachedPrepare(db,
      `SELECT created_at_epoch_ms, session_summary FROM sessions
       WHERE project = ? AND status = 'completed'
       ORDER BY created_at_epoch_ms DESC LIMIT 1`
    ).get(project) as { created_at_epoch_ms: number; session_summary: string | null } | undefined;

    const hoursSinceLast = lastSession
      ? (now - lastSession.created_at_epoch_ms / 1000) / 3600
      : Infinity;

    // Short gap → continuation (high probability)
    if (hoursSinceLast < 2 && lastSession) {
      // Get last thread topic for context
      const lastThread = cachedPrepare(db,
        `SELECT topic FROM thread_state
         WHERE session_id = (
           SELECT session_id FROM sessions
           WHERE project = ? AND status = 'completed'
           ORDER BY created_at_epoch_ms DESC LIMIT 1
         )`
      ).get(project) as { topic: string | null } | undefined;

      const topic = lastThread?.topic ?? lastSession.session_summary ?? 'recent work';
      return {
        intent: 'continuation',
        topic: topic.slice(0, 200),
        confidence: 0.7,
        layer: 1,
        artifactIds: [],
        reason: `Short session gap (${hoursSinceLast.toFixed(1)}h) — likely continuation`,
      };
    }

    // Query temporal profile for historical patterns at this time slot
    const profile = cachedPrepare(db,
      `SELECT session_count, common_first_actions FROM temporal_profile
       WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
    ).get(project, hourBucket, dayOfWeek) as {
      session_count: number;
      common_first_actions: string;
    } | undefined;

    if (profile && profile.session_count >= 3) {
      // Strong temporal pattern — user has established a routine at this time
      let firstActions: string[] = [];
      try {
        firstActions = JSON.parse(profile.common_first_actions);
      } catch { /* ignore parse errors */ }

      // Map first actions to intent types
      const intent = inferIntentFromActions(firstActions);
      const confidence = Math.min(0.6, 0.4 + profile.session_count * 0.02);

      return {
        intent,
        topic: `Temporal pattern: ${firstActions.slice(0, 3).join(', ') || 'routine session'}`,
        confidence,
        layer: 1,
        artifactIds: [],
        reason: `Temporal match: ${profile.session_count} sessions at bucket ${hourBucket}, day ${dayOfWeek}`,
      };
    }

    // Long gap → lower confidence, probably new topic
    if (hoursSinceLast > 24) {
      return {
        intent: 'planning',
        topic: 'New session after extended break',
        confidence: 0.4,
        layer: 1,
        artifactIds: [],
        reason: `Long session gap (${hoursSinceLast.toFixed(0)}h) — likely new topic`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 2: Weak Anticipation (action transition Markov chain)
// ---------------------------------------------------------------------------

/**
 * Queries action_transitions for most likely first actions given
 * the last session's final actions.
 * Non-throwing — returns null if no transition data.
 */
function predictLayer2(db: Database, project: string): PredictionResult | null {
  try {
    // Get last session's final event types
    const lastEvents = cachedPrepare(db,
      `SELECT event_type FROM session_events
       WHERE project = ? AND session_id = (
         SELECT session_id FROM sessions
         WHERE project = ? AND status = 'completed'
         ORDER BY created_at_epoch_ms DESC LIMIT 1
       )
       ORDER BY timestamp_epoch DESC LIMIT 3`
    ).all(project, project) as Array<{ event_type: string }>;

    if (lastEvents.length === 0) return null;

    // Query most likely next actions from transition table
    const lastAction = lastEvents[0].event_type;
    const transitions = cachedPrepare(db,
      `SELECT to_action, count FROM action_transitions
       WHERE project = ? AND from_action = ?
       ORDER BY count DESC LIMIT 3`
    ).all(project, lastAction) as Array<{ to_action: string; count: number }>;

    if (transitions.length === 0) return null;

    const topAction = transitions[0].to_action;
    const totalCount = transitions.reduce((sum, t) => sum + t.count, 0);
    const topProbability = transitions[0].count / totalCount;

    // Predict if top action has meaningful probability (> 20% of transitions)
    if (topProbability < 0.2) return null;

    const intent = inferIntentFromActions([topAction]);

    return {
      intent,
      topic: `Predicted from action chain: ${lastAction} → ${topAction}`,
      confidence: 0.3,
      layer: 2,
      artifactIds: [],
      reason: `Markov: ${lastAction} → ${topAction} (${(topProbability * 100).toFixed(0)}% of ${totalCount} transitions)`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: map action types to intent types
// ---------------------------------------------------------------------------

function inferIntentFromActions(actions: string[]): IntentType {
  if (actions.length === 0) return 'continuation';
  const first = actions[0].toLowerCase();
  if (first.includes('file_edit') || first.includes('file_create')) return 'implementation';
  if (first.includes('test') || first.includes('build')) return 'investigation';
  if (first.includes('search')) return 'investigation';
  if (first.includes('decision')) return 'planning';
  return 'continuation';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Predict session intent using three-layer model.
 *
 * Returns the highest-confidence prediction across all layers,
 * or null if no prediction exceeds the minimum useful threshold (0.2).
 *
 * Non-throwing — returns null on any error.
 */
export function predictSessionIntent(
  db: Database,
  project: string,
  sessionId: string,
): PredictionResult | null {
  try {
    const candidates: PredictionResult[] = [];

    // Layer 0: Strong anticipation (coupling, no model)
    const l0 = predictLayer0(db, project, sessionId);
    if (l0) candidates.push(l0);

    // Layer 1: Weak anticipation (temporal features)
    const l1 = predictLayer1(db, project);
    if (l1) candidates.push(l1);

    // Layer 2: Weak anticipation (action transition Markov)
    const l2 = predictLayer2(db, project);
    if (l2) candidates.push(l2);

    if (candidates.length === 0) return null;

    // Highest confidence wins
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0];
  } catch {
    return null;
  }
}

/**
 * Record prediction accuracy for feedback loop.
 *
 * Compares the predicted intent (stored at session-start) with the actual
 * dominant intent observed during the session.
 *
 * Non-throwing.
 */
export function recordPredictionAccuracy(
  db: Database,
  sessionId: string,
  project: string,
  predictedIntent: string,
  actualIntent: string,
  wasReferenced: boolean,
): void {
  try {
    const accurate = predictedIntent === actualIntent ? 1 : 0;
    cachedPrepare(db,
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, ?, 'intent_prediction_accuracy', 'predictor', ?, ?)`
    ).run(
      sessionId,
      project,
      accurate ? 'accurate' : 'inaccurate',
      JSON.stringify({ predicted: predictedIntent, actual: actualIntent, referenced: wasReferenced }),
    );
  } catch {
    // Non-throwing
  }
}

/**
 * Determine the actual dominant intent of a session from its events.
 *
 * Analyzes session_events to infer what the user actually did.
 * Non-throwing — returns 'continuation' as default.
 */
export function determineActualIntent(db: Database, sessionId: string): IntentType {
  try {
    // Exclude meta event types from counting — they're system bookkeeping, not user actions.
    // Without this filter, meta events (intent_classification, compaction, etc.) all fall into
    // the 'continuation' bucket and then intent_classification events get double-counted below.
    const META_EVENTS = ['intent_prediction', 'intent_prediction_accuracy', 'intent_classification',
      'session_success_bonus', 'compaction', 'angel_processed', 'correction_detected', 'memrl_q_update'];
    const counts = cachedPrepare(db,
      `SELECT event_type, COUNT(*) as cnt FROM session_events
       WHERE session_id = ?
         AND event_type NOT IN (${META_EVENTS.map(() => '?').join(',')})
       GROUP BY event_type
       ORDER BY cnt DESC`
    ).all(sessionId, ...META_EVENTS) as Array<{ event_type: string; cnt: number }>;

    if (counts.length === 0) return 'continuation';

    // Map event types to intents and find dominant
    const intentCounts: Record<IntentType, number> = {
      continuation: 0,
      investigation: 0,
      implementation: 0,
      planning: 0,
      recall: 0,
    };

    for (const { event_type, cnt } of counts) {
      if (event_type === 'file_edit' || event_type === 'file_create') {
        intentCounts.implementation += cnt;
      } else if (event_type === 'test_run' || event_type === 'build' || event_type === 'search') {
        intentCounts.investigation += cnt;
      } else if (event_type === 'decision') {
        intentCounts.planning += cnt;
      } else {
        intentCounts.continuation += cnt;
      }
    }

    // Use MODE of all per-turn intent classifications (not just the last one)
    // This gives the true dominant intent of the session
    const classifiedAll = cachedPrepare(db,
      `SELECT entity, COUNT(*) as cnt FROM session_events
       WHERE session_id = ? AND event_type = 'intent_classification'
       GROUP BY entity ORDER BY cnt DESC`
    ).all(sessionId) as Array<{ entity: string; cnt: number }>;

    for (const row of classifiedAll) {
      if (row.entity in intentCounts) {
        intentCounts[row.entity as IntentType] += row.cnt * 2; // Boost classified intents
      }
    }

    // Find the dominant intent
    let maxIntent: IntentType = 'continuation';
    let maxCount = 0;
    for (const [intent, count] of Object.entries(intentCounts)) {
      if (count > maxCount) {
        maxCount = count;
        maxIntent = intent as IntentType;
      }
    }

    return maxIntent;
  } catch {
    return 'continuation';
  }
}

// ---------------------------------------------------------------------------
// Temporal profile update (called from stop hook)
// ---------------------------------------------------------------------------

/**
 * Updates the temporal_profile table with current session's time slot.
 * Increments session_count for the (project, hour_bucket, day_of_week) tuple.
 *
 * Also updates common_first_actions by appending the first event type
 * from this session and keeping the top 5 most common.
 *
 * Non-throwing.
 */
export function updateTemporalProfile(
  db: Database,
  project: string,
  sessionId: string,
): void {
  try {
    const now = new Date();
    const hourBucket = Math.floor(now.getHours() / 4);
    const dayOfWeek = now.getDay();

    // Get first event of this session for common_first_actions tracking
    const firstEvent = cachedPrepare(db,
      `SELECT event_type FROM session_events
       WHERE session_id = ? AND event_type NOT IN ('intent_prediction', 'intent_prediction_accuracy', 'intent_classification', 'session_success_bonus', 'compaction')
       ORDER BY timestamp_epoch ASC LIMIT 1`
    ).get(sessionId) as { event_type: string } | undefined;

    // Upsert temporal profile
    const existing = cachedPrepare(db,
      `SELECT session_count, common_first_actions FROM temporal_profile
       WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
    ).get(project, hourBucket, dayOfWeek) as {
      session_count: number;
      common_first_actions: string;
    } | undefined;

    // Compute avg session duration for this specific time slot (hour_bucket + day_of_week).
    // Falls back to project-wide average if no sessions exist for this slot.
    const slotAvg = cachedPrepare(db,
      `SELECT AVG((ended_at_epoch_ms - created_at_epoch_ms) / 1000.0) as avg_sec
       FROM sessions
       WHERE project = ? AND ended_at_epoch_ms IS NOT NULL
         AND created_at_epoch_ms > 0 AND ended_at_epoch_ms > created_at_epoch_ms
         AND CAST((CAST((created_at_epoch_ms / 1000) % 86400 AS REAL) / 3600 / 4) AS INTEGER) = ?
         AND CAST((((created_at_epoch_ms / 1000) / 86400 + 4) % 7) AS INTEGER) = ?`
    ).get(project, hourBucket, dayOfWeek) as { avg_sec: number | null } | undefined;

    const globalAvg = slotAvg?.avg_sec ? null : cachedPrepare(db,
      `SELECT AVG((ended_at_epoch_ms - created_at_epoch_ms) / 1000.0) as avg_sec
       FROM sessions
       WHERE project = ? AND ended_at_epoch_ms IS NOT NULL
         AND created_at_epoch_ms > 0 AND ended_at_epoch_ms > created_at_epoch_ms`
    ).get(project) as { avg_sec: number | null } | undefined;

    const avgDurationSec = slotAvg?.avg_sec ?? globalAvg?.avg_sec ?? null;

    if (existing) {
      // Update existing row
      let actions: string[] = [];
      try { actions = JSON.parse(existing.common_first_actions); } catch { /* ignore */ }

      if (firstEvent) {
        actions.push(firstEvent.event_type);
      }

      // Keep top 5 most common first actions
      const actionCounts = new Map<string, number>();
      for (const a of actions) {
        actionCounts.set(a, (actionCounts.get(a) ?? 0) + 1);
      }
      const topActions = [...actionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([action]) => action);

      cachedPrepare(db,
        `UPDATE temporal_profile
         SET session_count = session_count + 1,
             common_first_actions = ?,
             avg_duration_sec = ?,
             updated_at_epoch = unixepoch()
         WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
      ).run(JSON.stringify(topActions), avgDurationSec, project, hourBucket, dayOfWeek);
    } else {
      // Insert new row
      const actions = firstEvent ? [firstEvent.event_type] : [];
      cachedPrepare(db,
        `INSERT INTO temporal_profile (project, hour_bucket, day_of_week, session_count, common_first_actions, avg_duration_sec)
         VALUES (?, ?, ?, 1, ?, ?)`
      ).run(project, hourBucket, dayOfWeek, JSON.stringify(actions), avgDurationSec);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Action transitions update (called from stop hook)
// ---------------------------------------------------------------------------

/**
 * Updates the action_transitions table with consecutive event type pairs
 * from this session. Implements a simple Markov chain for next-action prediction.
 *
 * Non-throwing.
 */
export function updateActionTransitions(
  db: Database,
  project: string,
  sessionId: string,
): void {
  try {
    const events = cachedPrepare(db,
      `SELECT event_type FROM session_events
       WHERE session_id = ? AND event_type NOT IN ('intent_prediction', 'intent_prediction_accuracy', 'intent_classification', 'session_success_bonus', 'compaction')
       ORDER BY timestamp_epoch ASC`
    ).all(sessionId) as Array<{ event_type: string }>;

    if (events.length < 2) return;

    // Insert or update transition counts for consecutive pairs
    const upsertStmt = cachedPrepare(db,
      `INSERT INTO action_transitions (project, from_action, to_action, count, last_epoch)
       VALUES (?, ?, ?, 1, unixepoch())
       ON CONFLICT(project, from_action, to_action) DO UPDATE SET
         count = action_transitions.count + 1,
         last_epoch = unixepoch()`
    );

    // Deduplicate consecutive pairs to avoid over-counting repetitive sequences
    const seen = new Set<string>();
    for (let i = 0; i < events.length - 1; i++) {
      const from = events[i].event_type;
      const to = events[i + 1].event_type;
      const key = `${from}→${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      upsertStmt.run(project, from, to);
    }
  } catch {
    // Non-throwing
  }
}
