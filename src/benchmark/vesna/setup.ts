/**
 * Setup-step DSL — deterministic, idempotent DB-population primitives.
 * Operates against an isolated test DB at ~/.claudex/db/claudex-vesna-test.db.
 * Production claudex.db is NEVER touched.
 *
 * Each artifact / critical_rule row written is tagged via session_id prefix
 * `vesna-probe-...` so resetTestDb can scrub probe-scoped state between runs
 * without touching any non-probe rows the test DB might accumulate.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../core/storage.js';
import { createV17Artifact } from '../../tests/helpers/v7-unified-schema.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import type { SetupStep } from './types.js';

const VESNA_TEST_SESSION_PREFIX = 'vesna-probe-';
const VESNA_TEST_RULE_PROJECT = 'vesna-test';

/** Returns the canonical Vesna test DB path. Honors CLAUDEX_VESNA_DB env var for CI. */
export function getVesnaTestDbPath(): string {
  const override = process.env.CLAUDEX_VESNA_DB;
  if (override) return path.normalize(override);
  return path.normalize(path.join(os.homedir(), '.claudex', 'db', 'claudex-vesna-test.db'));
}

/** Returns the temp directory used for handoff fixtures + narration flag. */
export function getVesnaFixtureDir(): string {
  return path.normalize(path.join(os.tmpdir(), 'claudex-vesna-fixtures'));
}

/** Path to the handoff fixture file written by `kind: handoff` setup steps. */
export function getHandoffFixturePath(): string {
  return path.join(getVesnaFixtureDir(), 'ACTIVE.md');
}

/** Path to the narration-directive flag file. */
export function getNarrationFlagPath(): string {
  return path.join(getVesnaFixtureDir(), 'narration.json');
}

/** Open (and migrate) the Vesna test DB. Creates parent dirs as needed. */
export function openVesnaTestDb(): Database.Database {
  const dbPath = getVesnaTestDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return openDatabase(dbPath);
}

export interface SessionContext {
  /** Synthetic session id for probe-scoped writes — derived from probe.id. */
  sessionId: string;
  /** Project for any setup-step that doesn't carry an explicit project. */
  defaultProject: string;
}

/**
 * Apply each setup step in order against the test DB. Idempotent: re-applying
 * the same steps yields the same observable state (rows reset by resetTestDb,
 * fixtures rewritten in place).
 */
