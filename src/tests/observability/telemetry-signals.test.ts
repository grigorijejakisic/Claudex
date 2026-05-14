import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  recordRerereadAfterSurface,
  recordRetrievalFallback,
  recordTranscriptInjectionAcceptance,
  recordRetrievedButUnapplied,
} from '../../core/telemetry-signals.js';

describe('recordRerereadAfterSurface', () => {
  let db: TestDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('writes a row with event_kind=signal_reread_after_surface', () => {
    recordRerereadAfterSurface(db, {
      session_id: 'sess-1',
      file_path: '/path/to/file.ts',
      turns_since_surface: 2,
    });
    const row = db
      .prepare("SELECT * FROM telemetry WHERE event_kind = 'signal_reread_after_surface'")
      .get() as { event_kind: string; detail: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.event_kind).toBe('signal_reread_after_surface');
    const detail = JSON.parse(row!.detail);
    expect(detail.session_id).toBe('sess-1');
    expect(detail.turns_since_surface).toBe(2);
  });
});

describe('recordRetrievalFallback', () => {
  let db: TestDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('writes a row with event_kind=signal_retrieval_fallback', () => {
    recordRetrievalFallback(db, {
      session_id: 'sess-2',
      reason: 'vec0_empty',
      channel_used: 'fts_only',
    });
    const row = db
      .prepare("SELECT * FROM telemetry WHERE event_kind = 'signal_retrieval_fallback'")
      .get() as { detail: string } | undefined;
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail);
    expect(detail.reason).toBe('vec0_empty');
    expect(detail.channel_used).toBe('fts_only');
  });
});

describe('recordTranscriptInjectionAcceptance', () => {
  let db: TestDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('writes a row with event_kind=signal_transcript_injection_acceptance', () => {
    recordTranscriptInjectionAcceptance(db, {
      session_id: 'sess-3',
      injected_span_session_id: 'source-sess',
      injected_span_turn_index: 42,
      accepted: true,
    });
    const row = db
      .prepare("SELECT * FROM telemetry WHERE event_kind = 'signal_transcript_injection_acceptance'")
      .get() as { detail: string } | undefined;
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail);
    expect(detail.accepted).toBe(true);
    expect(detail.injected_span_turn_index).toBe(42);
  });
});

describe('recordRetrievedButUnapplied', () => {
  let db: TestDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('writes a row with event_kind=signal_retrieved_but_unapplied', () => {
    recordRetrievedButUnapplied(db, {
      session_id: 'sess-4',
      surfaced_turn_index: 5,
      domain_token: 'big-balkan',
      turns_checked: 3,
    });
    const row = db
      .prepare("SELECT * FROM telemetry WHERE event_kind = 'signal_retrieved_but_unapplied'")
      .get() as { detail: string } | undefined;
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail);
    expect(detail.domain_token).toBe('big-balkan');
    expect(detail.turns_checked).toBe(3);
  });

  it('does NOT throw when telemetry write fails (non-breaking hook)', () => {
    const brokenDb = createTestDb();
    brokenDb.close();
    expect(() =>
      recordRetrievedButUnapplied(brokenDb, {
        session_id: 'sess-5',
        surfaced_turn_index: 1,
        domain_token: 'token',
        turns_checked: 3,
      }),
    ).not.toThrow();
  });
});
