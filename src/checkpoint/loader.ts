/**
 * Two-layer checkpoint recovery: DB-first + file fallback + 3-hop chain.
 * Selective loading presets filter fields per Architecture Section 8.5.
 * All public functions are non-throwing.
 * @see Architecture Section 8.4
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as yaml from 'js-yaml';
import { atomicWriteFile } from '../shared/fs-helpers.js';
import { writeCompressedFile } from './writer.js';
import { getCheckpointsDir } from '../shared/paths.js';
import type {
  CheckpointV3,
  CheckpointMeta,
  SelectiveLoadPreset,
} from './types.js';

/** Max compressed size before decompression: 10 MB. */
const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
/** Max decompressed size: 50 MB. */
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * Returns true if the basename is safe (no traversal, not absolute).
 */
function isSafeBasename(name: string): boolean {
  if (!name) return false;
  if (name.includes('..')) return false;
  if (path.isAbsolute(name)) return false;
  return true;
}

/**
 * Validates that a resolved path is within the expected directory.
 */
function isWithinDir(resolvedPath: string, dir: string): boolean {
  const normalizedDir = path.resolve(dir) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);
  return normalizedPath.startsWith(normalizedDir) || normalizedPath === path.resolve(dir);
}

/**
 * Returns true if the file path ends with a compressed extension.
 */
function isCompressedPath(filePath: string): boolean {
  return filePath.endsWith('.yaml.gz') || filePath.endsWith('.yml.gz');
}

/**
 * Reads a checkpoint file, auto-detecting compression by extension.
 * Files ending in .yaml.gz are decompressed via zlib gunzip.
 * Rejects gzip bombs: compressed > 10MB or decompressed > 50MB.
 * Returns parsed YAML content as string, or null on error.
 * Non-throwing.
 */
