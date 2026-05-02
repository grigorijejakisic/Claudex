/**
 * DIAG-06: Claude Code hooks-registration check.
 *
 * Reads ~/.claude/settings.json, walks the `hooks` map, and for each
 * EXPECTED_HOOK_NAMES entry verifies that at least one Claudex command
 * is registered (command string contains 'claudex' case-insensitive,
 * matching setup.ts's own claim-detection in patchSettingsJson).
 */

import * as fs from 'fs';
import type { CheckFn } from './types.js';
import { getSettingsJsonPath, EXPECTED_HOOK_NAMES } from '../cli/setup.js';

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

interface SettingsShape {
  hooks?: Record<string, HookEntry[] | unknown>;
}

export interface CheckHooksOptions {
  settingsPath?: string;
}

export function makeCheckHooks(opts: CheckHooksOptions = {}): CheckFn {
  return async () => {
    const settingsPath = opts.settingsPath ?? getSettingsJsonPath();

    if (!fs.existsSync(settingsPath)) {
      return {
        name: 'CC hooks',
        status: 'fail',
        detail: `${settingsPath} not found`,
        remediation: "Claude Code settings missing. Run 'bun run setup' to register hooks.",
      };
    }

    let parsed: SettingsShape;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsShape;
    } catch (err) {
      return {
        name: 'CC hooks',
        status: 'fail',
        detail: `settings.json malformed: ${(err as Error).message}`,
        remediation: 'Fix or restore ~/.claude/settings.json then run bun run setup.',
      };
    }

    const hooks = (parsed.hooks ?? {}) as Record<string, unknown>;
    const found: string[] = [];
    const missing: string[] = [];

    for (const name of EXPECTED_HOOK_NAMES) {
      const entries = Array.isArray(hooks[name]) ? (hooks[name] as HookEntry[]) : [];
      const hasClaudex = entries.some(
        (entry) =>
          Array.isArray(entry.hooks) &&
          entry.hooks.some(
            (h) => typeof h.command === 'string' && h.command.toLowerCase().includes('claudex'),
          ),
      );
      if (hasClaudex) found.push(name);
      else missing.push(name);
    }

    const expected = EXPECTED_HOOK_NAMES.length;

    if (missing.length === 0) {
      return {
        name: 'CC hooks',
        status: 'pass',
        detail: `${found.length} of ${expected} registered`,
      };
    }

    const missingPreview = missing.slice(0, 3).join(', ');
    const overflow = missing.length > 3 ? `, +${missing.length - 3} more` : '';
    return {
      name: 'CC hooks',
      status: 'fail',
      detail: `${found.length} of ${expected} registered (missing: ${missingPreview}${overflow})`,
      remediation: "Hooks not registered. Run 'bun run setup' to patch ~/.claude/settings.json.",
    };
  };
}

export const checkHooks: CheckFn = makeCheckHooks();
