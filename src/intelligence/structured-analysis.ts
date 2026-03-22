/**
 * Structured Failure Analysis (Reflexion) — 3.1
 *
 * When a correction is detected, generates a structured analysis:
 *   {assumption, reality, root_cause, generalized_rule}
 *
 * Two-tier: LLM (Ollama) structures the analysis when available,
 * heuristic extraction from correction text as fallback.
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { isLocalOrPrivateUrl } from '../embeddings/embedding-provider.js';
import { fetchJsonWithTimeout } from '../shared/fetch-utils.js';
import type { EnrichmentProvider } from './enrichment.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuredAnalysis {
  assumption: string;
  reality: string;
  root_cause: string;
  generalized_rule: string;
}

// ---------------------------------------------------------------------------
// Heuristic extraction
// ---------------------------------------------------------------------------

/**
 * Heuristic extraction patterns for each structured field.
 * Fires when Ollama is unavailable — less accurate but always works.
 */

const ASSUMPTION_PATTERNS = [
  /\b(?:I\s+(?:assumed|thought|expected|believed))\s+(?:that\s+)?([^.!?\n]{10,200})/i,
  /\b(?:the\s+assumption\s+was|assumed\s+that|was\s+expecting)\s+([^.!?\n]{10,200})/i,
  /\b(?:incorrectly|mistakenly|wrongly)\s+([^.!?\n]{10,200})/i,
];

const REALITY_PATTERNS = [
  /\b(?:actually|in\s+reality|the\s+(?:real|actual)\s+(?:issue|problem|behavior))\s+(?:is|was)\s+([^.!?\n]{10,200})/i,
  /\b(?:but\s+(?:actually|in\s+fact|really))\s+([^.!?\n]{10,200})/i,
  /\b(?:instead|however|turns\s+out)\s*[,:]?\s+([^.!?\n]{10,200})/i,
];

const ROOT_CAUSE_PATTERNS = [
  /\b(?:root\s+cause|the\s+(?:problem|issue|bug)\s+(?:is|was))\s+([^.!?\n]{10,200})/i,
  /\b(?:this\s+(?:is|was)\s+because|this\s+happens?\s+because|caused\s+by)\s+([^.!?\n]{10,200})/i,
  /\b(?:the\s+reason\s+(?:is|was))\s+([^.!?\n]{10,200})/i,
];

const RULE_PATTERNS = [
  /\b(?:always|never|going\s+forward|from\s+now\s+on|the\s+rule\s+is)\s+([^.!?\n]{10,200})/i,
  /\b(?:the\s+correct\s+(?:approach|way)\s+is)\s+([^.!?\n]{10,200})/i,
  /\b(?:should\s+always|must\s+always|we\s+(?:always|never))\s+([^.!?\n]{10,200})/i,
];

/**
 * Extracts a field value from text using an array of patterns.
 * Returns the first match or empty string.
 */
function extractField(text: string, patterns: RegExp[]): string {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m?.[1]) {
      return m[1].trim().replace(/[!]+$/, '').trim();
    }
  }
  return '';
}

/**
 * Heuristic structured analysis from correction + assistant text.
 * Best-effort: may return empty fields.
 */
function heuristicAnalysis(
  correctionText: string,
  assistantText: string,
): StructuredAnalysis {
  const combined = `${assistantText}\n${correctionText}`;

  const assumption = extractField(combined, ASSUMPTION_PATTERNS);
  const reality = extractField(combined, REALITY_PATTERNS);
  const rootCause = extractField(combined, ROOT_CAUSE_PATTERNS);
  let rule = extractField(combined, RULE_PATTERNS);

  // If we couldn't extract a rule but have a correction with lesson-like text,
  // derive the rule from the correction itself
  if (!rule && correctionText) {
    // Strip correction signal phrases and use the correction as the rule
    const cleaned = correctionText
      .replace(/\b(?:I\s+told\s+you|we\s+already|same\s+mistake|you\s+keep|how\s+many\s+times)\b/gi, '')
      .replace(/[!?]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 10 && cleaned.length <= 200) {
      rule = cleaned;
    }
  }

  return {
    assumption,
    reality,
    root_cause: rootCause,
    generalized_rule: rule,
  };
}

