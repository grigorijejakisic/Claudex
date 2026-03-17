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
const SECRET_PATH_PATTERNS = /(?:^|[\/\\._-])(?:\.env|credentials|secrets?|tokens?|passwords?|private[_-]?keys?)(?:[\/\\._-]|$)/i;

/** Patterns for content that is likely to contain secrets (Bearer tokens, API keys, PEM blocks, etc.). */
export const SECRET_CONTENT_PATTERNS = /(?:Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----|ghp_[A-Za-z0-9]{36}|xox[bpras]-[A-Za-z0-9\-]+)/;

/**
 * Returns true if the file path matches known secret file patterns.
 * Used to prevent secret capture in tool signatures.
 */
function isSecretPath(filePath: string): boolean {
  return SECRET_PATH_PATTERNS.test(filePath);
}

/**
 * Returns true if the content contains patterns that look like secrets.
 * Used to redact tool output before signature storage.
 */
function hasSecretContent(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.test(content);
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
    const safeContent = (filePath && isSecretPath(filePath)) || hasSecretContent(rawContent)
      ? '[REDACTED]'
      : rawContent;

    if (filePath || safeContent) {
      // Hash the content portion to avoid storing raw code/command fragments in signatures
      const contentHash = safeContent
        ? createHash('sha256').update(safeContent).digest('hex').slice(0, 12)
        : '';
      return `${toolName}:${filePath}:${contentHash}`;
    }

    const keys = Object.keys(toolInput).sort().join(',');
    const inputHash = createHash('sha256').update(`${toolName}:${keys}`).digest('hex').slice(0, 12);
    return `${toolName}:shape:${inputHash}`;
  } catch {
    return toolName || '';
  }
}
