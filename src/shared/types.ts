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

/** Session initialization payload. */
export interface SessionInitPayload {
  kind: 'session_init';
  source: 'startup' | 'resume' | 'clear' | 'bridge_init';
}

/** Before-prompt payload with optional capability-gated fields. */
export interface BeforePromptPayload {
  kind: 'before_prompt';
  prompt: string;
  isPostCompaction: boolean;
  /** From hasNativeContextUsage OR hasTranscriptAccess */
  tokenUsage?: TokenUsage;
  /** From hasFullMessageHistory (OpenClaw only) */
  messageHistory?: Message[];
}

/** After-tool payload. */
export interface AfterToolPayload {
  kind: 'after_tool';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
}

/** After-turn payload (from supportsTurnEndEvent). */
export interface AfterTurnPayload {
  kind: 'after_turn';
  lastAssistantText?: string;
  lastUserText?: string;
}

/** Before-compact payload. */
export interface BeforeCompactPayload {
  kind: 'before_compact';
  trigger: 'auto' | 'manual';
  /** From hasFullMessageHistory */
  messagesToSummarize?: Message[];
  turnPrefixMessages?: Message[];
}

/** Session end payload. */
export interface SessionEndPayload {
  kind: 'session_end';
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'bridge_end';
}

/** Discriminated union of all event payloads. */
export type EventPayload =
  | SessionInitPayload
  | BeforePromptPayload
  | AfterToolPayload
  | AfterTurnPayload
  | BeforeCompactPayload
  | SessionEndPayload;

/**
 * Host-neutral event envelope.
 * @see Architecture Section 3.1
 */
export interface RuntimeEvent {
  kind: 'session_init' | 'before_prompt' | 'after_tool' | 'after_turn' | 'before_compact' | 'session_end';
  sessionId: string;
  cwd: string;
  /** Unix epoch ms */
  timestamp: number;
  payload: EventPayload;
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

/**
 * Core engine interface — processes events, checks capabilities.
 * @see Architecture Section 3.1
 */
export interface ClaudexCore {
  readonly capabilities: RuntimeCapabilities;

  /** Process any runtime event — single dispatch point. */
  handleEvent(event: RuntimeEvent): Promise<InjectPayload | void>;

  /** Lifecycle cleanup. */
  close(): void;
}