// ---------------------------------------------------------------------------
// LLM-based analysis (Ollama)
// ---------------------------------------------------------------------------

/**
 * Uses Ollama to structure the analysis. Non-throwing.
 * Returns null if LLM is unavailable or fails.
 */
async function llmAnalysis(
  correctionText: string,
  assistantText: string,
  enrichmentProvider: EnrichmentProvider,
): Promise<StructuredAnalysis | null> {
  try {
    const baseUrl = enrichmentProvider.baseUrl;
    if (!isLocalOrPrivateUrl(baseUrl)) return null;

    const prompt =
      `Analyze this correction interaction. The user corrected the assistant.\n\n` +
      `Assistant's response: ${assistantText.slice(0, 500)}\n\n` +
      `User's correction: ${correctionText.slice(0, 500)}\n\n` +
      `Extract a structured analysis as JSON:\n` +
      `{"assumption": "what the assistant wrongly assumed", "reality": "what is actually correct", ` +
      `"root_cause": "why the mistake happened", "generalized_rule": "a general rule to prevent this"}\n\n` +
      `Respond with JSON only.`;

    const result = await fetchJsonWithTimeout(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: enrichmentProvider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0,
      }),
      redirect: 'manual',
      timeoutMs: 10000,
    }) as { choices?: Array<{ message?: { content?: string } }> } | null;

    const content = result?.choices?.[0]?.message?.content;
    if (!content) return null;

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Partial<StructuredAnalysis>;

    return {
      assumption: typeof parsed.assumption === 'string' ? parsed.assumption.slice(0, 500) : '',
      reality: typeof parsed.reality === 'string' ? parsed.reality.slice(0, 500) : '',
      root_cause: typeof parsed.root_cause === 'string' ? parsed.root_cause.slice(0, 500) : '',
      generalized_rule: typeof parsed.generalized_rule === 'string' ? parsed.generalized_rule.slice(0, 500) : '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a structured failure analysis from correction context.
 * Two-tier: LLM (Ollama) if available, heuristic fallback otherwise.
 *
 * Returns the analysis. Always returns an object (fields may be empty).
 * Non-throwing.
 */
export async function analyzeFailure(
  correctionText: string,
  assistantText: string,
  enrichmentProvider?: EnrichmentProvider | null,
): Promise<StructuredAnalysis> {
  try {
    // Tier 1: LLM analysis
    if (enrichmentProvider) {
      const llmResult = await llmAnalysis(correctionText, assistantText, enrichmentProvider);
      if (llmResult) return llmResult;
    }

    // Tier 2: Heuristic fallback
    return heuristicAnalysis(correctionText, assistantText);
  } catch {
    return { assumption: '', reality: '', root_cause: '', generalized_rule: '' };
  }
}

/**
 * Stores structured analysis fields on an existing experience pattern.
 * Non-throwing.
 */
export function storeStructuredAnalysis(
  db: Database,
  patternId: string,
  analysis: StructuredAnalysis,
): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET assumption = ?, reality = ?, root_cause = ?, generalized_rule = ?
       WHERE id = ?`
    ).run(
      analysis.assumption || null,
      analysis.reality || null,
      analysis.root_cause || null,
      analysis.generalized_rule || null,
      patternId,
    );
  } catch {
    // Non-throwing
  }
}

/**
 * Retrieves structured analysis fields for a pattern.
 * Returns null if pattern not found or no analysis stored.
 * Non-throwing.
 */
export function getStructuredAnalysis(
  db: Database,
  patternId: string,
): StructuredAnalysis | null {
  try {
    const row = cachedPrepare(db,
      `SELECT assumption, reality, root_cause, generalized_rule
       FROM experience_patterns WHERE id = ?`
    ).get(patternId) as Partial<StructuredAnalysis> | undefined;

    if (!row) return null;
    if (!row.assumption && !row.reality && !row.root_cause && !row.generalized_rule) return null;

    return {
      assumption: row.assumption ?? '',
      reality: row.reality ?? '',
      root_cause: row.root_cause ?? '',
      generalized_rule: row.generalized_rule ?? '',
    };
  } catch {
    return null;
  }
}
