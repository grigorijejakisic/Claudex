/**
 * Core type system for CLAUDEXv3.
 * All types defined per Architecture Section 3.1.
 */

/** Conversation message (for OpenClaw messageHistory). */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Token usage metrics. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
  /** 0.0 - 1.0 */
  utilization: number;
}

/**
 * Runtime capabilities — declared once per adapter at init.
 * Adapters declare what they can provide; core checks before using host-specific features.
 * @see Architecture Section 3.1
 */
export interface RuntimeCapabilities {
  /** Can provide conversation messages (OpenClaw: yes, CC: no) */
  hasFullMessageHistory: boolean;
  /** Can provide exact token counts from SDK (OpenClaw: yes, CC: no) */
  hasNativeContextUsage: boolean;
  /** Can read transcript JSONL for gauge (CC: yes, OpenClaw: no) */
  hasTranscriptAccess: boolean;
  /** Can inject system messages mid-turn (both: yes) */
  supportsSystemInjection: boolean;
  /** Can call LLM API without deadlock (both: yes) */
  supportsAsyncEnrichment: boolean;
  /** Can compute embeddings locally (both: yes if Ollama + nomic available) */
  hasLocalEmbeddings: boolean;
  /** Fires afterTurn at end of agent turn (both: yes) */
  supportsTurnEndEvent: boolean;
}

/** Injection payload returned by handleEvent when context should be injected. */
export interface InjectPayload {
  /** Markdown to inject into context */
  content: string;
  /** Approximate token count */
  tokenEstimate: number;
  /** Which data sources contributed */
  sources: string[];
}

