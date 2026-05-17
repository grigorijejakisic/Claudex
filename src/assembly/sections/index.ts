/**
 * sections/index.ts — Re-export hub for modular section formatters.
 *
 * Downstream callers that import from 'assembly/sections.js' continue to work
 * because sections.ts re-exports from this file. Wave 2/3 workers can also
 * import directly from their owned sub-file for cleaner file ownership:
 *
 *   import { formatProvenPrinciplesSection } from './sections/lessons.js';
 *   import { formatCodebaseContextSection }  from './sections/codebase-context.js';
 *   import { formatPendingReviewLinksSection } from './sections/links.js';  // Wave 2
 *
 * Do NOT add logic here — this is purely a re-export surface.
 */

export {
  formatProvenPrinciplesSection,
  formatLearningsSection,
  // 14-07j exports:
  formatLessonsWithInlineExpansion,
  inlineExpandLesson,
  readLessonTrigger,
  INLINE_EXPANSION_BUDGET_TOKENS,
  PER_LESSON_BODY_TOKEN_CAP,
} from './lessons.js';

export type {
  LessonsSectionParams,
} from './lessons.js';

export type {
  CodebaseContextFile,
} from './codebase-context.js';

export {
  formatCodebaseContextSection,
} from './codebase-context.js';

// links.ts exports — Wave 2 (14-07f: formatPendingReviewLinksSection; 14-07g: formatProvenanceChainSection):
export { formatPendingReviewLinksSection } from './links.js';
export { formatProvenanceChainSection } from './links.js';

// last-session-synthesis.ts exports — Wave 3 (14-07k):
export { formatLastSessionSynthesisSection } from './last-session-synthesis.js';
export type { FormatLSSParams } from './last-session-synthesis.js';
