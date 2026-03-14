/**
 * Bridge adapter callbacks mapping Pi SDK events to core pipeline functions.
 * Persistent DB lifecycle (opened once in activate, closed via deactivate).
 * Session-scoped state (sessionId, cwd, project, scope) derived per-callback from ctx.
 */

import { OPENCLAW_CAPABILITIES } from '../../shared/constants.js';
import { detectProjectScope, getProjectId } from '../../shared/scope-detector.js';
import { createSession } from '../../core/sessions.js';
import { recoverFromDb } from '../../checkpoint/loader.js';
import { pruneTelemetry, emitTelemetry } from '../../observability/telemetry.js';
import { assembleFullContext, assembleRegularPrompt } from '../../assembly/assembler.js';
import { searchArtifacts, materializeArtifacts } from '../../core/artifacts.js';
import { getIdentityDir } from '../../shared/paths.js';
import { getCheckpointTracking, clearPostCompactPending } from '../../core/checkpoint-tracking.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { TopicShiftDetector } from '../../intelligence/topic-shift.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { initTemplates } from '../../embeddings/templates.js';
import { readGsdState } from '../../gsd/state-reader.js';
import { detectEnrichmentProvider } from '../../intelligence/enrichment.js';
import type Database from 'better-sqlite3';
import type { ClaudexConfig } from '../../shared/config.js';
import type { TokenUsage, InjectPayload } from '../../shared/types.js';
import type {
  BridgeInitContext,
  PiContext,
  PiToolResultContext,
  PiMessageEndContext,
  PiCompactContext,
  PiCompactPrep,
  PiRuntime,
  ClaudexBridge,
} from './bridge-types.js';
import {
  processToolAndPressure,
  trackAfterTool,
  trackAfterTurn,
  checkpointIfThresholdMet,
  captureDecisionsWithClassifier,
  runCompactionSequence,
  persistTopicIfShifted,
} from '../shared/lifecycle.js';
import { sanitizeErrorForTelemetry } from '../cc-hooks/infrastructure.js';

/** Cached embedding resources reused across bridge callbacks. */
export interface EmbeddingCache {
  /** The config fingerprint (baseUrl + model) these resources were created with. */
  configKey: string;
  /** Shared EmbeddingProvider instance. */
  provider: EmbeddingProvider;
  /** Whether the provider has been confirmed available. */
  available: boolean;
  /** Cached decision templates (null if init failed or not yet attempted). */
  templates: Awaited<ReturnType<typeof initTemplates>> | null;
  /** Whether template init has been attempted (avoids retrying on failure). */
  templatesInitialized: boolean;
  /** Cached TopicShiftDetector using the shared provider (Jaccard fallback when no embeddings). */
  topicShiftDetector: TopicShiftDetector;
}

/** Persistent context shared across all bridge callbacks.
 * Only truly shared resources (DB, config) live here.
 * Session-scoped state (sessionId, cwd, project, scope) is derived per-callback from ctx.
 * lastSessionId/lastCwd/lastProject/lastScope are set by onInit solely for session_end
 * (which receives no ctx).
 */
export interface BridgeContext {
  db: Database.Database;
  config: ClaudexConfig;
  /** Adapter identity for multi-adapter isolation. */
  adapter: 'openclaw';
  /** Cached embedding resources — reused across callbacks, invalidated on config change. */
  embeddingCache?: EmbeddingCache;
  /** Last sessionId set by onInit — used only by session_end handler (which has no ctx). */
  lastSessionId: string;
  /** Last cwd set by onInit — used only by session_end handler (which has no ctx). */
  lastCwd: string;
  /** Last project set by onInit — used only by session_end handler. */
  lastProject: string;
  /** Last scope set by onInit — used only by session_end handler. */
  lastScope: string | null;
}

/**
 * Maps Pi SDK's getContextUsage() return value to the shared TokenUsage type.
 * Computes utilization clamped to [0, 1].
 */
export function mapTokenUsage(sdkUsage: { inputTokens: number; outputTokens: number; contextWindowTokens: number }): TokenUsage {
  const raw = sdkUsage.contextWindowTokens > 0
    ? sdkUsage.inputTokens / sdkUsage.contextWindowTokens
    : 0;
  return {
    inputTokens: sdkUsage.inputTokens,
    outputTokens: sdkUsage.outputTokens,
    contextWindowTokens: sdkUsage.contextWindowTokens,
    utilization: Math.min(Math.max(raw, 0), 1),
  };
}

