/**
 * composeBody — the single source of truth for legacy-row → artifact payload composition.
 *
 * Invariant: Phase A (pre-embed staging) and Phase B (atomic INSERT) MUST call this
 * function with identical inputs to keep `artifact_embeddings` aligned with the
 * `title + " " + body` text that FTS5 and the cross-encoder reranker see.
 *
 * Pure: no DB access, no filesystem, no clock reads. Safe for worker threads.
 */

import { KIND_MAPPING, type ArtifactKind, type ComposedPayload, type LegacyTable } from './kind-mapping.js';

export type { ArtifactKind, LegacyTable } from './kind-mapping.js';

export interface Composed extends ComposedPayload {}

/**
 * Map artifact kind → legacy table. Reverse of KIND_MAPPING key → value.kind.
 * Used internally; kept as a hand-maintained table because it's tiny and fast.
 */
const KIND_TO_TABLE: Record<ArtifactKind, LegacyTable> = {
  learning: 'learnings',
  decision: 'decisions',
  experience_pattern: 'experience_patterns',
  angel_opinion: 'angel_opinions',
  critical_rule: 'critical_rules',
  mental_model: 'project_curated_context',
};

/**
 * Compose the `{title, body, data, scope, status, confidence, session_id, project_id}`
 * payload for a single legacy row.
 *
 * @param kind   Target artifact kind. Must be one of the 6 P1 kinds.
 * @param row    Legacy row object (shape defined by the corresponding v3 table).
 * @returns      Composed payload. Deterministic — same input always produces same output.
 */
export function composeBody(kind: ArtifactKind, row: Record<string, unknown>): Composed {
  const tbl = KIND_TO_TABLE[kind];
  const mapping = KIND_MAPPING[tbl];
  if (!mapping) {
    throw new Error(`composeBody: unknown kind '${kind}'`);
  }
  return mapping.compose(row);
}
