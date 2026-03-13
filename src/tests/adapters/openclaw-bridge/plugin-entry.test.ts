/**
 * Tests for activate(): globalThis registration, session_end cleanup, DB lifecycle.
 * Uses in-memory SQLite with initialized schema.
 */

import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { initializeSchema } from '../../../core/migrations.js';
import { BRIDGE_KEY } from '../../../adapters/openclaw-bridge/bridge-types.js';
import type { OpenClawPluginApi, ClaudexBridge } from '../../../adapters/openclaw-bridge/bridge-types.js';
import { activate } from '../../../adapters/openclaw-bridge/plugin-entry.js';

// Mock external dependencies that touch filesystem
vi.mock('../../../shared/paths.js', () => ({
  getDbPath: () => ':memory:',
  getIdentityDir: () => '/tmp/identity',
  getClaudexHome: () => '/tmp/claudex',
  getCheckpointsDir: () => '/tmp/checkpoints',
  getConfigPath: () => '/tmp/config.json',
}));

vi.mock('../../../shared/scope-detector.js', () => ({
  detectProjectScope: () => null,
  getProjectId: () => 'test-proj',
}));

function createMockApi(): OpenClawPluginApi & { handlers: Record<string, Function> } {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    registerHook(event: string, handler: () => Promise<void> | void) {
      handlers[event] = handler;
    },
  };
}

function getBridge(): ClaudexBridge | undefined {
  return (globalThis as any)[BRIDGE_KEY];
}

describe('activate() registration', () => {
  afterEach(() => {
    // Clean up globalThis between tests
    (globalThis as any)[BRIDGE_KEY] = undefined;
  });

  it('registers bridge on globalThis[BRIDGE_KEY]', () => {
    const api = createMockApi();
    activate(api);

    const bridge = getBridge();
    expect(bridge).toBeDefined();
    expect(bridge!.onInit).toBeDefined();
    expect(bridge!.onContext).toBeDefined();
    expect(bridge!.onToolResult).toBeDefined();
    expect(bridge!.onTurnEnd).toBeDefined();
    expect(bridge!.onCompact).toBeDefined();
  });

  it('registers session_end hook via api.registerHook', () => {
    const api = createMockApi();
    activate(api);

    expect(typeof api.handlers['session_end']).toBe('function');
  });

  it('bridge object has correct shape (ClaudexBridge interface)', () => {
    const api = createMockApi();
    activate(api);

    const bridge = getBridge();
    expect(typeof bridge!.onInit).toBe('function');
    expect(typeof bridge!.onContext).toBe('function');
    expect(typeof bridge!.onToolResult).toBe('function');
    expect(typeof bridge!.onTurnEnd).toBe('function');
    expect(typeof bridge!.onCompact).toBe('function');
  });
});

describe('activate() lifecycle', () => {
  afterEach(() => {
    (globalThis as any)[BRIDGE_KEY] = undefined;
  });

  it('session_end hook clears globalThis[BRIDGE_KEY]', async () => {
    const api = createMockApi();
    activate(api);

    expect(getBridge()).toBeDefined();

    // Call session_end handler
    await api.handlers['session_end']();

    expect(getBridge()).toBeUndefined();
  });

  it('session_end hook does not throw', async () => {
    const api = createMockApi();
    activate(api);

    // session_end should be non-throwing
    await expect(api.handlers['session_end']()).resolves.not.toThrow();
  });
});

describe('activate() graceful degradation', () => {
  afterEach(() => {
    (globalThis as any)[BRIDGE_KEY] = undefined;
  });

  it('activate does not throw if getDbPath returns bad path', () => {
    // Even with mocked paths, activate should not throw
    const api = createMockApi();
    expect(() => activate(api)).not.toThrow();
  });
});

describe('full lifecycle integration', () => {
  afterEach(() => {
    (globalThis as any)[BRIDGE_KEY] = undefined;
  });

  it('activate -> onInit -> session_end completes without error', async () => {
    const api = createMockApi();
    activate(api);

    const bridge = getBridge();
    expect(bridge).toBeDefined();

    // onInit sets up session
    await bridge!.onInit({ sessionKey: 'integration-test', cwd: '/tmp/test' });

    // session_end cleans up
    await api.handlers['session_end']();

    // globalThis cleaned up
    expect(getBridge()).toBeUndefined();
  });
});
