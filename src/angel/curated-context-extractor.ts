/**
 * Angel Curated Context Extractor — scans completed sessions for reframes,
 * directives, and other high-signal statements that belong in the Project
 * Curated Context slot (P2.1 injection). Writes them as Angel-proposed
 * entries that the next agent confirms at /endsession.
 *
 * This is Angel's fallback path for sessions where the agent didn't run
 * /endsession or forgot to curate. Without this, crashed/abandoned sessions
 * would lose all reframe signal.
 *
 * Provenance chain: session transcript → regex candidates → LLM extraction →
 * dedup against existing entries → writeEntry with curator='angel', tier=1,
 * status='proposed'.
 *
 * See context/specs/CURATED_CONTEXT.md for the full design.
 *
 * Non-throwing — returns empty result on any failure, so the heartbeat
 * continues even when llama-server is down or the LLM returns garbage.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { recordEvent } from '../core/session-events.js';
import {
  writeEntry,
  listEntries,
  type CuratedType,
} from '../core/curated-context.js';
import { GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';
import { callLocalLLM } from './llama-client.js';
import type { ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Regex signal detection — pre-filter before calling LLM
// ---------------------------------------------------------------------------

/**
 * Reframe / directive indicators. A turn containing any of these phrases is
 * a candidate for LLM extraction. Keywords chosen to favor explicit user
 * directives and explicit theory shifts — hard on precision, soft on recall.
 * Angel's extraction is expensive, so we'd rather miss a weak signal than
 * call the LLM on every turn.
 */
