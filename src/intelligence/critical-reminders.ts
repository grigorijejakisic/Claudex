/**
 * Critical Reminders Tier — anti-drift behavioral rule re-injection.
 *
 * Re-injects distilled CLAUDE.md behavioral rules into context at strategic
 * moments (TTL expiry, activity gates, first-encounter domains) to prevent
 * instruction drift in long conversations.
 *
 * Key design:
 *   - Deterministic jitter: (rule.id * 7 + turnNumber) % range — no Math.random
 *   - Deferred applyEffects pattern (same as renderExperienceWarnings)
 *   - Budget: scaleBudget(300, contextWindowTokens) hard cap
 *   - Phrasing variants stored as JSON column, rotated deterministically
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { estimateTokens } from '../shared/text-utils.js';
import { scaleBudget } from '../shared/constants.js';
import { getExperienceFlags, setExperienceFlags } from './experience-flags.js';
import { getWeakDomains, generateDomainAdvisory } from './capability-tracker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CriticalRule {
  id: number;
  project: string;
  rule_text: string;
  variants: string | null;
  source: 'author' | 'system-promoted';
  drift_risk: 'safety' | 'working-method' | 'style';
  domain_tags: string | null; // JSON array
  base_ttl: number;
  current_ttl: number | null;
  last_injected_turn: number | null;
  injection_count: number;
  violation_count: number;
  compliance_count: number;
}

export interface CriticalRemindersResult {
  section: string;
  tokenCost: number;
  injectedRuleIds: number[];
  applyEffects: () => void;
}

export interface ParsedCriticalRule {
  rule_text: string;
  drift_risk: 'safety' | 'working-method' | 'style';
  domain_tags: string[];
  base_ttl: number;
}

// ---------------------------------------------------------------------------
// WU4: Decay Engine (TTL + Jitter)
// ---------------------------------------------------------------------------

/** Jitter range per drift_risk tier. */
const JITTER_RANGES: Record<string, number> = {
  safety: 2,
  'working-method': 3,
  style: 5,
};

/**
 * Determines whether a rule should be injected based on TTL + deterministic jitter.
 * No Math.random — jitter is seeded from rule.id + turnNumber for reproducibility.
 */
export function shouldInjectRule(
  rule: CriticalRule,
  turnNumber: number,
): boolean {
  if (rule.last_injected_turn == null) return true; // never injected

  const elapsed = turnNumber - rule.last_injected_turn;
  const effectiveTTL = rule.current_ttl ?? rule.base_ttl;
  const jitterRange = JITTER_RANGES[rule.drift_risk] ?? 3;

  // Deterministic jitter: (rule.id * 13 + turnNumber) % (2 * jitterRange + 1) - jitterRange
  // Uses 13 as multiplier (coprime to all moduli: 5, 7, 11) for proper dispersion.
  const jitter = ((rule.id * 13 + turnNumber) % (2 * jitterRange + 1)) - jitterRange;

  return elapsed >= effectiveTTL + jitter;
}

/**
 * Leitner advance: extend TTL on compliance evidence.
 * current_ttl = min(current_ttl * 1.5, base_ttl * 3), compliance_count++
 */
