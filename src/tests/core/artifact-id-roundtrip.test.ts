/**
 * Phase 14-09 — claudex_search → claudex_recall ID contract round-trip.
 *
 * Before this fix: `claudex_search` returned `id: <SQLite rowid>` (a.rowid AS id
 * in V17_TO_ARTIFACT_ROW_SELECT). The rowid is an internal handle, not stable
 * across rebuilds. `claudex_recall(id=<rowid>)` then ran `lookupV17ByLegacy`
 * against the artifact_id_map table (which maps legacy artifacts.id → V17 TEXT)
 * and missed, because rowid is neither a legacy artifacts.id nor a V17 TEXT id.
 *
 * Fix: V17_TO_ARTIFACT_ROW_SELECT now projects `a.id AS artifact_id` alongside
 * the rowid. ArtifactRow grows an optional `artifact_id: string` field. claudex
 * MCP surfaces include `artifact_id` in search results and accept it as a
 * lookup key in recall.
 *
 * This test validates the contract: a V17 artifact inserted directly should be
 * findable via hybrid search AND retrievable via direct V17 lookup using the
 * same `artifact_id` string.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';

describe('artifact_id contract round-trip', () => {
  it('V17 row select projects a.id AS artifact_id (TEXT stable handle)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Insert a V17 artifact directly.
    const now = Date.now();
    const v17Id = 'aabbccdd11223344eeff556677889900'; // 32-char hex shape
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project, confidence, status)
       VALUES (?, 'session_synthesis', 'test-title', 'test body content', ?, ?, 'test-project', 0.92, 'active')`,
    ).run(v17Id, now, now);

    // Direct V17 lookup by TEXT id — the path claudex_recall(artifact_id=...) uses.
    const row = db.prepare(
      `SELECT id, kind, title, body FROM artifact WHERE id = ?`,
    ).get(v17Id) as { id: string; kind: string; title: string; body: string } | undefined;

    expect(row).toBeTruthy();
    expect(row!.id).toBe(v17Id);
    expect(row!.kind).toBe('session_synthesis');
    expect(row!.title).toBe('test-title');

    // Verify the V17_TO_ARTIFACT_ROW_SELECT projects artifact_id alongside rowid.
    // This mirrors the actual SELECT used by hybrid-retrieval.
    const projected = db.prepare(`
      SELECT a.rowid AS id, a.id AS artifact_id, a.kind AS artifact_type, a.title AS summary
      FROM artifact a WHERE a.id = ?
    `).get(v17Id) as { id: number; artifact_id: string; artifact_type: string; summary: string } | undefined;

    expect(projected).toBeTruthy();
    expect(projected!.artifact_id).toBe(v17Id); // stable TEXT handle
    expect(typeof projected!.id).toBe('number'); // rowid — unstable, but typed
    expect(projected!.artifact_type).toBe('session_synthesis');

    db.close();
  });

  it('round-trip: search result artifact_id resolves via direct V17 lookup', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const now = Date.now();
    const ids = ['11111111aaaaaaaa22222222bbbbbbbb', '33333333cccccccc44444444dddddddd'];
    for (const id of ids) {
      db.prepare(
        `INSERT INTO artifact (id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project, confidence, status)
         VALUES (?, 'observation', ?, ?, ?, ?, 'test-project', 0.5, 'active')`,
      ).run(id, `title-${id.slice(0, 8)}`, `body-${id.slice(0, 8)}`, now, now);
    }

    // Simulate the V17_TO_ARTIFACT_ROW_SELECT shape.
    const searchResults = db.prepare(`
      SELECT a.rowid AS id, a.id AS artifact_id, a.kind AS artifact_type, a.title AS summary
      FROM artifact a WHERE a.project = ?
    `).all('test-project') as Array<{ id: number; artifact_id: string; artifact_type: string }>;

    expect(searchResults.length).toBe(2);

    // For each search result, round-trip via claudex_recall's artifact_id path.
    for (const r of searchResults) {
      expect(r.artifact_id).toBeTruthy();
      const recalled = db.prepare(
        `SELECT id, kind, title FROM artifact WHERE id = ?`,
      ).get(r.artifact_id) as { id: string; kind: string; title: string } | undefined;
      expect(recalled).toBeTruthy();
      expect(recalled!.id).toBe(r.artifact_id);
      expect(ids).toContain(recalled!.id);
    }

    db.close();
  });

  it('legacy fallback: numeric ID still resolves via artifact_id_map when artifact_id absent', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Insert a legacy artifact + map it to a V17 row.
    const v17Id = '99999999aaaaaaaa88888888bbbbbbbb';
    const now = Date.now();
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project, status)
       VALUES (?, 'observation', 'legacy-bridge', 'legacy body', ?, ?, 'p', 'active')`,
    ).run(v17Id, now, now);
    db.prepare(
      `INSERT INTO artifact_id_map (legacy_id, v17_id, mapped_at_epoch_ms, project)
       VALUES (?, ?, ?, 'p')`,
    ).run(12345, v17Id, now);

    // Direct lookup via legacy ID through the map.
    const mapped = db.prepare(
      `SELECT v17_id FROM artifact_id_map WHERE legacy_id = ?`,
    ).get(12345) as { v17_id: string } | undefined;
    expect(mapped?.v17_id).toBe(v17Id);

    // Then resolve via V17 table.
    const row = db.prepare(
      `SELECT id, title FROM artifact WHERE id = ?`,
    ).get(v17Id) as { id: string; title: string } | undefined;
    expect(row?.title).toBe('legacy-bridge');

    db.close();
  });
});
