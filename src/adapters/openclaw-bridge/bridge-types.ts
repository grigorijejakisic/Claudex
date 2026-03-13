/**
 * Bridge types for the OpenClaw adapter.
 * BRIDGE_KEY Symbol, ClaudexBridge interface, and minimal Pi SDK type stubs.
 * @see Architecture Section 3.3
 */

/** globalThis key for bridge discovery. */
export const BRIDGE_KEY = Symbol.for('claudex.v3.bridge');

/**
 * Minimal Pi SDK context stubs -- compile-time only, not runtime dependency.
 * Match Architecture Section 3.3 usage patterns.
 */

/** Context object passed to bridge onInit. */
export interface BridgeInitContext {
  sessionKey: string;
  cwd: string;
}

/** Base Pi SDK context (shared by context/tool_result/message_end). */
export interface PiContext {
  sessionKey: string;
  cwd: string;
  messages: Array<{ role: string; content: string }>;
  getContextUsage(): { inputTokens: number; outputTokens: number; contextWindowTokens: number };
  isPostCompaction?: boolean;
}

/** Pi SDK tool_result context. */
export interface PiToolResultContext extends PiContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

/** Pi SDK message_end context. */
export interface PiMessageEndContext extends PiContext {
  lastAssistantText: string;
  lastUserText: string;
}

/** Pi SDK compaction prep object. */
export interface PiCompactPrep {
  messagesToSummarize: Array<{ role: string; content: string }>;
  turnPrefixMessages: Array<{ role: string; content: string }>;
}

/** Pi SDK compact context. */
export interface PiCompactContext extends PiContext {}

/** Pi SDK runtime (passed to session_before_compact). */
export interface PiRuntime {}

/** Standard Pi SDK extension interface. */
export interface PiExtension {
  name: string;
  context?(ctx: PiContext): Promise<void>;
  tool_result?(ctx: PiToolResultContext): Promise<void>;
  message_end?(ctx: PiMessageEndContext): Promise<void>;
  session_before_compact?(ctx: PiCompactContext, prep: PiCompactPrep, runtime: PiRuntime): Promise<void>;
}

/** OpenClaw plugin API for registration. */
export interface OpenClawPluginApi {
  registerHook(event: string, handler: () => Promise<void> | void): void;
}

/** Bridge object registered on globalThis[BRIDGE_KEY]. */
export interface ClaudexBridge {
  onInit(ctx: BridgeInitContext): Promise<{ content: string; tokenEstimate: number; sources: string[] } | void>;
  onContext(ctx: PiContext): Promise<{ content: string; tokenEstimate: number; sources: string[] } | void>;
  onToolResult(ctx: PiToolResultContext): Promise<void>;
  onTurnEnd(ctx: PiMessageEndContext): Promise<void>;
  onCompact(ctx: PiCompactContext, prep: PiCompactPrep, runtime: PiRuntime): Promise<void>;
}
