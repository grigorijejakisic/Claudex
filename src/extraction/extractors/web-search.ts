/**
 * WebSearch tool extractor — query, results.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a WebSearch tool invocation.
 * Title: "WebSearch: {query}". Content: result count + top results summary.
 * Returns null if no query in input.
 */
export function extractWebSearch(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const query = String(input.query ?? '');
    if (!query) return null;

    const title = truncateText(`WebSearch: ${query}`, 120);

    const results = Array.isArray(output?.results) ? output.results : [];
    const resultCount = results.length;

    let content: string;
    if (resultCount > 0) {
      const summaries = results.map((r: unknown, i: number) => {
        if (typeof r === 'object' && r !== null) {
          const rec = r as Record<string, unknown>;
          return `${i + 1}. ${rec.title ?? rec.url ?? 'Result'}`;
        }
        return `${i + 1}. ${String(r)}`;
      });
      content = `${resultCount} results:\n${summaries.join('\n')}`;
    } else {
      content = `Query: ${query}, no results`;
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
