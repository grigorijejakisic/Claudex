/**
 * Behavioral signal helpers for loop detection in PostToolUse.
 *
 * Extracted from correction-detection.ts to keep that module focused on
 * linguistic correction detection only (O25).
 *
 * All functions are non-throwing with safe defaults.
 */

import { createHash } from 'crypto';

/** Patterns for file paths that are likely to contain secrets. */
const SECRET_PATH_PATTERNS = /\.env|credentials|secret|token|key|password|auth/i;

/**
 * Returns true if the file path matches known secret file patterns.
 * Used to prevent secret capture in tool signatures.
 */
function isSecretPath(filePath: string): boolean {
  return SECRET_PATH_PATTERNS.test(filePath);
}

/**
 * Extracts a short, stable signature from tool input for loop detection.
 * Includes tool name to prevent all tool-less calls colliding on ":".
 * Redacts content from known secret file paths.
 */
export function buildToolSignature(toolName: string, toolInput: Record<string, unknown>): string {
  try {
    const filePath = String(toolInput?.file_path ?? toolInput?.path ?? toolInput?.pattern ?? '');
    const rawContent = String(toolInput?.content ?? toolInput?.command ?? '');

    // Redact content if the file path matches known secret patterns
    const safeContent = filePath && isSecretPath(filePath) ? '[REDACTED]' : rawContent;

    if (filePath || safeContent) {
      // Hash the content portion to avoid storing raw code/command fragments in signatures
      const contentHash = safeContent
        ? createHash('sha256').update(safeContent).digest('hex').slice(0, 12)
        : '';
      return `${toolName}:${filePath}:${contentHash}`;
    }

    return `${toolName}:${JSON.stringify(toolInput).slice(0, 100)}`;
  } catch {
    return toolName || '';
  }
}
