/**
 * Angel Highlights Extractor — Phase 13 Plan 03.
 *
 * Produces a session_highlights row by calling Claude Opus 4.7 via OAuth
 * (primary) against the Sessions/ markdown for a completed session. Falls
 * back to the Angel-configured local LLM (AngelConfig.localModel via
 * callLocalLLM) on Opus failure.
 *
 * Degraded flag discipline mirrors CLAUDE.md reranker-fallback pattern:
 *   - every fallback artifact carries degraded=true + degraded_reason + degraded_model
 *   - `frame_extraction_fallback` telemetry row written on every fallback path
 *   - heartbeat re-attempts Opus on degraded artifacts (next tick)
 *   - operator-visible health line surfaces in session-start when degraded
 *     persists beyond one heartbeat cycle (assembly side, Plan 13-04)
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { upsertHighlights } from '../intelligence/session-highlights.js';
import { recordFrameExtractionFallback } from '../core/telemetry-signals.js';
import { callLocalLLM } from './llama-client.js';
import type { AngelConfig } from './types.js';

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
  | 'opus_empty_response';

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

  // Try Claude Opus 4.7 via OAuth (primary)
  try {
    const opusFn = opusCallableForTest ?? callOpusOAuth;
    result = await opusFn(prompt);
  } catch (err) {
    const reason = classifyOpusError(err);
    degraded = true;
    degradedReason = reason;

    // Emit fallback telemetry row
    try {
      recordFrameExtractionFallback(db, {
        session_id: sessionId,
        project,
        reason,
        fallback_model: config.localModel ?? 'unknown',
      });
    } catch { /* non-fatal */ }

    // Try Ollama/local fallback
    try {
      const fallbackFn = fallbackCallableForTest ?? callLocalFallback;
      result = await fallbackFn(prompt, config.localModel ?? '');
      degradedModel = config.localModel;
    } catch {
      // Both failed — write a minimal degraded row so the session does not stay
      // in the pending queue forever (next heartbeat retries via the pending sweep).
      result = {};
      degradedModel = config.localModel ?? 'none';
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
}

/**
 * Call Claude Opus 4.7 via OAuth using credentials from ~/.claude/.credentials.json.
 * Throws on timeout, non-2xx, auth failure, empty response, or JSON parse failure.
 * The thrown Error carries a `degradedReason` property for the caller to classify.
 */
async function callOpusOAuth(prompt: string): Promise<ExtractResult> {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let token: string;
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')) as
      { claudeAiOauth?: { accessToken?: string }; access_token?: string };
    token = creds.claudeAiOauth?.accessToken ?? creds.access_token ?? '';
    if (!token) throw new Error('No access token in credentials');
  } catch {
    throw Object.assign(new Error('OAuth credentials unavailable'), { degradedReason: 'opus_auth_failed' as DegradedReason });
  }

  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const { request } = await import('node:https');
  const responseText = await new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { degradedReason: 'opus_non_2xx' as DegradedReason }));
        } else {
          resolve(data);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('Timeout'), { degradedReason: 'opus_timeout' as DegradedReason }));
    });
    req.on('error', (e) => reject(Object.assign(e, { degradedReason: 'opus_non_2xx' as DegradedReason })));
    req.write(body);
    req.end();
  });

  let parsed: { content?: Array<{ text?: string }> };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw Object.assign(new Error('Outer JSON parse failure'), { degradedReason: 'opus_parse_failed' as DegradedReason });
  }
  const text = parsed?.content?.[0]?.text ?? '';
  if (!text.trim()) {
    throw Object.assign(new Error('Empty response'), { degradedReason: 'opus_empty_response' as DegradedReason });
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
