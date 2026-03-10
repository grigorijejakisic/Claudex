/**
 * Task/agent tool extractor — description, result.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
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
    const content = truncateText(result || `Task: ${description}`, 2000);

    return {
      title,
      content,
      files_modified: [],
    };
  } catch {
    return null;
  }
}
