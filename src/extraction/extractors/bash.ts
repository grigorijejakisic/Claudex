/**
 * Bash tool extractor — command, exit code, output.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Bash tool invocation.
 * Title: "Bash: {first 80 chars of command}". Content: stdout/stderr + exit code.
 * Returns null if no command in input.
 */
export function extractBash(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const command = String(input.command ?? '');
    if (!command) return null;

    const title = truncateText(`Bash: ${command}`, 120);

    const stdout = String(output?.output ?? output?.stdout ?? '');
    const stderr = String(output?.stderr ?? '');
    const exitCode = output?.exitCode;

    let content = [stdout, stderr].filter(Boolean).join('\n');
    if (exitCode !== undefined && exitCode !== 0) {
      content = `Exit code: ${exitCode}\n${content}`;
    }
    content = truncateText(content, CONTENT_MAX_CHARS);

    return {
      title,
      content,
      files_modified: [],
    };
  } catch {
    return null;
  }
}
