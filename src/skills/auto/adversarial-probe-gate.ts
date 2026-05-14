import * as fs from 'node:fs';
import * as path from 'node:path';
import { invokeCrossFamily, type CrossFamilyResult } from './cross-family-wrapper.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProbeGateVerdict = 'PRODUCED' | 'PARTIAL' | 'BLOCKED' | 'SKIPPED';

export interface AdversarialProbeResult {
  verdict: ProbeGateVerdict;
  families_produced: string[];
  families_blocked: string[];
  families_degraded: string[];
  output_files: string[];
  message?: string;
}

export interface AdversarialProbeGateOptions {
  testFilePath: string;
  families?: ('gemini' | 'codex')[];
  implementationContext?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Request adversarial vitest probes for a test task from cross-family agents.
 * The returned vitest bodies are written to `<testFilePath-basename>.<family>-adversarial.test.ts`.
 * Both same-family and adversarial tests run in `bun run test`.
 */
export async function requestAdversarialProbes(
  planContent: string,
  taskDescription: string,
  options: AdversarialProbeGateOptions,
): Promise<AdversarialProbeResult> {
  const { testFilePath, families = ['gemini', 'codex'], implementationContext } = options;

  const authorshipPrompt = buildAuthorshipPrompt(planContent, taskDescription, implementationContext);

  const results = await invokeCrossFamily(authorshipPrompt, {
    family: families,
    mode: 'authorship',
    promptBudgetTokens: 16_000,
  });

  return processResults(results, testFilePath);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAuthorshipPrompt(
  planContent: string,
  taskDescription: string,
  implementationContext?: string,
): string {
  return `You are authoring adversarial vitest test cases. Your goal is to write test cases that a SAME-FAMILY agent (Claude/Sonnet) would NOT have thought to write — edge cases, boundary conditions, silent-failure paths, null/undefined propagation, error isolation. These are NOT tests of the happy path; those already exist.

Context: The implementation is being built by a same-family agent. The v5.0.1 silent-fail lesson is that same-family agents write both the silent-failure code AND the tests that say "should not throw" on it. Your job is to author tests that would catch silent failures the same-family agent would miss.

For each adversarial probe you author, return it as a vitest test body in findings[].evidence. Use this format:
- findings[].category = "adversarial-probe"
- findings[].summary = one-line description of what the probe catches
- findings[].evidence = the full vitest test body (describe + it blocks, ready to paste into a .test.ts file)

Author 2–5 adversarial probes. Respond with verdict=SIGNOFF when done, FLAG if you have authorship concerns, BLOCK if you cannot author probes for this task.

## Task Under Test
${taskDescription}

## Plan Section
${planContent}

${implementationContext ? `## Implementation Context\n${implementationContext}` : ''}`;
}

function processResults(
  results: CrossFamilyResult[],
  testFilePath: string,
): AdversarialProbeResult {
  const familiesProduced: string[] = [];
  const familiesBlocked: string[] = [];
  const familiesDegraded: string[] = [];
  const outputFiles: string[] = [];

  for (const result of results) {
    if (result.degraded) {
      familiesDegraded.push(result.family);
      continue;
    }
    if (result.verdict === 'BLOCK') {
      familiesBlocked.push(result.family);
      continue;
    }

    const probeFindings = result.findings.filter((f) => f.category === 'adversarial-probe');
    if (probeFindings.length === 0) {
      familiesDegraded.push(result.family);
      continue;
    }

    const vitestBodies = probeFindings.map((f) => f.evidence).join('\n\n');
    const outputPath = deriveAdversarialTestPath(testFilePath, result.family);

    writeAdversarialTestFile(outputPath, vitestBodies, result.family);
    outputFiles.push(outputPath);
    familiesProduced.push(result.family);
  }

  const verdict = deriveVerdict(familiesProduced, familiesBlocked, familiesDegraded);

  return {
    verdict,
    families_produced: familiesProduced,
    families_blocked: familiesBlocked,
    families_degraded: familiesDegraded,
    output_files: outputFiles,
    message: buildMessage(verdict, familiesBlocked, familiesDegraded),
  };
}

function deriveAdversarialTestPath(testFilePath: string, family: string): string {
  const dir = path.dirname(testFilePath);
  const base = path.basename(testFilePath, '.test.ts');
  return path.join(dir, `${base}.${family}-adversarial.test.ts`);
}

function writeAdversarialTestFile(filePath: string, vitestBodies: string, family: string): void {
  const header = `/**
 * Adversarial probes authored by ${family} (cross-family agent).
 * These tests were NOT written by the same-family agent that authored the implementation.
 * Purpose: catch silent failures and edge cases the implementation agent would miss.
 * Generated: ${new Date().toISOString()}
 */

import { describe, it, expect } from 'vitest';

`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, header + vitestBodies, 'utf8');
}

function deriveVerdict(
  produced: string[],
  blocked: string[],
  degraded: string[],
): ProbeGateVerdict {
  if (produced.length === 0 && blocked.length > 0) return 'BLOCKED';
  if (produced.length === 0) return 'SKIPPED';
  if (produced.length < 2 && (blocked.length > 0 || degraded.length > 0)) return 'PARTIAL';
  return 'PRODUCED';
}

function buildMessage(
  verdict: ProbeGateVerdict,
  blocked: string[],
  degraded: string[],
): string | undefined {
  if (verdict === 'BLOCKED')
    return 'All families refused to author probes. Adversarial coverage ABSENT for this task.';
  if (verdict === 'PARTIAL') {
    const parts: string[] = [];
    if (blocked.length) parts.push(`blocked: ${blocked.join(', ')}`);
    if (degraded.length) parts.push(`degraded: ${degraded.join(', ')}`);
    return `Partial adversarial coverage — ${parts.join('; ')}.`;
  }
  return undefined;
}
