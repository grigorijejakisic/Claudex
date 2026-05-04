/**
 * Wrapper-block parser — single source of truth for splitting an injected
 * user prompt into its organic + injected components.
 *
 * Phase 1 (v5) substrate, Plan 01-02 (EPI-04). The provenance row attribute
 * in `episodic_events` is enforced by parsing every UserPromptSubmit prompt
 * through this function exactly once: organic content goes to the
 * `provenance='organic'` row, each wrapper block becomes a sibling
 * `provenance='injected'` row tied via `parent_event_id`.
 *
 * KNOWN_WRAPPER_TAGS is the locked set for v5.0 — Phase 2/3 will surface
 * additional modality types via `metadata_json`, NOT by enlarging this list.
 */

export interface WrapperBlock {
  /** Tag name (lowercased to match the regex's case-insensitive flag). */
  tag: string;
  /** Inner text between the opening and closing tags. */
  content: string;
  /** Raw attribute string from the opening tag (e.g. `path="x.ts"`), or undefined. */
  attributes?: string;
}

export interface ParsedWrappers {
  /** Original text with all wrapper blocks removed AND trimmed. */
  organic: string;
  /** One block per wrapper found, in document order. */
  injected: WrapperBlock[];
}

/**
 * The locked wrapper-tag set for Phase 1. Adding a tag here is a substrate
 * change — Phases 2/3 surface new modalities via metadata_json on existing
 * provenance values, not by widening this enum.
 */
export const KNOWN_WRAPPER_TAGS = [
  'task-notification',
  'system-reminder',
  'experience-data',
  'local-command-caveat',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'file-content',
] as const;

/**
 * Build the parser regex from KNOWN_WRAPPER_TAGS. The pattern matches an
 * opening tag (with optional attributes), captures the inner content
 * non-greedily, and matches the matching closing tag. Case-insensitive +
 * dotall via [\s\S]*? — same flags as the existing strip regex at
 * `src/adapters/cc-hooks/user-prompt-submit.ts:266` (replaced by this module).
 */
const TAGS_ALT = KNOWN_WRAPPER_TAGS.join('|');
const WRAPPER_REGEX = new RegExp(
  `<(${TAGS_ALT})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
  'gi',
);

/**
 * Split an input string into organic + injected wrapper blocks.
 *
 * Empty input returns `{ organic: '', injected: [] }`. Input with no
 * wrappers returns `{ organic: text.trim(), injected: [] }`. Multiple
 * wrappers (including duplicates of the same tag) are returned in document
 * order. Attribute strings are captured verbatim (without the leading
 * whitespace and without the closing `>`).
 */
export function parseWrappers(text: string): ParsedWrappers {
  if (!text) return { organic: '', injected: [] };

  const injected: WrapperBlock[] = [];
  // Build the stripped text by walking matches and copying intervening
  // organic spans. Avoids the second pass `.replace()` would do.
  const fresh = new RegExp(WRAPPER_REGEX.source, WRAPPER_REGEX.flags);
  let lastIndex = 0;
  let strippedParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fresh.exec(text)) !== null) {
    if (match.index > lastIndex) {
      strippedParts.push(text.slice(lastIndex, match.index));
    }
    const tag = match[1].toLowerCase();
    const attrsRaw = match[2] ? match[2].trim() : undefined;
    const content = match[3] ?? '';
    injected.push({
      tag,
      content,
      ...(attrsRaw ? { attributes: attrsRaw } : {}),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    strippedParts.push(text.slice(lastIndex));
  }

  const organic = (strippedParts.length > 0 ? strippedParts.join('') : text).trim();
  return { organic, injected };
}
