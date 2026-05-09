/**
 * v6 deliberation surfacing — pure formatter.
 *
 * Phase 10 plan 10-02 (ASM-01..03). Consumes a `RoutingResult` from Plan
 * 10-01's `routeFromArtifact(s)` and renders the surfaced transcript spans
 * as labeled citations beneath an advisory-narration header consistent with
 * Phase 7's "When You Recall — Narrate" discipline.
 *
 * Pure: no I/O, no DB, no network. Non-throwing (loadConfig is already
 * non-throwing; no other failure surfaces exist in the formatter).
 *
 * Token budget asymmetry per CONTEXT decision 3:
 *   full token_pct_cap          when the cross-encoder confirmed the spans
 *   bi_encoder_budget_pct ×     when only the bi-encoder produced them
 *     token_pct_cap                (lower-confidence → smaller share)
 *
 * Greedy-packs spans largest-score-first; spans that overflow are dropped
 * silently rather than truncated mid-sentence. The advisory header is
 * suppressed when no spans pack (no empty section header).
 *
 * Opt-in per assembly site via `DeliberationSurfaceOptions.enabled` —
 * sites that don't opt in see no behavior change.
 */

import { estimateTokens } from '../shared/text-utils.js';
import { loadConfig } from '../shared/config.js';
import type { RoutingResult, RoutingSpan } from '../retrieval/transcript-routing.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeliberationSurfaceOptions {
  /** Total assembly token budget — surfaced spans cap at token_pct_cap × this */
  totalAssemblyBudgetTokens: number;
  /** When false, formatter returns null with no other side effects (opt-in) */
  enabled: boolean;
  /** Optional per-span artifact-context labels keyed by chunk_id */
  artifactLabels?: Record<number, string>;
}

export interface DeliberationSurfaceResult {
  /** Rendered section text with advisory header + per-span citations; null if nothing surfaced */
  text: string | null;
  /** Spans actually included after greedy-packing */
  packed: RoutingSpan[];
  /** True if the bi-encoder reduced budget was applied */
  bi_encoder_budget_applied: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render surfaced spans as labeled citations + advisory header. Pure +
 * non-throwing. Returns null when disabled, empty, or every span overflows.
 */
export function formatDeliberationSurface(
  routing: RoutingResult,
  opts: DeliberationSurfaceOptions,
): DeliberationSurfaceResult {
  if (!opts.enabled) {
    return { text: null, packed: [], bi_encoder_budget_applied: false };
  }
  if (!routing || !routing.spans || routing.spans.length === 0) {
    return { text: null, packed: [], bi_encoder_budget_applied: false };
  }

  const cfg = loadConfig().v6.routing;
  const baseBudgetPct = cfg.token_pct_cap / 100;
  const biEncoderMultiplier = cfg.bi_encoder_budget_pct / 100;
  const effectivePct = routing.bi_encoder_only
    ? baseBudgetPct * biEncoderMultiplier
    : baseBudgetPct;
  const budgetTokens = Math.floor(opts.totalAssemblyBudgetTokens * effectivePct);
  const biEncoderBudgetApplied = routing.bi_encoder_only;

  // Pre-render each citation block so we can measure exact token cost.
  const labels = opts.artifactLabels ?? {};
  const candidates = routing.spans.slice(0, cfg.max_k_per_query);
  const rendered = candidates.map((span) => ({
    span,
    text: renderCitationBlock(span, labels[span.chunk_id]),
  }));

  // POLISH-02 — Gemini Assembly Finding #4: pre-deduct header + per-span
  // separator overhead BEFORE the greedy-pack loop runs. The greedy pack must
  // see the *content-available* budget, not the gross cap, so the rendered
  // surface (header + separators + span content) ≤ budgetTokens. Worst-case
  // overhead uses `candidates.length` separators since pre-pack we don't know
  // how many will fit; post-pack actual overhead is ≤ pre-deduct estimate, so
  // the cap is held. We render the header upfront with the worst-case count
  // (candidates.length) so the token estimate matches the actual rendered
  // header within ±1 token (counts are interpolated as digits — same length
  // class for typical N≤20).
  const sessionCountWorst = new Set(candidates.map((c) => c.session_id)).size;
  const headerText = buildAdvisoryHeader(
    candidates.length,
    sessionCountWorst,
    biEncoderBudgetApplied,
  );
  const SEPARATOR = '\n\n';
  const headerTokens = estimateTokens(headerText);
  const separatorTokens = estimateTokens(SEPARATOR);
  const overheadEstimate = headerTokens + separatorTokens * candidates.length;
  const packBudgetTokens = Math.max(0, budgetTokens - overheadEstimate);

  // Greedy-pack: largest-score-first (already sorted by Plan 10-01 contract).
  // Drop overflow silently; continue scanning so smaller low-rank spans can
  // still slot in if they fit.
  const packed: RoutingSpan[] = [];
  const packedTexts: string[] = [];
  let usedTokens = 0;
  for (const r of rendered) {
    const cost = estimateTokens(r.text);
    if (usedTokens + cost > packBudgetTokens) continue;
    packed.push(r.span);
    packedTexts.push(r.text);
    usedTokens += cost;
  }

  if (packed.length === 0) {
    return { text: null, packed: [], bi_encoder_budget_applied: biEncoderBudgetApplied };
  }

  const sessionCount = new Set(packed.map((s) => s.session_id)).size;
  const header = buildAdvisoryHeader(packed.length, sessionCount, biEncoderBudgetApplied);
  const text = `${header}${SEPARATOR}${packedTexts.join(SEPARATOR)}`;

  return { text, packed, bi_encoder_budget_applied: biEncoderBudgetApplied };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-span citation block.
 *
 * Format per CONTEXT § specifics:
 *   "From session {sessionId} turn {turnIndex}, where {label}: {body}"
 *
 * The `, where {label}` clause is omitted when no label is supplied.
 */
function renderCitationBlock(span: RoutingSpan, label: string | undefined): string {
  const labelSuffix = label ? `, where ${label}` : '';
  return `From session ${span.session_id} turn ${span.turn_index}${labelSuffix}: ${span.body}`;
}

/**
 * Build the advisory narration line per CONTEXT § specifics.
 *
 * POLISH-02 — Gemini Assembly Finding #3: when `bi_encoder_budget_applied=true`
 * the locked wording is `## Deliberation Surfaced (low-confidence retrieval)`
 * (see 11-CONTEXT.md § Assembly fallback annotation, line 70). The suffix
 * surfaces the cross-encoder/bi-encoder asymmetry to the consumer LLM so it
 * can calibrate trust in the surfaced spans. Cross-encoder confirmed path
 * keeps the existing `N spans from M sessions` summary header.
 */
function buildAdvisoryHeader(
  spans: number,
  sessions: number,
  biEncoderBudgetApplied: boolean,
): string {
  if (biEncoderBudgetApplied) {
    return '## Deliberation Surfaced (low-confidence retrieval)';
  }
  const spanWord = spans === 1 ? 'span' : 'spans';
  const sessionWord = sessions === 1 ? 'session' : 'sessions';
  return `## Deliberation Surfaced — ${spans} ${spanWord} from ${sessions} ${sessionWord}`;
}
