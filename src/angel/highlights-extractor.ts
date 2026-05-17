/**
 * Angel Highlights Extractor — Phase 13 Plan 03 + Phase 14 Plan 14-00.
 *
 * Phase 14 Plan 14-00 (2026-05-15) — Opus path rewired:
 * RCA-2 found that the original OAuth path (reading the MAX subscription
 * OAuth token from `~/.claude/.credentials.json` and calling
 * `api.anthropic.com/v1/messages` directly) returned HTTP 429
 * `rate_limit_error` on every call. Result: 100% of session_highlights
 * since Phase 13 ship were degraded=1, falling back to the Ollama-
 * proxied cloud model. The OAuth path is removed.
 *
 * The new contract:
 *   - When `process.env.ANTHROPIC_API_KEY` is set + non-empty, the
 *     extractor calls Opus via API key (separate billing path). Opus
 *     success: degraded=0. Opus failure: degraded=1 + fallback to
 *     local LLM via `callLocalLLM`.
 *   - When `ANTHROPIC_API_KEY` is unset (the default — operator opts
 *     in explicitly), the extractor goes straight to `callLocalLLM`
 *     (Ollama daemon, default `glm-5.1:cloud` proxied to Ollama Cloud).
 *     Local-as-primary success: degraded=0. Local-as-primary failure:
 *     degraded=1 with `local_llm_failed` reason.
 *
 * Degraded flag discipline mirrors CLAUDE.md reranker-fallback pattern:
 *   - every fallback artifact carries degraded=true + degraded_reason + degraded_model
 *   - `frame_extraction_fallback` telemetry row written on every fallback path
 *   - HTTP status code (when applicable) preserved in telemetry detail
 *   - heartbeat re-attempts Opus on degraded artifacts (next tick)
 *   - operator-visible health line surfaces in session-start when degraded
 *     persists beyond one heartbeat cycle (assembly side, Plan 13-04)
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { upsertHighlights } from '../intelligence/session-highlights.js';
import { recordFrameExtractionFallback } from '../core/telemetry-signals.js';
import { callLocalLLM } from './llama-client.js';
import type { AngelConfig } from './types.js';
import { recordExtractedFrom } from '../intelligence/soft-link-writers.js';

const FRAME_EXTRACTION_PROMPT = `You are analyzing a session transcript to extract the session's FRAME — the mental model, open questions, reframes, tools introduced, decisions not made, and posture context.

IMPORTANT: Extract what the participants were THINKING ABOUT and WHY they made decisions, not just what happened.

Respond with ONLY valid JSON (no prose, no markdown fences) matching this schema exactly:
{
  "mental_model": "string — the project-state theory as of session-end; what the agent understood the project to be doing",
  "open_questions": [{"question": "string", "context": "string — why this is unresolved"}],
  "reframes": [{"old_theory": "string", "new_theory": "string", "why": "string — what caused the reframe"}],
  "tools_introduced": [{"path": "string — file or script path", "purpose": "string — what it does"}],
  "decisions_not_made": [{"gray_area": "string", "why_deferred": "string"}],
  "posture_context": "string or null — emotional/working-style notes visible from the transcript (e.g. operator was frustrated about X, that informed Y)"
}

If a field has no entries, use null for strings and [] for arrays.

SESSION TRANSCRIPT:
`;

export type DegradedReason =
  | 'opus_timeout'
  | 'opus_non_2xx'
  | 'opus_auth_failed'
  | 'opus_parse_failed'
  | 'opus_empty_response'
  | 'local_llm_failed';

/**
 * Test seam: when set, treat Opus path as available regardless of
 * `ANTHROPIC_API_KEY`. Production callers should never set this.
 */
let opusEnabledForTest = false;
export function _setOpusEnabledForTest(enabled: boolean): void {
  opusEnabledForTest = enabled;
}

interface ExtractResult {
  mental_model?: string;
  open_questions?: Array<{ question: string; context: string }>;
  reframes?: Array<{ old_theory: string; new_theory: string; why: string }>;
  tools_introduced?: Array<{ path: string; purpose: string }>;
  decisions_not_made?: Array<{ gray_area: string; why_deferred: string }>;
  posture_context?: string;
}

/** Hook for tests: overrides the Opus OAuth callable. */
let opusCallableForTest: ((prompt: string) => Promise<ExtractResult>) | null = null;
/** Hook for tests: overrides the fallback callable. */
let fallbackCallableForTest: ((prompt: string, model: string) => Promise<ExtractResult>) | null = null;

export function _setOpusCallableForTest(fn: ((prompt: string) => Promise<ExtractResult>) | null): void {
  opusCallableForTest = fn;
}
export function _setFallbackCallableForTest(fn: ((prompt: string, model: string) => Promise<ExtractResult>) | null): void {
  fallbackCallableForTest = fn;
}

export interface ExtractHighlightsParams {
  db: Database;
  sessionId: string;
  project: string;
  projectDir: string;
  config: AngelConfig;
}

