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
import { estimateTokens } from '../../shared/text-utils.js';

export interface CodebaseContextFile {
  file_path: string;
  symbols: SymbolInfo[];
  relevance: number;
  // 14-07i: codebase-context annotation — optional retrieval metadata fields.
  // Populated when the file was surfaced via hybrid retrieval (match_query + match_kind).
  // When absent, the formatter falls back to the existing format (path: symbols).
  /** The query string that matched this file, already truncated to ≤200 chars at source. */
  match_query?: string;
  /** Final hybrid score for this candidate, as returned by hybrid retrieval. */
  score?: number;
  /** Which retrieval channel was responsible for this candidate's score. */
  match_kind?: 'fts' | 'vector';
}

/** Max display length for match_query in the annotation line. */
const ANNOTATION_QUERY_DISPLAY_MAX = 50;

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
 * 14-07i: codebase-context annotation — when a file has `match_query` and
 * `score` metadata (populated by hybrid retrieval), a one-line annotation is
 * rendered between the path and the symbol list:
 *   - `<path>` — matched "<truncated_query>" (score <N.NN>, <kind>) — <symbols>
 * When metadata is absent the existing format is used:
 *   - `<path>`: <symbols>
 *
 * @param files          Relevant files from findRelevantFiles.
 * @param shortenPath    Path-shortener for cache-stable relative paths.
 * @param budgetTokens   Optional token budget. When provided, files are added
 *                       greedily until the budget is exhausted. The LAST file
 *                       is dropped (not the annotations) to stay within budget.
 *                       When omitted, all files are rendered (caller enforces cap).
 */
export function formatCodebaseContextSection(
  files: CodebaseContextFile[],
  shortenPath: (fp: string) => string,
  budgetTokens?: number,
): string {
  if (!files || files.length === 0) return '';

  /** Render a single file line (with annotation if metadata present). */
  function renderFileLine(f: CodebaseContextFile): string {
    const relPath = shortenPath(f.file_path);
    const topSymbols = f.symbols
      .filter(s => s.exported)
      .slice(0, 5)
      .map(s => `${s.kind} ${s.name}`)
      .join(', ');
    const symbolsStr = topSymbols || '(no exports)';

    // 14-07i: codebase-context annotation
    // Render annotation when match_query is non-empty and score is present.
    const hasAnnotation =
      typeof f.match_query === 'string' &&
      f.match_query.length > 0 &&
      typeof f.score === 'number';

    if (hasAnnotation) {
      // Truncate query for display (≤50 chars, ellipsize if longer)
      const displayQuery =
        f.match_query!.length > ANNOTATION_QUERY_DISPLAY_MAX
          ? f.match_query!.substring(0, ANNOTATION_QUERY_DISPLAY_MAX) + '…'
          : f.match_query!;
      const scoreStr = f.score!.toFixed(2);
      const kindStr = f.match_kind ?? 'fts';
      return `- \`${relPath}\` — matched "${displayQuery}" (score ${scoreStr}, ${kindStr}) — ${symbolsStr}`;
    }
    return `- \`${relPath}\`: ${symbolsStr}`;
  }

  // 14-07i: budget-aware greedy file selection.
  // When budgetTokens is set, stop adding files once the next file would overflow.
  // AC-10: drop the trailing file, not the annotations.
  const header = '**Relevant files:**';
  const sectionPrefix = '## Codebase Context\n';
  const headerCost = estimateTokens(sectionPrefix + header);

  let fileLines: string[];
  if (budgetTokens !== undefined && budgetTokens > 0) {
    fileLines = [];
    let usedTokens = headerCost;
    for (const f of files) {
      const line = renderFileLine(f);
      const lineCost = estimateTokens('\n' + line);
      if (usedTokens + lineCost > budgetTokens && fileLines.length > 0) break;
      fileLines.push(line);
      usedTokens += lineCost;
    }
  } else {
    fileLines = files.map(renderFileLine);
  }

  if (fileLines.length === 0) return '';

  const codeParts: string[] = [header, ...fileLines];
  return `${sectionPrefix}${codeParts.join('\n')}`;
}
