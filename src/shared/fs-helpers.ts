/**
 * Shared filesystem helpers — atomic writes, JSON read/write with fallbacks.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Atomic write: tmp in same dir, rename, fallback copy+unlink on Windows EPERM */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  await fs.promises.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });

  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM' || code === 'EEXIST') {
      await fs.promises.copyFile(tmp, filePath);
      await fs.promises.chmod(filePath, 0o600).catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      return;
    }
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Read JSON with fallback on missing/corrupt file */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON with restrictive permissions */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