export async function extractHighlightsForSession(params: ExtractHighlightsParams): Promise<void> {
  const { db, sessionId, project, projectDir, config } = params;

  // Find the Sessions/ markdown file for this session
  const sessionsDir = path.join(projectDir, 'Sessions');
  let sessionMarkdown: string;
  try {
    const files = fs.readdirSync(sessionsDir);
    const file = files.find(f => f.endsWith(`_${sessionId}.md`));
    if (!file) return; // No Sessions/ file yet — wait for 13-01 to write it
    sessionMarkdown = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
  } catch {
    return; // Sessions/ dir doesn't exist for this project yet
  }

  if (!sessionMarkdown.trim()) return;

  // Cap transcript at ~50K chars for LLM context budget; keep the end (most recent context).
  const cappedMarkdown = sessionMarkdown.length > 50_000
    ? sessionMarkdown.slice(-50_000)
    : sessionMarkdown;

  const prompt = FRAME_EXTRACTION_PROMPT + cappedMarkdown;

  let result: ExtractResult | null = null;
  let degraded = false;
  let degradedReason: DegradedReason | undefined;
  let degradedModel: string | undefined;

  // Phase 14 Plan 14-00 (2026-05-15): API-key-gated Opus path.
  // Opus is opt-in via ANTHROPIC_API_KEY (a real billing API key, not the
  // MAX subscription OAuth token — RCA-2 confirmed the OAuth path returns
  // HTTP 429 on every programmatic call). When the env var is unset, we
  // treat the local LLM as the chosen primary path (degraded=0).
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  const opusAvailable = opusEnabledForTest || apiKey.length > 0 || opusCallableForTest !== null;

  if (opusAvailable) {
    // Try Opus first; on any failure, drop to local LLM (degraded path).
    try {
      const opusFn = opusCallableForTest ?? ((p: string) => callOpusApiKey(p, apiKey));
      result = await opusFn(prompt);
    } catch (err) {
      const reason = classifyOpusError(err);
      const httpStatus = (err && typeof err === 'object')
        ? (err as { httpStatus?: number }).httpStatus
        : undefined;
      degraded = true;
      degradedReason = reason;

      // Telemetry: include http_status when known so future debugging can
      // distinguish 429-rate-limit from 401-auth from 5xx-server.
      try {
        recordFrameExtractionFallback(db, {
          session_id: sessionId,
          project,
          reason,
          fallback_model: config.localModel ?? 'unknown',
          ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
        });
      } catch { /* non-fatal */ }

      // Fall back to local LLM
      try {
        const fallbackFn = fallbackCallableForTest ?? callLocalFallback;
        result = await fallbackFn(prompt, config.localModel ?? '');
        degradedModel = config.localModel;
      } catch {
        // Both Opus AND local failed — write a minimal degraded row so the
        // session does not stay in the pending queue forever (next heartbeat
        // retries via the pending sweep).
        result = {};
        degradedModel = config.localModel ?? 'none';
      }
    }
  } else {
    // No API key — local LLM IS the primary path. Success is degraded=0.
    try {
      const fallbackFn = fallbackCallableForTest ?? callLocalFallback;
      result = await fallbackFn(prompt, config.localModel ?? '');
    } catch {
      // Local-as-primary failed. Surface explicitly so substrate health
      // can flag the situation (no Opus to fall back to here).
      degraded = true;
      degradedReason = 'local_llm_failed';
      degradedModel = config.localModel ?? 'none';
      try {
        recordFrameExtractionFallback(db, {
          session_id: sessionId,
          project,
          reason: 'local_llm_failed',
          fallback_model: config.localModel ?? 'none',
        });
      } catch { /* non-fatal */ }
      result = {};
    }
  }

  upsertHighlights(db, {
    session_id: sessionId,
    project,
    mental_model: result?.mental_model,
    open_questions: result?.open_questions,
    reframes: result?.reframes,
    tools_introduced: result?.tools_introduced,
    decisions_not_made: result?.decisions_not_made,
    posture_context: result?.posture_context,
    degraded,
    degraded_reason: degradedReason,
    degraded_model: degradedModel,
    created_at_epoch_ms: Date.now(),
  });

  // 14-07d: emit extracted_from soft links (post-write; non-blocking).
  // Only emit when we have a non-degraded extraction (degraded=true means
  // the result was empty/minimal; no meaningful highlight artifact to link).
  if (!degraded) {
    try {
      // Look up the highlight artifact in the V17 artifact table.
      // session_highlights rows may be represented in the artifact table
      // post-Wave-1 migration as kind='session_highlight'.
      const highlightArtifact = db.prepare(
        `SELECT id FROM artifact
         WHERE kind = 'session_highlight' AND session_id = ? AND project = ?
         ORDER BY created_at_epoch_ms DESC
         LIMIT 1`
      ).get(sessionId, project) as { id: string } | undefined;

      // Look up the session frame artifact (kind='session_log' from the Sessions/ directory).
      const sessionFrameArtifact = db.prepare(
        `SELECT id FROM artifact
         WHERE kind = 'session_log' AND session_id = ? AND project = ?
         ORDER BY created_at_epoch_ms DESC
         LIMIT 1`
      ).get(sessionId, project) as { id: string } | undefined;

      if (highlightArtifact && sessionFrameArtifact) {
        // 14-07d: emit extracted_from soft link per highlight.
        recordExtractedFrom({
          db,
          session_id: sessionId,
          highlight_artifact_id: highlightArtifact.id,
          session_frame_artifact_id: sessionFrameArtifact.id,
        });
      } else {
        // V17 artifact rows not yet present (pre-Wave-1 migration or file
        // not yet ingested) — skip silently with telemetry.
        try {
          db.prepare(
            `INSERT INTO telemetry (session_id, event_kind, detail, adapter) VALUES (?, 'soft_link_skipped', ?, '14-07d-soft-link-writers')`
          ).run(sessionId, JSON.stringify({
            reason: 'artifact_not_found',
            site: 'recordExtractedFrom',
            has_highlight: !!highlightArtifact,
            has_session_frame: !!sessionFrameArtifact,
          }));
        } catch { /* non-fatal */ }
      }
    } catch {
      // Non-fatal: soft-link emission errors must never surface to callers.
    }
  }
}

