/**
 * Edit tool extractor — file path and diff summary.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from an Edit tool invocation.
 * Title: "Edit: {basename}". Content: old_string -> new_string diff summary.
 * Returns null if no file_path in input.
 */
export function extractEdit(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    if (!filePath) return null;

    const basename = filePath.split(/[/\\]/).pop() ?? filePath;
    const title = truncateText(`Edit: ${basename}`, 120);

    const oldStr = String(input.old_string ?? input.oldString ?? '');
    const newStr = String(input.new_string ?? input.newString ?? '');

    const diff = `--- old\n${oldStr}\n+++ new\n${newStr}`;
    const content = truncateText(diff, CONTENT_MAX_CHARS);

    return {
      title,
      content,
      files_modified: [filePath],
    };
  } catch {
    return null;
  }
}