export function advanceTTL(db: Database, ruleId: number): void {
  try {
    cachedPrepare(db,
      `UPDATE critical_rules
       SET current_ttl = MIN(CAST(COALESCE(current_ttl, base_ttl) * 1.5 AS INTEGER), base_ttl * 3),
           compliance_count = compliance_count + 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(ruleId);
  } catch { /* non-fatal */ }
}

/**
 * Leitner reset: reset TTL on violation evidence.
 * current_ttl = base_ttl, violation_count++
 */
export function resetTTL(db: Database, ruleId: number): void {
  try {
    cachedPrepare(db,
      `UPDATE critical_rules
       SET current_ttl = base_ttl,
           violation_count = violation_count + 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(ruleId);
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// WU6: Phrasing Variation Renderer
// ---------------------------------------------------------------------------

/**
 * Selects a phrasing variant for a rule based on injection count.
 * Pure deterministic rotation — no LLM call.
 */
export function renderRuleVariant(rule: CriticalRule, injectionCount: number): string {
  if (!rule.variants) return rule.rule_text;
  try {
    const variants = JSON.parse(rule.variants) as string[];
    if (!Array.isArray(variants) || variants.length === 0) return rule.rule_text;
    return variants[injectionCount % variants.length];
  } catch {
    return rule.rule_text;
  }
}

// ---------------------------------------------------------------------------
// WU2: CLAUDE.md Marker Parser
// ---------------------------------------------------------------------------

const SAFETY_KEYWORDS = /\b(never|deadlock|scope|verify|safety)\b/i;
const METHOD_KEYWORDS = /\b(systematic|analysis|method|read|before)\b/i;
const DOMAIN_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  { re: /\b(bash|command|shell)\b/i, tag: 'bash' },
  { re: /\b(git|commit|push)\b/i, tag: 'git' },
  { re: /\b(file|edit|modify)\b/i, tag: 'multi-file' },
  { re: /\b(team|agent|spawn)\b/i, tag: 'team' },
];

/**
 * Parses `<!-- critical -->` or `<!-- critical: key=val, ... -->` markers from CLAUDE.md content.
 * The marker applies to the NEXT non-empty line (numbered list item or bullet).
 * Extended format: `<!-- critical: drift-risk=safety, domains=multi-file,git,team -->`
 */
export function parseCriticalMarkers(content: string): ParsedCriticalRule[] {
  const lines = content.split('\n');
  const results: ParsedCriticalRule[] = [];
  let pendingCritical: { driftRisk?: string; domains?: string[] } | null = null;

  for (const line of lines) {
    const markerMatch = line.match(/<!--\s*critical(?::([^>]*))?\s*-->/);
    if (markerMatch) {
      const meta: { driftRisk?: string; domains?: string[] } = {};
      if (markerMatch[1]) {
        const pairs = markerMatch[1].split(',').map(s => s.trim());
        for (const pair of pairs) {
          const [key, val] = pair.split('=').map(s => s.trim());
          if (key === 'drift-risk' && val) meta.driftRisk = val;
          if (key === 'domains' && val) meta.domains = val.split(',').map(s => s.trim());
        }
      }
      pendingCritical = meta;
      continue;
    }

    if (pendingCritical && line.trim().length > 0) {
      // Strip markdown list prefix (-, *, 1., etc.)
      const ruleText = line.trim().replace(/^[-*]\s+|^\d+\.\s+/, '');

      // Use marker metadata if provided, otherwise auto-detect
      let driftRisk: ParsedCriticalRule['drift_risk'] = 'style';
      let baseTtl = 20;

      if (pendingCritical.driftRisk === 'safety' || (!pendingCritical.driftRisk && SAFETY_KEYWORDS.test(ruleText))) {
        driftRisk = 'safety';
        baseTtl = 6;
      } else if (pendingCritical.driftRisk === 'working-method' || (!pendingCritical.driftRisk && METHOD_KEYWORDS.test(ruleText))) {
        driftRisk = 'working-method';
        baseTtl = 10;
      }

      // Use marker domains if provided, otherwise auto-detect
      const domainTags: string[] = pendingCritical.domains ?? [];
      if (domainTags.length === 0) {
        for (const { re, tag } of DOMAIN_PATTERNS) {
          if (re.test(ruleText)) domainTags.push(tag);
        }
      }

      results.push({ rule_text: ruleText, drift_risk: driftRisk, domain_tags: domainTags, base_ttl: baseTtl });
      pendingCritical = null;
    }
  }

  return results;
}

/**
 * Seeds critical rules from CLAUDE.md markers at session start.
 * Reads global + project CLAUDE.md, parses markers, upserts into critical_rules.
 */
export function seedCriticalRules(db: Database, project: string, projectDir: string): void {
  const claudeMdPaths = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(projectDir, 'CLAUDE.md'),
  ];

  for (const mdPath of claudeMdPaths) {
    try {
      if (!fs.existsSync(mdPath)) continue;
      const content = fs.readFileSync(mdPath, 'utf-8');
      const rules = parseCriticalMarkers(content);

      for (const rule of rules) {
        cachedPrepare(db,
          `INSERT INTO critical_rules (project, rule_text, source, drift_risk, domain_tags, base_ttl)
           VALUES (?, ?, 'author', ?, ?, ?)
           ON CONFLICT (project, rule_text) DO UPDATE SET
             drift_risk = excluded.drift_risk,
             domain_tags = excluded.domain_tags,
             base_ttl = excluded.base_ttl,
             updated_at = datetime('now')`
        ).run(
          project,
          rule.rule_text,
          rule.drift_risk,
          rule.domain_tags.length > 0 ? JSON.stringify(rule.domain_tags) : null,
          rule.base_ttl,
        );
      }
    } catch { /* non-fatal per file */ }
  }

  // Ensure unique constraint exists for upsert — add it idempotently
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_critical_rules_dedup ON critical_rules(project, rule_text)');
  } catch { /* non-fatal — may already exist */ }
}