function readCheckpointFile(filePath: string): string | null {
  try {
    if (isCompressedPath(filePath)) {
      const compressed = fs.readFileSync(filePath);
      // Fix 3: Gzip bomb guard — reject oversized compressed input
      if (compressed.length > MAX_COMPRESSED_BYTES) return null;
      const decompressed = zlib.gunzipSync(compressed);
      // Fix 3: Gzip bomb guard — reject oversized decompressed output
      if (decompressed.length > MAX_DECOMPRESSED_BYTES) return null;
      return decompressed.toString('utf-8');
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * DB recovery at sessionInit: re-mirror committed rows, discard pending rows.
 * Non-throwing — silently skips errors per row.
 */
export async function recoverFromDb(db: Database): Promise<void> {
  try {
    // Re-mirror committed rows
    const committedRows = db
      .prepare(
        `SELECT * FROM checkpoint_meta WHERE status = 'committed'
         ORDER BY created_at_epoch DESC`
      )
      .all() as CheckpointMeta[];

    const mirroredDirs = new Map<string, { basename: string; epoch: number }>();

    for (const row of committedRows) {
      try {
        if (!row.data) continue;

        const checkpoint = JSON.parse(row.data);
        // C11 fix: Validate DB-loaded JSON has required schema fields
        if (!checkpoint || checkpoint.schema !== 'claudex/checkpoint' || !checkpoint.version) continue;
        const mirrorPath = row.mirror_path;

        if (mirrorPath) {
          // C1 fix: Validate mirror_path is within a checkpoints directory
          const resolvedMirror = path.resolve(mirrorPath);
          if (!isSafeBasename(path.basename(resolvedMirror))) continue;
          // Ensure the resolved path is under a 'checkpoints' directory
          const mirrorParent = path.dirname(resolvedMirror);
          if (!mirrorParent.split(path.sep).includes('checkpoints')) continue;

          // Fix 6: Use JSON_SCHEMA for round-trip consistency
          const yamlContent = yaml.dump(checkpoint, { lineWidth: 120, noRefs: true, schema: yaml.JSON_SCHEMA });
          let writeOk: boolean;

          // Fix 1: Use writeCompressedFile for .yaml.gz/.yml.gz paths
          if (isCompressedPath(mirrorPath)) {
            writeOk = await writeCompressedFile(mirrorPath, yamlContent);
          } else {
            writeOk = await atomicWriteFile(mirrorPath, yamlContent);
          }

          if (writeOk) {
            db.prepare(
              `UPDATE checkpoint_meta SET status = 'mirrored', updated_at_epoch = unixepoch()
               WHERE checkpoint_id = ?`
            ).run(row.checkpoint_id);

            // Fix 5: Track newest mirrored row per directory
            const dir = path.dirname(mirrorPath);
            const existing = mirroredDirs.get(dir);
            if (!existing || row.created_at_epoch > existing.epoch) {
              mirroredDirs.set(dir, { basename: path.basename(mirrorPath), epoch: row.created_at_epoch });
            }
          }
        }
      } catch {
        // Skip this row
      }
    }

    // Fix 5: Write per-directory latest.yaml (not just one global)
    for (const [dir, info] of mirroredDirs) {
      try {
        await atomicWriteFile(path.join(dir, 'latest.yaml'), `ref: ${info.basename}\n`);
      } catch {
        // Non-throwing
      }
    }

    // Delete pending rows (incomplete writes)
    db.prepare(`DELETE FROM checkpoint_meta WHERE status = 'pending'`).run();
  } catch {
    // Non-throwing
  }
}

/**
 * File fallback chain: latest.yaml -> dir scan -> null.
 * Non-throwing — returns null on any error.
 */
export function loadFromFile(projectDir: string): CheckpointV3 | null {
  try {
    const checkpointsDir = getCheckpointsDir(projectDir);

    // Step 1: Try latest.yaml
    try {
      const latestPath = path.join(checkpointsDir, 'latest.yaml');
      const latestContent = fs.readFileSync(latestPath, 'utf-8');
      const match = latestContent.match(/ref:\s*(.+)/);
      if (match) {
        const refFile = match[1].trim();
        // Fix 2: Path traversal guard on ref from latest.yaml
        if (isSafeBasename(refFile)) {
          const refPath = path.resolve(checkpointsDir, refFile);
          if (isWithinDir(refPath, checkpointsDir)) {
            const content = readCheckpointFile(refPath);
            if (content) {
              // Fix 6: Use JSON_SCHEMA to prevent type coercion
              const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as CheckpointV3;
              if (parsed && parsed.schema === 'claudex/checkpoint') return parsed;
            }
          }
        }
      }
    } catch {
      // latest.yaml missing or corrupt — fall through
    }

    // Step 2: Directory scan
    try {
      if (!fs.existsSync(checkpointsDir)) return null;

      const files = fs.readdirSync(checkpointsDir)
        .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yaml.gz') || f.endsWith('.yml') || f.endsWith('.yml.gz')) && f !== 'latest.yaml');

      if (files.length === 0) return null;

      // Sort by mtime desc (newest first)
      const withStats = files.map((f) => {
        const fullPath = path.join(checkpointsDir, f);
        const stat = fs.statSync(fullPath);
        return { file: f, mtime: stat.mtimeMs };
      });
      withStats.sort((a, b) => b.mtime - a.mtime);

      for (const { file } of withStats) {
        try {
          const content = readCheckpointFile(path.join(checkpointsDir, file));
          if (!content) continue;
          // Fix 6: Use JSON_SCHEMA to prevent type coercion
          const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
          // R8 fix: Runtime shape validation before cast
          if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).schema === 'claudex/checkpoint' && (parsed as Record<string, unknown>).version) return parsed as CheckpointV3;
        } catch {
          // Invalid YAML — try next
        }
      }
    } catch {
      // Dir scan failed
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Follow previous_checkpoint chain up to maxHops.
 * Uses Set for cycle detection.
 * Non-throwing — returns collected so far on error.
 */
export function followHopChain(
  checkpointsDir: string,
  startBasename: string,
  maxHops: number = 3
): CheckpointV3[] {
  const result: CheckpointV3[] = [];
  const seen = new Set<string>();

  try {
    let current = startBasename;

    for (let i = 0; i < maxHops; i++) {
      if (seen.has(current)) break;
      seen.add(current);

      // Fix 2: Path traversal guard on hop chain basenames
      if (!isSafeBasename(current)) break;
      const resolvedPath = path.resolve(checkpointsDir, current);
      if (!isWithinDir(resolvedPath, checkpointsDir)) break;

      try {
        const content = readCheckpointFile(resolvedPath);
        if (!content) break;
        // Fix 6: Use JSON_SCHEMA to prevent type coercion
        const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as CheckpointV3;
        if (!parsed || parsed.schema !== 'claudex/checkpoint') break;

        result.push(parsed);

        const prev = parsed.meta?.previous_checkpoint;
        if (!prev) break;
        current = prev;
      } catch {
        break;
      }
    }
  } catch {
    // Return collected so far
  }

  return result;
}

/**
 * Apply selective loading preset to strip unwanted fields.
 */
function applyPreset(
  checkpoint: CheckpointV3,
  preset: SelectiveLoadPreset
): CheckpointV3 {
  // Deep clone to avoid mutation
  const cp = JSON.parse(JSON.stringify(checkpoint)) as CheckpointV3;

  switch (preset) {
    case 'ALWAYS':
      cp.decisions = [];
      cp.files = { hot: [], read: [] };
      cp.thread = {
        topic: cp.thread.topic,
        summary: null,
        key_exchanges: [],
      };
      cp.open_items = [];
      cp.learnings = [];
      cp.gsd = null;
      break;

    case 'RESUME':
      cp.gsd = null;
      break;

    case 'GSD':
      // Keep everything
      break;
  }

  return cp;
}

/**
 * Main entry point: two-layer recovery with selective loading.
 * Layer 1: DB-first. Layer 2: File fallback.
 * Non-throwing — returns null if no checkpoint found.
 * @see Architecture Section 8.4
 */
export function loadCheckpoint(
  db: Database | null,
  projectDir: string,
  preset?: SelectiveLoadPreset,
  project?: string
): CheckpointV3 | null {
  try {
    let checkpoint: CheckpointV3 | null = null;

    // Layer 1: DB recovery
    if (db) {
      try {
        let row: CheckpointMeta | undefined;

        if (project) {
          row = db
            .prepare(
              `SELECT cm.* FROM checkpoint_meta cm
               JOIN sessions s ON cm.session_id = s.session_id
               WHERE cm.status IN ('committed', 'mirrored')
                 AND s.project = ?
               ORDER BY cm.created_at_epoch DESC LIMIT 1`
            )
            .get(project) as CheckpointMeta | undefined;
        } else {
          row = db
            .prepare(
              `SELECT * FROM checkpoint_meta
               WHERE status IN ('committed', 'mirrored')
               ORDER BY created_at_epoch DESC LIMIT 1`
            )
            .get() as CheckpointMeta | undefined;
        }

        if (row?.data) {
          const parsed = JSON.parse(row.data);
          // C11 fix: Validate DB-loaded JSON has required schema fields
          if (parsed && parsed.schema === 'claudex/checkpoint' && parsed.version) {

            // If committed but not mirrored: re-mirror (sync path)
            if (row.status === 'committed' && row.mirror_path) {
              try {
                // C1 fix: Validate mirror_path is within checkpoints directory
                const resolvedMirror = path.resolve(row.mirror_path);
                const expectedDir = getCheckpointsDir(projectDir);
                if (!isWithinDir(resolvedMirror, expectedDir)) {
                  throw new Error('mirror_path outside checkpoints directory');
                }
                const dir = path.dirname(resolvedMirror);
                fs.mkdirSync(dir, { recursive: true });
                // Fix 6: Use JSON_SCHEMA for round-trip consistency
                const yamlContent = yaml.dump(parsed, { lineWidth: 120, noRefs: true, schema: yaml.JSON_SCHEMA });
                // Fix 1: Use compression for .yaml.gz/.yml.gz paths
                if (isCompressedPath(row.mirror_path)) {
                  const compressed = zlib.gzipSync(Buffer.from(yamlContent, 'utf-8'));
                  fs.writeFileSync(row.mirror_path, compressed);
                } else {
                  fs.writeFileSync(row.mirror_path, yamlContent, 'utf-8');
                }
                db.prepare(
                  `UPDATE checkpoint_meta SET status = 'mirrored', updated_at_epoch = unixepoch()
                   WHERE checkpoint_id = ?`
                ).run(row.checkpoint_id);
              } catch {
                // File write failed — leave status as committed
              }
            }

            checkpoint = parsed as CheckpointV3;
          }
          // If schema validation failed, checkpoint remains null → falls through to file
        }
      } catch {
        // DB layer failed — fall through to file
      }
    }

    // Layer 2: File fallback
    if (!checkpoint) {
      checkpoint = loadFromFile(projectDir);
    }

    if (!checkpoint) return null;

    // Apply preset if provided
    if (preset) {
      return applyPreset(checkpoint, preset);
    }

    return checkpoint;
  } catch {
    return null;
  }
}
