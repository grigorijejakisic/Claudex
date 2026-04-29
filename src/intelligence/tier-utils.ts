/**
 * Phase 6.5 — shared infrastructure for the Architecture B parallel-tier
 * pattern (Critical Reminders Tier and Experience Tier).
 *
 * Both tiers need the same TTL/decay/jitter/variant-rotation primitives but
 * over different inputs (rules vs episodes/lessons). Extracting the shared
 * primitives here enforces "shared infrastructure, separate scorers" without
 * coupling the two tiers' input schemas.
 *
 * Critical Reminders Tier still wraps these via `shouldInjectRule` for
 * backward compatibility with prior callers.
 */

/** Jitter range per drift_risk tier (Critical Reminders) or salience tier
 *  (Experience). Used as the dispersion window for deterministic jitter. */
export const JITTER_RANGES: Record<string, number> = {
  safety: 2,
  'working-method': 3,
  style: 5,
  experience: 4, // Experience Tier default — between safety and style
};

/**
 * Generic should-inject decision based on TTL + deterministic jitter.
 *
 * No Math.random — jitter is seeded from artifactId + turnNumber so cache
 * stability holds (CACH-02 invariance: identical inputs → identical outputs).
 *
 * Returns true when:
 *   - never injected before, OR
 *   - elapsed turns ≥ effectiveTTL + jitter
 *
 * Where effectiveTTL = currentTtl ?? baseTtl, and jitter ∈ [-range, +range].
 */
export function shouldInjectArtifact(
  artifactId: number,
  lastInjectedTurn: number | null,
  currentTurn: number,
  baseTtl: number,
  currentTtl: number | null,
  jitterKey: keyof typeof JITTER_RANGES = 'working-method',
): boolean {
  if (lastInjectedTurn == null) return true;

  const elapsed = currentTurn - lastInjectedTurn;
  const effectiveTTL = currentTtl ?? baseTtl;
  const jitterRange = JITTER_RANGES[jitterKey] ?? 3;

  // Coprime multiplier 13 against ranges 2/3/4/5 → proper dispersion.
  const jitter = ((artifactId * 13 + currentTurn) % (2 * jitterRange + 1)) - jitterRange;

  return elapsed >= effectiveTTL + jitter;
}

/**
 * Leitner advance: extend TTL on positive evidence (helpful or compliance).
 * Returns the new TTL value: min(currentTtl * 1.5, baseTtl * 3).
 */
export function advanceTTL(currentTtl: number | null, baseTtl: number): number {
  const start = currentTtl ?? baseTtl;
  return Math.min(Math.floor(start * 1.5), baseTtl * 3);
}

/**
 * Leitner reset: shrink TTL back to baseline on negative evidence.
 */
export function resetTTL(baseTtl: number): number {
  return baseTtl;
}

/**
 * Render an observational variant from a template with var substitutions.
 * Variant index is taken modulo variants.length so callers can pass
 * arbitrary monotonically-increasing counters (e.g. injection_count).
 *
 * If `variants` is empty or null, returns the template verbatim.
 */
export function renderObservationalVariant(
  variants: string[] | null,
  variantIndex: number,
  fallback: string,
): string {
  if (!variants || variants.length === 0) return fallback;
  return variants[variantIndex % variants.length] ?? fallback;
}