// ---------------------------------------------------------------------------
// WU3: System Promotion Bridge
// ---------------------------------------------------------------------------

/**
 * Auto-promotes weak domains from capability_tracker into critical_rules.
 * Demotes rules whose correction_rate has dropped below 15%.
 * Cap: max 10 system-promoted rules per project.
 */
export function promoteFromCapabilityTracker(db: Database, project: string): void {
  try {
    const weakDomains = getWeakDomains(db, project, 0.3, 5);

    // Count existing system-promoted rules
    const countRow = cachedPrepare(db,
      `SELECT COUNT(*) as cnt FROM critical_rules WHERE project = ? AND source = 'system-promoted'`
    ).get(project) as { cnt: number } | undefined;
    let systemCount = countRow?.cnt ?? 0;

    for (const domain of weakDomains) {
      if (systemCount >= 10) break;

      // Check if already promoted
      const exists = cachedPrepare(db,
        `SELECT 1 FROM critical_rules WHERE project = ? AND source = 'system-promoted' AND domain_tags LIKE ?`
      ).get(project, `%"${domain.domain}"%`);
      if (exists) continue;

      // Generate advisory text
      const advisory = generateDomainAdvisory(db, project, domain.domain);
      if (!advisory) continue;

      cachedPrepare(db,
        `INSERT INTO critical_rules (project, rule_text, source, drift_risk, domain_tags, base_ttl)
         VALUES (?, ?, 'system-promoted', 'working-method', ?, 8)`
      ).run(project, advisory, JSON.stringify([domain.domain]));
      systemCount++;
    }

    // Demotion check: remove system-promoted rules where correction_rate < 15%
    const promoted = cachedPrepare(db,
      `SELECT id, domain_tags FROM critical_rules WHERE project = ? AND source = 'system-promoted'`
    ).all(project) as Array<{ id: number; domain_tags: string | null }>;

    for (const rule of promoted) {
      if (!rule.domain_tags) continue;
      try {
        const tags = JSON.parse(rule.domain_tags) as string[];
        if (tags.length === 0) continue;
        const domainName = tags[0];

        const boundary = cachedPrepare(db,
          `SELECT total_interactions, corrections FROM capability_boundaries
           WHERE project = ? AND domain = ?`
        ).get(project, domainName) as { total_interactions: number; corrections: number } | undefined;

        if (boundary && boundary.total_interactions >= 5) {
          const rate = boundary.corrections / boundary.total_interactions;
          if (rate < 0.15) {
            cachedPrepare(db, 'DELETE FROM critical_rules WHERE id = ?').run(rule.id);
          }
        }
      } catch { /* non-fatal per rule */ }
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// WU5: Tool-to-Domain Mapping
// ---------------------------------------------------------------------------

/**
 * Maps a tool name to a rule domain for first-encounter gating.
 */
export function mapToolToDomain(toolName: string): string | null {
  const lower = toolName.toLowerCase();
  if (lower === 'bash') return 'bash';
  if (lower === 'edit' || lower === 'write') return 'multi-file';
  if (lower === 'read' || lower === 'glob' || lower === 'grep') return 'read';
  if (lower === 'task' || lower === 'agent') return 'team';
  return null;
}

// ---------------------------------------------------------------------------
// WU7: assembleCriticalReminders + Scoring
// ---------------------------------------------------------------------------

/**
 * Assembles the critical reminders section for injection into context.
 * Scores rules against current state, selects top 5, renders with variation,
 * caps at scaleBudget(300, contextWindowTokens) tokens.
 *
 * Returns null if no rules qualified. Side effects deferred to applyEffects().
 */
export function assembleCriticalReminders(
  db: Database,
  sessionId: string,
  turnNumber: number,
  project: string,
  activityGate: boolean,
  seenDomains: string[],
  contextWindowTokens?: number,
): CriticalRemindersResult | null {
  try {
    const rules = cachedPrepare(db,
      'SELECT * FROM critical_rules WHERE project = ?'
    ).all(project) as CriticalRule[];

    if (rules.length === 0) return null;

    // Score each rule
    const scored: Array<{ rule: CriticalRule; score: number }> = [];

    for (const rule of rules) {
      let score = 0;

      // Decay expired?
      if (shouldInjectRule(rule, turnNumber)) score += 3;

      // Activity gate set? Boost safety rules.
      if (activityGate && rule.drift_risk === 'safety') score += 5;

      // First-encounter: rule has domain_tag in seenDomains but wasn't injected for it yet
      if (rule.domain_tags) {
        try {
          const tags = JSON.parse(rule.domain_tags) as string[];
          for (const tag of tags) {
            if (seenDomains.includes(tag) && (rule.last_injected_turn == null || rule.last_injected_turn === 0)) {
              score += 4;
              break;
            }
          }
          // Domain match bonus
          if (tags.some(t => seenDomains.includes(t))) score += 1;
        } catch { /* non-fatal */ }
      }

      if (score > 0) scored.push({ rule, score });
    }

    if (scored.length === 0) return null;

    // Sort by score DESC, take top 5
    scored.sort((a, b) => b.score - a.score);
    let selected = scored.slice(0, 5);

    // Render each with phrasing variation
    const rendered: string[] = [];
    const injectedRuleIds: number[] = [];

    for (const { rule } of selected) {
      rendered.push(`- ${renderRuleVariant(rule, rule.injection_count)}`);
      injectedRuleIds.push(rule.id);
    }

    let section = `## Critical Reminders\n${rendered.join('\n')}`;
    let tokenCost = estimateTokens(section);
    const budget = scaleBudget(300, contextWindowTokens);

    // Drop lowest-scored rules until under budget
    while (tokenCost > budget && selected.length > 1) {
      selected = selected.slice(0, -1);
      const trimmedRendered = selected.map(({ rule }) =>
        `- ${renderRuleVariant(rule, rule.injection_count)}`
      );
      injectedRuleIds.length = 0;
      for (const { rule } of selected) injectedRuleIds.push(rule.id);
      section = `## Critical Reminders\n${trimmedRendered.join('\n')}`;
      tokenCost = estimateTokens(section);
    }

    if (tokenCost > budget) return null; // Even a single rule exceeds budget

    return {
      section,
      tokenCost,
      injectedRuleIds: [...injectedRuleIds],
      applyEffects: () => {
        try {
          for (const ruleId of injectedRuleIds) {
            cachedPrepare(db,
              `UPDATE critical_rules
               SET last_injected_turn = ?, injection_count = injection_count + 1, updated_at = datetime('now')
               WHERE id = ?`
            ).run(turnNumber, ruleId);
          }
          // Clear activity gate
          try {
            const flags = getExperienceFlags(db, sessionId);
            if (flags.critical_activity_gate) {
              setExperienceFlags(db, sessionId, { critical_activity_gate: false }, flags);
            }
          } catch { /* non-fatal */ }
        } catch { /* non-fatal */ }
      },
    };
  } catch {
    return null;
  }
}
