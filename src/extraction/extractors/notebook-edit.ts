/**
 * NotebookEdit tool extractor — cell, change type.
 * @see Architecture Section 5.2
 */

import { truncateText } from '../../shared/text-utils.js';
import type { ExtractionResult } from './types.js';

/**
 * Extracts observation from a NotebookEdit tool invocation.
 * Title: "NotebookEdit: {cell identifier or change type}". Content: cell changes.
 * Returns null if no meaningful input available.
 */
export function extractNotebookEdit(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): ExtractionResult | null {
  try {
    const cellId = String(input.cell_id ?? input.cellId ?? input.cell ?? '');
    const changeType = String(input.type ?? input.change_type ?? input.action ?? '');
    const notebookPath = String(input.notebook ?? input.file_path ?? input.filePath ?? '');

    const identifier = cellId || changeType;
    if (!identifier) return null;

    const title = truncateText(`NotebookEdit: ${identifier}`, 120);

    const cellContent = String(input.content ?? input.new_content ?? output?.content ?? '');
    const content = truncateText(cellContent || `Cell: ${identifier}`, 2000);

    const filesModified = notebookPath ? [notebookPath] : [];

    return {
      title,
      content,
      files_modified: filesModified,
    };
  } catch {
    return null;
  }
}
