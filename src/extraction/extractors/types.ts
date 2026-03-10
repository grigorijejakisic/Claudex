/**
 * Shared types for per-tool extractors.
 * @see Architecture Section 5.2 — per-tool extractors
 */

/** Result produced by a per-tool extractor. */
export interface ExtractionResult {
  /** {toolName}: {key_detail}, max 120 chars */
  title: string;
  /** Meaningful extracted output, max 2000 chars */
  content: string;
  /** Affected file paths */
  files_modified: string[];
}

/** Extractor function signature shared by all per-tool extractors. */
export type ExtractorFn = (
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
) => ExtractionResult | null;
