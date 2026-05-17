/**
 * Codebase Context section formatter for the assembly pipeline.
 *
 * Owns: formatCodebaseContextSection — extracted from assembler.ts:857 (inline
 * render inside assembleRegularPrompt) as part of the Wave 0 sections.ts split.
 *
 * Wave 3 (14-07i) modifies this function to annotate each surfaced file with
 * the retrieval reason (query + score, or a natural-language one-liner).
 *
 * All functions are pure, non-throwing (return null on error), and take
 * pre-fetched data.
 */

import type { SymbolInfo } from '../../indexer/codebase-indexer.js';

export interface CodebaseContextFile {
  file_path: string;
  symbols: SymbolInfo[];
  relevance: number;
}

/**
 * Renders the Codebase Context section given a list of relevant files and a
 * path-shortener function.
 *
 * Extracted from the inline render in assembleRegularPrompt (assembler.ts:857).
 * Signature-preserving extraction: the assembler calls this function with the
 * same data it previously used inline, producing byte-identical output.
 *
 * Per-turn, query-gated. Fires only when relevant files exist.
 * Caller is responsible for the 200-token hard cap check.
 *
 * Returns the section string (never null — caller checks length > 0 before
 * using), or an empty string if no files provided.
 *
 * @param files          Relevant files from findRelevantFiles.
 * @param shortenPath    Path-shortener for cache-stable relative paths.
 */
export function formatCodebaseContextSection(
  files: CodebaseContextFile[],
  shortenPath: (fp: string) => string,
): string {
  if (!files || files.length === 0) return '';

  const codeParts: string[] = ['**Relevant files:**'];
  for (const f of files) {
    const relPath = shortenPath(f.file_path);
    const topSymbols = f.symbols
      .filter(s => s.exported)
      .slice(0, 5)
      .map(s => `${s.kind} ${s.name}`)
      .join(', ');
    codeParts.push(`- \`${relPath}\`: ${topSymbols || '(no exports)'}`);
  }

  return `## Codebase Context\n${codeParts.join('\n')}`;
}
