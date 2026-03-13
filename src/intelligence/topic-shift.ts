/**
 * 3-layer topic-shift detection: explicit pivot regex, embedding cosine
 * with sliding window, and keyword Jaccard fallback.
 * Non-throwing — returns { shifted: false } on error.
 * @see Architecture Section 7.3.1
 */

import type { Database } from 'better-sqlite3';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { cosineSimilarity } from '../embeddings/cosine.js';
import { keywordJaccard } from './semantic-dedup.js';
import { getThreadState } from '../core/thread.js';
import { extractTopic } from './thread-tracker.js';

export interface TopicShiftResult {
  shifted: boolean;
  newTopic?: string;
  previousTopic?: string;
  confidence?: number;
  method?: 'explicit' | 'embedding' | 'jaccard';
}

/** Explicit pivot signal regex — cheapest, highest precision. */
const EXPLICIT_PIVOT = /^(now let's|next[,:]|switch to|moving on|let's work on|different topic|new task|back to|forget that|actually[,:]?\s*(?:let's|can we|I need))/i;

/**
 * Stateful topic-shift detector maintaining a sliding window
 * of recent prompt embeddings for noise smoothing.
 */
export class TopicShiftDetector {
  private provider: EmbeddingProvider | null;
  private recentPromptEmbeddings: number[][];
  private topicEmbeddingCache: { topic: string; embedding: number[] } | null;

  constructor(provider: EmbeddingProvider | null) {
    this.provider = provider;
    this.recentPromptEmbeddings = [];
    this.topicEmbeddingCache = null;
  }

  /**
   * Detect whether user prompt represents a topic shift.
   * Layer 1: Explicit pivot regex (always checked first)
   * Layer 2: Embedding cosine similarity with sliding window
   * Layer 3: Keyword Jaccard fallback (when no embeddings)
   */
  async detectTopicShift(params: {
    prompt: string;
    db: Database;
    sessionId: string;
    config?: {
      topicShiftThreshold?: number;
      topicShiftWindow?: number;
      embeddingsEnabled?: boolean;
    };
  }): Promise<TopicShiftResult> {
    try {
      const { prompt, db, sessionId, config } = params;
      const threshold = config?.topicShiftThreshold ?? 0.35;
      const windowSize = config?.topicShiftWindow ?? 3;
      const embeddingsEnabled = config?.embeddingsEnabled ?? true;

      // Layer 1: Explicit pivot signals (always checked first)
      if (EXPLICIT_PIVOT.test(prompt.trim())) {
        const thread = getThreadState(db, sessionId);
        const newTopic = inferTopic(prompt);
        return {
          shifted: true,
          newTopic: newTopic ?? undefined,
          previousTopic: thread?.topic ?? undefined,
          confidence: 1.0,
          method: 'explicit',
        };
      }

      // Get current topic from thread state
      const thread = getThreadState(db, sessionId);
      if (!thread?.topic) return { shifted: false };

      // Layer 2: Embedding cosine similarity (skipped if embeddings disabled)
      if (this.provider && embeddingsEnabled) {
        const topicEmb = await this.getTopicEmbedding(thread.topic);
        if (topicEmb) {
          const promptEmb = await this.provider.embed(prompt);
          if (promptEmb) {
            const similarity = cosineSimilarity(topicEmb, promptEmb);

            // Sliding window: compare against recent prompts
            const avgRecent = this.computeAvgRecent(promptEmb);

            // Push to window after computing avgRecent
            this.recentPromptEmbeddings.push(promptEmb);
            if (this.recentPromptEmbeddings.length > windowSize) {
              this.recentPromptEmbeddings.shift();
            }

            if (similarity < threshold && avgRecent < 0.40) {
              const newTopic = inferTopic(prompt);
              this.topicEmbeddingCache = null; // Invalidate on shift
              return {
                shifted: true,
                newTopic: newTopic ?? undefined,
                previousTopic: thread.topic ?? undefined,
                confidence: 1.0 - similarity,
                method: 'embedding',
              };
            }

            return { shifted: false };
          }
          // Embed failed — fall through to Layer 3
        }
        // Topic embed failed — fall through to Layer 3
      }

      // Layer 3: Keyword Jaccard fallback
      const overlap = keywordJaccard(thread.topic, prompt);
      if (overlap < 0.15) {
        const newTopic = inferTopic(prompt);
        return {
          shifted: true,
          newTopic: newTopic ?? undefined,
          previousTopic: thread.topic ?? undefined,
          confidence: 1.0 - overlap,
          method: 'jaccard',
        };
      }

      return { shifted: false };
    } catch {
      return { shifted: false };
    }
  }

  /** Clear topic embedding cache and recent prompt window. */
  clearCache(): void {
    this.topicEmbeddingCache = null;
    this.recentPromptEmbeddings = [];
  }

  /** Get topic embedding with caching. */
  private async getTopicEmbedding(topic: string): Promise<number[] | null> {
    try {
      if (this.topicEmbeddingCache?.topic === topic) {
        return this.topicEmbeddingCache.embedding;
      }
      const emb = await this.provider!.embed(topic);
      if (emb) {
        this.topicEmbeddingCache = { topic, embedding: emb };
      }
      return emb;
    } catch {
      return null;
    }
  }

  /** Compute average similarity of promptEmb against recent prompt embeddings. */
  private computeAvgRecent(promptEmb: number[]): number {
    if (this.recentPromptEmbeddings.length === 0) {
      // When no prior prompts, use the prompt's own similarity as avgRecent
      // This means only the topic threshold matters for the first prompt
      return 0; // Conservative: treat as low similarity to allow shift detection
    }
    let sum = 0;
    for (const recent of this.recentPromptEmbeddings) {
      sum += cosineSimilarity(promptEmb, recent);
    }
    return sum / this.recentPromptEmbeddings.length;
  }
}

/** Infer new topic from pivot prompt. Reuses extractTopic from thread-tracker. */
function inferTopic(text: string): string | null {
  return extractTopic(text);
}

/** Convenience factory for creating detector. */
export function createTopicShiftDetector(
  provider: EmbeddingProvider | null
): TopicShiftDetector {
  return new TopicShiftDetector(provider);
}
