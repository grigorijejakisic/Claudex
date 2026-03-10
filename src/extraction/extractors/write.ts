/**
 * Write tool extractor — file path and content summary.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Write tool invocation.
 * Title: "Write: {basename}". Content: first 2000 chars of written content.
 * Returns null if no file_path in input.
 */
export function extractWrite(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    if (!filePath) return null;

    const basename = filePath.split(/[/\\]/).pop() ?? filePath;
    const title = truncateText(`Write: ${basename}`, 120);

    const content = truncateText(String(input.content ?? ''), 2000);

    return {
      title,
      content,
      files_modified: [filePath],
    };
  } catch {
    return null;
  }
}
