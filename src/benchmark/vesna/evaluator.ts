/**
 * Pattern-match evaluator. v4 is auto-only; LLM-judge is deferred.
 * Pass requires:
 *   1. turns_taken <= must_surface_within_turns
 *   2. EVERY regex in must_contain_phrase_pattern matches agent_text (case-insensitive)
 * Use alternation in a single phrase pattern for OR-semantics.
 */

import type { ExpectedRecall } from './types.js';

export interface AgentObservation {
  /** Concatenated text the agent saw / would have said in the first N turns. */
  agent_text: string;
  /** Turn count the harness used to produce agent_text (1-indexed). */
  turns: number;
  /** Tool calls the agent made in those turns (currently informational). */
  tool_calls: { name: string; args: unknown }[];
}

export interface EvaluationOutput {
  passed: boolean;
  diagnostic: string;
}

export function evaluate(
  output: AgentObservation,
  expected: ExpectedRecall,
): EvaluationOutput {
  if (output.turns > expected.must_surface_within_turns) {
    return {
      passed: false,
      diagnostic: `turns_taken=${output.turns} exceeded must_surface_within_turns=${expected.must_surface_within_turns}`,
    };
  }

  const missing: string[] = [];
  for (const pattern of expected.must_contain_phrase_pattern) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch (e) {
      return {
        passed: false,
        diagnostic: `invalid regex in must_contain_phrase_pattern: ${pattern} — ${(e as Error).message}`,
      };
    }
    if (!re.test(output.agent_text)) {
      missing.push(pattern);
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      diagnostic: `missing required phrase pattern(s): ${missing.map((p) => JSON.stringify(p)).join(', ')}`,
    };
  }

  return { passed: true, diagnostic: 'all phrase patterns matched within turn budget' };
}
