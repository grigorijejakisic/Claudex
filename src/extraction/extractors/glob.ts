/**
 * Glob tool extractor — pattern and matched files.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Glob tool invocation.
 * Title: "Glob: {pattern} ({fileCount} files)". Content: matched file list.
 * Returns null if no pattern in input.
 */
export function extractGlob(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const pattern = String(input.pattern ?? '');
    if (!pattern) return null;

    const files = Array.isArray(output?.files) ? output.files as string[] : [];
    const fileCount = files.length;

    const title = truncateText(`Glob: ${pattern} (${fileCount} files)`, 120);
    const content = truncateText(
      files.length > 0 ? files.join('\n') : `Pattern: ${pattern}, no files matched`,
      CONTENT_MAX_CHARS
    );

    return {
      title,
      content,
      files_modified: [],
    };
  } catch {
    return null;
  }
}
