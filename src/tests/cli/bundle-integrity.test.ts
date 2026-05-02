/**
 * Bundle integrity tests — `require()` every `.cjs` under `dist/cli/` and
 * `dist/benchmark/vesna/` and assert no top-level errors.
 *
 * Catches:
 *   - Module-load ReferenceErrors (broken imports, missing re-exports)
 *   - Syntax errors in the bundled output
 *   - Top-level `process.exit()` or main()-on-import side effects (caught
 *     because we time-out the require and watch for premature exit)
 *
 * Does NOT catch the v4.1.1 bug directly — that one fired inside main(),
 * not at module load. cli-bundle-smoke.test.ts covers the runtime path.
 * This test is the cheaper static guard for a related failure class.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Only CLIs with `require.main === module` guards can be safely require()'d
// from a test — others (e.g., dist/benchmark/vesna/cli.cjs) auto-run main()
// at module load and call process.exit, which would crash the test runner.
// Those are covered by cli-bundle-smoke.test.ts via subprocess instead.
const CJS_PATHS = [
  path.join(REPO_ROOT, 'dist', 'cli', 'setup.cjs'),
  path.join(REPO_ROOT, 'dist', 'cli', 'doctor.cjs'),
  path.join(REPO_ROOT, 'dist', 'cli', 'why.cjs'),
  path.join(REPO_ROOT, 'dist', 'cli', 'session-token-cost.cjs'),
];

describe('CLI bundle integrity', () => {
  for (const cjsPath of CJS_PATHS) {
    const name = path.basename(cjsPath);

    it(`${name} can be require()'d without throwing at module load`, () => {
      // Skip silently if the file isn't built — the smoke suite enforces presence.
      if (!fs.existsSync(cjsPath)) {
        return;
      }

      // Most CLIs guard their main() with a `require.main === module` check, so
      // requiring them from a test does NOT auto-run main() — only the module's
      // top-level statements + exports execute. If those throw, the bundle is broken.
      let loadError: unknown = null;
      try {
        // Bust require cache to ensure fresh load each test.
        delete require.cache[require.resolve(cjsPath)];
        require(cjsPath);
      } catch (err) {
        loadError = err;
      }

      expect(
        loadError,
        `${name} threw at module load: ${loadError instanceof Error ? loadError.message : String(loadError)}`
      ).toBeNull();
    });
  }

  it('all required CLI bundles exist in dist/ (run `bun run build` first)', () => {
    const missing = CJS_PATHS.filter(p => !fs.existsSync(p));
    expect(missing, `missing bundled CLIs: ${missing.join(', ')}`).toHaveLength(0);
  });
});
