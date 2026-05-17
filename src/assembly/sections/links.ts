/**
 * Link-related section formatters for the assembly pipeline.
 *
 * This file is a Wave 2/3 landing zone. Wave 0 creates it as a placeholder
 * to eliminate cross-plan collision risk (five plans in Waves 2 and 3 touch
 * sections.ts; with modular files, F/G/J each own their file).
 *
 * Wave 2 will add to this file:
 *   - 14-07f: formatPendingReviewLinksSection — "Inferred Links Pending Review"
 *     section for the Good Child hard-link propose-confirm UX.
 *   - 14-07g: formatProvenanceChainSection — walks links from a checkpoint
 *     decision back to source observations.
 *
 * All functions are pure, non-throwing (return null on error), and take
 * pre-fetched data.
 */

// Wave 2 (14-07f, 14-07g) populates this file.
// Wave 3 (14-07j) may extend the lessons surface but owns lessons.ts, not this file.
