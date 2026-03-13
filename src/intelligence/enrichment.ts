/**
 * LLM enrichment with auto-detecting provider and safety-net merge.
 * Non-throwing — returns null on error, heuristic data on merge failure.
 * @see Architecture Section 6.4
 */

import type { RuntimeCapabilities } from '../shared/types.js';
import { normalizeForDedup, isDuplicate } from './semantic-dedup.js';
import { isLocalOrPrivateUrl } from '../embeddings/embedding-provider.js';
import { fetchJsonWithTimeout } from '../shared/fetch-utils.js';

export interface EnrichmentProvider {
  type: 'ollama';
  model: string;
  baseUrl: string;
}

export interface CheckpointData {
  topic?: string;
  task?: string;
  status?: string;
  decisions?: string[];
  open_items?: string[];
  learnings?: string[];
  summary?: string;
  key_exchanges?: Array<{ role: string; gist: string }>;
}

/**
 * One-time detection at core init. Tries Ollama and returns provider if available.
 * Returns null if no enrichment provider available. Non-throwing.
 *
 * Note: OpenClaw native enrichment was considered but removed — it was detected
 * but never implemented (returned null). If OpenClaw native enrichment becomes
 * feasible in the future, add it back with an actual API call implementation.
 */
export async function detectEnrichmentProvider(
  config: { baseUrl?: string; model?: string; provider?: string; enabled?: boolean },
  _capabilities: RuntimeCapabilities
): Promise<EnrichmentProvider | null> {
  try {
    // If enrichment is explicitly disabled, skip detection entirely
    if (config.enabled === false) return null;

    const baseUrl = config.baseUrl ?? 'http://localhost:11434';
    const modelPref = config.model ?? 'auto';

    // Validate baseUrl before making any outbound requests
    if (!isLocalOrPrivateUrl(baseUrl)) {
      console.warn(`[claudex] detectEnrichmentProvider: baseUrl "${baseUrl}" is not a local/private address. Skipping Ollama detection.`);
      return null;
    }

    // Try Ollama
    const data = await fetchJsonWithTimeout(`${baseUrl}/api/tags`, {
      timeoutMs: 3000,
    }) as { models?: Array<{ name: string; size: number }> } | null;

    if (!data) return null;

    const models: Array<{ name: string; size: number }> = data.models ?? [];

    if (models.length > 0) {
      let selectedModel: string | undefined;
      if (modelPref === 'auto') {
        // Pick smallest available model
        const sorted = [...models].sort((a, b) => a.size - b.size);
        selectedModel = sorted[0].name;
      } else {
        // Check specific model exists
        const found = models.find(
          (m) => m.name === modelPref || m.name.startsWith(`${modelPref}:`)
        );
        if (found) {
          selectedModel = found.name;
        }
      }
      if (selectedModel) {
        return { type: 'ollama', model: selectedModel, baseUrl };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Build enrichment prompt per Architecture 6.4. */
function buildEnrichmentPrompt(data: CheckpointData): string {
  return `You are reviewing a session checkpoint. Refine the following heuristic data.
For each field, keep what's accurate, fix what's imprecise, remove what's noise.
Do NOT invent — only refine what's given.

Current checkpoint:
- Topic: ${data.topic ?? ''}
- Task: ${data.task ?? ''}
- Status: ${data.status ?? ''}
- Decisions: ${JSON.stringify(data.decisions ?? [])}
- Open items: ${JSON.stringify(data.open_items ?? [])}
- Learnings: ${JSON.stringify(data.learnings ?? [])}
- Thread summary: ${data.summary ?? ''}
- Key exchanges: ${JSON.stringify(data.key_exchanges ?? [])}

Return JSON with the same fields. Any field you don't want to change, return as-is.`;
}

/**
 * Call LLM for checkpoint enrichment. Returns enriched partial data,
 * or null on any error. Non-throwing.
 */
export async function enrichCheckpoint(
  data: CheckpointData,
  provider: EnrichmentProvider,
  timeoutMs = 10000
): Promise<Partial<CheckpointData> | null> {
  try {
    // Validate baseUrl before making outbound request
    if (!isLocalOrPrivateUrl(provider.baseUrl)) {
      console.warn(`[claudex] enrichCheckpoint: baseUrl "${provider.baseUrl}" is not a local/private address. Skipping enrichment.`);
      return null;
    }

    // Ollama via OpenAI-compatible chat completions
    const prompt = buildEnrichmentPrompt(data);

    const result = await fetchJsonWithTimeout(`${provider.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0,
      }),
      timeoutMs,
    }) as { choices?: Array<{ message?: { content?: string } }> } | null;

    if (!result) return null;

    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    // Parse LLM response as JSON
    const enriched = JSON.parse(content) as Partial<CheckpointData>;
    return enriched;
  } catch {
    return null;
  }
}

/** Array fields that participate in safety-net merge. */
const ARRAY_FIELDS = ['decisions', 'open_items', 'learnings'] as const;
type ArrayField = (typeof ARRAY_FIELDS)[number];

/** String fields that prefer enriched when non-empty. */
const STRING_FIELDS = ['topic', 'summary', 'task', 'status'] as const;
type StringField = (typeof STRING_FIELDS)[number];

/**
 * Safety-net merge: LLM enrichment can improve but never silently drop
 * heuristic data. Uncovered heuristic entries appended to enriched arrays.
 * Pure function. Non-throwing (returns heuristic on error).
 * @see Architecture Section 6.4
 */
export function mergeEnrichment(
  heuristic: CheckpointData,
  enriched: Partial<CheckpointData>
): CheckpointData {
  try {
    const result: CheckpointData = { ...heuristic };

    // Array fields: accept enriched, append uncovered heuristic entries
    for (const field of ARRAY_FIELDS) {
      const enrichedArr = enriched[field as ArrayField];
      const heuristicArr = heuristic[field as ArrayField];

      if (enrichedArr && enrichedArr.length > 0) {
        result[field as ArrayField] = [...enrichedArr];

        if (heuristicArr && heuristicArr.length > 0) {
          // Find heuristic entries NOT covered by enrichment
          const enrichedNormalized = new Set(
            enrichedArr.map((e) => normalizeForDedup(e))
          );

          const uncovered = heuristicArr.filter((h) => {
            // Check normalized exact match
            if (enrichedNormalized.has(normalizeForDedup(h))) return false;
            // Check semantic duplicate
            if (enrichedArr.some((e) => isDuplicate(h, e))) return false;
            return true;
          });

          // Append uncovered entries (LLM missed them)
          result[field as ArrayField]!.push(...uncovered);
        }
      }
    }

    // String fields: prefer enriched if non-empty
    for (const field of STRING_FIELDS) {
      if (enriched[field as StringField]) {
        (result as Record<string, unknown>)[field] = enriched[field as StringField];
      }
    }

    // key_exchanges: prefer enriched if array is non-empty
    if (enriched.key_exchanges && enriched.key_exchanges.length > 0) {
      result.key_exchanges = enriched.key_exchanges;
    }

    return result;
  } catch {
    return { ...heuristic };
  }
}
