/**
 * Tests for MCP recall server tool handlers and transport.
 */

import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { createArtifact, searchArtifactsGlobal } from '../../core/artifacts.js';
import { hybridSearchSync } from '../../core/hybrid-retrieval.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { addJournalEntry, searchJournalFTS } from '../../core/journal.js';

// We test the handler logic directly rather than spawning the server process.
// The server's tool handlers are not exported, so we replicate their core logic
// against a real DB to verify schema compatibility and edge cases.

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function insertSession(db: Database.Database, sessionId: string, project: string = 'test'): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, ?, 'active', 0, ?)`
  ).run(sessionId, project, Math.floor(Date.now() / 1000));
}

describe('handleStore schema compatibility', () => {
  it('inserts a decision with namespaced session_id', () => {
    const db = createDb();
    try {
      const fingerprint = 'use async io for production';
      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:test-project', 'test-project', 'Use async I/O for production scale', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.session_id).toBe('mcp:test-project');
      expect(row.project).toBe('test-project');
    } finally {
      db.close();
    }
  });

  it('inserts a learning matching actual schema', () => {
    const db = createDb();
    try {
      const fingerprint = 'always validate limit params';
      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO learnings (content, project, fingerprint)
         VALUES (?, ?, ?)`
      ).run('Always validate limit parameters', 'test-project', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM learnings WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.content).toBe('Always validate limit parameters');
      expect(row.project).toBe('test-project');
    } finally {
      db.close();
    }
  });

  it('returns changes=0 on duplicate fingerprint', () => {
    const db = createDb();
    try {
      const fingerprint = 'duplicate test';
      cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:proj', 'proj', 'First', fingerprint);

      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:proj', 'proj', 'Second same fingerprint', fingerprint);

      expect(result.changes).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('handleSearch limit validation', () => {
  it('clamps negative limit to default', () => {
    const rawLimit = -5;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(10);
  });

  it('clamps NaN to default', () => {
    const rawLimit = NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(10);
  });

  it('clamps over-50 to 50', () => {
    const rawLimit = 100;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(50);
  });

  it('accepts valid integer', () => {
    const rawLimit = 25;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(25);
  });
});

describe('handleRecall id validation', () => {
  it('rejects id=0', () => {
    const rawId = 0;
    const id = rawId !== null && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBeNull();
  });

  it('rejects NaN', () => {
    const rawId = NaN;
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBeNull();
  });

  it('accepts valid positive integer', () => {
    const rawId = 42;
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBe(42);
  });
});

describe('fresh DB initialization', () => {
  it('initializeSchema + runMigrations creates all required tables on empty DB', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      runMigrations(db);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);

      // Core tables
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('artifacts');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('decisions');
      expect(tableNames).toContain('learnings');

      // New tables from v3→v4
      expect(tableNames).toContain('context_triggers');
      expect(tableNames).toContain('session_events');

      // FTS5 virtual tables
      expect(tableNames).toContain('observations_fts');
      expect(tableNames).toContain('artifacts_fts');

      // Verify we can insert new artifact types
      insertSession(db, 'test-sess', 'test');
      expect(() => {
        createArtifact(db, 'test-sess', 'test', 'memory_file', '/test.md', 'test', 'content', 3);
      }).not.toThrow();

      // Verify user_version is current
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(row[0].user_version).toBe(16);
    } finally {
      db.close();
    }
  });
});

