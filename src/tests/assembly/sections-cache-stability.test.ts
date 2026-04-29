import { describe, it, expect } from 'vitest';
import { _shortenPathCacheStable, type FullAssemblyParams } from '../../assembly/assembler.js';
import { getSessionAttribution } from '../../assembly/sections.js';

describe('CACH-03 hardening', () => {
  describe('shortenPath normalization (assembler.ts:646)', () => {
    it('normalizes Windows-style backslash paths to forward slashes', () => {
      expect(_shortenPathCacheStable('C:\\Users\\foo\\src\\bar.ts')).toBe('src/bar.ts');
    });

    it('preserves POSIX paths starting at src/', () => {
      expect(_shortenPathCacheStable('/home/foo/src/bar.ts')).toBe('src/bar.ts');
    });

    it('falls back to basename concat when no src/ segment is present', () => {
      expect(_shortenPathCacheStable('/home/foo/lib/baz.ts')).toBe('lib/baz.ts');
      expect(_shortenPathCacheStable('C:\\proj\\lib\\baz.ts')).toBe('lib/baz.ts');
    });

    it('produces byte-identical output across host-style inputs', () => {
      const win = _shortenPathCacheStable('C:\\Users\\foo\\src\\bar.ts');
      const posix = _shortenPathCacheStable('/home/foo/src/bar.ts');
      expect(win).toBe(posix);
    });
  });

  describe('getSessionAttribution omits session UUID slice (sections.ts:861)', () => {
    it('returns "unknown session" for null artifactSessionId', () => {
      expect(getSessionAttribution(null)).toBe('unknown session');
    });

    it('returns "current session" when artifactSessionId === currentSessionId', () => {
      expect(getSessionAttribution('abcdefgh-ffff-0000-0000-000000000000', 'abcdefgh-ffff-0000-0000-000000000000'))
        .toBe('current session');
    });

    it('returns "prior session" without leaking UUID slice', () => {
      const out = getSessionAttribution('abcdefgh-1234-5678-9012-cafebabedead', 'zzzzzzzz-0000-0000-0000-000000000000');
      expect(out).toBe('prior session');
      expect(out).not.toMatch(/[0-9a-f]{8}/i);
      expect(out).not.toContain('abcdefgh');
    });

    it('returns byte-identical output for two distinct prior session IDs (cache stability)', () => {
      const a = getSessionAttribution('aaaaaaaa-1111-1111-1111-111111111111');
      const b = getSessionAttribution('bbbbbbbb-2222-2222-2222-222222222222');
      expect(a).toBe(b);
    });
  });

  describe('FullAssemblyParams.nowEpoch is pinnable (assembler.ts:572,:657)', () => {
    it('exposes optional nowEpoch field', () => {
      // Type-level assertion; if the field is removed the build fails.
      const params: Partial<FullAssemblyParams> = { nowEpoch: 1700000000 };
      expect(params.nowEpoch).toBe(1700000000);
    });
  });
});
