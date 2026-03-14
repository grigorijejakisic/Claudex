/**
 * File system utilities with defensive non-throwing pattern.
 * Atomic writes use tmp+rename with Windows EPERM handling.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';

// Cache homedir at module level — avoids repeated os.homedir() + realpathSync per call.
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
    // Non-throwing: no DB access — mkdir failed, check if dir already exists
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      // Non-throwing: no DB access — dir doesn't exist and can't be created, caller gets false
      return false;
    }
  }
}

/**
 * Atomic file write: writes to tmp file, then renames.
 * On Windows, if rename fails with EPERM, cleans up tmp and fails.
 * Creates parent directories if needed. Returns true on success. Never throws.
 * Synchronous — all I/O is sync, so the function is explicitly sync.
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
      // On EPERM, clean up tmp and fail (no copyFileSync fallback)
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup of temp file
      }
      throw renameErr;
    }

    return true;
  } catch {
    // Non-throwing: no DB access — write failed (disk full, permissions, etc.), caller gets false
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
    // Non-throwing: no DB access — file missing or invalid JSON, caller handles null return
    return null;
  }
}

/**
 * JSON.stringifies with 2-space indent and writes via atomicWriteFile.
 * Returns true on success. Never throws.
 * Synchronous — delegates to sync atomicWriteFile.
 * Callers that `await` the return value will still work.
 */
export function writeJsonFile(filePath: string, data: unknown): boolean {
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    return atomicWriteFile(filePath, content);
  } catch {
    // Non-throwing: no DB access — JSON.stringify failed (circular ref, etc.), caller gets false
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
    // Non-throwing: no DB access — compression or write failed, caller gets false
    return false;
  }
}

/**
 * Validates that a path is safe to read/write.
 * Rejects UNC/device paths and paths outside the user's home directory.
 * Security utility — validates path is within the user's home directory.
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
    // File doesn't exist — resolve parent directory to catch symlink escapes.
    // A symlinked directory under home pointing outside home would pass with the raw path.
    const parent = path.dirname(resolved);
    try {
      const realParent = process.platform === 'win32'
        ? fs.realpathSync.native(parent)
        : fs.realpathSync(parent);
      normalizedResolved = path.join(realParent, path.basename(resolved));
    } catch {
      // Parent also doesn't exist — reject as unsafe
      return false;
    }
  }
  const rel = path.relative(CACHED_HOME, normalizedResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}