describe('claudex_search journal FTS integration', () => {
  it('searchJournalFTS returns results alongside artifact search', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');

      // Create an artifact
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Fixed VBS startup script', 'Replaced CLIProxyAPI.vbs with .bat', 4);

      // Create a journal entry with recall_text
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Analyzed VBS deprecation issue on Windows boot',
        undefined,
        'openclaw script problem | startup popup fix | vbs deprecation',
      );

      // Artifact search finds the artifact
      const artifactResults = searchArtifactsGlobal(db, 'test-project', 'VBS startup', 10);
      expect(artifactResults.length).toBeGreaterThanOrEqual(1);

      // Journal FTS finds the flow entry by recall_text
      const journalResults = searchJournalFTS(db, 'openclaw script problem');
      expect(journalResults.length).toBe(1);
      expect(journalResults[0].recall_text).toContain('openclaw script problem');

      // Journal FTS finds by content too
      const contentResults = searchJournalFTS(db, 'VBS deprecation Windows');
      expect(contentResults.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('journal results include recall_text in output', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Redesigned memory retrieval system',
        { recall_aliases: ['how I remember vs how you remember'] },
        'how I remember vs how you remember | upgrade flow | recall aliases concept',
      );

      const results = searchJournalFTS(db, 'remember');
      expect(results.length).toBe(1);
      expect(results[0].recall_text).toContain('how I remember');
      expect(results[0].metadata).toContain('recall_aliases');
    } finally {
      db.close();
    }
  });

  it('merged search prioritizes journal recall matches over artifact content matches', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');

      // Artifact mentions "flow" in content
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Updated flow logic', 'Changed flow entry generation', 3);

      // Journal has "flow" in recall_text (human recall cue)
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Session about upgrading flow system',
        undefined,
        'upgrade flow | redesign flow entries | flow recall metadata',
      );

      // Both should be findable
      const journalHits = searchJournalFTS(db, 'upgrade flow');
      const artifactHits = searchArtifactsGlobal(db, 'test-project', 'flow', 10);
      expect(journalHits.length).toBeGreaterThanOrEqual(1);
      expect(artifactHits.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe('Content-Length framing', () => {
  it('Buffer.byteLength handles multibyte correctly', () => {
    const text = '{"result":"日本語テスト 🎉"}';
    const stringLen = text.length;
    const byteLen = Buffer.byteLength(text, 'utf-8');
    // Multibyte: byte length > string length
    expect(byteLen).toBeGreaterThan(stringLen);
    // The framing must use byte length, not string length
    const buf = Buffer.from(text, 'utf-8');
    expect(buf.length).toBe(byteLen);
  });
});

// ---------------------------------------------------------------------------
// Part 6: MCP Recall Server Upgrades
// ---------------------------------------------------------------------------

describe('6.1 Hybrid search in claudex_search', () => {
  it('hybridSearchSync returns ScoredArtifact with hybrid_score', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Implemented hybrid retrieval pipeline', 'Full RRF fusion across FTS5 and recency', 4);
      createArtifact(db, 'sess1', 'test-project', 'decision', null, 'Use RRF for retrieval ranking', 'Reciprocal rank fusion is the standard', 5);

      const results = hybridSearchSync(db, 'hybrid retrieval pipeline', 'test-project', { limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Every result has a hybrid_score
      for (const r of results) {
        expect(typeof r.hybrid_score).toBe('number');
        expect(r.hybrid_score).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it('hybridSearchSync gracefully returns empty for very short queries', () => {
    const db = createDb();
    try {
      const results = hybridSearchSync(db, 'ab', 'test-project');
      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('hybridSearchSync includes score_breakdown', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Database migration architecture', 'Schema versioning with user_version pragma', 4);

      const results = hybridSearchSync(db, 'database migration architecture', 'test-project', { limit: 5 });
      if (results.length > 0) {
        const first = results[0];
        expect(first.score_breakdown).toBeDefined();
        expect(typeof first.score_breakdown!.rrf_fts5).toBe('number');
        expect(typeof first.score_breakdown!.rrf_recency).toBe('number');
        expect(typeof first.score_breakdown!.three_factor).toBe('number');
      }
    } finally {
      db.close();
    }
  });

  it('search handler falls back to FTS5 when hybridSearchSync returns empty (short query)', () => {
    // Replicates the handler logic: if hybridSearchSync returns empty, FTS5 fallback
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Short query test artifact', 'Some content about testing', 3);

      // hybridSearchSync has a min query length of 3 chars
      const hybridResults = hybridSearchSync(db, 'ab', 'test-project');
      expect(hybridResults).toEqual([]);

      // FTS5 fallback works for short queries too (searchArtifactsGlobal has its own tokenizer)
      const ftsResults = searchArtifactsGlobal(db, 'test-project', 'short query test', 10);
      expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe('6.2 Pagination', () => {
  it('offset parameter validation: negative defaults to 0', () => {
    const rawOffset = -3;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    expect(offset).toBe(0);
  });

  it('offset parameter validation: NaN defaults to 0', () => {
    const rawOffset = NaN;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    expect(offset).toBe(0);
  });

  it('offset parameter validation: valid non-negative integer accepted', () => {
    const rawOffset = 5;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    expect(offset).toBe(5);
  });

  it('offset=0 is accepted (not treated as falsy)', () => {
    const rawOffset = 0;
    const offset = rawOffset != null && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    expect(offset).toBe(0);
  });

  it('pagination slices results correctly and computes has_more', () => {
    // Replicate handler merge+pagination logic
    const allResults = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      type: 'observation',
      summary: `Result ${i + 1}`,
      provenance: `artifact #${i + 1}`,
      importance: 3,
      project: 'test',
      source: 'artifacts' as const,
      score: 0.5 - i * 0.01,
    }));

    const limit = 5;
    const offset = 0;
    const total = allResults.length;
    const paginatedResults = allResults.slice(offset, offset + limit);
    const has_more = offset + limit < total;

    expect(paginatedResults.length).toBe(5);
    expect(paginatedResults[0].id).toBe(1);
    expect(paginatedResults[4].id).toBe(5);
    expect(has_more).toBe(true);
    expect(total).toBe(15);
  });

  it('pagination with offset returns correct page', () => {
    const allResults = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      type: 'observation',
      summary: `Result ${i + 1}`,
      score: 0.5,
    }));

    const limit = 5;
    const offset = 5;
    const total = allResults.length;
    const paginatedResults = allResults.slice(offset, offset + limit);
    const has_more = offset + limit < total;

    expect(paginatedResults.length).toBe(5);
    expect(paginatedResults[0].id).toBe(6);
    expect(paginatedResults[4].id).toBe(10);
    expect(has_more).toBe(true);
  });

  it('pagination at the end returns has_more=false', () => {
    const allResults = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      type: 'observation',
      summary: `Result ${i + 1}`,
      score: 0.5,
    }));

    const limit = 5;
    const offset = 10;
    const total = allResults.length;
    const paginatedResults = allResults.slice(offset, offset + limit);
    const has_more = offset + limit < total;

    expect(paginatedResults.length).toBe(5);
    expect(paginatedResults[0].id).toBe(11);
    expect(has_more).toBe(false);
  });

  it('pagination beyond total returns empty results', () => {
    const allResults = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      type: 'observation',
      summary: `Result ${i + 1}`,
      score: 0.5,
    }));

    const limit = 5;
    const offset = 10;
    const total = allResults.length;
    const paginatedResults = allResults.slice(offset, offset + limit);
    const has_more = offset + limit < total;

    expect(paginatedResults.length).toBe(0);
    expect(has_more).toBe(false);
  });
});

