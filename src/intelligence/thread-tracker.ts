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

    // Skip greetings and very short messages
    if (trimmed.length < 20 || GREETING_PATTERN.test(trimmed)) return null;

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
