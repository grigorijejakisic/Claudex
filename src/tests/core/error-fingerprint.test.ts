/**
 * Pure fingerprinter unit tests — Phase 2 IDX-01.
 *
 * No DB. Asserts:
 *   - byte-stable determinism across two calls (golden equivalence on the
 *     JSON-stringified output) — proves the fn is referentially transparent.
 *   - looksLikeStackTrace truth-table per CONTEXT discretion.
 *   - outer_exception extraction across canonical traces.
 *   - frame_count correctness.
 *   - shingles structural properties (sorted, deduped, 16-hex chars).
 *   - constants are stable (algorithm_version, shingle_width).
 *   - total-fn contract: 100 random inputs never throw, always return null
 *     or a valid ErrorFingerprint.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computeErrorFingerprint,
  looksLikeStackTrace,
  extractFrames,
  FINGERPRINT_ALGORITHM_VERSION,
  SHINGLE_WIDTH,
} from '../../core/error-fingerprint.js';

const NODE_TRACE = `TypeError: Cannot read property 'foo' of undefined
    at handleRequest (/srv/app/server.js:42:18)
    at processIncomingMessage (/srv/app/server.js:91:12)
    at IncomingMessage.emit (events.js:223:7)
    at addChunk (_stream_readable.js:309:12)
    at readableAddChunk (_stream_readable.js:290:11)`;

const PYTHON_TRACE = `Traceback (most recent call last):
  File "/srv/etl/main.py", line 18, in <module>
    run_pipeline()
  File "/srv/etl/pipeline.py", line 42, in run_pipeline
    extract(ctx)
  File "/srv/etl/extract.py", line 15, in extract
    raise KeyError('missing-token')
KeyError: 'missing-token'`;

const SQLITE_TRACE = `sqlite3.OperationalError: no such table: foo
    at runMigrations (/srv/db.js:200:10)
    at openDatabase (/srv/db.js:42:5)`;

describe('error-fingerprint pure module (IDX-01)', () => {
  describe('determinism', () => {
    it('produces byte-stable output across two calls on the same input', () => {
      const samples = [
        NODE_TRACE,
        PYTHON_TRACE,
        SQLITE_TRACE,
        '',
        'plain log line, no errors',
        'TypeError: short single-line error',
      ];
      for (const s of samples) {
        const a = JSON.stringify(computeErrorFingerprint(s));
        const b = JSON.stringify(computeErrorFingerprint(s));
        expect(a).toBe(b);
      }
    });
  });

  describe('looksLikeStackTrace truth-table', () => {
    it('matches Node-style "at" lines (≥2)', () => {
      expect(looksLikeStackTrace(NODE_TRACE)).toBe(true);
    });
    it('matches Python-style File lines', () => {
      expect(looksLikeStackTrace(PYTHON_TRACE)).toBe(true);
    });
    it('matches a single Traceback header', () => {
      expect(looksLikeStackTrace('Traceback (most recent call last):\n  some line')).toBe(true);
    });
    it('matches a plain TypeError header', () => {
      expect(looksLikeStackTrace('TypeError: foo bar baz')).toBe(true);
    });
    it('does NOT match a single English line', () => {
      expect(looksLikeStackTrace('hello world this is normal log')).toBe(false);
    });
    it('does NOT match a JSON blob', () => {
      expect(looksLikeStackTrace('{"key":"value","n":1}')).toBe(false);
    });
    it('does NOT match an empty string', () => {
      expect(looksLikeStackTrace('')).toBe(false);
    });
  });

  describe('outer_exception extraction', () => {
    it('extracts TypeError', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      expect(fp?.outer_exception).toBe('TypeError');
    });
    it('extracts KeyError', () => {
      const fp = computeErrorFingerprint(PYTHON_TRACE);
      expect(fp?.outer_exception).toBe('KeyError');
    });
    it('extracts dotted sqlite3.OperationalError', () => {
      const fp = computeErrorFingerprint(SQLITE_TRACE);
      expect(fp?.outer_exception).toBe('sqlite3.OperationalError');
    });
    it('returns null outer_exception when only stack frames present (no header)', () => {
      const noHeader = `    at fn1 (file.js:1:1)\n    at fn2 (file.js:2:1)\n    at fn3 (file.js:3:1)`;
      const fp = computeErrorFingerprint(noHeader);
      expect(fp).not.toBeNull();
      expect(fp?.outer_exception).toBeNull();
    });
  });

  describe('frame count', () => {
    it('counts ≥5 frames in a 5-line Node trace', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      expect(fp?.frame_count).toBeGreaterThanOrEqual(5);
    });
    it('counts ≥3 frames in a 3-block Python trace', () => {
      const fp = computeErrorFingerprint(PYTHON_TRACE);
      expect(fp?.frame_count).toBeGreaterThanOrEqual(3);
    });
    it('extractFrames yields {file,line,func} tuples', () => {
      const frames = extractFrames(NODE_TRACE);
      expect(frames.length).toBeGreaterThan(0);
      for (const f of frames) {
        expect(typeof f.file).toBe('string');
        expect(typeof f.line).toBe('string');
        expect(typeof f.func).toBe('string');
      }
    });
  });

  describe('shingle structural properties', () => {
    it('shingles is non-empty array on long-enough error content', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      expect(Array.isArray(fp?.shingles)).toBe(true);
      expect(fp!.shingles.length).toBeGreaterThan(0);
    });
    it('every shingle is a 16-hex-char lowercase string', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      for (const s of fp!.shingles) {
        expect(s).toMatch(/^[0-9a-f]{16}$/);
      }
    });
    it('shingles are sorted lexicographically and deduplicated', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      const sorted = [...fp!.shingles].sort();
      expect(JSON.stringify(fp!.shingles)).toBe(JSON.stringify(sorted));
      expect(new Set(fp!.shingles).size).toBe(fp!.shingles.length);
    });
  });

  describe('constants', () => {
    it('algorithm_version equals FINGERPRINT_ALGORITHM_VERSION (=1)', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      expect(fp?.algorithm_version).toBe(FINGERPRINT_ALGORITHM_VERSION);
      expect(FINGERPRINT_ALGORITHM_VERSION).toBe(1);
    });
    it('shingle_width equals SHINGLE_WIDTH (=5)', () => {
      const fp = computeErrorFingerprint(NODE_TRACE);
      expect(fp?.shingle_width).toBe(SHINGLE_WIDTH);
      expect(SHINGLE_WIDTH).toBe(5);
    });
  });

  describe('total function contract', () => {
    it('100 seeded random strings never throw and always return null-or-valid', () => {
      for (let i = 0; i < 100; i++) {
        const seed = createHash('sha256').update(`fixture-${i}`).digest('hex');
        // Generate a sometimes-trace-shaped, sometimes-pure-noise input
        const input = i % 3 === 0
          ? seed
          : i % 3 === 1
            ? `Error: ${seed}\n    at fn (a.js:${i}:${i})\n    at fn2 (b.js:${i}:${i})`
            : seed.repeat(3);
        const fp = computeErrorFingerprint(input);
        if (fp !== null) {
          expect(fp.algorithm_version).toBe(FINGERPRINT_ALGORITHM_VERSION);
          expect(fp.shingle_width).toBe(SHINGLE_WIDTH);
          expect(Array.isArray(fp.shingles)).toBe(true);
          expect(typeof fp.frame_count).toBe('number');
        }
      }
    });
  });
});
