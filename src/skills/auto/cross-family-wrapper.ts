import { z } from 'zod';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Schema ───────────────────────────────────────────────────────────────────

const CrossFamilyFindingSchema = z.object({
  category: z.string(),
  summary: z.string(),
  evidence: z.string(),
});

export const CrossFamilyResultSchema = z.object({
  family: z.enum(['gemini', 'codex']),
  verdict: z.enum(['BLOCK', 'FLAG', 'SIGNOFF']).nullable(),
  severity: z.enum(['critical', 'major', 'minor', 'none']).nullable(),
  findings: z.array(CrossFamilyFindingSchema),
  recommendation: z.string(),
  degraded: z.literal(true).optional(),
  raw_output: z.string().optional(),
  reason: z.enum(['malformed', 'unreachable', 'timeout']).optional(),
  truncated: z.boolean().optional(),
});

export type CrossFamilyResult = z.infer<typeof CrossFamilyResultSchema>;
export type CrossFamilyFamily = 'gemini' | 'codex';
export type CrossFamilyMode = 'review' | 'authorship';

export interface CrossFamilyOptions {
  family?: CrossFamilyFamily | CrossFamilyFamily[];
  mode?: CrossFamilyMode;
  promptBudgetTokens?: number;
  context?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HARD_CEILING_TOKENS = 32_000;
const CHARS_PER_TOKEN_APPROX = 4;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Invoke one or both cross-family LLMs and return structured BLOCK/FLAG/SIGNOFF results.
 * Families: 'gemini' (Gemini-3-Flash via ollama) and 'codex' (Codex CLI).
 * Claude is intentionally excluded — already present as orchestrator + teammates.
 */
export async function invokeCrossFamily(
  prompt: string,
  options: CrossFamilyOptions = {},
): Promise<CrossFamilyResult[]> {
  const { family = ['gemini', 'codex'], mode = 'review', promptBudgetTokens } = options;
  const families = Array.isArray(family) ? family : [family];

  for (const f of families) {
    if (f !== 'gemini' && f !== 'codex') {
      throw new Error(
        `invokeCrossFamily: unknown family '${f}'. Only 'gemini' and 'codex' are supported. Claude is excluded by design.`,
      );
    }
  }

  const effectiveBudget = Math.min(promptBudgetTokens ?? HARD_CEILING_TOKENS, HARD_CEILING_TOKENS);
  const { boundPrompt, truncated } = applyPromptBudget(prompt, options.context, effectiveBudget);

  const results = await Promise.all(
    families.map((f) => invokeOneFamily(f, boundPrompt, mode, truncated)),
  );

  return results;
}

// ── Prompt budget ─────────────────────────────────────────────────────────────

function applyPromptBudget(
  prompt: string,
  context: string | undefined,
  budgetTokens: number,
): { boundPrompt: string; truncated: boolean } {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN_APPROX;
  const header = context ? `## Artifact Under Critique\n\n${context}\n\n## Review Prompt\n\n` : '';
  const full = header + prompt;

  if (full.length <= budgetChars) {
    return { boundPrompt: full, truncated: false };
  }

  const allowedBody = budgetChars - header.length - 200;
  const truncatedPrompt = prompt.slice(0, Math.max(0, allowedBody));
  return {
    boundPrompt: header + truncatedPrompt + '\n\n[... truncated to fit prompt budget ...]',
    truncated: true,
  };
}

// ── One-family invocation ─────────────────────────────────────────────────────

async function invokeOneFamily(
  family: CrossFamilyFamily,
  prompt: string,
  mode: CrossFamilyMode,
  truncated: boolean,
): Promise<CrossFamilyResult> {
  const modeInstructions =
    mode === 'authorship'
      ? "You are authoring adversarial test cases (vitest bodies) that a same-family reviewer would not have thought to write. Return findings[].evidence containing vitest test body strings. verdict=SIGNOFF when probes produced cleanly, FLAG if authorship issues, BLOCK if you refuse."
      : 'You are performing a code/methodology review. Return verdict=BLOCK for critical findings that invalidate the approach, FLAG for concerns that should be noted but allow proceeding, SIGNOFF for no concerns.';

  const fullPrompt = `${modeInstructions}\n\nRespond ONLY in this JSON schema (no prose outside JSON):\n{\n  "family": "${family}",\n  "verdict": "BLOCK" | "FLAG" | "SIGNOFF",\n  "severity": "critical" | "major" | "minor" | "none",\n  "findings": [{ "category": string, "summary": string, "evidence": string }],\n  "recommendation": string\n}\n\n---\n\n${prompt}`;

  let rawOutput: string;
  try {
    rawOutput = shellInvokeFamily(family, fullPrompt);
  } catch (err) {
    return {
      family,
      verdict: null,
      severity: null,
      findings: [],
      recommendation: '',
      degraded: true,
      raw_output: String(err),
      reason: 'unreachable',
      truncated: truncated || undefined,
    };
  }

  return parseWithRetry(family, rawOutput, fullPrompt, truncated);
}

// ── Shell invocation ──────────────────────────────────────────────────────────

function shellInvokeFamily(family: CrossFamilyFamily, prompt: string): string {
  const tmpFile = path.join(os.tmpdir(), `claudex-cross-family-${family}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');

  try {
    if (family === 'gemini') {
      // Use ollama with gemini model — same pattern as external-review-gate.cjs
      const output = execSync(`ollama run gemini-3-flash-preview:cloud`, {
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
      return output;
    } else {
      // Codex CLI — per docs/codex.md: no -o flag, no /tmp/, no run_in_background on Windows
      const output = execSync(`codex review`, {
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
      return output;
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup failure
    }
  }
}

// ── Parse with retry ──────────────────────────────────────────────────────────

function parseWithRetry(
  family: CrossFamilyFamily,
  rawOutput: string,
  originalPrompt: string,
  truncated: boolean,
): CrossFamilyResult {
  const first = tryParse(family, rawOutput, truncated);
  if (first !== null) return first;

  // Retry once with a stricter format reminder
  const retryPrompt = `${originalPrompt}\n\nIMPORTANT: You MUST respond with ONLY valid JSON matching the schema. No prose. No markdown fences. Raw JSON only.\n\nExample:\n{"family":"${family}","verdict":"SIGNOFF","severity":"none","findings":[],"recommendation":"No issues found."}`;

  let retryOutput = '';
  try {
    retryOutput = shellInvokeFamily(family, retryPrompt);
  } catch {
    // retry invocation also failed — fall through to degraded
  }

  const second = tryParse(family, retryOutput, truncated);
  if (second !== null) return second;

  return {
    family,
    verdict: null,
    severity: null,
    findings: [],
    recommendation: '',
    degraded: true,
    raw_output: rawOutput.slice(0, 4096),
    reason: 'malformed',
    truncated: truncated || undefined,
  };
}

function tryParse(
  family: CrossFamilyFamily,
  raw: string,
  truncated: boolean,
): CrossFamilyResult | null {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = CrossFamilyResultSchema.safeParse({
    ...(parsed as object),
    family,
    truncated: truncated || undefined,
  });
  if (!result.success) return null;
  return result.data;
}
