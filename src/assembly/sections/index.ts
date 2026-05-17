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
} from './lessons.js';

export type {
  CodebaseContextFile,
} from './codebase-context.js';

export {
  formatCodebaseContextSection,
} from './codebase-context.js';

// links.ts exports added by Wave 2 (14-07f, 14-07g):
// export { formatPendingReviewLinksSection } from './links.js';  // 14-07f adds this
export { formatProvenanceChainSection } from './links.js';