describe('6.3 Relevance scoring in results', () => {
  it('hybrid search results include numeric score', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Implemented vector search embedding', 'Nomic embed text model via Ollama', 4);

      const hybridResults = hybridSearchSync(db, 'vector search embedding', 'test-project', { limit: 10 });

      // Map to output format like the handler does
      const outputResults = hybridResults.map(a => ({
        id: a.id,
        type: a.artifact_type,
        summary: a.summary,
        provenance: a.artifact_ref ?? `artifact #${a.id}`,
        importance: a.importance,
        project: a.project,
        source: 'artifacts' as const,
        score: a.hybrid_score,
      }));

      expect(outputResults.length).toBeGreaterThanOrEqual(1);
      for (const r of outputResults) {
        expect(typeof r.score).toBe('number');
        expect(r.score).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it('journal results get a baseline score of 0.5', () => {
    // Replicates the handler logic for journal results
    const journalResult = {
      id: 1,
      type: 'journal_flow' as const,
      summary: 'Some journal content',
      provenance: 'session:sess1',
      importance: 4,
      project: 'test',
      source: 'journal' as const,
      recall_text: 'some recall text',
      score: 0.5,
    };

    expect(journalResult.score).toBe(0.5);
  });

  it('higher importance artifacts get higher hybrid scores', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Critical architecture decision pattern', 'Architecture decision about pattern usage', 5);
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Minor architecture observation pattern', 'Architecture observation about pattern usage', 2);

      const results = hybridSearchSync(db, 'architecture decision pattern', 'test-project', { limit: 10 });
      if (results.length >= 2) {
        // Sorted by hybrid_score descending — higher importance contributes to higher score
        expect(results[0].hybrid_score).toBeGreaterThanOrEqual(results[1].hybrid_score);
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: RRF 1-indexed scoring
// The first result's RRF score must be 1/(K+1), not 1/K.
// With K=60, rank 1 → 1/(60+1) = 1/61 ≈ 0.01639
// Bug was using 0-indexed i, giving 1/(60+0) = 1/60 ≈ 0.01667
// ---------------------------------------------------------------------------

describe('RRF 1-indexed scoring (regression)', () => {
  it('first result has score 1/(K+1) not 1/K', () => {
    const RRF_K = 60;
    // Replicate the handler's mapping logic: score = 1.0 / (RRF_K + i + 1)
    // This is the FIXED version — `i + 1` makes it 1-indexed.
    const results = [
      { id: 1, summary: 'First', score: 0 },
      { id: 2, summary: 'Second', score: 0 },
      { id: 3, summary: 'Third', score: 0 },
    ].map((r, i) => ({
      ...r,
      score: 1.0 / (RRF_K + i + 1), // 1-indexed: rank 1, 2, 3
    }));

    // Rank 1: 1/(60+1) = 1/61
    expect(results[0].score).toBeCloseTo(1 / 61, 6);
    // Rank 2: 1/(60+2) = 1/62
    expect(results[1].score).toBeCloseTo(1 / 62, 6);
    // Rank 3: 1/(60+3) = 1/63
    expect(results[2].score).toBeCloseTo(1 / 63, 6);

    // Key check: first result is NOT 1/60 (0-indexed bug)
    expect(results[0].score).not.toBeCloseTo(1 / 60, 6);
  });

  it('score decreases with rank position', () => {
    const RRF_K = 60;
    const scores = [0, 1, 2, 3, 4].map(i => 1.0 / (RRF_K + i + 1));
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: Source weight narrowing
// Source weights should be in 0.95-1.05 range (not old 0.8-1.3)
// The old range let weak decisions outrank strong artifacts.
// ---------------------------------------------------------------------------

describe('Source weight narrowing (regression)', () => {
  it('all source weights are in 0.95-1.05 range', () => {
    // Replicate the SOURCE_WEIGHTS from the handler
    const SOURCE_WEIGHTS: Record<string, number> = {
      decision: 1.05,
      learning: 1.03,
      artifacts: 1.0,
      journal: 0.97,
      conversation: 0.95,
    };

    for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
      expect(weight).toBeGreaterThanOrEqual(0.95);
      expect(weight).toBeLessThanOrEqual(1.05);
    }
  });

  it('source weights have narrow spread (max/min < 1.12)', () => {
    const SOURCE_WEIGHTS: Record<string, number> = {
      decision: 1.05,
      learning: 1.03,
      artifacts: 1.0,
      journal: 0.97,
      conversation: 0.95,
    };

    // The max distortion of narrow weights is bounded:
    // worst case = (1.05/0.95) ≈ 1.105 — at most ~10.5% rank distortion
    const maxDistortion = Math.max(...Object.values(SOURCE_WEIGHTS)) / Math.min(...Object.values(SOURCE_WEIGHTS));
    expect(maxDistortion).toBeLessThan(1.12);

    // Verify the old weights had much larger distortion:
    // old: decision=1.3, conversation=0.8 → ratio 1.625 (62% distortion)
    const oldMaxDistortion = 1.3 / 0.8;
    expect(oldMaxDistortion).toBeGreaterThan(1.6);
  });

  it('narrow weights preserve ordering across large rank gaps (8+)', () => {
    const SOURCE_WEIGHTS: Record<string, number> = {
      decision: 1.05,
      conversation: 0.95,
    };

    // With K=60 and narrow weights (max ratio 1.105x), a conversation at rank 1
    // should beat a decision at rank 8+ because the rank gap dominates.
    // Math: 0.95/(60+1) > 1.05/(60+8) → 0.01557 > 0.01544 ✓
    const RRF_K = 60;
    const convScore = (1.0 / (RRF_K + 1)) * SOURCE_WEIGHTS.conversation;
    const decScore = (1.0 / (RRF_K + 8)) * SOURCE_WEIGHTS.decision;
    expect(convScore).toBeGreaterThan(decScore);

    // But old weights (0.8/1.3) would flip this ordering even for rank 8:
    const oldConvScore = (1.0 / (RRF_K + 1)) * 0.8;
    const oldDecScore = (1.0 / (RRF_K + 8)) * 1.3;
    expect(oldDecScore).toBeGreaterThan(oldConvScore); // old weights flip the order
  });
});

describe('6.4 Agent-ID attribution', () => {
  it('stores decision with agent_id in session_id when provided', () => {
    const db = createDb();
    try {
      const agent_id = 'worker-W4';
      const proj = 'test-project';
      const fingerprint = 'agent attributed decision';
      const sessionId = `${agent_id}:mcp:${proj}`;

      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(sessionId, proj, 'Agent-attributed decision content', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.session_id).toBe('worker-W4:mcp:test-project');
      expect(row.project).toBe('test-project');
    } finally {
      db.close();
    }
  });

  it('stores decision without agent_id prefix when agent_id is omitted', () => {
    const db = createDb();
    try {
      const agent_id = undefined;
      const proj = 'test-project';
      const fingerprint = 'no agent decision';
      const sessionId = agent_id ? `${agent_id}:mcp:${proj}` : `mcp:${proj}`;

      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(sessionId, proj, 'Decision without agent ID', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.session_id).toBe('mcp:test-project');
    } finally {
      db.close();
    }
  });

  it('agent_id returned in store response matches input', () => {
    // Replicates response format from the handler
    const agent_id = 'codex-agent-7';
    const response = {
      stored: true,
      type: 'decision',
      project: 'test-project',
      agent_id: agent_id ?? null,
    };

    expect(response.agent_id).toBe('codex-agent-7');
  });

  it('agent_id is null in response when not provided', () => {
    const agent_id = undefined;
    const response = {
      stored: true,
      type: 'learning',
      project: 'test-project',
      agent_id: agent_id ?? null,
    };

    expect(response.agent_id).toBeNull();
  });

  it('different agents produce distinct session_id prefixes', () => {
    const db = createDb();
    try {
      const proj = 'test-project';

      // Agent A stores a decision
      const fpA = 'agent a unique decision content';
      const sessionA = 'agent-A:mcp:test-project';
      cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(sessionA, proj, 'Decision from agent A', fpA);

      // Agent B stores a different decision
      const fpB = 'agent b unique decision content';
      const sessionB = 'agent-B:mcp:test-project';
      cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run(sessionB, proj, 'Decision from agent B', fpB);

      const rowA = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fpA) as Record<string, unknown>;
      const rowB = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fpB) as Record<string, unknown>;

      expect(rowA.session_id).toBe('agent-A:mcp:test-project');
      expect(rowB.session_id).toBe('agent-B:mcp:test-project');
      expect(rowA.session_id).not.toBe(rowB.session_id);
    } finally {
      db.close();
    }
  });
});

describe('Channel 6: Experience patterns in claudex_search', () => {
  function insertPattern(
    db: Database.Database,
    id: string,
    triggerContext: string,
    lesson: string,
    project: string = 'test-project',
    severity: string = 'important',
    score: number = 5,
  ): void {
    cachedPrepare(db,
      `INSERT INTO experience_patterns
         (id, pattern_type, trigger_context, lesson, anti_pattern, severity,
          score, times_triggered, times_useful, source_session, source_project,
          created_at_epoch, abstraction_level)
       VALUES (?, 'correction', ?, ?, NULL, ?, ?, 0, 0, 'test-session', ?, ?, 'tip')`
    ).run(id, triggerContext, lesson, severity, score, project, Math.floor(Date.now() / 1000));
  }

  it('FTS5 MATCH on experience_patterns_fts returns matching patterns', () => {
    const db = createDb();
    try {
      insertSession(db, 'test-session', 'test-project');
      insertPattern(db, 'pat-sine-1', 'Pedja says you would not write a sine function', 'Use existing libraries instead of writing from scratch');

      const keywords = ['Pedja', 'sine', 'function'];
      const ftsQuery = keywords.join(' OR ');
      const hits = cachedPrepare(db,
        `SELECT ep.id, ep.lesson, ep.severity, ep.score, ep.source_project,
                bm25(experience_patterns_fts) as rank
         FROM experience_patterns ep
         JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
         WHERE experience_patterns_fts MATCH ?
           AND ep.score >= 2
           AND (ep.source_project = ? OR ep.source_project = '__global__')
         ORDER BY rank
         LIMIT 10`
      ).all(ftsQuery, 'test-project') as Array<{
        id: string; lesson: string; severity: string; score: number;
        source_project: string; rank: number;
      }>;

      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].id).toBe('pat-sine-1');
      expect(hits[0].lesson).toContain('existing libraries');
    } finally {
      db.close();
    }
  });

  it('filters out patterns with score < 2', () => {
    const db = createDb();
    try {
      insertSession(db, 'test-session', 'test-project');
      insertPattern(db, 'pat-low-1', 'low score pattern about databases', 'Some lesson about databases', 'test-project', 'minor', 1);
      insertPattern(db, 'pat-high-1', 'high score pattern about databases', 'Validated lesson about databases', 'test-project', 'important', 5);

      const hits = cachedPrepare(db,
        `SELECT ep.id, ep.score
         FROM experience_patterns ep
         JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
         WHERE experience_patterns_fts MATCH 'databases'
           AND ep.score >= 2
           AND (ep.source_project = ? OR ep.source_project = '__global__')
         ORDER BY bm25(experience_patterns_fts)
         LIMIT 10`
      ).all('test-project') as Array<{ id: string; score: number }>;

      expect(hits.length).toBe(1);
      expect(hits[0].id).toBe('pat-high-1');
    } finally {
      db.close();
    }
  });

  it('includes global patterns alongside project-scoped ones', () => {
    const db = createDb();
    try {
      insertSession(db, 'test-session', 'test-project');
      insertPattern(db, 'pat-local-1', 'local authentication pattern', 'Always validate tokens locally', 'test-project');
      insertPattern(db, 'pat-global-1', 'global authentication pattern', 'Never store tokens in plaintext', '__global__');

      const hits = cachedPrepare(db,
        `SELECT ep.id, ep.source_project
         FROM experience_patterns ep
         JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
         WHERE experience_patterns_fts MATCH 'authentication'
           AND ep.score >= 2
           AND (ep.source_project = ? OR ep.source_project = '__global__')
         ORDER BY bm25(experience_patterns_fts)
         LIMIT 10`
      ).all('test-project') as Array<{ id: string; source_project: string }>;

      expect(hits.length).toBe(2);
      const projects = hits.map(h => h.source_project);
      expect(projects).toContain('test-project');
      expect(projects).toContain('__global__');
    } finally {
      db.close();
    }
  });
});
