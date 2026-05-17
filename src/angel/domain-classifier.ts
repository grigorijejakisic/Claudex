/**
 * Domain classifier — Angel-side binding/indexing on Phase 1 substrate.
 *
 * Classifies a completed session's thread topic into a single technical
 * domain (e.g. "typescript", "git") via cheap regex first then a local LLM
 * fallback for topics that don't match the regex vocabulary. Writes via
 * recordDomainInteraction; does NOT write to experience_patterns.
 *
 * Phase 4 reduction: this function used to live in src/angel/pattern-extractor.ts
 * alongside the deleted extractPatternsFromSession. Domain classification
 * survived the deletion because it is binding/indexing on Phase 1 substrate
 * (not extraction-time abstraction). See
 * .planning/reframes/2026-05-05-multi-handle-kill.md.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { callLocalLLM } from './llama-client.js';
import { generate } from './generation-backend.js';
import { recordDomainInteraction, extractDomain } from '../intelligence/capability-tracker.js';

/**
 * Classify domains for sessions that have thread topics but no capability_boundaries entries.
 * Uses extractDomain() (regex) first, then Ollama for complex topics.
 * Never uses Claude CLI — classification is trivial, local models handle it fine.
 */
export async function classifySessionDomains(
  db: Database,
  sessionId: string,
  project: string,
  localModel: string,
): Promise<number> {
  try {
    // Get thread topic
    const thread = cachedPrepare(db,
      `SELECT topic FROM thread_state WHERE session_id = ?`
    ).get(sessionId) as { topic: string | null } | undefined;

    if (!thread?.topic) return 0;

    // Use the built-in extractDomain for simple cases
    const simpleDomain = extractDomain(thread.topic);
    if (simpleDomain) {
      recordDomainInteraction(db, project, simpleDomain, false);
      return 1;
    }

    // For complex topics, use the local llama-server (Gemma 4 31B Q6_K).
    // maxTokens needs to budget for Gemma's reasoning_content — a naive
    // 32-token budget burns entirely on reasoning and returns empty content.
    // 512 is enough for reasoning overhead + a short domain response.
    let domain = '';
    const classifyPrompt = `Classify this session topic into a single technical domain (1-2 words, lowercase). Topic: "${thread.topic}". Respond with just the domain name, nothing else.`;

    try {
      const raw = await callLocalLLM({
        prompt: classifyPrompt,
        maxTokens: 512,
      });
      domain = raw.toLowerCase().split('\n')[0];
    } catch { /* llama-server not available — skip classification */ }

    if (domain && domain.length < 50) {
      recordDomainInteraction(db, project, domain, false);
      return 1;
    }

    return 0;
  } catch {
    return 0;
  }
}
