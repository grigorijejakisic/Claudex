/**
 * Stage 1 model-agnostic decision capture with 4-tier regex extraction.
 * Stage 2 (embedding classification) deferred to Phase 4.
 * @see Architecture Section 6.1
 */

import type { Database } from 'better-sqlite3';
import { insertDecision, getDecisionsBySession } from '../core/decisions.js';
import { normalizeForDedup, isDuplicate } from './semantic-dedup.js';

export interface CapturedDecision {
  content: string;
  source: 'confirmation' | 'direction' | 'rejection' | 'explicit';
  tier: 1 | 2 | 3 | 4;
}

// --- Patterns ---

const TIER1_CONFIRM = /^(yes|yeah|yep|ok|okay|go|approved|confirmed|do it|proceed|looks good|lgtm|ship it|agreed|correct|exactly|perfect|that works)\b/i;

const TIER2_IMPERATIVE = /^(use|implement|create|add|remove|replace|switch|migrate|keep|drop|split|merge|deploy|configure|set|enable|disable)\b/i;
const TIER2_COMPARISON = /\b(instead of|rather than)\b|\bnot\s+\w+\s+but\b/i;
const TIER2_COMMITMENT = /\bwill\s+(use|implement|do|create|go with)\b|\bgoing to\b|\bthe\s+(plan|approach|strategy|design)\s+is\b/i;
const TIER2_RECOMMEND = /\b(should|recommend|suggest|propose|best to|better to|prefer)\b/i;

const TIER3_REJECTION = /\b(no,|don't|actually,|instead(?=\s|$)|not that|wrong|stop|revert|undo|that's not|scratch that)/i;

const TIER4_MARKER = /(DECISION:|decided:|we agreed|final answer|conclusion:|verdict:|going with:|chosen approach:)/i;

const FILLER_ACTION = /^(let me|looking at|checking|I see|examining|opening|searching|running|reading)\b/i;
const FILLER_GREETING = /^(hi|hello|hey|thanks|thank you|sure|ok|great|nice|good|alright)\b/i;

// --- Helpers ---

/** Strip code fence content before extraction */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** Check if candidate is a filler phrase */
function isFiller(candidate: string): boolean {
  if (candidate.length < 15) return true;
  if (FILLER_ACTION.test(candidate)) return true;
  if (candidate.length <= 15 && FILLER_GREETING.test(candidate)) return true;
  return false;
}

/** Extract the sentence containing a regex match */
function extractSentenceAt(text: string, matchIndex: number): string {
  // Find sentence boundaries around the match
  const before = text.lastIndexOf('.', matchIndex);
  const afterDot = text.indexOf('.', matchIndex);
  const afterBang = text.indexOf('!', matchIndex);
  const afterQ = text.indexOf('?', matchIndex);

  const start = before >= 0 ? before + 1 : 0;

  const ends = [afterDot, afterBang, afterQ].filter((i) => i >= 0);
  const end = ends.length > 0 ? Math.min(...ends) + 1 : text.length;

  return text.slice(start, end).trim();
}

// --- Tier Extractors ---

function extractTier1(userText: string, assistantText: string | undefined): CapturedDecision[] {
  if (!TIER1_CONFIRM.test(userText.trim())) return [];
  const content = assistantText?.trim() || userText.trim();
  if (isFiller(content)) return [];
  return [{ content, source: 'confirmation', tier: 1 }];
}

function extractTier2(assistantText: string): CapturedDecision[] {
  const cleaned = stripCodeFences(assistantText);
  const lines = cleaned.split('\n');
  const results: CapturedDecision[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < 20) continue;
    if (isFiller(line)) continue;
    if (
      TIER2_IMPERATIVE.test(line) ||
      TIER2_COMPARISON.test(line) ||
      TIER2_COMMITMENT.test(line) ||
      TIER2_RECOMMEND.test(line)
    ) {
      results.push({ content: line, source: 'direction', tier: 2 });
    }
  }

  return results;
}

function extractTier3(userText: string): CapturedDecision[] {
  if (!TIER3_REJECTION.test(userText)) return [];
  const content = userText.trim();
  if (isFiller(content)) return [];
  return [{ content, source: 'rejection', tier: 3 }];
}

function extractTier4(text: string): CapturedDecision[] {
  const cleaned = stripCodeFences(text);
  const match = TIER4_MARKER.exec(cleaned);
  if (!match) return [];
  const sentence = extractSentenceAt(cleaned, match.index);
  if (isFiller(sentence)) return [];
  return [{ content: sentence, source: 'explicit', tier: 4 }];
}

// --- Main ---

/**
 * Captures decisions from turn or tool text. Non-throwing.
 * - after_tool: Tier 1 + 4 only
 * - after_turn: all 4 tiers
 */
export function captureDecisions(params: {
  db: Database;
  sessionId: string;
  project: string;
  userText?: string;
  assistantText?: string;
  mode: 'after_turn' | 'after_tool';
}): CapturedDecision[] {
  try {
    const { db, sessionId, project, userText, assistantText, mode } = params;
    const candidates: CapturedDecision[] = [];

    // Tier 1: user confirmations (both modes)
    if (userText) {
      candidates.push(...extractTier1(userText, assistantText));
    }

    // Tier 4: explicit markers (both modes)
    if (userText) candidates.push(...extractTier4(userText));
    if (assistantText) candidates.push(...extractTier4(assistantText));

    // Tier 2 + 3: full-turn only
    if (mode === 'after_turn') {
      if (assistantText) candidates.push(...extractTier2(assistantText));
      if (userText) candidates.push(...extractTier3(userText));
    }

    if (candidates.length === 0) return [];

    // Dedup against existing session decisions
    const existing = getDecisionsBySession(db, sessionId);
    const stored: CapturedDecision[] = [];

    for (const candidate of candidates) {
      // Check against existing DB decisions
      const isDup = existing.some((e) => isDuplicate(candidate.content, e.content));
      if (isDup) continue;

      // Check against decisions already captured in this batch
      const batchDup = stored.some((s) => isDuplicate(candidate.content, s.content));
      if (batchDup) continue;

      // Store
      const fingerprint = normalizeForDedup(candidate.content);
      insertDecision(db, {
        session_id: sessionId,
        project,
        content: candidate.content,
        source: candidate.source,
        fingerprint,
      });

      stored.push(candidate);
    }

    return stored;
  } catch {
    return [];
  }
}
