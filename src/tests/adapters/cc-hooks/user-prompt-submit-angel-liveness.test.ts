/**
 * Plan 04-06-03 — hook-driven Angel liveness.
 *
 * Verifies that user-prompt-submit.ts imports `ensureAngelRunning` from the
 * standalone angel-launcher module (not from session-start.ts). This is the
 * design constraint that keeps the SessionStart hook's top-level `main()`
 * from re-firing on every user turn.
 *
 * The structural test is lightweight: we read the hook source file and grep
 * for the import path. A behavioral test would spawn the compiled hook with
 * stdin payload and inspect stdout — but that's already covered by the build
 * smoke test (build.ts runs every hook with a smoke payload and asserts
 * stdout is valid JSON; the whole reason this plan separated the module was
 * because the naive session-start import doubled the smoke output).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HOOK_SOURCE = path.resolve(
  __dirname, '..', '..', '..', 'adapters', 'cc-hooks', 'user-prompt-submit.ts',
);

describe('user-prompt-submit — plan 04-06-03 hook-driven Angel liveness', () => {
  it('imports ensureAngelRunning from angel-launcher, not session-start', () => {
    const body = fs.readFileSync(HOOK_SOURCE, 'utf-8');
    expect(body).toMatch(/from '\.\/angel-launcher\.js'/);
    expect(body).not.toMatch(/ensureAngelRunning.*from '\.\/session-start\.js'/);
  });

  it('calls ensureAngelRunning with isUserTurn=true early in the handler', () => {
    const body = fs.readFileSync(HOOK_SOURCE, 'utf-8');
    // Must appear after the CC_INTERNAL early-exit (so we skip on tasknotification)
    // and before the intent-classification block (so the check is cheap even on
    // paths that do heavy assembly work later).
    const internalIdx = body.indexOf("CC_INTERNAL_RE.test(prompt)");
    const ensureIdx = body.indexOf("ensureAngelRunning(");
    // First *usage* of classifyIntent (not the import line) so we assert
    // position relative to runtime code, not module header order.
    const intentIdx = body.indexOf("= classifyIntent(");
    expect(internalIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(internalIdx);
    expect(ensureIdx).toBeLessThan(intentIdx);
    // isUserTurn flag is true so respawn events carry the hook-driven label.
    expect(body).toMatch(/ensureAngelRunning\(ctx\.db, input\.session_id, ctx\.project, [^)]*true\)/);
  });
});
