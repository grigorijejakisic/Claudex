/**
 * Bash tool extractor — command, exit code, output.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Extracts observation from a Bash tool invocation.
 * Title: "Bash: {first 80 chars of command}". Content: stdout/stderr + exit code.
 * ANSI escape codes are stripped to keep FTS search and learnings clean.
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

    const stdout = stripAnsi(String(output?.output ?? output?.stdout ?? ''));
    const stderr = stripAnsi(String(output?.stderr ?? ''));
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