/**
 * Build a config fingerprint for cache invalidation.
 * If the embedding config changes, cached resources are stale.
 */
function embeddingConfigKey(config: ClaudexConfig): string {
  return `${config.embeddings.ollama_base_url}|${config.embeddings.model}`;
}

/**
 * Get or create the shared EmbeddingProvider and cache.
 * Lazily initializes on first call. Invalidates if config has changed.
 * Non-throwing — returns a cache with available=false on error.
 */
async function getEmbeddingCache(bctx: BridgeContext): Promise<EmbeddingCache> {
  const key = embeddingConfigKey(bctx.config);

  // Return existing cache if config hasn't changed
  if (bctx.embeddingCache && bctx.embeddingCache.configKey === key) {
    return bctx.embeddingCache;
  }

  // Create fresh cache
  try {
    const provider = new EmbeddingProvider({
      baseUrl: bctx.config.embeddings.ollama_base_url,
      model: bctx.config.embeddings.model,
    });
    const available = await provider.isAvailable();

    const cache: EmbeddingCache = {
      configKey: key,
      provider,
      available,
      templates: null,
      templatesInitialized: false,
      // Always create TopicShiftDetector — when provider is unavailable,
      // pass null so Layer 3 (keyword Jaccard) fallback still runs.
      topicShiftDetector: new TopicShiftDetector(available ? provider : null),
    };

    bctx.embeddingCache = cache;
    return cache;
  } catch {
    const fallback: EmbeddingCache = {
      configKey: key,
      provider: new EmbeddingProvider(),
      available: false,
      templates: null,
      templatesInitialized: true,
      // Jaccard fallback still works with null provider
      topicShiftDetector: new TopicShiftDetector(null),
    };
    bctx.embeddingCache = fallback;
    return fallback;
  }
}

/**
 * Get cached decision templates, initializing on first call.
 * Returns null if provider unavailable or init fails.
 * Non-throwing.
 */
async function getCachedTemplates(cache: EmbeddingCache): Promise<Awaited<ReturnType<typeof initTemplates>> | null> {
  if (cache.templatesInitialized) return cache.templates;

  try {
    if (!cache.available) {
      cache.templatesInitialized = true;
      return null;
    }
    cache.templates = await initTemplates(cache.provider);
    cache.templatesInitialized = true;
    return cache.templates;
  } catch {
    cache.templatesInitialized = true;
    cache.templates = null;
    return null;
  }
}

/**
 * Build a cached classifier from the bridge's embedding cache.
 * Returns null if unavailable. Non-throwing.
 */
async function buildCachedClassifier(bctx: BridgeContext): Promise<{ provider: EmbeddingProvider; templates: NonNullable<Awaited<ReturnType<typeof initTemplates>>> } | null> {
  if (!bctx.config.embeddings.enabled) return null;

  try {
    const cache = await getEmbeddingCache(bctx);
    if (cache.available) {
      const templates = await getCachedTemplates(cache);
      if (templates) {
        return { provider: cache.provider, templates };
      }
    }
  } catch {
    // Fail open -- no classifier
  }
  return null;
}

/**
 * Creates the 5 bridge callbacks that map Pi SDK events to core pipeline calls.
 * Each callback derives session-scoped state from its own ctx (not shared bctx).
 * Each callback is defensive non-throwing -- errors caught and logged via telemetry.
 */
