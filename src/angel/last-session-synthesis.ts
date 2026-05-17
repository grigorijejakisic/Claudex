/**
 * Last-Session Synthesis (LSS) — Phase 14-07k.
 *
 * LLM-driven structured extraction over the previous session's JSONL transcript.
 * Persists as a V17 artifact (kind='session_synthesis') with deterministic ID.
 * Augments (does NOT replace) the existing synthesizeSessionSummary pattern.
 *
 * Public surface:
 *   synthesizeLastSession   — main entry point; called from session-end hook
 *   parseLLMSynthesisOutput — parses and normalizes LLM JSON output
 *   validateSynthesisSchema — type-guard for LastSessionSynthesis
 *   persistSynthesisArtifact — UPSERT into V17 artifact table
 *   deriveSynthesisArtifactId — deterministic sha256-based ID
 *
 * Safety rules:
 *   - Uses Ollama (hook-safe). Never calls CC's CLIProxyAPI.
 *   - Non-throwing at the top level. All failures emit one telemetry row.
 *   - V17 artifact storage only — no flat-file shim.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { fromClaudeCode } from '../intelligence/canonical-session-ir.js';
import { callLocalLLM } from './llama-client.js';
import { generate } from './generation-backend.js';
import { EMBEDDED_PROMPTS } from './embedded-prompts.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OperatorPivot {
  at_turn: number;
  pivot_summary: string;
}

export interface AgentPosition {
  at_turn: number;
  position_summary: string;
}

export interface LastSessionSynthesis {
  schema_version: 1;
  session_id: string;
  operator_pivots: OperatorPivot[];
  agent_positions: AgentPosition[];
  last_unresolved_question: string | null;
  recommended_next_action: string;
  confidence: number;          // 0-1
  prompt_version: string;      // e.g. 'v1'
  llm_model: string;
  generated_at_epoch_ms: number;
  degraded?: boolean;           // true if confidence ∈ [0.3, 0.5)
}

export interface SynthesizeOpts {
  project: string;
  jsonl_path?: string;
  prompt_version?: string;
  llm_model?: string;
  max_dialogue_tokens?: number;   // default 8192
}

// ---------------------------------------------------------------------------
// Deterministic artifact ID
// ---------------------------------------------------------------------------

/**
 * Returns sha256(sessionId + 'session_synthesis').slice(0, 32).
 * Matches V17 ID conventions (hex32).
 */
