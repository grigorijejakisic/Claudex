/**
 * Grep tool extractor — pattern, matches, files.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Grep tool invocation.
 * Title: "Grep: {pattern} ({matchCount} matches)". Content: file list + match counts.
 * Returns null if no pattern in input.
 */
export function extractGrep(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const pattern = String(input.pattern ?? '');
    if (!pattern) return null;

    const matchCount = Number(output?.matchCount ?? output?.numFiles ?? 0);
    const title = truncateText(`Grep: ${pattern} (${matchCount} matches)`, 120);

    const rawFiles = output?.files ?? output?.filenames;
    const files = Array.isArray(rawFiles) ? rawFiles as string[] : [];
    const matches = output?.matches;

    let content: string;
    if (typeof matches === 'string') {
      content = matches;
    } else if (Array.isArray(matches)) {
      content = matches.map(String).join('\n');
    } else if (files.length > 0) {
      content = `Matched files:\n${files.join('\n')}`;
    } else {
      content = `Pattern: ${pattern}, ${matchCount} matches`;
    }
    content = truncateText(content, CONTENT_MAX_CHARS);

    return {
      title,
      content,
      files_modified: files,
    };
  } catch {
    return null;
  }
}