export function createBridgeCallbacks(bctx: BridgeContext): ClaudexBridge {
  return {
    async onInit(ctx: BridgeInitContext): Promise<InjectPayload | void> {
      const startMs = Date.now();
      try {
        const project = getProjectId(ctx.cwd);
        const scope = detectProjectScope(ctx.cwd);

        // Store for session_end handler (which receives no ctx)
        bctx.lastSessionId = ctx.sessionKey;
        bctx.lastCwd = ctx.cwd;
        bctx.lastProject = project;
        bctx.lastScope = scope;

        createSession(bctx.db, {
          session_id: ctx.sessionKey,
          project,
          scope: scope ?? undefined,
          cwd: ctx.cwd,
          source: 'openclaw-bridge',
          adapter: 'openclaw',
        });

        await recoverFromDb(bctx.db);

        if (bctx.config.observability.enabled) {
          pruneTelemetry(bctx.db, {
            retentionDays: bctx.config.observability.retention_days,
            retainErrorCount: bctx.config.observability.retain_error_count,
          });
        }

        const payload = assembleFullContext({
          db: bctx.db,
          project,
          projectDir: ctx.cwd,
          config: bctx.config,
          identityDir: getIdentityDir(),
          sessionId: ctx.sessionKey,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, ctx.sessionKey, 'hook_invocation', {
          hook: 'onInit',
          duration_ms: elapsed,
          result: payload.content ? 'inject' as const : 'skip' as const,
        }, elapsed, 'openclaw');

        return payload.content ? payload : undefined;
      } catch (e) {
        emitTelemetry(bctx.db, ctx.sessionKey, 'error', {
          subsystem: 'bridge:onInit',
          error: sanitizeErrorForTelemetry(e),
        }, undefined, 'openclaw');
        return undefined;
      }
    },

    async onContext(ctx: PiContext): Promise<InjectPayload | void> {
      const startMs = Date.now();
      try {
        const sessionId = ctx.sessionKey;
        const cwd = ctx.cwd;
        const project = getProjectId(cwd);

        const lastUserMsg = [...ctx.messages].reverse().find(m => m.role === 'user');
        const prompt = lastUserMsg?.content ?? '';

        const tracking = getCheckpointTracking(bctx.db, sessionId);
        const isPostCompaction = ctx.isPostCompaction ?? (tracking?.post_compact_pending === 1);

        const sdkUsage = ctx.getContextUsage();
        const nativeUsage = mapTokenUsage(sdkUsage);

        const gauge = getTokenGauge({
          capabilities: OPENCLAW_CAPABILITIES,
          nativeUsage,
        });

        let topicShift: TopicShiftResult | null = null;
        if (!isPostCompaction && prompt) {
          try {
            const cache = await getEmbeddingCache(bctx);
            const detector = cache.topicShiftDetector;
            if (detector) {
              topicShift = await detector.detectTopicShift({
                prompt,
                db: bctx.db,
                sessionId,
                config: {
                  topicShiftThreshold: bctx.config.embeddings.topic_shift_threshold,
                  topicShiftWindow: bctx.config.embeddings.topic_shift_window,
                  jaccardShiftThreshold: bctx.config.embeddings.jaccard_shift_threshold,
                },
              });
            }
          } catch {
            topicShift = null;
          }
        }

        // Persist topic update to thread_state when shift detected
        persistTopicIfShifted(bctx.db, sessionId, topicShift);

        // Materialize artifacts before assembly reads them (ARCH-002)
        try {
          const query = prompt || topicShift?.newTopic;
          if (query) {
            const matches = searchArtifacts(bctx.db, project, query, 10);
            if (matches.length > 0) {
              materializeArtifacts(bctx.db, matches.map(a => a.id));
            }
          }
        } catch { /* non-fatal */ }

        const payload = assembleRegularPrompt({
          isPostCompaction,
          prompt,
          gauge,
          topicShift,
          db: bctx.db,
          project,
          projectDir: cwd,
          config: bctx.config,
          identityDir: getIdentityDir(),
          sessionId,
        });

        if (isPostCompaction) {
          clearPostCompactPending(bctx.db, sessionId);
        }

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, sessionId, 'hook_invocation', {
          hook: 'onContext',
          duration_ms: elapsed,
          result: payload.content ? 'inject' as const : 'skip' as const,
        }, elapsed, 'openclaw');

        return payload.content ? payload : undefined;
      } catch (e) {
        emitTelemetry(bctx.db, ctx.sessionKey, 'error', {
          subsystem: 'bridge:onContext',
          error: sanitizeErrorForTelemetry(e),
        }, undefined, 'openclaw');
        return undefined;
      }
    },

    async onToolResult(ctx: PiToolResultContext): Promise<void> {
      const startMs = Date.now();
      try {
        const sessionId = ctx.sessionKey;
        const cwd = ctx.cwd;
        const project = getProjectId(cwd);
        const scope = detectProjectScope(cwd);
        const { toolName, toolInput, toolOutput } = ctx;

        processToolAndPressure({
          db: bctx.db,
          sessionId,
          project,
          cwd,
          toolName,
          toolInput,
          toolOutput,
        });

        // Thread tracking
        trackAfterTool(bctx.db, sessionId, undefined, toolName, toolInput);

        // Checkpoint threshold check
        const sdkUsage = ctx.getContextUsage();
        const nativeUsage = mapTokenUsage(sdkUsage);
        const gauge = getTokenGauge({
          capabilities: OPENCLAW_CAPABILITIES,
          nativeUsage,
        });

        await checkpointIfThresholdMet({
          db: bctx.db,
          sessionId,
          project,
          cwd,
          scope: scope ?? undefined,
          config: bctx.config,
          gauge,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, sessionId, 'hook_invocation', {
          hook: 'onToolResult',
          duration_ms: elapsed,
          result: 'skip' as const,
        }, elapsed, 'openclaw');
      } catch (e) {
        emitTelemetry(bctx.db, ctx.sessionKey, 'error', {
          subsystem: 'bridge:onToolResult',
          error: sanitizeErrorForTelemetry(e),
        }, undefined, 'openclaw');
      }
    },

    async onTurnEnd(ctx: PiMessageEndContext): Promise<void> {
      const startMs = Date.now();
      try {
        const sessionId = ctx.sessionKey;
        const cwd = ctx.cwd;
        const project = getProjectId(cwd);
        const scope = detectProjectScope(cwd);
        const { lastAssistantText, lastUserText } = ctx;

        // Decision capture with optional embedding classifier (cached across calls)
        const classifier = await buildCachedClassifier(bctx);

        await captureDecisionsWithClassifier({
          db: bctx.db,
          sessionId,
          project,
          config: bctx.config,
          userText: lastUserText,
          assistantText: lastAssistantText,
          classifier,
        });

        // Thread tracking
        trackAfterTurn(bctx.db, sessionId, lastUserText, lastAssistantText);

        // Checkpoint threshold check
        const sdkUsage = ctx.getContextUsage();
        const nativeUsage = mapTokenUsage(sdkUsage);
        const gauge = getTokenGauge({
          capabilities: OPENCLAW_CAPABILITIES,
          nativeUsage,
        });

        await checkpointIfThresholdMet({
          db: bctx.db,
          sessionId,
          project,
          cwd,
          scope: scope ?? undefined,
          config: bctx.config,
          gauge,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, sessionId, 'hook_invocation', {
          hook: 'onTurnEnd',
          duration_ms: elapsed,
          result: 'skip' as const,
        }, elapsed, 'openclaw');
      } catch (e) {
        emitTelemetry(bctx.db, ctx.sessionKey, 'error', {
          subsystem: 'bridge:onTurnEnd',
          error: sanitizeErrorForTelemetry(e),
        }, undefined, 'openclaw');
      }
    },

    async onCompact(ctx: PiCompactContext, _prep: PiCompactPrep, _runtime: PiRuntime): Promise<void> {
      const startMs = Date.now();
      try {
        const sessionId = ctx.sessionKey;
        const cwd = ctx.cwd;
        const project = getProjectId(cwd);
        const scope = detectProjectScope(cwd);

        const sdkUsage = ctx.getContextUsage();
        const nativeUsage = mapTokenUsage(sdkUsage);
        const gauge = getTokenGauge({
          capabilities: OPENCLAW_CAPABILITIES,
          nativeUsage,
        });
        const gsd = readGsdState(cwd);

        const enrichProvider = await detectEnrichmentProvider({
          baseUrl: bctx.config.enrichment.ollama_base_url,
          model: bctx.config.enrichment.ollama_model,
          provider: bctx.config.enrichment.provider,
          enabled: bctx.config.enrichment.enabled,
        }, OPENCLAW_CAPABILITIES);

        await runCompactionSequence({
          db: bctx.db,
          sessionId,
          project,
          cwd,
          scope: scope ?? undefined,
          gauge: gauge ?? undefined,
          gsd: gsd ?? undefined,
          enrichmentProvider: enrichProvider ?? undefined,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, sessionId, 'hook_invocation', {
          hook: 'onCompact',
          duration_ms: elapsed,
          result: 'skip' as const,
        }, elapsed, 'openclaw');
      } catch (e) {
        emitTelemetry(bctx.db, ctx.sessionKey, 'error', {
          subsystem: 'bridge:onCompact',
          error: sanitizeErrorForTelemetry(e),
        }, undefined, 'openclaw');
      }
    },
  };
}
