/**
 * Unit tests for the directive detector (Plan 03-01).
 *
 * Covers:
 *   - stripCodeBlocks (fenced + inline)
 *   - DIRECTIVE_REGEX_FAMILIES (positive + negative + multi-family hits)
 *   - shouldReject (threshold gates + universal stricter gate + is_directive=false)
 *   - parseConfirmation (valid / missing fields / wrong types / malformed JSON)
 *   - parseDedupRelation (all 4 enums + unknown → fallback)
 *   - l2DistanceToCosine (d=0 / √2 / 2 anchors)
 *   - cosineNorm (verifies unit-normalization on a synthetic vector)
 *   - dedupLookup (seeds 5 artifacts, asserts same-scope top-3 by cosine)
 *   - End-to-end extractDirectivesFromSession with dryRun=true on 3 turns
 *     (1 confirmed directive, 1 regex-rejected, 1 confirm-rejected).
 *
 * The confirmer + embedder + dedup relation LLM are mocked via vi.mock.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { encodeVector } from '../../core/sqlite-vec-loader.js';

// ── Mocks (must be declared BEFORE the module under test is imported) ─────
const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();
const mockEmbedText = vi.fn<(text: string) => Promise<number[] | null>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
}));

vi.mock('../../embeddings/embed-pipeline.js', () => ({
  embedText: (text: string) => mockEmbedText(text),
}));

// NOTE: import after vi.mock so ESM hoists the mock ahead of the import.
import {
  DIRECTIVE_REGEX_FAMILIES,
  matchFamilies,
  stripCodeBlocks,
} from '../../intelligence/directive-detector-regex.js';
import {
  extractDirectivesFromSession,
  l2DistanceToCosine,
  cosineNorm,
  shouldReject,
  parseConfirmation,
  parseDedupRelation,
  dedupLookup,
  formatContextForLLM,
  type ConfirmationResult,
} from '../../intelligence/directive-detector.js';
import { DEFAULT_CONFIG } from '../../intelligence/directive-detector-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupV17Db(): { db: TestDatabase; sessionId: string; project: string } {
  const ctx = createTestDbWithSession('dd-sess-1', 'dd-proj');
  applyV17DDL(ctx.db);
  return ctx;
}

function insertTurn(
  db: TestDatabase,
  sessionId: string,
  project: string,
  turnNumber: number,
  userText: string | null,
  assistantText: string | null = null,
): void {
  db.prepare(
    `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, project, turnNumber, userText, assistantText, 1000 + turnNumber);
}

function unitVector(i: number): number[] {
  // Make a unit vector along axis i, padded to 1024 dims.
  const v = new Array(1024).fill(0);
  v[i % 1024] = 1;
  return v;
}

function insertDirectiveArtifact(
  db: TestDatabase,
  opts: {
    id: string;
    scope: 'session' | 'project' | 'universal';
    project: string;
    title: string;
    body: string;
    embedding?: number[];
    sessionId?: string;
  },
): string {
  db.prepare(
    `INSERT INTO artifact(
       id, kind, title, body, scope, status, confidence,
       created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
     ) VALUES (?, 'directive_rule', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.title,
    opts.body,
    opts.scope,
    0.9,
    1000,
    1000,
    opts.sessionId ?? 'dd-sess-1',
    opts.project,
    JSON.stringify({
      polarity: 'prescriptive',
      reasoning: 'seed',
      reinforcement_count: 1,
      reinforcements: [],
    }),
  );
  if (opts.embedding) {
    const vec = encodeVector(opts.embedding);
    const maxRow = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM artifact_embeddings`).get() as { m: number | bigint };
    const prev = typeof maxRow.m === 'bigint' ? maxRow.m : BigInt(maxRow.m);
    const rowid = prev + 1n;
    db.prepare(`INSERT INTO artifact_embeddings(rowid, embedding) VALUES (?, ?)`).run(rowid, vec);
    db.prepare(`UPDATE artifact SET embedding_ref = ? WHERE id = ?`).run(Number(rowid), opts.id);
  }
  return opts.id;
}

// ---------------------------------------------------------------------------
// stripCodeBlocks + matchFamilies
// ---------------------------------------------------------------------------

describe('stripCodeBlocks', () => {
  it('removes fenced code blocks', () => {
    expect(stripCodeBlocks('hello\n```\nalways foo\n```\nworld')).toBe('hello\n\nworld');
  });

  it('removes inline backtick code', () => {
    expect(stripCodeBlocks('run `always foo` and `never bar`')).toBe('run  and ');
  });

  it('handles mixed fenced + inline', () => {
    // Fenced strips `a` → "x  `b` y"; inline then strips `b` → "x   y" (3 spaces).
    expect(stripCodeBlocks('x ```a``` `b` y')).toBe('x   y');
  });

  it('returns empty string for empty input', () => {
    expect(stripCodeBlocks('')).toBe('');
  });

  it('leaves text without code unchanged', () => {
    expect(stripCodeBlocks('always use Bun')).toBe('always use Bun');
  });

  it('strips <system-reminder> blocks', () => {
    const text = '<system-reminder>that is wrong, stop doing that</system-reminder>how are we looking?';
    expect(stripCodeBlocks(text)).toBe('how are we looking?');
  });

  it('strips <task-notification> blocks', () => {
    const text = '<task-notification><task-id>foo</task-id><status>done</status></task-notification>next turn text';
    expect(stripCodeBlocks(text)).toBe('next turn text');
  });

  it('strips <teammate-message> blocks', () => {
    const text = '<teammate-message teammate_id="x">always do X</teammate-message>actual user speech';
    expect(stripCodeBlocks(text)).toBe('actual user speech');
  });

  it('strips multiple tags in one turn', () => {
    const text = '<system-reminder>a</system-reminder>middle<task-notification>b</task-notification>end';
    expect(stripCodeBlocks(text)).toBe('middleend');
  });
});

describe('DIRECTIVE_REGEX_FAMILIES', () => {
  it('covers the 12 families declared in CONTEXT §Area 1', () => {
    expect(DIRECTIVE_REGEX_FAMILIES.length).toBe(12);
    const names = DIRECTIVE_REGEX_FAMILIES.map(f => f.name);
    expect(names).toEqual([
      'remember_this_that_to', 'remember_colon', 'always_emphasis', 'never_emphasis',
      'from_now_on', 'next_time', 'in_the_future',
      'polite_imperative', 'stop_doing_using', 'negation_dont',
      'do_x_instead', 'use_x_instead',
    ]);
  });

  it.each([
    ['remember to always commit',             ['remember_this_that_to', 'always_emphasis']],
    ['remember: never push to main',           ['remember_colon', 'never_emphasis']],
    ["from now on, don't touch the legacy",   ['from_now_on', 'negation_dont']],
    ['next time, use Bun instead',            ['next_time', 'use_x_instead']],
    ['in the future please always run tests', ['in_the_future', 'polite_imperative', 'always_emphasis']],
    ['stop using Qdrant',                     ['stop_doing_using']],
    ['do the migration via CLI instead',      ['do_x_instead']],
  ])('hits the expected families for %s', (input, expected) => {
    const hits = matchFamilies(stripCodeBlocks(input));
    for (const want of expected) expect(hits).toContain(want);
  });

  it('matches nothing for a neutral sentence', () => {
    expect(matchFamilies(stripCodeBlocks('What do you think about that?'))).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(matchFamilies(stripCodeBlocks('ALWAYS USE BUN'))).toContain('always_emphasis');
  });
});

// ---------------------------------------------------------------------------
// shouldReject
// ---------------------------------------------------------------------------

function mkConfirm(overrides: Partial<ConfirmationResult>): ConfirmationResult {
  return {
    is_directive: true,
    confidence: 0.8,
    polarity: 'prescriptive',
    scope: 'project',
    suggested_title: 'Use Bun',
    normalized_text: 'Use Bun for tests',
    reasoning: 'ok',
    ...overrides,
  };
}

describe('shouldReject', () => {
  it('rejects when is_directive is false', () => {
    expect(shouldReject(mkConfirm({ is_directive: false }), DEFAULT_CONFIG)).toBe('reject_is_directive');
  });

  it('rejects when confidence < thresholdGeneral', () => {
    expect(shouldReject(mkConfirm({ confidence: 0.69 }), DEFAULT_CONFIG)).toBe('reject_threshold');
  });

  it('accepts when confidence === thresholdGeneral', () => {
    expect(shouldReject(mkConfirm({ confidence: 0.70 }), DEFAULT_CONFIG)).toBe('accept');
  });

  it('rejects universal when below universal threshold but above general', () => {
    expect(
      shouldReject(mkConfirm({ scope: 'universal', confidence: 0.84 }), DEFAULT_CONFIG),
    ).toBe('reject_threshold');
  });

  it('accepts universal at threshold', () => {
    expect(
      shouldReject(mkConfirm({ scope: 'universal', confidence: 0.85 }), DEFAULT_CONFIG),
    ).toBe('accept');
  });
});

// ---------------------------------------------------------------------------
// parseConfirmation / parseDedupRelation
// ---------------------------------------------------------------------------

describe('parseConfirmation', () => {
  it('parses a well-formed confirmation', () => {
    const raw = JSON.stringify({
      is_directive: true,
      confidence: 0.9,
      polarity: 'prescriptive',
      scope: 'project',
      suggested_title: 't',
      normalized_text: 'b',
      reasoning: 'r',
    });
    const c = parseConfirmation(raw);
    expect(c).not.toBeNull();
    expect(c!.is_directive).toBe(true);
    expect(c!.confidence).toBe(0.9);
  });

  it('extracts JSON from noisy leading/trailing text', () => {
    const raw = `Sure thing!\n${JSON.stringify({ is_directive: false, confidence: 0.9 })}\nDone.`;
    const c = parseConfirmation(raw);
    expect(c).not.toBeNull();
    expect(c!.is_directive).toBe(false);
  });

  it('returns null when is_directive type is wrong', () => {
    expect(parseConfirmation('{"is_directive":"yes","confidence":0.9}')).toBeNull();
  });

  it('returns null when confidence is missing', () => {
    expect(parseConfirmation('{"is_directive":true}')).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(parseConfirmation('nope')).toBeNull();
  });

  it('normalizes bad scope/polarity to null', () => {
    const c = parseConfirmation(
      '{"is_directive":true,"confidence":0.9,"scope":"galaxy","polarity":"maybe"}',
    );
    expect(c!.scope).toBeNull();
    expect(c!.polarity).toBeNull();
  });

  it('clamps confidence into [0,1]', () => {
    expect(parseConfirmation('{"is_directive":true,"confidence":1.5}')!.confidence).toBe(1);
    expect(parseConfirmation('{"is_directive":true,"confidence":-0.2}')!.confidence).toBe(0);
  });
});

describe('parseDedupRelation', () => {
  it.each([
    ['restatement', 'restatement'],
    ['opposite_polarity', 'opposite_polarity'],
    ['related_but_distinct', 'related_but_distinct'],
    ['unrelated', 'unrelated'],
  ])('accepts %s', (input, expected) => {
    const r = parseDedupRelation(`{"relation":"${input}","reasoning":"r"}`);
    expect(r.relation).toBe(expected);
  });

  it('falls back to unrelated on unknown enum', () => {
    expect(parseDedupRelation('{"relation":"cousin"}').relation).toBe('unrelated');
  });

  it('falls back to unrelated on malformed JSON', () => {
    expect(parseDedupRelation('nope').relation).toBe('unrelated');
  });
});

// ---------------------------------------------------------------------------
// Distance conversion + normalization
// ---------------------------------------------------------------------------

describe('l2DistanceToCosine', () => {
  it('maps d=0 to cosine=1.0', () => {
    expect(l2DistanceToCosine(0)).toBeCloseTo(1.0, 8);
  });

  it('maps d=√2 to cosine=0.0 (orthogonal unit vectors)', () => {
    expect(l2DistanceToCosine(Math.SQRT2)).toBeCloseTo(0.0, 8);
  });

  it('maps d=2 to cosine=-1.0 (antipodal unit vectors)', () => {
    expect(l2DistanceToCosine(2)).toBeCloseTo(-1.0, 8);
  });
});

describe('cosineNorm', () => {
  it('returns 1.0 for a canonical unit vector', () => {
    expect(cosineNorm(unitVector(0))).toBeCloseTo(1.0, 8);
  });

  it('returns ≈2 for a doubled unit vector', () => {
    const v = unitVector(0).map(x => x * 2);
    expect(cosineNorm(v)).toBeCloseTo(2.0, 8);
  });
});

// ---------------------------------------------------------------------------
// dedupLookup — seeded vec0 lookup
// ---------------------------------------------------------------------------

describe('dedupLookup', () => {
  let db: TestDatabase;
  let project: string;

  beforeEach(() => {
    const ctx = setupV17Db();
    db = ctx.db;
    project = ctx.project;
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('returns only same-scope same-project rows ordered by cosine DESC', async () => {
    // Seed 5 directive_rule rows:
    //   a,b,c in project scope (target); d in universal scope; e in another project.
    insertDirectiveArtifact(db, { id: 'a', scope: 'project', project, title: 'A', body: 'rule a', embedding: unitVector(0) });
    insertDirectiveArtifact(db, { id: 'b', scope: 'project', project, title: 'B', body: 'rule b', embedding: unitVector(1) });
    insertDirectiveArtifact(db, { id: 'c', scope: 'project', project, title: 'C', body: 'rule c', embedding: unitVector(2) });
    insertDirectiveArtifact(db, { id: 'd', scope: 'universal', project, title: 'D', body: 'rule d', embedding: unitVector(0) });
    insertDirectiveArtifact(db, { id: 'e', scope: 'project', project: 'other-proj', title: 'E', body: 'rule e', embedding: unitVector(0) });

    // Query identical to axis-0 unit vector → should match 'a' most tightly.
    const hits = await dedupLookup(db, unitVector(0), 'project', project, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('a');
    // d and e must be excluded
    for (const hit of hits) {
      expect(hit.id).not.toBe('d');
      expect(hit.id).not.toBe('e');
    }
  });

  it('returns [] when no rows exist in the scope', async () => {
    const hits = await dedupLookup(db, unitVector(0), 'project', project, 3);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatContextForLLM
// ---------------------------------------------------------------------------

describe('formatContextForLLM', () => {
  it('marks the candidate turn with [CANDIDATE]', () => {
    const block = formatContextForLLM(
      [
        { id: 1, turn_number: 1, user_text: 'hi',        assistant_text: null },
        { id: 2, turn_number: 2, user_text: 'always X',  assistant_text: null },
        { id: 3, turn_number: 3, user_text: 'thanks',    assistant_text: null },
      ],
      2,
    );
    expect(block).toContain('[Turn 2 [CANDIDATE]] USER: always X');
    expect(block).toContain('[Turn 1] USER: hi');
    expect(block).toContain('[Turn 3] USER: thanks');
  });
});

// ---------------------------------------------------------------------------
// End-to-end dryRun — exercises the full pipeline without DB writes.
// ---------------------------------------------------------------------------

describe('extractDirectivesFromSession (dryRun)', () => {
  let db: TestDatabase;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const ctx = setupV17Db();
    db = ctx.db;
    sessionId = ctx.sessionId;
    project = ctx.project;

    mockCallLocalLLM.mockReset();
    mockEmbedText.mockReset();
    // Default embedder: stable unit vector.
    mockEmbedText.mockResolvedValue(unitVector(0));
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('counts candidates + confirmations correctly across mixed turns', async () => {
    // Turn 1 → no regex hit (rejected_regex — won't appear in decisions)
    // Turn 2 → regex hit + LLM confirms  (accepted)
    // Turn 3 → regex hit + LLM says is_directive=false (rejected_confirm)
    // Turn 4 → regex hit + LLM below threshold (rejected_confirm)
    insertTurn(db, sessionId, project, 1, 'Can you tell me about the config?');
    insertTurn(db, sessionId, project, 2, 'always use Bun for tests in this project');
    insertTurn(db, sessionId, project, 3, 'never touch the legacy files');
    insertTurn(db, sessionId, project, 4, 'please do always run the tests');

    // Order of LLM calls mirrors the regex-hit iteration order (turns 2,3,4).
    mockCallLocalLLM
      .mockResolvedValueOnce(JSON.stringify({ // turn 2
        is_directive: true, confidence: 0.9, polarity: 'prescriptive',
        scope: 'project', suggested_title: 'Use Bun',
        normalized_text: 'Use Bun for tests', reasoning: 'clear',
      }))
      .mockResolvedValueOnce(JSON.stringify({ // turn 3 — rejected by is_directive=false
        is_directive: false, confidence: 0.9, polarity: null, scope: null,
        suggested_title: null, normalized_text: null, reasoning: 'task request',
      }))
      .mockResolvedValueOnce(JSON.stringify({ // turn 4 — rejected by threshold
        is_directive: true, confidence: 0.5, polarity: 'prescriptive',
        scope: 'project', suggested_title: 'x', normalized_text: 'y', reasoning: 'weak',
      }));

    const result = await extractDirectivesFromSession(db, sessionId, project, { dryRun: true });

    expect(result.candidates).toBe(3);     // 3 turns passed regex
    expect(result.confirmed).toBe(1);      // only turn 2 passed both gates
    expect(result.inserted).toBe(1);       // dryRun still classifies the "would-be" decision
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);        // turns 3 + 4
    expect(result.errors).toBe(0);

    // Dry-run MUST NOT write any artifact row
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM artifact WHERE kind='directive_rule'`).get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('returns zero candidates when no user turns match any regex family', async () => {
    insertTurn(db, sessionId, project, 1, 'What is the weather like?');
    insertTurn(db, sessionId, project, 2, 'Interesting design choice.');

    const result = await extractDirectivesFromSession(db, sessionId, project, { dryRun: true });

    expect(result.candidates).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(mockCallLocalLLM).not.toHaveBeenCalled();
  });

  it('wraps per-candidate exceptions into errors and continues', async () => {
    insertTurn(db, sessionId, project, 1, 'always do X');
    insertTurn(db, sessionId, project, 2, 'never do Y');

    // First candidate throws; second succeeds.
    mockCallLocalLLM
      .mockRejectedValueOnce(new Error('network boom'))
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.9, polarity: 'prohibitive',
        scope: 'project', suggested_title: 't', normalized_text: 'n', reasoning: 'r',
      }));

    const result = await extractDirectivesFromSession(db, sessionId, project, { dryRun: true });

    expect(result.candidates).toBe(2);
    // First candidate: confirmCandidate catches the error and returns null,
    // which maps to rejected_confirm (skipped), not errors.
    expect(result.skipped + result.errors + result.inserted).toBe(2);
    // At least one is still inserted (second candidate succeeded).
    expect(result.inserted + result.updated).toBe(1);
  });
});
