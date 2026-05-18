/**
 * Episodic Recall Gate — automatable "does session-start feel remembered, not read?" probe set.
 *
 * The v7 qualitative thesis (per 14-07 ship report) requires operator judgment
 * today: "does the agent reach for the right surface on episodic questions?"
 * This gate is the structural half of that judgment — automating the part that
 * doesn't need an LLM.
 *
 * Each probe pairs a canonical episodic-shape query with a seeded artifact and
 * asserts the hybrid retrieval pipeline:
 *   (a) finds the right answer in the top-K,
 *   (b) does so via the `match_kind='episodic'` channel (added 2026-05-18
 *       to close the user_framing/session_summary coverage gap diagnosed in
 *       session d2237451 turn 215),
 *   (c) ranks the episodic hit ABOVE any conceptual decoy if both exist.
 *
 * Failures here mean either the episodic channel regressed or the isEpisodicQuery
 * detector stopped routing the boost for a known-episodic query shape. Pair this
 * with the Vesna behavioral probes (which test agent-side routing) for the full
 * v7 qualitative gate.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { hybridSearchSync, isEpisodicQuery } from '../../core/hybrid-retrieval.js';

interface EpisodicProbe {
  id: string;
  query: string;
  // Seeded user_framing event(s) on the session — the "memory" the gate asks about
  framings: Array<{ session_id: string; detail: string; ts_offset_seconds: number }>;
  // What the answer should contain (case-insensitive substring match against any top-3 hit)
  expected_substring: string;
  // Optional: also seed a conceptual decoy artifact so the gate confirms episodic wins
  decoy_artifact?: { kind: string; title: string; body: string };
}

const PROBES: EpisodicProbe[] = [
  {
    id: 'pc-crashed-recovery',
    query: 'why did the last session stop, did the PC crash?',
    framings: [
      {
        session_id: 'probe-sess-a',
        detail: 'Again, PC crashed, please read the entirety or the previous session, no skipping or skimming!',
        ts_offset_seconds: -3600,
      },
    ],
    expected_substring: 'pc crashed',
  },
  {
    id: 'production-cutoff',
    query: 'why did production stop the last 2 times we were making V7?',
    framings: [
      {
        session_id: 'probe-sess-b',
        detail: 'yo, can you tell me last 2 times why did the production stopped? We were making V7 and got cut off',
        ts_offset_seconds: -7200,
      },
    ],
    expected_substring: 'production',
  },
  {
    id: 'session-cutoff-mid-pivot',
    query: 'what happened when we got cut off mid-pivot last time',
    framings: [
      {
        session_id: 'probe-sess-c',
        detail: 'got cut off mid-phase during the cutover gate redesign. picking up where we left',
        ts_offset_seconds: -10800,
      },
    ],
    expected_substring: 'cut off',
  },
  {
    id: 'episodic-wins-over-conceptual-decoy',
    query: 'why did production stop',
    framings: [
      {
        session_id: 'probe-sess-d',
        detail: 'production stopped because the cutover gate refused',
        ts_offset_seconds: -1800,
      },
    ],
    // Conceptual decoy: a decision artifact that mentions production in passing
    decoy_artifact: {
      kind: 'decision',
      title: 'Production deployment strategy for v8',
      body: 'When production goes live we should batch the rollout...',
    },
    expected_substring: 'cutover gate refused',
  },
  {
    id: 'session-summary-channel',
    query: 'when did we work on migrations.ts cutover',
    framings: [],
    // No user_framing; the answer lives in sessions.session_summary
    decoy_artifact: undefined,
    expected_substring: 'cutover',
  },
];

function seedUserFraming(
  db: TestDatabase,
  sessionId: string,
  project: string,
  detail: string,
  timestampSec: number,
): void {
  const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
  const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
  const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  const tsVal = hasMs ? timestampSec * 1000 : timestampSec;
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
     VALUES (?, ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
  ).run(sessionId, project, detail, tsVal);
}

describe('Episodic Recall Gate — v7 qualitative thesis (structural half)', () => {
  it('every probe query is detected as episodic-shape', () => {
    for (const probe of PROBES) {
      // The session-summary channel probe doesn't strictly need the recency
      // boost — it relies on plain keyword match. The others should all
      // trigger the isEpisodicQuery detector.
      if (probe.id !== 'session-summary-channel') {
        expect(isEpisodicQuery(probe.query)).toBe(true);
      }
    }
  });

  it.each(PROBES)('probe[$id]: hybrid search surfaces the episodic answer', (probe) => {
    const db = createTestDb();
    const project = 'claudex-v3';
    const now = Math.floor(Date.now() / 1000);

    // Seed the user_framing events
    for (const f of probe.framings) {
      createSession(db, {
        session_id: f.session_id,
        project,
        cwd: 'C:/test',
        source: 'test',
      });
      seedUserFraming(db, f.session_id, project, f.detail, now + f.ts_offset_seconds);
    }

    // For the session-summary probe — seed a sessions.session_summary row
    if (probe.id === 'session-summary-channel') {
      createSession(db, {
        session_id: 'probe-sess-e',
        project,
        cwd: 'C:/test',
        source: 'test',
      });
      db.prepare(
        `UPDATE sessions
           SET session_summary = 'edited migrations.ts (22x) for cutover redesign, V43 epoch normalization'
         WHERE session_id = 'probe-sess-e'`,
      ).run();
    }

    // Optional conceptual decoy
    if (probe.decoy_artifact) {
      const nowMs = Date.now();
      db.prepare(
        `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0.7, ?, ?, '{}')`,
      ).run(
        `decoy-${probe.id}`,
        probe.decoy_artifact.kind,
        probe.decoy_artifact.title,
        probe.decoy_artifact.body,
        project,
        probe.framings[0]?.session_id ?? 'probe-sess-e',
        nowMs,
        nowMs,
      );
    }

    const results = hybridSearchSync(db, probe.query, project, { limit: 5 });

    // PASS criterion: top-3 contains a result with expected_substring
    // AND that result came via match_kind='episodic' (not a stray FTS hit on the decoy)
    const top3 = results.slice(0, 3);
    const episodicHit = top3.find(r =>
      r.match_kind === 'episodic' &&
      String(r.content || '').toLowerCase().includes(probe.expected_substring.toLowerCase()),
    );

    expect(episodicHit, `expected episodic top-3 hit containing "${probe.expected_substring}" for query "${probe.query}"`).toBeDefined();

    // STRICT criterion (episodic-wins-over-decoy probe): the episodic hit
    // must rank above the conceptual decoy. Previously soft because synth
    // episodic rows had confidence=0.6 and the importance multiplier flipped
    // order — closed 2026-05-18 by the `episodic` multiplier (1.6x) in
    // computeArtifactScore which applies post-three-factor when the query
    // is episodic-shape AND the candidate came via the episodic channel.
    if (probe.decoy_artifact && probe.framings.length > 0) {
      const episodicIdx = results.findIndex(r => r.match_kind === 'episodic');
      const decoyIdx = results.findIndex(r => String(r.artifact_id) === `decoy-${probe.id}`);
      expect(episodicIdx).toBeGreaterThanOrEqual(0);
      if (decoyIdx >= 0) {
        expect(episodicIdx).toBeLessThan(decoyIdx);
      }
    }

    db.close();
  });

  // ---------------------------------------------------------------------
  // Counter-probe: confirm the 2.5x episodic multiplier does NOT fire on
  // conceptual queries that happen to share keywords with user_framing
  // events. Without this, a stronger episodic multiplier could over-rank
  // raw operator prompts above real decisions/learnings on conceptual
  // recall — the exact failure shape `feedback_take_position_unless_flagged`
  // tagged as a regression vector before this counter-probe existed.
  // ---------------------------------------------------------------------
  describe('counter-probe: conceptual queries do not get inappropriate episodic boost', () => {
    it('isEpisodicQuery returns false for clearly conceptual queries', () => {
      // None of these should trip the episodic regex — they're asking about
      // decisions/strategy/knowledge, not about past sessions.
      const conceptualQueries = [
        'production deployment strategy',
        'what is our retry policy for API calls',
        'how do migrations handle schema versioning',
        'best practices for observability',
        'compare ollama vs claude subprocess for synthesis',
      ];
      for (const q of conceptualQueries) {
        expect(isEpisodicQuery(q), `query "${q}" should NOT be episodic-shape`).toBe(false);
      }
    });

    it('conceptual decision outranks user_framing on a non-episodic query that shares keywords', () => {
      const db = createTestDb();
      const project = 'claudex-v3';
      const sessionId = 'counter-sess';
      const now = Math.floor(Date.now() / 1000);

      createSession(db, {
        session_id: sessionId,
        project,
        cwd: 'C:/test',
        source: 'test',
      });

      // Real decision artifact about production — high importance, real provenance.
      const nowMs = Date.now();
      db.prepare(
        `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, data)
         VALUES ('real-decision-1', 'decision', 'Production deployment strategy uses blue/green rollout', 'We decided production rollouts use blue/green with health-gated traffic shift', ?, ?, 'active', 0.8, ?, ?, '{}')`,
      ).run(project, sessionId, nowMs, nowMs);

      // user_framing event mentioning "production" — would surface via the
      // episodic channel if isEpisodicQuery were tripped, but for a
      // conceptual query it should NOT get the 2.5x boost.
      seedUserFraming(
        db,
        sessionId,
        project,
        'we got cut off mid-production-rollout last session',
        now - 1800,
      );

      // The query is conceptual-shape ("strategy" not "why/when/what happened").
      // Expect: isEpisodicQuery=false, decision outranks user_framing.
      const query = 'production deployment strategy';
      expect(isEpisodicQuery(query)).toBe(false);

      const results = hybridSearchSync(db, query, project, { limit: 5 });

      const decisionIdx = results.findIndex(r => r.artifact_id === 'real-decision-1');
      const episodicIdx = results.findIndex(r => r.match_kind === 'episodic');

      expect(decisionIdx).toBeGreaterThanOrEqual(0);
      // If the episodic hit even appears, the decision must rank above it.
      if (episodicIdx >= 0) {
        expect(decisionIdx).toBeLessThan(episodicIdx);
      }

      db.close();
    });

    it('episodic multiplier strictly requires BOTH conditions (channel hit AND query shape)', () => {
      // Same seed as above, but switch the query to an episodic-shape one.
      // Verifies the multiplier flips on cleanly when both conditions hold.
      const db = createTestDb();
      const project = 'claudex-v3';
      const sessionId = 'counter-sess-2';
      const now = Math.floor(Date.now() / 1000);

      createSession(db, {
        session_id: sessionId,
        project,
        cwd: 'C:/test',
        source: 'test',
      });

      const nowMs = Date.now();
      db.prepare(
        `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, data)
         VALUES ('real-decision-2', 'decision', 'Production deployment strategy uses blue/green rollout', 'We decided production rollouts use blue/green', ?, ?, 'active', 0.8, ?, ?, '{}')`,
      ).run(project, sessionId, nowMs, nowMs);

      seedUserFraming(
        db,
        sessionId,
        project,
        'why did production stop the last 2 times we deployed',
        now - 1800,
      );

      const conceptualQuery = 'production deployment strategy';
      const episodicQuery = 'why did production stop last time';

      const conceptualResults = hybridSearchSync(db, conceptualQuery, project, { limit: 5 });
      const episodicResults = hybridSearchSync(db, episodicQuery, project, { limit: 5 });

      // Find the user_framing rank in each
      const conceptualEpIdx = conceptualResults.findIndex(r => r.match_kind === 'episodic');
      const episodicEpIdx = episodicResults.findIndex(r => r.match_kind === 'episodic');

      // On the episodic query: user_framing should rank higher than on the conceptual query.
      // (Either it doesn't surface on conceptual, or it surfaces lower.)
      if (conceptualEpIdx >= 0 && episodicEpIdx >= 0) {
        expect(episodicEpIdx).toBeLessThanOrEqual(conceptualEpIdx);
      }

      // On the conceptual query: real decision should outrank user_framing
      const conceptualDecisionIdx = conceptualResults.findIndex(r => r.artifact_id === 'real-decision-2');
      expect(conceptualDecisionIdx).toBeGreaterThanOrEqual(0);
      if (conceptualEpIdx >= 0) {
        expect(conceptualDecisionIdx).toBeLessThan(conceptualEpIdx);
      }

      db.close();
    });
  });

  it('gate aggregate: ≥ 80% probes pass (ship gate threshold)', () => {
    const db = createTestDb();
    const project = 'claudex-v3';
    const now = Math.floor(Date.now() / 1000);
    let pass = 0;
    for (const probe of PROBES) {
      try {
        for (const f of probe.framings) {
          try {
            createSession(db, {
              session_id: f.session_id,
              project,
              cwd: 'C:/test',
              source: 'test',
            });
          } catch { /* already created — skip */ }
          seedUserFraming(db, f.session_id, project, f.detail, now + f.ts_offset_seconds);
        }
        if (probe.id === 'session-summary-channel') {
          try {
            createSession(db, {
              session_id: 'probe-sess-e',
              project,
              cwd: 'C:/test',
              source: 'test',
            });
          } catch { /* already created */ }
          db.prepare(
            `UPDATE sessions SET session_summary = ? WHERE session_id = 'probe-sess-e'`,
          ).run('edited migrations.ts (22x) for cutover redesign, V43 epoch normalization');
        }

        const results = hybridSearchSync(db, probe.query, project, { limit: 5 });
        const top3 = results.slice(0, 3);
        const hit = top3.find(r =>
          r.match_kind === 'episodic' &&
          String(r.content || '').toLowerCase().includes(probe.expected_substring.toLowerCase()),
        );
        if (hit) pass++;
      } catch { /* probe-level failure counts as fail */ }
    }
    const ratio = pass / PROBES.length;
    // 80% gate threshold mirrors Vesna SC#3 convention
    expect(ratio).toBeGreaterThanOrEqual(0.8);
    db.close();
  });
});
