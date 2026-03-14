/**
 * OpenClaw plugin entry point.
 * Opens DB once, creates bridge callbacks, registers on globalThis, sets up session_end cleanup.
 * DB stays open across sessions; explicit deactivate() closes it.
 */

import { BRIDGE_KEY } from './bridge-types.js';
import type { OpenClawPluginApi } from './bridge-types.js';
import { createBridgeCallbacks } from './bridge-adapter.js';
import type { BridgeContext } from './bridge-adapter.js';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { loadConfig } from '../../shared/config.js';
import { getDbPath } from '../../shared/paths.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { runSessionEndCleanup } from '../shared/lifecycle.js';

/** Module-level ref for deactivate() to access. */
let activeBctx: BridgeContext | null = null;

/**
 * Standard OpenClaw plugin activate() function.
 * Opens DB once, creates bridge, registers on globalThis, registers session_end cleanup.
 * DB persists across sessions — call deactivate() for explicit teardown.
 */
export function activate(api: OpenClawPluginApi): void {
  try {
    const db = openDatabase(getDbPath());
    const config = loadConfig();

    const bctx: BridgeContext = {
      db,
      config,
      adapter: 'openclaw',
      lastSessionId: '',
      lastCwd: '',
      lastProject: '',
      lastScope: null,
    };

    activeBctx = bctx;
    const bridge = createBridgeCallbacks(bctx);

    // Register bridge on globalThis for OpenClaw's extensions.ts to discover
    (globalThis as any)[BRIDGE_KEY] = bridge;

    // Register session_end cleanup — per-session only, NOT plugin teardown
    api.registerHook('session_end', async () => {
      try {
        // Guard against session_end running before onInit sets lastSessionId.
        // Without a valid sessionId, cleanup writes would target empty-string keys.
        if (!bctx.lastSessionId) return;

        const startMs = Date.now();

        await runSessionEndCleanup({
          db: bctx.db,
          sessionId: bctx.lastSessionId,
          project: bctx.lastProject,
          cwd: bctx.lastCwd,
          scope: bctx.lastScope ?? undefined,
          config: bctx.config,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, bctx.lastSessionId, 'hook_invocation', {
          hook: 'session_end',
          duration_ms: elapsed,
          result: 'skip' as const,
        }, elapsed, 'openclaw');
      } catch {
        // Non-throwing -- session_end must not crash
      }
      // No finally — DB stays open for subsequent sessions.
      // Call deactivate() for explicit plugin teardown.
    });
  } catch {
    // activate() must not throw -- OpenClaw plugin load should degrade gracefully
  }
}

/**
 * Explicit plugin teardown: unregisters bridge from globalThis, closes DB.
 * Called by OpenClaw plugin lifecycle (not per-session).
 */
export function deactivate(): void {
  try {
    (globalThis as any)[BRIDGE_KEY] = undefined;
    if (activeBctx) {
      closeDatabase(activeBctx.db);
      activeBctx = null;
    }
  } catch {
    // deactivate() must not throw
  }
}
