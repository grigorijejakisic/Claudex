/**
 * Thread state tracker with exchange accumulation, gist extraction, and summary construction.
 * Stateful class: holds in-memory buffer between after_tool calls, flushed at after_turn.
 */

import type { Database } from 'better-sqlite3';
import { upsertThreadState, getThreadState } from '../core/thread.js';
import { TOOL_CATALOG } from '../shared/tool-catalog.js';

const MAX_KEY_EXCHANGES = 8;
const MAX_GIST_LEN = 120;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'your',
  'let', 'just', 'now', 'so', 'if', 'but', 'or', 'and', 'not', 'no',
]);

const GREETING_PATTERN = /^(hi|hello|hey|thanks|thank you|good morning|good afternoon)\b/i;

/**
 * Matches CC internal messages that should never become thread topics.
 * Task notifications: "tasknotification taskid...taskid tooluseid..."
 * Output file references: "outputfile..." (CC background task outputs)
 */
const CC_INTERNAL_PATTERN = /^(tasknotification\s|outputfile)/i;

/**
 * Cleans a gist for use in thread summary.
 * Strips markdown formatting, collapses whitespace, ensures proper termination.
 */
function cleanGistForSummary(gist: string): string {
  let cleaned = gist
    .replace(/```[\s\S]*?```/g, '')      // Remove code blocks
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // Bold -> plain
    .replace(/\*([^*]+)\*/g, '$1')       // Italic -> plain
    .replace(/^#+\s+/gm, '')             // Heading markers
    .replace(/^[-*]\s+/gm, '')           // List markers
    .replace(/`([^`]+)`/g, '$1')         // Inline code -> plain
    .replace(/\n+/g, ' ')                // Newlines -> space
    .replace(/\s{2,}/g, ' ')             // Collapse whitespace
    .trim();
  // Ensure ends with sentence terminator
  if (cleaned && !/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }
  return cleaned;
}

/**
 * Extract a short gist from raw text.
 * - <= 120 chars: return as-is
 * - > 120 chars: truncate at sentence boundary or 120 with "..."
 */
export function extractGist(raw: string): string {
  try {
    if (!raw) return '';
    const trimmed = raw.trim();
    if (trimmed.length <= MAX_GIST_LEN) return trimmed;

    // Find last sentence boundary before 120
    const sub = trimmed.slice(0, MAX_GIST_LEN);
    const lastDot = sub.lastIndexOf('.');
    const lastBang = sub.lastIndexOf('!');
    const lastQ = sub.lastIndexOf('?');
    const boundary = Math.max(lastDot, lastBang, lastQ);

    if (boundary > 20) {
      return trimmed.slice(0, boundary + 1);
    }

    return sub + '...';
  } catch {
    return raw?.slice(0, MAX_GIST_LEN) ?? '';
  }
}

/**
 * Extract topic from user text.
 * Takes first sentence, removes stop words, trims to 5-15 words.
 */
export function extractTopic(text: string): string | null {
  try {
    if (!text) return null;
    const trimmed = text.trim();

    // Skip greetings, very short messages, and CC internal notifications
    if (trimmed.length < 20 || GREETING_PATTERN.test(trimmed) || CC_INTERNAL_PATTERN.test(trimmed)) return null;

    // First sentence
    const sentEnd = trimmed.search(/[.!?]/);
    const firstSentence = sentEnd > 0 ? trimmed.slice(0, sentEnd) : trimmed;

    // Remove stop words
    const words = firstSentence
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

    if (words.length < 3) {
      // Too short after filtering — use original first sentence
      return firstSentence.slice(0, 60).trim();
    }

    // Keep 5-15 words
    return words.slice(0, 15).join(' ');
  } catch {
    return null;
  }
}

/** Summarize tool input to a short string */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  try {
    const catalogEntry = TOOL_CATALOG[toolName];
    const keyFields = catalogEntry?.keyFields ?? Object.keys(input).slice(0, 1);
    for (const key of keyFields) {
      if (input[key] != null) {
        const val = String(input[key]);
        return val.length > 80 ? val.slice(0, 77) + '...' : val;
      }
    }
    return JSON.stringify(input).slice(0, 80);
  } catch {
    return '';
  }
}

export class ThreadTracker {
  private db: Database;
  private sessionId: string;
  private pendingExchanges: Array<{ role: string; raw: string }>;
  private topic: string | null;
  private keyExchanges: Array<{ role: string; gist: string }>;
  private summary: string | null;
  private hasUserThisTurn: boolean;

  constructor(db: Database, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;
    this.pendingExchanges = [];
    this.topic = null;
    this.keyExchanges = [];
    this.summary = null;
    this.hasUserThisTurn = false;

    // Restore from DB if existing
    try {
      const existing = getThreadState(db, sessionId);
      if (existing) {
        this.topic = existing.topic ?? null;
        this.summary = existing.summary ?? null;
        this.keyExchanges = existing.key_exchanges ?? [];
      }
    } catch {
      // Fresh state
    }
  }

  /**
   * Called during after_tool event. Accumulates exchanges in buffer.
   * Does NOT persist to DB.
   */
  onAfterTool(
    userText: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>
  ): void {
    try {
      // Add user text once per turn
      if (userText && !this.hasUserThisTurn) {
        this.pendingExchanges.push({ role: 'user', raw: userText });
        this.hasUserThisTurn = true;
      }

      // Add tool action
      const summary = summarizeToolInput(toolName, toolInput);
      this.pendingExchanges.push({ role: 'tool', raw: `${toolName}: ${summary}` });
    } catch {
      // Non-throwing
    }
  }

  /**
   * Called during after_turn event. Flushes buffer, extracts gists,
   * updates state, persists to DB.
   */
  onAfterTurn(userText: string | undefined, assistantText: string | undefined): void {
    try {
      // Add remaining exchanges
      if (userText && !this.hasUserThisTurn) {
        // Guard against cross-process duplicate. PostToolUse (process A) may
        // have already recorded this user prompt via onAfterTool, persisted to DB,
        // then Stop (process B) re-creates the tracker and calls onAfterTurn with the
        // same userText. Check if last DB-loaded exchange is already a 'user' with matching gist.
        const userGist = extractGist(userText);
        const lastExchange = this.keyExchanges[this.keyExchanges.length - 1];
        const isDuplicate = lastExchange?.role === 'user' && lastExchange.gist === userGist;
        if (!isDuplicate) {
          this.pendingExchanges.push({ role: 'user', raw: userText });
        }
      }
      if (assistantText) {
        this.pendingExchanges.push({ role: 'agent', raw: assistantText });
      }

      // Flush: extract gists and append to keyExchanges
      for (const exchange of this.pendingExchanges) {
        if (exchange.role === 'tool') continue; // Collapse tool entries; they're context for agent gist
        const gist = extractGist(exchange.raw);
        if (gist) {
          // Enforce rolling window
          if (this.keyExchanges.length >= MAX_KEY_EXCHANGES) {
            this.keyExchanges.shift();
          }
          this.keyExchanges.push({ role: exchange.role, gist });
        }
      }

      // Update topic (set once)
      if (!this.topic && userText) {
        this.topic = extractTopic(userText);
      }

      // Update summary
      this.summary = this.buildSummary();

      // Persist
      this.persist();

      // Clear buffer for next turn
      this.pendingExchanges = [];
      this.hasUserThisTurn = false;
    } catch {
      // Non-throwing — clear buffer to avoid repeated failures
      this.pendingExchanges = [];
      this.hasUserThisTurn = false;
    }
  }

  /**
   * Build summary from topic + last 2-3 agent gists.
   * Strips markdown formatting and collapses whitespace for readable output.
   */
  buildSummary(): string {
    try {
      const agentGists = this.keyExchanges
        .filter((e) => e.role === 'agent')
        .slice(-3)
        .map((e) => cleanGistForSummary(e.gist));

      const parts: string[] = [];
      if (this.topic) parts.push(this.topic);
      if (agentGists.length > 0) parts.push(agentGists.join(' '));

      const raw = parts.join('. ');
      return raw.length > 300 ? raw.slice(0, 297) + '...' : raw;
    } catch {
      return '';
    }
  }

  /**
   * Persist current state to DB.
   */
  persist(): void {
    try {
      upsertThreadState(this.db, {
        session_id: this.sessionId,
        topic: this.topic ?? undefined,
        summary: this.summary ?? undefined,
        key_exchanges: this.keyExchanges,
      });
      // Thread summary embedding moved to Stop hook (awaited there)
      // because persist() is sync and CC hooks are ephemeral processes.
    } catch {
      // Non-throwing
    }
  }

  /**
   * Update the current topic (e.g., after topic-shift detection).
   * Persists immediately to DB. Non-throwing.
   * Provides the call site for topic-shift results to be persisted.
   */
  updateTopic(newTopic: string): void {
    try {
      this.topic = newTopic;
      this.summary = this.buildSummary();
      this.persist();
    } catch {
      // Non-throwing
    }
  }

  /** Get current topic (for testing/inspection) */
  getTopic(): string | null {
    return this.topic;
  }

  /** Get current key exchanges (for testing/inspection) */
  getKeyExchanges(): Array<{ role: string; gist: string }> {
    return this.keyExchanges;
  }

  /** Get current summary (for testing/inspection) */
  getSummary(): string | null {
    return this.summary;
  }
}

/**
 * Persists a new topic to thread_state when a topic shift is detected.
 * Standalone function so CC hooks can call it without instantiating a full ThreadTracker.
 * Non-throwing.
 */
export function persistTopicUpdate(db: Database, sessionId: string, newTopic: string): void {
  try {
    const tracker = new ThreadTracker(db, sessionId);
    tracker.updateTopic(newTopic);
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Cross-session thread linking (4.3)
// ---------------------------------------------------------------------------

/** A matched thread from a previous session. */
export interface SimilarThread {
  session_id: string;
  topic: string | null;
  summary: string | null;
  key_exchanges: Array<{ role: string; gist: string }>;
  similarity: number;
}

/**
 * Cosine similarity between two Float32Array-like vectors.
 * Returns 0.0 for zero-length or zero-norm vectors.
 */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find threads from previous sessions with semantically similar summaries.
 *
 * Queries thread_state for stored summary_embeddings (same project, last 20 sessions).
 * Computes cosine similarity in app code (SQLite BLOB → Float32Array → cosine).
 * Returns threads above the given threshold, sorted by similarity descending.
 *
 * @param db - SQLite database
 * @param queryEmbedding - embedding vector of the current prompt/query
 * @param project - project scope
 * @param threshold - cosine similarity threshold (default 0.8)
 * @param excludeSessionId - session to exclude (typically current session)
 * @returns matching threads sorted by similarity
 *
 * Non-throwing — returns empty array on any failure.
 */
/**
 * Synchronous thread search — SQLite BLOB cosine only.
 * For Qdrant-accelerated search, use findSimilarThreadsAsync.
 */
export function findSimilarThreads(
  db: Database,
  queryEmbedding: number[] | Float32Array,
  project: string,
  threshold: number = 0.8,
  excludeSessionId?: string,
): SimilarThread[] {
  try {
    return findSimilarThreadsSQLite(db, queryEmbedding, project, threshold, excludeSessionId);
  } catch {
    return [];
  }
}

/** SQLite BLOB cosine — loads embeddings and computes similarity in JS. */
function findSimilarThreadsSQLite(
  db: Database,
  queryEmbedding: number[] | Float32Array,
  project: string,
  threshold: number,
  excludeSessionId?: string,
): SimilarThread[] {
  const rows = db.prepare(
    `SELECT t.session_id, t.topic, t.summary, t.key_exchanges, t.summary_embedding
     FROM thread_state t
     JOIN sessions s ON s.session_id = t.session_id
     WHERE s.project = ?
       AND t.summary_embedding IS NOT NULL
       ${excludeSessionId ? 'AND t.session_id != ?' : ''}
     ORDER BY t.updated_at_epoch_ms DESC
     LIMIT 20`
  ).all(...(excludeSessionId ? [project, excludeSessionId] : [project])) as Array<{
    session_id: string;
    topic: string | null;
    summary: string | null;
    key_exchanges: string;
    summary_embedding: Buffer;
  }>;

  const results: SimilarThread[] = [];

  for (const row of rows) {
    try {
      const vec = new Float32Array(
        row.summary_embedding.buffer,
        row.summary_embedding.byteOffset,
        row.summary_embedding.byteLength / 4,
      );
      const sim = cosine(queryEmbedding, vec);
      if (sim >= threshold) {
        let parsedExchanges: Array<{ role: string; gist: string }> = [];
        try {
          parsedExchanges = JSON.parse(row.key_exchanges);
        } catch { /* corrupt JSON */ }

        results.push({
          session_id: row.session_id,
          topic: row.topic,
          summary: row.summary,
          key_exchanges: parsedExchanges.filter(e => e.role !== '__cooldown'),
          similarity: sim,
        });
      }
    } catch {
      // Skip corrupted rows
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 3);
}

/**
 * Async Qdrant-accelerated thread search. Use this from async callers
 * (UserPromptSubmit) for true KNN acceleration.
 * Falls back to SQLite if Qdrant is unavailable.
 */
export async function findSimilarThreadsAsync(
  db: Database,
  queryEmbedding: number[] | Float32Array,
  project: string,
  threshold: number = 0.8,
  excludeSessionId?: string,
): Promise<SimilarThread[]> {
  try {
    // Phase 5 (session 47): Qdrant removed. Vector search now runs in-process
    // via sqlite-vec, which is always available on databases opened through
    // `openDatabase()` (V14→V15 migration loads the extension and creates the
    // virtual tables automatically). The legacy probing pattern
    // (getQdrantClient + isQdrantAvailable + SQLite fallback) is no longer
    // needed — searchThreads routes directly to the sqlite-vec backend.
    const { searchThreads, isSqliteVecReady } = await import('../embeddings/qdrant-client.js');
    if (!isSqliteVecReady()) {
      return findSimilarThreadsSQLite(db, queryEmbedding, project, threshold, excludeSessionId);
    }
    const embedding = Array.from(queryEmbedding);
    const qdrantResults = await searchThreads(embedding, project, 10);

      const results: SimilarThread[] = [];
      for (const r of qdrantResults) {
        if (r.score < threshold) continue;
        const sessionId = r.payload?.session_id as string;
        if (!sessionId || sessionId === excludeSessionId) continue;

        // Hydrate from DB for full thread data
        const thread = db.prepare(
          'SELECT topic, summary, key_exchanges FROM thread_state WHERE session_id = ?'
        ).get(sessionId) as { topic: string | null; summary: string | null; key_exchanges: string } | undefined;

        if (!thread) continue;

        let parsedExchanges: Array<{ role: string; gist: string }> = [];
        try { parsedExchanges = JSON.parse(thread.key_exchanges); } catch { /* */ }

        results.push({
          session_id: sessionId,
          topic: thread.topic,
          summary: thread.summary,
          key_exchanges: parsedExchanges.filter(e => e.role !== '__cooldown'),
          similarity: r.score,
        });
      }

    if (results.length > 0) return results.slice(0, 3);
  } catch { /* Qdrant unavailable — fall through to SQLite */ }

  return findSimilarThreadsSQLite(db, queryEmbedding, project, threshold, excludeSessionId);
}
