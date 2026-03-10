/**
 * WebFetch tool extractor — URL, status, content.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a WebFetch tool invocation.
 * Title: "WebFetch: {url}". Content: status + content summary.
 * Returns null if no url in input.
 */
export function extractWebFetch(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const url = String(input.url ?? input.URL ?? '');
    if (!url) return null;

    const title = truncateText(`WebFetch: ${url}`, 120);

    const status = output?.status ?? output?.statusCode ?? '';
    const body = String(output?.content ?? output?.body ?? '');
    let content = status ? `Status: ${status}\n${body}` : body;
    content = truncateText(content, 2000);

    return {
      title,
      content,
      files_modified: [],
    };
  } catch {
    return null;
  }
}
