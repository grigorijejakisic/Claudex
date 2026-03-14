/**
 * File system utilities with defensive non-throwing pattern (QUAL-01).
 * Atomic writes use tmp+rename with Windows EPERM fallback (QUAL-05).
 * @see Architecture Section 15.5
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';

// ARCH-001: Cache homedir at module level — avoids repeated os.homedir() + realpathSync per call.
const CACHED_HOME = (() => {
  let home = os.homedir();
  try {
    if (process.platform === 'win32') {
      home = fs.realpathSync.native(home);
    } else {
      home = fs.realpathSync(home);
    }
  } catch {
    // If realpath fails, use the raw homedir
  }
  return home;
})();

/**
 * Synchronous mkdir -p. Returns true if dir exists after call. Never throws.
 */
export function ensureDir(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch {
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * Atomic file write: writes to tmp file, then renames.
 * On Windows, if rename fails with EPERM, cleans up tmp and fails.
 * Creates parent directories if needed. Returns true on success. Never throws.
 * R29: Synchronous — all I/O is sync, so the function is explicitly sync.
 * Callers that `await` the return value will still work (awaiting a non-Promise resolves immediately).
 */
export function atomicWriteFile(filePath: string, content: string): boolean {
  try {
    const dir = path.dirname(filePath);
    ensureDir(dir);

    const suffix = randomBytes(6).toString('hex');
    const tmpPath = `${filePath}.tmp.${suffix}`;

    fs.writeFileSync(tmpPath, content, 'utf-8');

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr: unknown) {
      // C8: Removed unsafe copyFileSync fallback — on EPERM, clean up tmp and fail
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup of temp file
      }
      throw renameErr;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and JSON.parses a file. Returns null on any error. Never throws.
 */
export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * JSON.stringifies with 2-space indent and writes via atomicWriteFile.
 * Returns true on success. Never throws.
 * R29: Synchronous — delegates to sync atomicWriteFile.
 * Callers that `await` the return value will still work.
 */
export function writeJsonFile(filePath: string, data: unknown): boolean {
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    return atomicWriteFile(filePath, content);
  } catch {
    return false;
  }
}

/**
 * Writes a file with zlib gzip compression.
 * Creates parent directories if needed. Returns true on success. Never throws.
 */
export async function writeCompressedFile(filePath: string, content: string): Promise<boolean> {
  try {
    const dir = path.dirname(filePath);
    ensureDir(dir);

    const compressed = zlib.gzipSync(Buffer.from(content, 'utf-8'));
    fs.writeFileSync(filePath, compressed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that a path is safe to read/write.
 * Rejects UNC/device paths and paths outside the user's home directory.
 * ARCH-001: Moved from token-gauge.ts — this is a security utility, not a gauge concern.
 */
export function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  // Reject UNC paths (\\server\share or //server/share)
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return false;
  // Reject Windows device paths (\\.\ or \\?\)
  if (resolved.startsWith('\\\\.\\') || resolved.startsWith('\\\\?\\')) return false;
  // Must end with .jsonl
  if (!resolved.endsWith('.jsonl')) return false;
  // Must be under user's home directory
  // Use realpathSync on ALL platforms to resolve symlinks that could point outside home.
  // On Windows, use realpathSync.native to also resolve 8.3 short names (e.g. GRIGOR~1).
  let normalizedResolved = resolved;
  try {
    if (process.platform === 'win32') {
      normalizedResolved = fs.realpathSync.native(resolved);
    } else {
      normalizedResolved = fs.realpathSync(resolved);
    }
  } catch {
    // If file doesn't exist yet or realpath fails, use the resolved path as-is
  }
  const rel = path.relative(CACHED_HOME, normalizedResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}