const SIGNAL_INDICATORS: readonly RegExp[] = [
  // Theory reframes ("we're actually X, not Y")
  /\bwe['’]?re actually\b/i,
  /\bwe['’]?re (not|racing|chasing)\b/i,
  /\bturns out\b/i,
  /\bthe real (thing|problem|issue)\b/i,
  /\b(this|that) (supersedes|replaces|revises)\b/i,
  /\bsuperseding\b/i,
  /\bmental model\b/i,
  /\breframe\b/i,
  /\bkey (insight|realization)\b/i,

  // Standing directives
  /\bfrom now on\b/i,
  /\balways (use|do|prefer|check)\b/i,
  /\bnever (touch|use|do|commit|push|assume)\b/i,
  /\bwe should (always|never|tend to)\b/i,
  /\bi prefer\b/i,
  /\bthe rule is\b/i,
  /\bi want you to\b/i,

  // Shipped / constraint markers
  /\bshipped\b/i,
  /\bdo not rebuild\b/i,
  /\balready (built|shipped|done)\b/i,
  /\bload[-\s]bearing\b/i,

  // Workspace map
  /\bcode (lives|is at|at)\b/i,
  /\bthe real (repo|codebase|source)\b/i,
];

/**
 * Returns true if the text contains any curated-context signal indicator.
 */
export function hasCuratedSignal(text: string): boolean {
  if (!text) return false;
  for (const re of SIGNAL_INDICATORS) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Scans conversation turns and returns indices of turns that contain signal
 * indicators. Both user and assistant text are scanned — user text is more
 * likely to contain directives; assistant text may contain reframes.
 */
export function findSignalCandidates(turns: ConversationTurn[]): ConversationTurn[] {
  const candidates: ConversationTurn[] = [];
  for (const turn of turns) {
    if (
      (turn.user_text && hasCuratedSignal(turn.user_text)) ||
      (turn.assistant_text && hasCuratedSignal(turn.assistant_text))
    ) {
      candidates.push(turn);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// LLM extraction — local llama-server (Gemma 4 31B Q6 via llama-client)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You extract Project Curated Context entries from AI coding session transcripts.

Your job: given a subset of conversation turns that contain reframe / directive signals, return a JSON array of curated context entries.

## Entry types (pick the most specific)

- "mental_model" — project theory shifts. "We're racing Mozzart's stale feed, not courtsiding settlement lag."
- "reframe" — explicit supersession ("this replaces the old X"). Use when prior theory is being explicitly retired.
- "preference" — standing disposition. "Prefer Sonnet for workers, Opus only for product-defining work."
- "constraint" — hard rule. "Never touch the verifier — it's shipped."
- "workspace_map" — paths. "Code lives at ~/Desktop/Lacuna, docs at ~/Projects/Lacuna-Betting."
- "shipped" — "DO NOT REBUILD" entries. "bet365_zap_verifier — Lacuna/src/verifier/zap.ts (session 22)".

## Project scope

Each entry has a scope:
- "project" — applies to this project only (all types allowed)
- "global" — cross-project rule, applies everywhere. ONLY for mental_model, reframe, preference, or constraint. workspace_map and shipped are NEVER global.

Use "global" ONLY when the user made an EXPLICIT cross-project directive ("from now on always X", "I prefer Y", "we always Z"). Project-specific statements about THIS project are "project".

## Precision over recall

Only extract entries with VERY HIGH confidence. It is better to return an empty array than to hallucinate. You are writing into a privileged always-on injection slot — wrong entries pollute every future session.

## Output format

Return ONLY a JSON array (no prose, no markdown). Each item:

{
  "scope": "project" | "global",
  "type": "mental_model" | "reframe" | "preference" | "constraint" | "workspace_map" | "shipped",
  "content": "<active voice, ≤500 chars, self-contained — future sessions read this without the conversation>",
  "confidence": 0.0-1.0,
  "reasoning": "<one sentence: why this is curated context>"
}

If no entries meet the precision bar, return [].`;

// ---------------------------------------------------------------------------
// Prompt building + response parsing
// ---------------------------------------------------------------------------

interface ExtractedCuratedEntry {
  scope: 'project' | 'global';
  type: CuratedType;
  content: string;
  confidence: number;
  reasoning: string;
}

/**
 * Format signal-candidate turns into a transcript for the LLM. Truncates
 * individual turns to keep total under ~6000 chars so a 2048-token response
 * fits comfortably with the system prompt budget.
 */
function formatCandidateTranscript(
  candidates: ConversationTurn[],
  projectName: string,
): string {
  const parts: string[] = [
    `Project: ${projectName}`,
    `Candidate turns with reframe / directive signals:`,
    '',
  ];
  const maxTurnLen = Math.min(
    1200,
    Math.floor(6000 / Math.max(candidates.length, 1)),
  );
  for (const turn of candidates) {
    if (turn.user_text) {
      const text =
        turn.user_text.length > maxTurnLen
          ? turn.user_text.slice(0, maxTurnLen) + '...'
          : turn.user_text;
      parts.push(`[Turn ${turn.turn_number}] USER: ${text}`);
    }
    if (turn.assistant_text) {
      const text =
        turn.assistant_text.length > maxTurnLen
          ? turn.assistant_text.slice(0, maxTurnLen) + '...'
          : turn.assistant_text;
      parts.push(`[Turn ${turn.turn_number}] ASSISTANT: ${text}`);
    }
  }
  return parts.join('\n\n');
}

const VALID_TYPES: ReadonlySet<CuratedType> = new Set<CuratedType>([
  'mental_model',
  'workspace_map',
  'shipped',
  'reframe',
  'constraint',
  'preference',
]);

/**
 * Parse the LLM response into a list of extracted entries. Non-throwing —
 * returns [] on malformed JSON or wrong shape. Filters out entries that
 * fail validation (invalid type, invalid scope, empty content, low
 * confidence).
 */
export function parseExtractionResponse(
  raw: string,
  minConfidence: number = 0.7,
): ExtractedCuratedEntry[] {
  if (!raw) return [];
  try {
    // LLMs sometimes wrap JSON in ```json fences or add prose before/after.
    // Strip the most common patterns before parsing.
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();
    // Find the first [ and last ] in case there's leading/trailing prose
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      text = text.slice(firstBracket, lastBracket + 1);
    }

    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];

    const out: ExtractedCuratedEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;

      const scope = obj.scope;
      const type = obj.type;
      const content = obj.content;
      const confidence = obj.confidence;

      if (scope !== 'project' && scope !== 'global') continue;
      if (typeof type !== 'string' || !VALID_TYPES.has(type as CuratedType)) continue;
      if (typeof content !== 'string' || content.trim().length === 0) continue;
      if (typeof confidence !== 'number' || confidence < minConfidence) continue;

      // Global-scope can't have workspace_map or shipped.
      if (scope === 'global' && (type === 'workspace_map' || type === 'shipped')) {
        continue;
      }

      out.push({
        scope: scope as 'project' | 'global',
        type: type as CuratedType,
        content: content.trim().slice(0, 500),
        confidence,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dedup — simple text-overlap heuristic (same as pattern-extractor)
// ---------------------------------------------------------------------------

/**
 * Returns true if the candidate entry content is sufficiently similar to any
 * already-active entry of the same type in the same scope.
 *
 * Uses a word-set overlap > 60% threshold — same heuristic the pattern
 * extractor uses. Cheap, effective, avoids a second LLM call.
 */
export function isDuplicate(
  candidate: ExtractedCuratedEntry,
  project: string,
  db: Database,
): boolean {
  const entries = listEntries(
    db,
    candidate.scope === 'global' ? GLOBAL_PROJECT_SCOPE : project,
    {
      includeGlobal: false,
      statuses: ['active', 'proposed'],
      types: [candidate.type],
    },
  );

  if (entries.length === 0) return false;

  const candidateWords = new Set(
    candidate.content
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  if (candidateWords.size === 0) return false;

  for (const existing of entries) {
    const existingWords = new Set(
      existing.content
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    const intersection = [...candidateWords].filter((w) =>
      existingWords.has(w),
    );
    const overlap =
      candidateWords.size > 0 ? intersection.length / candidateWords.size : 0;
    if (overlap > 0.6) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Session filtering — has the agent already curated this session?
// ---------------------------------------------------------------------------

/**
 * Returns true if Angel has already processed this session for curated
 * context extraction (successful or skipped). Tracked via a session_event
 * marker rather than a dedicated cursor column.
 */
export function isSessionAlreadyExtracted(
  db: Database,
  sessionId: string,
): boolean {
  try {
    const row = cachedPrepare(
      db,
      `SELECT 1 FROM session_events
        WHERE session_id = ? AND event_type = 'curated_context_extracted'
        LIMIT 1`,
    ).get(sessionId);
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Returns true if the agent already wrote curated entries from this session
 * at /endsession. If so, Angel should skip the session — the agent is
 * authoritative.
 */
export function hasAgentCuratedEntries(
  db: Database,
  sessionId: string,
): boolean {
  try {
    const row = cachedPrepare(
      db,
      `SELECT 1 FROM project_curated_context
        WHERE source_session_id = ? AND curator = 'agent'
        LIMIT 1`,
    ).get(sessionId);
    return row != null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetch conversation turns (minimal helper — same shape as pattern-extractor)
// ---------------------------------------------------------------------------

function getSessionTurns(db: Database, sessionId: string): ConversationTurn[] {
  try {
    return cachedPrepare(
      db,
      `SELECT id, session_id, project, turn_number, user_text, assistant_text, timestamp_epoch
         FROM conversation_turns
        WHERE session_id = ?
        ORDER BY turn_number ASC`,
    ).all(sessionId) as ConversationTurn[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry — called by Angel heartbeat
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  entriesCreated: number;
  entriesDuplicate: number;
  summary: string;
}

/**
 * Extract curated-context entries from a completed session.
 *
 * Skip conditions (marks the session as extracted regardless):
 *   - Already extracted (session_event marker present)
 *   - Agent already wrote curated entries at /endsession (agent wins)
 *   - No signal-candidate turns (nothing to extract)
 *   - No conversation turns stored
 *
 * Transient conditions (retry next tick, no marker written):
 *   - llama-server unavailable
 *   - LLM returns empty or malformed response
 */
export async function extractCuratedContextFromSession(
  db: Database,
  sessionId: string,
  project: string,
): Promise<ExtractionResult> {
  // Skip if already processed
  if (isSessionAlreadyExtracted(db, sessionId)) {
    return { entriesCreated: 0, entriesDuplicate: 0, summary: 'already extracted' };
  }

  // Skip if agent already curated — agent is authoritative
  if (hasAgentCuratedEntries(db, sessionId)) {
    markSessionExtracted(db, sessionId, project, 'agent already curated');
    return {
      entriesCreated: 0,
      entriesDuplicate: 0,
      summary: 'agent already curated',
    };
  }

  const turns = getSessionTurns(db, sessionId);
  if (turns.length === 0) {
    markSessionExtracted(db, sessionId, project, 'no conversation turns');
    return { entriesCreated: 0, entriesDuplicate: 0, summary: 'no conversation turns' };
  }

  const candidates = findSignalCandidates(turns);
  if (candidates.length === 0) {
    markSessionExtracted(db, sessionId, project, 'no signal candidates');
    return { entriesCreated: 0, entriesDuplicate: 0, summary: 'no signal candidates' };
  }

  const transcript = formatCandidateTranscript(candidates, project);

  let raw: string;
  try {
    raw = await callLocalLLM({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: transcript,
    });
  } catch {
    // Transient — do NOT mark extracted. Retry next tick.
    return { entriesCreated: 0, entriesDuplicate: 0, summary: 'llama-server unavailable' };
  }

  const extracted = parseExtractionResponse(raw);
  if (extracted.length === 0) {
    markSessionExtracted(db, sessionId, project, 'LLM returned no entries');
    return { entriesCreated: 0, entriesDuplicate: 0, summary: 'LLM returned no entries' };
  }

  let created = 0;
  let duplicate = 0;
  for (const entry of extracted) {
    if (isDuplicate(entry, project, db)) {
      duplicate++;
      continue;
    }
    try {
      writeEntry(db, {
        project: entry.scope === 'global' ? GLOBAL_PROJECT_SCOPE : project,
        type: entry.type,
        content: entry.content,
        curator: 'angel',
        source_session_id: sessionId,
      });
      created++;
    } catch {
      // Non-fatal per-entry (e.g., workspace_map at global scope — the
      // prompt prohibits it but LLMs are noisy; writeEntry enforces)
    }
  }

  const summary = `created ${created}, dup ${duplicate}, from ${candidates.length} candidates`;
  markSessionExtracted(db, sessionId, project, summary);
  return { entriesCreated: created, entriesDuplicate: duplicate, summary };
}

/**
 * Record the curated_context_extracted marker so this session isn't
 * reprocessed on the next heartbeat tick.
 */
function markSessionExtracted(
  db: Database,
  sessionId: string,
  project: string,
  detail: string,
): void {
  try {
    recordEvent(
      db,
      sessionId,
      project,
      'curated_context_extracted',
      'angel',
      'done',
      detail,
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Fetch completed sessions that haven't been curated-context-extracted yet.
 * Limited to `batchSize` per tick to keep the heartbeat responsive.
 *
 * Only processes sessions with 'completed' status — active sessions may
 * still be writing new turns, and the agent may run /endsession which
 * would supersede Angel's extraction anyway.
 */
export function getSessionsPendingCuratedExtraction(
  db: Database,
  batchSize: number,
): Array<{ session_id: string; project: string }> {
  try {
    return cachedPrepare(
      db,
      `SELECT s.session_id, s.project
         FROM sessions s
        WHERE s.status = 'completed'
          AND s.project IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM session_events e
             WHERE e.session_id = s.session_id
               AND e.event_type = 'curated_context_extracted'
          )
        ORDER BY s.ended_at_epoch DESC NULLS LAST, s.created_at_epoch DESC
        LIMIT ?`,
    ).all(batchSize) as Array<{ session_id: string; project: string }>;
  } catch {
    return [];
  }
}