export async function applySetup(
  db: Database.Database,
  steps: SetupStep[] | undefined,
  ctx: SessionContext,
): Promise<void> {
  if (!steps || steps.length === 0) return;

  fs.mkdirSync(getVesnaFixtureDir(), { recursive: true });

  for (const step of steps) {
    switch (step.kind) {
      case 'artifact': {
        const { kind, summary, content, project, tags } = step.payload;
        // 14-07b: migrated from legacy artifacts — write directly to V17 `artifact` table
        // so hybridSearchSync (which reads from V17) finds probe fixture rows.
        // Tags are preserved in the data JSON sidecar (artifact_ref was legacy-only).
        const dataSidecar: Record<string, unknown> = {
          artifact_ref: tags && tags.length > 0 ? `vesna:${JSON.stringify(tags)}` : `vesna:${ctx.sessionId}`,
        };
        createV17Artifact(db, {
          kind,
          project,
          title: summary.slice(0, 150),
          body: content ?? summary,
          status: 'active',
          confidence: 1.0, // High importance (was 5/5) so probe artifacts surface above ambient noise.
          session_id: ctx.sessionId,
          data: dataSidecar,
        });
        break;
      }

      case 'handoff': {
        const { status, phase, summary, topic, body_what_next } = step.payload;
        const lines: string[] = [];
        lines.push('---');
        lines.push(`status: ${status}`);
        lines.push(`phase: ${phase}`);
        lines.push(`topic: ${topic}`);
        lines.push(`summary: ${JSON.stringify(summary)}`);
        lines.push('---');
        lines.push('');
        lines.push(`# Probe handoff (${ctx.sessionId})`);
        lines.push('');
        if (body_what_next) {
          lines.push("**What's next:** " + body_what_next);
          lines.push('');
        }
        fs.writeFileSync(getHandoffFixturePath(), lines.join('\n'), 'utf-8');
        break;
      }

      case 'critical_rule': {
        const { rule, project } = step.payload;
        const proj = project ?? ctx.defaultProject ?? VESNA_TEST_RULE_PROJECT;
        // Stable dedup-on-replay: INSERT OR IGNORE (V13 unique index on project+rule_text).
        db.prepare(
          `INSERT OR IGNORE INTO critical_rules
            (project, rule_text, source, drift_risk, base_ttl, current_ttl)
           VALUES (?, ?, 'author', 'safety', 5, 5)`,
        ).run(proj, rule);
        break;
      }

      case 'narration_directive': {
        fs.writeFileSync(
          getNarrationFlagPath(),
          JSON.stringify({ silent: step.payload.silent }),
          'utf-8',
        );
        break;
      }

      case 'deliberation_surface': {
        // v6 Phase 10 — synthetic past-deliberation: artifact + companion transcript chunks.
        // Writes via the production write surfaces so the deliberation-surfacing routing
        // path (Plan 10-01 routeFromArtifact) can fan out from the artifact reference.
        const { artifact, transcript_chunks } = step.payload;
        // 14-07b: migrated from legacy artifacts — write directly to V17 `artifact` table.
        const deliberationRef = artifact.tags && artifact.tags.length > 0
          ? `vesna:${JSON.stringify(artifact.tags)}`
          : `vesna:${ctx.sessionId}`;
        createV17Artifact(db, {
          kind: artifact.kind,
          project: artifact.project,
          title: artifact.summary.slice(0, 150),
          body: artifact.summary,
          status: 'active',
          confidence: 1.0,
          session_id: ctx.sessionId,
          data: { artifact_ref: deliberationRef },
        });
        for (const chunk of transcript_chunks) {
          upsertChunk(db, chunk);
        }
        break;
      }

      default: {
        const exhaustive: never = step;
        throw new Error(`applySetup: unknown step kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

/**
 * Reset all probe-scoped state between runs. Scrubs:
 *   - artifacts where session_id begins with `vesna-probe-`
 *   - critical_rules where project = 'vesna-test' (or any project starting with vesna-)
 *   - the handoff fixture file
 *   - the narration flag file
 *
 * Untagged rows in the test DB are preserved so an operator running tests
 * against a working DB doesn't lose unrelated state. Production claudex.db
 * is never opened by this harness, so there is no cross-DB risk.
 */
export async function resetTestDb(db: Database.Database): Promise<void> {
  try {
    db.prepare('DELETE FROM artifacts WHERE session_id LIKE ?').run(
      `${VESNA_TEST_SESSION_PREFIX}%`,
    );
  } catch {
    // Table may not exist on a fresh DB — ignore.
  }
  try {
    db.prepare(`DELETE FROM critical_rules WHERE project LIKE 'vesna-%'`).run();
  } catch {
    // Table may not exist — ignore.
  }
  // v6 Phase 10 — scrub probe-scoped transcript chunks. Synthetic chunks
  // are tagged via session_id starting with the deliberation fixture prefix
  // ('phase-10-deliberation-fixture-'); resetTestDb removes them between runs.
  try {
    db.prepare(
      `DELETE FROM transcript_chunk_v6 WHERE session_id LIKE 'phase-10-deliberation-fixture-%'`,
    ).run();
  } catch {
    // Table may not exist on a pre-V32 DB — ignore.
  }
  for (const p of [getHandoffFixturePath(), getNarrationFlagPath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // Non-fatal — best-effort cleanup.
    }
  }
}

/** Constructs the deterministic synthetic session id used by a probe run. */
export function probeSessionId(probeId: string, trial: number): string {
  return `${VESNA_TEST_SESSION_PREFIX}${probeId}-t${trial}`;
}
