/**
 * Task/agent tool extractor — description, result.
 */

import { truncateText } from '../../shared/text-utils.js';
import { CONTENT_MAX_CHARS } from '../../shared/constants.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a Task tool invocation.
 * Title: "Task: {agent description or task name}". Content: task result/output.
 * Returns null if no description/name available.
 */
export function extractTask(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const description = String(
      input.description ?? input.task ?? input.name ?? ''
    );
    if (!description) return null;

    const title = truncateText(`Task: ${description}`, 120);

    const result = String(output?.result ?? output?.output ?? '');
    const content = truncateText(result || `Task: ${description}`, CONTENT_MAX_CHARS);

    return {
      title,
      content,
      files_modified: [],
    };
  } catch {
    return null;
  }
}
