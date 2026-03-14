/**
 * Two-stage model-agnostic decision capture.
 * Stage 1: 4-tier regex extraction (always active).
 * Stage 2: Embedding classification filtering (when classifier provided).
 */

import type { Database } from 'better-sqlite3';
import { insertDecision, getDecisionsBySession } from '../core/decisions.js';
import { normalizeForDedup, isDuplicate } from './semantic-dedup.js';
import { redactContent } from '../extraction/redaction.js';
import { emitTelemetry, sanitizeErrorForTelemetry } from '../observability/telemetry.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import type { DecisionTemplates } from '../embeddings/templates.js';
import { classifyDecision } from '../embeddings/templates.js';
import { createArtifact } from '../core/artifacts.js';
import { addVerifiedFact } from '../checkpoint/writer.js';

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
 * - Stage 2: when classifier provided, filters false positives via embedding classification
 */
export async function captureDecisions(params: {
  db: Database;
  sessionId: string;
  project: string;
  userText?: string;
  assistantText?: string;
  mode: 'after_turn' | 'after_tool' | 'explicit_only';
  classifier?: {
    provider: EmbeddingProvider;
    templates: DecisionTemplates;
  } | null;
  confidenceThreshold?: number;
}): Promise<CapturedDecision[]> {
  try {
    const { db, sessionId, project, userText, assistantText, mode, classifier, confidenceThreshold = 0.15 } = params;
    let candidates: CapturedDecision[] = [];

    // Stage 1: Tier extraction

    if (mode === 'explicit_only') {
      // Tier 4 only — explicit markers from user text (UserPromptSubmit path)
      if (userText) candidates.push(...extractTier4(userText));
    } else {
      // Tier 1: user confirmations (after_tool + after_turn)
      if (userText) {
        candidates.push(...extractTier1(userText, assistantText));
      }

      // Tier 4: explicit markers (after_tool + after_turn)
      if (userText) candidates.push(...extractTier4(userText));
      if (assistantText) candidates.push(...extractTier4(assistantText));

      // Tier 2 + 3: full-turn only
      if (mode === 'after_turn') {
        if (assistantText) candidates.push(...extractTier2(assistantText));
        if (userText) candidates.push(...extractTier3(userText));
      }
    }

    if (candidates.length === 0) return [];

    // Cap candidates before embedding to bound batch size
    const MAX_CANDIDATES_PER_TURN = 20;
    if (candidates.length > MAX_CANDIDATES_PER_TURN) {
      candidates = candidates.slice(0, MAX_CANDIDATES_PER_TURN);
    }

    // Stage 2: Embedding classification filter (when classifier provided)
    if (classifier) {
      const texts = candidates.map(c => c.content);
      const embeddings = await classifier.provider.embedBatch(texts);
      const filtered: CapturedDecision[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const candidateEmb = embeddings[i];
        if (!candidateEmb) {
          // Fail open: embed failure does not filter candidate
          filtered.push(candidates[i]);
          continue;
        }
        const confidence = classifyDecision(candidateEmb, classifier.templates);
        if (confidence > confidenceThreshold) {
          filtered.push(candidates[i]);
        }
      }
      candidates = filtered;
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

      // Secondary fingerprint-based dedup — catches near-duplicates that
      // pass the semantic window check but have identical normalized content
      const redacted = redactContent(candidate.content);
      const fingerprint = normalizeForDedup(redacted);
      const fpExists = db.prepare(
        'SELECT 1 FROM decisions WHERE fingerprint = ? AND project = ? LIMIT 1'
      ).get(fingerprint, project);
      if (fpExists) continue;

      // Store — redact content before fingerprinting and storage to
      // ensure sensitive tokens are not recoverable via fingerprint or stored content
      const insertedId = insertDecision(db, {
        session_id: sessionId,
        project,
        content: redacted,
        source: candidate.source,
        fingerprint,
      });

      if (insertedId !== null) {
        try {
          createArtifact(db, sessionId, project, 'decision', String(insertedId), redacted.slice(0, 100), redacted, candidate.tier >= 3 ? 4 : 3);
        } catch {
          // Non-throwing — artifact creation must not break decision capture
        }

        // Tier 1 (user confirmations) and Tier 4 (explicit markers) are verified facts —
        // the user has explicitly confirmed or stated something as decided.
        if (candidate.tier === 1 || candidate.tier === 4) {
          try {
            addVerifiedFact(db, sessionId, redacted);
          } catch {
            // Non-throwing
          }
        }
      }

      stored.push(candidate);
    }

    return stored;
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'decision_capture', error: sanitizeErrorForTelemetry(e) }); } catch {}
    return [];
  }
}