/**
 * Call Claude Opus 4.7 via the standard `x-api-key` API key header.
 *
 * Phase 14 Plan 14-00 (2026-05-15): replaces the prior `callOpusOAuth`
 * implementation which used the MAX subscription OAuth token from
 * `~/.claude/.credentials.json`. RCA-2 confirmed OAuth-credentialed
 * direct API calls return HTTP 429 `rate_limit_error` on every
 * invocation — interactive CC sessions consume the same token through
 * CC's own client and don't hit the limit, but Angel calling the API
 * directly does. The OAuth path is gone; Opus is opt-in via a real
 * billing API key in the `ANTHROPIC_API_KEY` env var.
 *
 * Throws on timeout, non-2xx, auth failure, empty response, or JSON
 * parse failure. The thrown Error carries `degradedReason` (for
 * bucketed classification) AND `httpStatus` (for precise debugging)
 * so the caller can record both in telemetry.
 */
async function callOpusApiKey(prompt: string, apiKey: string): Promise<ExtractResult> {
  if (!apiKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY required'), {
      degradedReason: 'opus_auth_failed' as DegradedReason,
    });
  }

  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const { request } = await import('node:https');
  const { responseText, statusCode } = await new Promise<{ responseText: string; statusCode: number }>((resolve, reject) => {
    const req = request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          // Distinguish auth errors (401/403) from generic non-2xx so
          // the bucketed reason is informative without masking the precise
          // HTTP status (preserved on the error object).
          const reason: DegradedReason = (status === 401 || status === 403)
            ? 'opus_auth_failed'
            : 'opus_non_2xx';
          reject(Object.assign(new Error(`HTTP ${status}`), {
            degradedReason: reason,
            httpStatus: status,
          }));
        } else {
          resolve({ responseText: data, statusCode: status });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('Timeout'), {
        degradedReason: 'opus_timeout' as DegradedReason,
      }));
    });
    req.on('error', (e) => reject(Object.assign(e, {
      degradedReason: 'opus_non_2xx' as DegradedReason,
    })));
    req.write(body);
    req.end();
  });

  // statusCode is referenced to keep the variable live for any future
  // diagnostics; the success path itself doesn't condition on it.
  void statusCode;

  let parsed: { content?: Array<{ text?: string }> };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw Object.assign(new Error('Outer JSON parse failure'), {
      degradedReason: 'opus_parse_failed' as DegradedReason,
    });
  }
  const text = parsed?.content?.[0]?.text ?? '';
  if (!text.trim()) {
    throw Object.assign(new Error('Empty response'), {
      degradedReason: 'opus_empty_response' as DegradedReason,
    });
  }
  return parseExtractResult(text, 'opus_parse_failed');
}

/**
 * Call the Angel-configured local LLM (callLocalLLM) as fallback.
 * Throws on transport or parse failure; the heartbeat retry mechanism
 * handles persistent failure.
 */
async function callLocalFallback(prompt: string, model: string): Promise<ExtractResult> {
  const response = await callLocalLLM({ prompt, model: model || undefined, maxTokens: 2048 });
  return parseExtractResult(response, 'opus_parse_failed');
}

function parseExtractResult(raw: string, reasonOnFail: DegradedReason): ExtractResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/im, '').trim();
  try {
    return JSON.parse(cleaned) as ExtractResult;
  } catch {
    throw Object.assign(new Error('Inner JSON parse failure'), { degradedReason: reasonOnFail });
  }
}

function classifyOpusError(err: unknown): DegradedReason {
  if (err && typeof err === 'object') {
    const reason = (err as { degradedReason?: string }).degradedReason;
    if (
      reason === 'opus_timeout' ||
      reason === 'opus_non_2xx' ||
      reason === 'opus_auth_failed' ||
      reason === 'opus_parse_failed' ||
      reason === 'opus_empty_response'
    ) {
      return reason;
    }
  }
  return 'opus_non_2xx';
}
