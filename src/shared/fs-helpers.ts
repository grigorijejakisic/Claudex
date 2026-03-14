/**
 * File system utilities with defensive non-throwing pattern (QUAL-01).
 * Atomic writes use tmp+rename with Windows EPERM fallback (QUAL-05).
 * @see Architecture Section 15.5
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

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
