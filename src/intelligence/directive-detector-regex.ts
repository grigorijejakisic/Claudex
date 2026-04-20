/**
 * Directive-detector regex families.
 *
 * Shared between the detector (`directive-detector.ts`) and the fixture-corpus
 * builder (`src/benchmarks/directive-detector/build-candidates.ts`). Keeping
 * them in one place guarantees the precision-harness corpus is filtered with
 * the exact same regex set the runtime detector uses.
 *
 * Family naming is `snake_case`; names are persisted as
 * `artifact.data.regex_family` so tuning downstream (P8) can partition by
 * family of origin.
 *
 * Case-insensitive match at the regex layer; polarity (e.g. "don't always X")
 * is resolved at the LLM confirmation layer per CONTEXT §Area 1.
 */

export interface RegexFamily {
  /** snake_case family tag — persisted in artifact.data.regex_family */
  name: string;
  /** case-insensitive RegExp — tested against stripped user_text */
  re: RegExp;
}

export const DIRECTIVE_REGEX_FAMILIES: readonly RegexFamily[] = [
  { name: 'remember_this_that_to', re: /\bremember\s+(this|that|to)\b/i },
  { name: 'remember_colon',        re: /\bremember:/i },
  { name: 'always_emphasis',       re: /\balways\b/i },
  { name: 'never_emphasis',        re: /\bnever\b/i },
  { name: 'from_now_on',           re: /\bfrom now on\b/i },
  { name: 'next_time',             re: /\bnext time\b/i },
  { name: 'in_the_future',         re: /\bin the future\b/i },
  { name: 'polite_imperative',     re: /\bplease\s+(do|don't|stop|always|never)\b/i },
  { name: 'stop_doing_using',      re: /\bstop\s+(doing|using)\b/i },
  { name: 'negation_dont',         re: /\b(don't|do not)\b/i },
  { name: 'do_x_instead',          re: /\bdo\s+[^.!?\n]+?\s+instead\b/i },
  { name: 'use_x_instead',         re: /\buse\s+[^.!?\n]+?\s+instead\b/i },
];

const FENCED_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_BACKTICK_RE = /`[^`\n]*`/g;

/**
 * Strip fenced code blocks (``` ... ```) and inline single-backtick code
 * (`...`) from a user turn before regex matching. Line breaks outside the
 * stripped ranges are preserved so multi-turn context alignment is unaffected.
 *
 * Per CONTEXT §Area 1: quoted speech (`"user says 'always X'"`) is NOT
 * preemptively stripped — the LLM handles quotation context.
 */
export function stripCodeBlocks(text: string): string {
  if (!text) return '';
  return text.replace(FENCED_BLOCK_RE, '').replace(INLINE_BACKTICK_RE, '');
}

/**
 * Apply every regex family to `stripped` and return the set of matching
 * family names. Empty array means "no families matched."
 */
export function matchFamilies(stripped: string): string[] {
  if (!stripped) return [];
  const hits: string[] = [];
  for (const fam of DIRECTIVE_REGEX_FAMILIES) {
    if (fam.re.test(stripped)) hits.push(fam.name);
  }
  return hits;
}
