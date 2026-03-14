/**
 * Capability-aware token utilization gauge.
 * Native SDK path (OpenClaw) or transcript JSONL tail-read (CC).
 * Non-throwing.
 * @see Architecture Section 7.4
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenUsage, RuntimeCapabilities } from '../shared/types.js';
import { detectWindowSize } from './window-detector.js';

// REC-26: Cache homedir at module level — avoids repeated os.homedir() + realpathSync per hook call.
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
 * Validates that a transcript path is safe to read.
 * Rejects UNC/device paths and paths outside the user's home directory.
 * Exported for reuse by infrastructure.ts (REC-06).
 */
export function isPathSafe(transcriptPath: string): boolean {
  const resolved = path.resolve(transcriptPath);
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

export interface GetTokenGaugeParams {
  capabilities: RuntimeCapabilities;
  transcriptPath?: string;
  nativeUsage?: TokenUsage;
  model?: string;
}

/**
 * Returns token usage from the best available source.
 * Path 1: OpenClaw native SDK (zero-cost).
 * Path 2: CC transcript JSONL tail-read.
 * Returns null if neither capability applies or on error.
 */
export function getTokenGauge(params: GetTokenGaugeParams): TokenUsage | null {
  try {
    const { capabilities, transcriptPath, nativeUsage, model } = params;

    // Path 1: OpenClaw native (zero-cost)
    if (capabilities.hasNativeContextUsage && nativeUsage) {
      return nativeUsage;
    }

    // Path 2: CC transcript JSONL tail-read
    if (capabilities.hasTranscriptAccess && transcriptPath) {
      return readTranscriptTail(transcriptPath, model);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Reads the tail ~8KB of a transcript JSONL file and finds the most recent usage entry.
 * @internal
 */
function readTranscriptTail(transcriptPath: string, model?: string): TokenUsage | null {
  try {
    // C9: Validate transcript path — reject UNC, device, and out-of-home paths
    if (!isPathSafe(transcriptPath)) return null;
    const resolved = path.resolve(transcriptPath);

    const fd = fs.openSync(resolved, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      const readSize = Math.min(fileSize, 8192);
      const position = Math.max(0, fileSize - readSize);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      // Iterate in reverse (most recent first)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          const usage = extractUsage(parsed);
          if (usage) {
            const contextWindowTokens = detectWindowSize({
              model,
              observedTokens: usage.inputTokens,
            });
            return {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              contextWindowTokens,
              utilization: usage.inputTokens / contextWindowTokens,
            };
          }
        } catch {
          // Malformed JSON line — skip
        }
      }

      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Extracts input/output tokens from a parsed JSONL entry.
 * Checks message.usage.input_tokens first, then root-level usage.input_tokens.
 * @internal
 */
function extractUsage(
  parsed: Record<string, unknown>
): { inputTokens: number; outputTokens: number } | null {
  // Check message.usage.input_tokens
  const message = parsed.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === 'object' && typeof usage.input_tokens === 'number') {
      return {
        inputTokens: usage.input_tokens as number,
        outputTokens: (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0) as number,
      };
    }
  }

  // Check root-level usage.input_tokens
  const rootUsage = parsed.usage as Record<string, unknown> | undefined;
  if (rootUsage && typeof rootUsage === 'object' && typeof rootUsage.input_tokens === 'number') {
    return {
      inputTokens: rootUsage.input_tokens as number,
      outputTokens: (typeof rootUsage.output_tokens === 'number' ? rootUsage.output_tokens : 0) as number,
    };
  }

  return null;
}
