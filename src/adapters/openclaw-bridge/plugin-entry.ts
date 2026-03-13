/**
 * OpenClaw plugin entry point.
 * Opens DB once, creates bridge callbacks, registers on globalThis, sets up session_end cleanup.
 * @see Architecture Section 3.3
 */

import { BRIDGE_KEY } from './bridge-types.js';
import type { OpenClawPluginApi } from './bridge-types.js';
import { createBridgeCallbacks } from './bridge-adapter.js';
import type { BridgeContext } from './bridge-adapter.js';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { loadConfig } from '../../shared/config.js';
import { detectProjectScope, getProjectId } from '../../shared/scope-detector.js';
import { getDbPath } from '../../shared/paths.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { runSessionEndCleanup } from '../shared/lifecycle.js';

/**
 * Standard OpenClaw plugin activate() function.
 * Opens DB once, creates bridge, registers on globalThis, registers session_end cleanup.
 */
export function activate(api: OpenClawPluginApi): void {
  try {
    const db = openDatabase(getDbPath());
    const config = loadConfig();
    const cwd = process.cwd();
    const scope = detectProjectScope(cwd);
    const project = getProjectId(cwd);

    const bctx: BridgeContext = {
      db,
      config,
      project,
      scope,
      sessionId: '', // Set by onInit when session starts
      cwd,
      adapter: 'openclaw',
    };

    const bridge = createBridgeCallbacks(bctx);

    // Register bridge on globalThis for OpenClaw's extensions.ts to discover
    (globalThis as any)[BRIDGE_KEY] = bridge;

    // Register session_end cleanup
    api.registerHook('session_end', async () => {
      try {
        const startMs = Date.now();

        await runSessionEndCleanup({
          db: bctx.db,
          sessionId: bctx.sessionId,
          project: bctx.project,
          cwd: bctx.cwd,
          scope: bctx.scope ?? undefined,
          config: bctx.config,
        });

        const elapsed = Date.now() - startMs;
        emitTelemetry(bctx.db, bctx.sessionId, 'hook_invocation', {
          hook: 'session_end',
          duration_ms: elapsed,
          result: 'skip' as const,
        }, elapsed, 'openclaw');
      } catch {
        // Non-throwing -- session_end must not crash
      } finally {
        // Clean up globalThis registration
        (globalThis as any)[BRIDGE_KEY] = undefined;
        // Close DB
        closeDatabase(bctx.db);
      }
    });
  } catch {
    // activate() must not throw -- OpenClaw plugin load should degrade gracefully
  }
}
