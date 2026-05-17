/**
 * Phase 14-07f — hard-link LLM proposer.
 *
 * Runs at session-end (hooked via Angel boundary-detector's post-session-end
 * action sequence). Analyzes recent artifacts via LLM and proposes
 * `triggered_by`, `evidence_for`, `contradicts` links. Proposals go through
 * `proposeHardLink` (PENDING state — operator must confirm before they enter
 * the active link graph).
 *
 * Per Good Child policy: NO autonomous confirmation. Every hard-link commit
 * requires operator action. This module only PROPOSES.
 *
 * LLM primary: local Ollama via callLocalLLM.
 * Cloud fallback: Anthropic Opus via ANTHROPIC_API_KEY env var (opt-in only).
 * NEVER calls CC's CLIProxyAPI (deadlock in hook context).
 */

import type { Database } from 'better-sqlite3';
import { proposeHardLink, getDecayCount, DECAY_THRESHOLD } from '../core/link-writer.js';
import { callLocalLLM } from '../angel/llama-client.js';
import { generate } from '../angel/generation-backend.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProposerParams {
  db: Database;
  session_id: string;
  project: string;
  /** Hours lookback for recent artifact selection. Default: 24. */
  recent_artifact_window_hours?: number;
  /** Max proposals per run (top by confidence). Default: 10. */
  max_proposals_per_run?: number;
}

export interface ProposerResult {
  proposed: number;
  skipped_decayed: number;
  skipped_invalid: number;
  llm_error: boolean;
}

interface RawProposal {
  src_artifact_id: string;
  dst_artifact_id: string;
  type: string;
  confidence: number;
  rationale: string;
}

interface ParsedProposals {
  proposals: RawProposal[];
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

export const LLM_PROPOSER_PROMPT = `You are analyzing a session of a developer's recent work to propose KNOWLEDGE-GRAPH LINKS between artifacts.

You will see artifacts (observations, decisions, lessons, checkpoints, handoffs) from the past N hours.

Your job: identify pairs of artifacts where one TRIGGERED the other, or one is EVIDENCE FOR another, or two CONTRADICT each other.

ONLY propose links you are reasonably confident about. False positives cost operator review time.

Output strict JSON:
{
  "proposals": [
    {
      "src_artifact_id": "<32-hex>",
      "dst_artifact_id": "<32-hex>",
      "type": "triggered_by" | "evidence_for" | "contradicts",
      "confidence": 0.0-1.0,
      "rationale": "<one-sentence reason an operator would understand>"
    }
  ]
}

Do not output any text outside the JSON object.`;

// ─── Test injection points ────────────────────────────────────────────────────

type LLMCallable = (prompt: string) => Promise<string>;

let _llmCallableForTest: LLMCallable | null = null;

/**
 * Override the LLM callable for tests and simulation.
 * Pass null to restore the default (callLocalLLM).
 */
export function _setLLMCallableForTest(fn: LLMCallable | null): void {
  _llmCallableForTest = fn;
}

// ─── Cloud fallback ───────────────────────────────────────────────────────────

/**
 * Call Anthropic Opus via direct API key (billing key, not OAuth).
 * Only used when ANTHROPIC_API_KEY is set.
 * Non-throwing — callers catch and fall back to local.
 */
async function callOpusApiKey(prompt: string, apiKey: string): Promise<string> {
  const url = 'https://api.anthropic.com/v1/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const httpStatus = resp.status;
    const err = new Error(`Opus API error ${resp.status}: ${resp.statusText}`) as Error & { httpStatus: number };
    err.httpStatus = httpStatus;
    throw err;
  }

  const data = (await resp.json()) as {
    content?: Array<{ type: string; text: string }>;
  };

  const text = data.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('Opus API response missing content');
  return text.trim();
}

// ─── Prompt building ──────────────────────────────────────────────────────────

interface ArtifactSummary {
  id: string;
  kind: string;
  summary: string;
}