export function deriveSynthesisArtifactId(sessionId: string): string {
  return createHash('sha256')
    .update(sessionId + 'session_synthesis', 'utf8')
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Type guard for LastSessionSynthesis.
 * Validates all required fields and their types.
 */
export function validateSynthesisSchema(s: unknown): s is LastSessionSynthesis {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Record<string, unknown>;

  if (obj['schema_version'] !== 1) return false;
  if (typeof obj['session_id'] !== 'string' || obj['session_id'].length === 0) return false;
  if (!Array.isArray(obj['operator_pivots'])) return false;
  if (!Array.isArray(obj['agent_positions'])) return false;
  if (obj['last_unresolved_question'] !== null && typeof obj['last_unresolved_question'] !== 'string') return false;
  if (typeof obj['recommended_next_action'] !== 'string') return false;
  if (typeof obj['confidence'] !== 'number' || obj['confidence'] < 0 || obj['confidence'] > 1) return false;
  if (typeof obj['prompt_version'] !== 'string') return false;
  if (typeof obj['llm_model'] !== 'string') return false;
  if (typeof obj['generated_at_epoch_ms'] !== 'number') return false;

  // Validate pivot array elements
  for (const pivot of obj['operator_pivots'] as unknown[]) {
    if (!pivot || typeof pivot !== 'object') return false;
    const p = pivot as Record<string, unknown>;
    if (typeof p['at_turn'] !== 'number') return false;
    if (typeof p['pivot_summary'] !== 'string') return false;
  }

  // Validate agent positions array elements
  for (const pos of obj['agent_positions'] as unknown[]) {
    if (!pos || typeof pos !== 'object') return false;
    const p = pos as Record<string, unknown>;
    if (typeof p['at_turn'] !== 'number') return false;
    if (typeof p['position_summary'] !== 'string') return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// LLM output parsing
// ---------------------------------------------------------------------------

/**
 * Parses LLM text output (JSON) into a validated LastSessionSynthesis.
 * Returns null on parse/validation failure; emits one telemetry row per failure.
 */
export function parseLLMSynthesisOutput(
  llmText: string,
  sessionId: string,
  promptVersion: string,
  llmModel: string,
  db?: Database,
): LastSessionSynthesis | null {
  try {
    // Strip Markdown code fences if the LLM wrapped the JSON
    const cleaned = llmText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      if (db) _emitLssTelemetry(db, sessionId, 'parse_failed', { raw_length: llmText.length });
      return null;
    }

    // Inject meta-fields if LLM omitted them (they're not in the transcript)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (!obj['schema_version']) obj['schema_version'] = 1;
      if (!obj['session_id']) obj['session_id'] = sessionId;
      if (!obj['prompt_version']) obj['prompt_version'] = promptVersion;
      if (!obj['llm_model']) obj['llm_model'] = llmModel;
      if (!obj['generated_at_epoch_ms']) obj['generated_at_epoch_ms'] = Date.now();
    }

    if (!validateSynthesisSchema(parsed)) {
      if (db) {
        const obj = parsed as Record<string, unknown>;
        // Scan all pivot/position elements for shape violations.
        const scanArr = (arr: unknown, requiredSummaryKey: string): string => {
          if (!Array.isArray(arr)) return 'not-array';
          for (let i = 0; i < arr.length; i++) {
            const el = arr[i];
            if (!el || typeof el !== 'object') return `element[${i}] not-object`;
            const e = el as Record<string, unknown>;
            if (typeof e['at_turn'] !== 'number') return `element[${i}].at_turn type=${typeof e['at_turn']} value=${JSON.stringify(e['at_turn'])}`;
            if (typeof e[requiredSummaryKey] !== 'string') return `element[${i}].${requiredSummaryKey} type=${typeof e[requiredSummaryKey]}`;
          }
          return 'ok';
        };
        _emitLssTelemetry(db, sessionId, 'schema_invalid', {
          parsed_keys: Object.keys(obj).join(','),
          pivot_scan: scanArr(obj['operator_pivots'], 'pivot_summary'),
          position_scan: scanArr(obj['agent_positions'], 'position_summary'),
          confidence_raw: obj['confidence'],
        });
      }
      return null;
    }

    return parsed;
  } catch {
    if (db) _emitLssTelemetry(db, sessionId, 'parse_failed', { error: 'exception_in_parser' });
    return null;
  }
}

// ---------------------------------------------------------------------------
// V17 artifact persistence
// ---------------------------------------------------------------------------

/**
 * UPSERT a LastSessionSynthesis into the V17 artifact table.
 * Returns { artifact_id, updated: true if pre-existing row was updated }.
 */
export function persistSynthesisArtifact(
  db: Database,
  synthesis: LastSessionSynthesis,
  project: string,
): { artifact_id: string; updated: boolean } {
  const artifactId = deriveSynthesisArtifactId(synthesis.session_id);
  const nowMs = Date.now();

  // Check if it already exists
  const existing = db.prepare(
    `SELECT id FROM artifact WHERE id = ?`
  ).get(artifactId) as { id: string } | undefined;

  const pivotSummary = synthesis.operator_pivots[0]?.pivot_summary;
  const title = pivotSummary
    ? pivotSummary.slice(0, 80)
    : (synthesis.last_unresolved_question ?? 'Session synthesis').slice(0, 80);

  const body = JSON.stringify(synthesis);

  // Determine which column name the project is stored under
  // (V34+ uses 'project'; V33- uses 'project_id'). Use the safe column detection.
  const projectCol = _getArtifactProjectCol(db);

  db.prepare(`
    INSERT INTO artifact (id, kind, ${projectCol}, title, body, scope, status,
                          created_at_epoch_ms, updated_at_epoch_ms, session_id)
    VALUES (?, 'session_synthesis', ?, ?, ?, 'project', 'active', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      body = excluded.body,
      title = excluded.title,
      updated_at_epoch_ms = excluded.updated_at_epoch_ms
  `).run(
    artifactId,
    project,
    title,
    body,
    synthesis.generated_at_epoch_ms,
    nowMs,
    synthesis.session_id,
  );

  return { artifact_id: artifactId, updated: !!existing };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * LLM-driven structured synthesis of a session transcript.
 *
 * Reads the JSONL transcript at jsonl_path (or resolves it from session_id),
 * extracts dialogue, calls Ollama, persists the V17 artifact.
 *
 * Returns the synthesis on success, null on any failure.
 * Non-throwing — all errors emit one telemetry row.
 */
export async function synthesizeLastSession(
  sessionId: string,
  db: Database,
  opts: SynthesizeOpts,
): Promise<LastSessionSynthesis | null> {
  const startMs = Date.now();
  try {
    // 1. Resolve JSONL path
    const jsonlPath = opts.jsonl_path ?? _resolveJsonlPath(sessionId);
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
      _emitLssTelemetry(db, sessionId, 'jsonl_missing', { path: jsonlPath ?? '(not resolved)' });
      return null;
    }

    // 2. Read + canonicalize
    let jsonlContent: string;
    try {
      jsonlContent = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      _emitLssTelemetry(db, sessionId, 'jsonl_missing', { path: jsonlPath, reason: 'read_error' });
      return null;
    }

    const canonical = fromClaudeCode(jsonlContent, sessionId);
    if (!canonical || canonical.messages.length === 0) {
      _emitLssTelemetry(db, sessionId, 'empty_transcript', { path: jsonlPath });
      return null;
    }

    // 3. Filter to dialogue (user + assistant text), skip tool noise
    const dialogue = _filterToDialogue(canonical.messages);

    // 4. Build transcript string, truncated to context window
    const maxTokens = opts.max_dialogue_tokens ?? 8192;
    const transcript = _truncateToTokens(dialogue, maxTokens);

    // 5. Load + substitute prompt
    const promptVersion = opts.prompt_version ?? 'v1';
    let promptTemplate: string;
    try {
      promptTemplate = _loadPromptTemplate(promptVersion);
    } catch {
      _emitLssTelemetry(db, sessionId, 'parse_failed', { reason: 'prompt_template_missing', version: promptVersion });
      return null;
    }
    const prompt = _substitutePlaceholders(promptTemplate, {
      transcript,
      session_id: sessionId,
      project: opts.project,
    });

    // 6. LLM call — routes through generation-backend selector.
    // Default backend is Claude subprocess (Sonnet for synthesis quality);
    // legacy Ollama path stays available via CLAUDEX_GENERATION_BACKEND=ollama.
    const llmModel = opts.llm_model ?? process.env['ANGEL_LLM_MODEL'] ?? 'sonnet';
    let llmText: string;
    try {
      llmText = await generate({
        prompt,
        model: llmModel,
        maxTokens: 1024,
        timeoutMs: 90_000,
        temperature: 0,
        db,
        subsystem: 'lss',
      });
    } catch (err) {
      const errStr = String(err);
      const reason = errStr.includes('timeout') || errStr.includes('abort')
        ? 'llm_timeout'
        : 'llm_unreachable';
      _emitLssTelemetry(db, sessionId, reason, { model: llmModel, error: errStr.slice(0, 200) });
      return null;
    }

    if (!llmText) {
      _emitLssTelemetry(db, sessionId, 'llm_unreachable', { model: llmModel, reason: 'empty_response' });
      return null;
    }

    // 7. Parse + validate
    const synthesis = parseLLMSynthesisOutput(llmText, sessionId, promptVersion, llmModel, db);
    if (!synthesis) {
      // parseLLMSynthesisOutput already emitted telemetry
      return null;
    }

    // 8. Confidence gate
    if (synthesis.confidence < 0.3) {
      _emitLssTelemetry(db, sessionId, 'confidence_below_threshold', {
        confidence: synthesis.confidence,
      });
      return null;
    }
    if (synthesis.confidence < 0.5) {
      synthesis.degraded = true;
    }

    // 9. Persist
    const persistResult = persistSynthesisArtifact(db, synthesis, opts.project);
    _emitLssCompleteTelemetry(db, sessionId, {
      artifact_id: persistResult.artifact_id,
      updated: persistResult.updated,
      confidence: synthesis.confidence,
      latency_ms: Date.now() - startMs,
    });

    return synthesis;
  } catch (err) {
    _emitLssTelemetry(db, sessionId, 'exception', { error: String(err).slice(0, 300) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve JSONL path from session_id.
 * Claude Code stores transcripts at ~/.claude/projects/<project>/<session_id>.jsonl
 * or at the CC_PROJECTS_DIR location.
 */
function _resolveJsonlPath(sessionId: string): string | null {
  try {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
    const candidateDirs = [
      process.env['CC_PROJECTS_DIR'],
      path.join(home, '.claude', 'projects'),
    ].filter(Boolean) as string[];

    for (const dir of candidateDirs) {
      // Search recursively one level (projects/<slug>/<session>.jsonl)
      if (!fs.existsSync(dir)) continue;
      const projectDirs = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of projectDirs) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(dir, entry.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
      // Also check flat (projects/<session>.jsonl)
      const flat = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(flat)) return flat;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Filter canonical messages to user + assistant text only.
 * Skip tool calls, tool outputs, and system messages.
 */
function _filterToDialogue(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
): Array<{ role: string; content: string; turn: number }> {
  const dialogue: Array<{ role: string; content: string; turn: number }> = [];
  let turn = 0;

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      const content = msg.content.trim();
      if (content.length > 0) {
        dialogue.push({ role: msg.role, content, turn });
        if (msg.role === 'user') turn++;
      }
    }
  }
  return dialogue;
}

/**
 * Truncate dialogue to approximately maxTokens tokens.
 * Keeps the LAST N tokens worth of dialogue (most recent context is most valuable).
 * ~4 chars per token (rough estimate).
 */
function _truncateToTokens(
  dialogue: Array<{ role: string; content: string; turn: number }>,
  maxTokens: number,
): string {
  const lines: string[] = dialogue.map(m =>
    `[turn ${m.turn}] ${m.role}: ${m.content.slice(0, 1000)}`,
  );

  const charBudget = maxTokens * 4;
  let totalChars = lines.reduce((acc, l) => acc + l.length + 1, 0);

  // If within budget, return as-is
  if (totalChars <= charBudget) {
    return lines.join('\n');
  }

  // Take most-recent lines until budget is exhausted
  const kept: string[] = [];
  let remaining = charBudget;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (remaining - line.length - 1 < 0) break;
    kept.unshift(line);
    remaining -= line.length + 1;
  }

  if (kept.length < lines.length) {
    const skipped = lines.length - kept.length;
    kept.unshift(`[... ${skipped} earlier turns omitted for context window ...]`);
  }

  return kept.join('\n');
}

/**
 * Load the prompt template from the versioned file.
 * Throws if not found.
 */
function _loadPromptTemplate(version: string): string {
  // Canonical location: src/angel/prompts/last-session-synthesis-v1.md (dev hot-edit).
  // Production fallback: embedded string constant from embedded-prompts.ts —
  // bundled into the .cjs at build time so dist/ deployments never miss the prompt.
  const candidates = [
    path.join(__dirname, 'prompts', `last-session-synthesis-${version}.md`),
    // Fallback for dist/ layout where __dirname is dist/angel/
    path.join(__dirname, '..', '..', 'src', 'angel', 'prompts', `last-session-synthesis-${version}.md`),
    // Production path relative to CWD
    path.join(process.cwd(), 'src', 'angel', 'prompts', `last-session-synthesis-${version}.md`),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    } catch { /* ignore — fall through to embedded */ }
  }

  // Embedded fallback — ships in every bundle, no IO required.
  const embedded = EMBEDDED_PROMPTS[`last-session-synthesis-${version}`];
  if (embedded) return embedded;

  throw new Error(`Prompt template not found: last-session-synthesis-${version}.md (no embedded fallback for version=${version})`);
}

/**
 * Substitute {transcript}, {session_id}, {project} placeholders in the template.
 */
function _substitutePlaceholders(
  template: string,
  vars: { transcript: string; session_id: string; project: string },
): string {
  return template
    .replace('{transcript}', vars.transcript)
    .replace('{session_id}', vars.session_id)
    .replace('{project}', vars.project);
}

/**
 * Detect whether the artifact table uses 'project' or 'project_id'.
 * V34+ uses 'project'; older test fixtures may use 'project_id'.
 * Cached per-process for performance.
 */
const _projectColCache = new WeakMap<Database, string>();

function _getArtifactProjectCol(db: Database): string {
  const cached = _projectColCache.get(db);
  if (cached) return cached;

  try {
    const cols = (db.pragma('table_info(artifact)') as Array<{ name: string }>).map(c => c.name);
    const col = cols.includes('project') ? 'project' : 'project_id';
    _projectColCache.set(db, col);
    return col;
  } catch {
    return 'project';
  }
}

// ---------------------------------------------------------------------------
// Telemetry helpers — use session_events table (no CHECK constraint risk)
// ---------------------------------------------------------------------------

/**
 * Emit a LSS failure telemetry row.
 * Uses session_events (event_type='lss_synthesis_failed') to avoid the
 * telemetry.event_kind CHECK constraint (which doesn't include LSS events yet).
 */
function _emitLssTelemetry(
  db: Database,
  sessionId: string,
  reason: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, 'lss', 'lss_synthesis_failed', 'lss', ?, ?)`
    ).run(sessionId, reason, JSON.stringify(detail));
  } catch {
    // Non-throwing — telemetry is advisory
  }
}

/**
 * Emit a LSS success telemetry row.
 */
function _emitLssCompleteTelemetry(
  db: Database,
  sessionId: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, 'lss', 'lss_synthesis_complete', 'lss', 'synthesized', ?)`
    ).run(sessionId, JSON.stringify(detail));
  } catch {
    // Non-throwing
  }
}
