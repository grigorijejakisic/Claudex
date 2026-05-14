import { invokeCrossFamily, type CrossFamilyResult } from './cross-family-wrapper.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type GateVerdict = 'BLOCKED' | 'PROCEED' | 'PROCEED_WITH_ANNOTATION';

export interface MethodologyCritiqueGateResult {
  verdict: GateVerdict;
  findings: CrossFamilyResult[];
  annotation?: string;
  triggered: boolean;
}

export interface MethodologyCritiqueGateOptions {
  force?: boolean;
  families?: ('gemini' | 'codex')[];
}

// ── Trigger tags ──────────────────────────────────────────────────────────────

const TRIGGER_TAGS = ['architecture', 'workflow', 'methodology'] as const;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the methodology critique gate against a phase plan's methodology section.
 * Triggered when the plan frontmatter contains any of: architecture, workflow, methodology.
 * Engineering-only phases are exempt unless options.force = true.
 */
export async function runMethodologyCritiqueGate(
  planContent: string,
  options: MethodologyCritiqueGateOptions = {},
): Promise<MethodologyCritiqueGateResult> {
  const { force = false, families } = options;

  const hasTriggerTag = force || planContentHasTriggerTag(planContent);
  if (!hasTriggerTag) {
    return { verdict: 'PROCEED', findings: [], triggered: false };
  }

  const critiquePrompt = buildMethodologyCritiquePrompt(planContent);

  const results = await invokeCrossFamily(critiquePrompt, {
    family: families ?? ['gemini', 'codex'],
    mode: 'review',
    promptBudgetTokens: 8_000,
  });

  const verdict = routeVerdict(results);
  const annotation = buildAnnotation(results, verdict);

  return { verdict, findings: results, annotation, triggered: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function planContentHasTriggerTag(content: string): boolean {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return false;
  const frontmatter = frontmatterMatch[1];

  for (const tag of TRIGGER_TAGS) {
    if (new RegExp(`\\b${tag}\\b`, 'i').test(frontmatter)) return true;
  }
  return false;
}

function buildMethodologyCritiquePrompt(planContent: string): string {
  return `You are reviewing the METHODOLOGY of a phase plan before it is committed. Your job is to find verdict-invalidating methodology errors — errors that would cause the plan to measure the wrong thing, introduce pseudoreplication, use biased judges, or make the plan's success criteria structurally impossible to meet.

Focus on:
- Does the measurement path match the production code path? (e.g., are harness arms measuring different code paths than what ships?)
- Is there pseudoreplication? (e.g., same probe set treated as independent samples across replications)
- Is the judge the same family as the agent being judged? (self-grading bias)
- Is the decision rule pre-committed before any data is collected?
- Are the success criteria achievable with the proposed methodology, or is there a structural gap?

Return BLOCK for verdict-invalidating concerns (the kind that would require redesigning the phase). Return FLAG for concerns that should be noted but allow proceeding with annotation. Return SIGNOFF if no methodology concerns.

## Phase Plan Under Critique

${planContent}`;
}

function routeVerdict(results: CrossFamilyResult[]): GateVerdict {
  const hasCritical = results.some(
    (r) => !r.degraded && r.verdict === 'BLOCK' && r.severity === 'critical',
  );
  if (hasCritical) return 'BLOCKED';

  const hasDegraded = results.some((r) => r.degraded);
  const hasFlag = results.some((r) => !r.degraded && r.verdict === 'FLAG');
  const hasMajor = results.some((r) => !r.degraded && r.severity === 'major');

  if (hasDegraded || hasFlag || hasMajor) return 'PROCEED_WITH_ANNOTATION';

  return 'PROCEED';
}

function buildAnnotation(results: CrossFamilyResult[], verdict: GateVerdict): string | undefined {
  if (verdict === 'PROCEED') return undefined;

  const lines: string[] = [`<!-- Methodology critique gate: ${verdict} -->`, ''];

  for (const r of results) {
    if (r.degraded) {
      lines.push(
        `**${r.family} (degraded — ${r.reason}):** ${r.raw_output?.slice(0, 200) ?? 'no output'}`,
      );
    } else {
      for (const f of r.findings) {
        lines.push(`**${r.family}/${f.category} [${r.severity}]:** ${f.summary}`);
        if (f.evidence) lines.push(`  Evidence: ${f.evidence.slice(0, 200)}`);
      }
    }
  }

  if (verdict === 'PROCEED_WITH_ANNOTATION') {
    lines.push('', '_Methodology critique concerns noted above. Planner acknowledges and proceeds._');
  }

  return lines.join('\n');
}