export function buildProposerPrompt(artifacts: ArtifactSummary[]): string {
  const artifactLines = artifacts
    .map(a => `  - id: ${a.id}\n    kind: ${a.kind}\n    summary: ${a.summary.slice(0, 200)}`)
    .join('\n');

  return `${LLM_PROPOSER_PROMPT}\n\nArtifacts to analyze:\n${artifactLines}`;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Strict JSON parse of the LLM's response.
 * Returns an array of raw proposals, or empty array on any parse failure.
 */
export function parseProposerResponse(raw: string): RawProposal[] {
  try {
    // Strip any markdown fences if present.
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(stripped) as ParsedProposals;
    if (!parsed || !Array.isArray(parsed.proposals)) return [];
    return parsed.proposals;
  } catch {
    return [];
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_MS = 60_000; // 1 minute per session

function isRateLimited(db: Database, session_id: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM telemetry
    WHERE session_id = ?
      AND event_kind = 'session_end_action'
      AND json_extract(detail, '$.action') = 'hard_link_proposer'
      AND timestamp_epoch_ms >= ?
    LIMIT 1
  `).get(session_id, Date.now() - RATE_LIMIT_MS);
  return row !== undefined;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_HARD_LINK_TYPES = new Set(['triggered_by', 'evidence_for', 'contradicts']);

function isValidProposal(p: RawProposal): boolean {
  if (!p.src_artifact_id || typeof p.src_artifact_id !== 'string') return false;
  if (!p.dst_artifact_id || typeof p.dst_artifact_id !== 'string') return false;
  if (!p.type || !VALID_HARD_LINK_TYPES.has(p.type)) return false;
  if (typeof p.confidence !== 'number') return false;
  if (p.confidence < 0 || p.confidence > 1) return false;
  if (!p.rationale || typeof p.rationale !== 'string') return false;
  return true;
}

function artifactExists(db: Database, id: string, project: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM artifact WHERE id = ? AND project = ? LIMIT 1`
  ).get(id, project);
  return row !== undefined;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the hard-link LLM proposer.
 *
 * Rate-limited: at most 1 run per session per minute.
 * Flag-gated: caller (boundary-detector) checks CLAUDEX_HARD_LINK_PROPOSER env.
 * Max proposals: 10 per run (top by confidence).
 * Decay-aware: skips (src, dst, type) tuples at DECAY_THRESHOLD.
 * Non-throwing: catches LLM errors and returns llm_error: true.
 */
export async function runHardLinkProposer(p: ProposerParams): Promise<ProposerResult> {
  const {
    db,
    session_id,
    project,
    recent_artifact_window_hours = 24,
    max_proposals_per_run = 10,
  } = p;

  const result: ProposerResult = {
    proposed: 0,
    skipped_decayed: 0,
    skipped_invalid: 0,
    llm_error: false,
  };

  const startMs = Date.now();

  // --- Rate limit check ---
  if (isRateLimited(db, session_id)) {
    // Emit rate-limited telemetry (raw SQL — event kind not in typed enum).
    try {
      db.prepare(`
        INSERT INTO telemetry (session_id, event_kind, detail, adapter)
        VALUES (?, 'session_end_action', ?, 'angel-boundary')
      `).run(
        session_id,
        JSON.stringify({
          action: 'hard_link_proposer',
          outcome: 'skipped',
          duration_ms: 0,
          skip_reason: 'rate_limited',
        }),
      );
    } catch { /* non-fatal */ }
    return result;
  }

  // --- Recent artifact selection ---
  const windowMs = recent_artifact_window_hours * 3600 * 1000;
  const cutoffMs = Date.now() - windowMs;

  const artifacts = db.prepare(`
    SELECT id, kind,
           COALESCE(title, SUBSTR(body, 1, 200), '(no content)') AS summary
    FROM artifact
    WHERE project = ?
      AND created_at_epoch_ms >= ?
    ORDER BY created_at_epoch_ms DESC
    LIMIT 50
  `).all(project, cutoffMs) as Array<{ id: string; kind: string; summary: string }>;

  if (artifacts.length === 0) {
    // Nothing to analyze — emit ok/skipped telemetry.
    try {
      db.prepare(`
        INSERT INTO telemetry (session_id, event_kind, detail, adapter)
        VALUES (?, 'session_end_action', ?, 'angel-boundary')
      `).run(
        session_id,
        JSON.stringify({
          action: 'hard_link_proposer',
          outcome: 'skipped',
          duration_ms: Date.now() - startMs,
          skip_reason: 'no_recent_artifacts',
        }),
      );
    } catch { /* non-fatal */ }
    return result;
  }

  // --- Build prompt ---
  const prompt = buildProposerPrompt(artifacts);

  // --- LLM call ---
  let rawResponse: string | null = null;

  try {
    if (_llmCallableForTest !== null) {
      rawResponse = await _llmCallableForTest(prompt);
    } else {
      const apiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
      if (apiKey.length > 0) {
        // Cloud (Opus) first; fall back to local on failure.
        try {
          rawResponse = await callOpusApiKey(prompt, apiKey);
        } catch {
          rawResponse = await callLocalLLM({ prompt, maxTokens: 2048 });
        }
      } else {
        rawResponse = await callLocalLLM({ prompt, maxTokens: 2048 });
      }
    }
  } catch {
    result.llm_error = true;
  }

  // --- Parse response ---
  let proposals: RawProposal[] = [];
  if (rawResponse !== null && !result.llm_error) {
    proposals = parseProposerResponse(rawResponse);
  }

  // --- Sort by confidence descending; cap at max_proposals_per_run ---
  proposals.sort((a, b) => b.confidence - a.confidence);
  if (proposals.length > max_proposals_per_run) {
    proposals = proposals.slice(0, max_proposals_per_run);
  }

  // --- Validate, decay-check, and propose each surviving proposal ---
  for (const raw of proposals) {
    // Validate shape.
    if (!isValidProposal(raw)) {
      result.skipped_invalid += 1;
      continue;
    }

    // Validate src/dst artifact IDs exist in this project.
    if (
      !artifactExists(db, raw.src_artifact_id, project) ||
      !artifactExists(db, raw.dst_artifact_id, project)
    ) {
      result.skipped_invalid += 1;
      continue;
    }

    // Decay guard: skip if this (src, dst, type) tuple is at threshold.
    const decayCount = getDecayCount(db, raw.src_artifact_id, raw.dst_artifact_id, raw.type as 'triggered_by' | 'evidence_for' | 'contradicts');
    if (decayCount >= DECAY_THRESHOLD) {
      result.skipped_decayed += 1;
      continue;
    }

    // Propose.
    try {
      const id = proposeHardLink(db, {
        src_artifact_id: raw.src_artifact_id,
        dst_artifact_id: raw.dst_artifact_id,
        type: raw.type as 'triggered_by' | 'evidence_for' | 'contradicts',
        proposed_confidence: raw.confidence,
        proposed_by_session: session_id,
        proposer_rationale: raw.rationale,
      });
      if (id !== null) {
        result.proposed += 1;
      } else {
        // proposeHardLink returned null — decayed internally.
        result.skipped_decayed += 1;
      }
    } catch {
      result.skipped_invalid += 1;
    }
  }

  // --- Telemetry: emit session_end_action row with all counters ---
  const duration_ms = Date.now() - startMs;
  try {
    db.prepare(`
      INSERT INTO telemetry (session_id, event_kind, detail, adapter)
      VALUES (?, 'session_end_action', ?, 'angel-boundary')
    `).run(
      session_id,
      JSON.stringify({
        action: 'hard_link_proposer',
        outcome: result.llm_error ? 'failed' : 'ok',
        duration_ms,
        proposed: result.proposed,
        skipped_decayed: result.skipped_decayed,
        skipped_invalid: result.skipped_invalid,
        llm_error: result.llm_error,
      }),
    );
  } catch { /* non-fatal */ }

  return result;
}
