/**
 * Read tool extractor — file path and structural content.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Read tool invocation.
 * Title: "Read: {basename}". Content: file content up to 2000 chars.
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

    const content = truncateText(String(output?.content ?? ''), 2000);

    return {
      title,
      content,
      files_modified: [filePath],
    };
  } catch {
    return null;
  }
}
