/**
 * Read tool extractor — file path and structural content.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Read tool invocation.
 * Title: "Read: {basename}". Content: file content up to 500 chars.
 * Returns null if no file_path in input.
 */
export function extractRead(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    if (!filePath) return null;

    const basename = filePath.split(/[/\\]/).pop() ?? filePath;
    const title = truncateText(`Read: ${basename}`, 120);

    const fileObj = output?.file as Record<string, unknown> | undefined;
    const content = truncateText(String(output?.content ?? fileObj?.content ?? ''), CONTENT_MAX_CHARS);

    return {
      title,
      content,
      files_modified: [filePath],
    };
  } catch {
    return null;
  }
}
