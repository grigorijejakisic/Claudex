/**
 * Observation Type Prior classifier -- cheap keyword/pattern classification.
 * No LLM calls. Used by the extraction pipeline to apply importance multipliers.
 */

/** Observation semantic types with importance multipliers. */
export const OBSERVATION_TYPES = {
  decision: { multiplier: 1.5, description: 'Architectural choices, trade-offs, explicit decisions' },
  error: { multiplier: 1.3, description: 'Errors, failures, stack traces' },
  discovery: { multiplier: 1.2, description: 'New patterns, unexpected findings' },
  configuration: { multiplier: 1.1, description: 'Config changes, env setup' },
  routine: { multiplier: 0.8, description: 'Standard tool output, file reads, listings' },
  acknowledgment: { multiplier: 0.5, description: 'Confirmations, status checks' },
} as const;

export type ObservationType = keyof typeof OBSERVATION_TYPES;

/** Decision signal patterns. */
const DECISION_PATTERNS = /\b(decided|chose|trade-?off|instead of|went with|opting for|agreed to|confirmed approach|architectural choice|design decision)\b/i;

/** Error signal patterns. */
const ERROR_PATTERNS = /\b(error|failed|exception|stack trace|traceback|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|panic|fatal|crash|segfault)\b/i;

/** Exit code error pattern (separate from content patterns). */
const EXIT_CODE_ERROR = /exit code [1-9]/i;

/** Discovery signal patterns. */
const DISCOVERY_PATTERNS = /\b(found|discovered|unexpected|noticed|turns out|interesting|surprisingly|TIL|learned that)\b/i;

/** Configuration signal patterns. */
const CONFIG_PATTERNS = /\b(config|configuration|\.env|setting|environment|variable|tsconfig|package\.json|webpack|vite\.config|eslint|prettier)\b/i;

/** Routine tool names that produce standard output. */
const ROUTINE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * Classifies an observation into a semantic type using cheap keyword/pattern matching.
 * Classification priority: error > decision > discovery > configuration > acknowledgment > routine.
 *
 * @param content The observation content
 * @param toolName The tool that produced this observation
 * @param exitCode Optional exit code (for Bash tool)
 * @returns The classified observation type
 */
export function classifyObservationType(
  content: string,
  toolName: string,
  exitCode?: number | undefined,
): ObservationType {
  try {
    // Bash with non-zero exit code -> error
    if (toolName === 'Bash' && exitCode !== undefined && exitCode !== 0) {
      return 'error';
    }

    // Error patterns (highest priority after explicit exit code)
    if (ERROR_PATTERNS.test(content) || EXIT_CODE_ERROR.test(content)) {
      return 'error';
    }

    // Decision patterns
    if (DECISION_PATTERNS.test(content)) {
      return 'decision';
    }

    // Discovery patterns
    if (DISCOVERY_PATTERNS.test(content)) {
      return 'discovery';
    }

    // Configuration patterns
    if (CONFIG_PATTERNS.test(content)) {
      return 'configuration';
    }

    // Very short content -> acknowledgment (after error/decision/discovery/config checks
    // so concise error messages are not misclassified)
    if (content.length < 50) {
      return 'acknowledgment';
    }

    // Routine tools with standard output
    if (ROUTINE_TOOLS.has(toolName)) {
      return 'routine';
    }

    // Default: routine for most things
    return 'routine';
  } catch {
    return 'routine';
  }
}

/**
 * Applies the Type Prior multiplier to a base importance score.
 * Result is clamped to [1, 5] (the valid importance range).
 *
 * @param baseImportance The base importance score (1-5)
 * @param obsType The classified observation type
 * @returns Adjusted importance score, clamped to [1, 5]
 */
export function applyTypePrior(baseImportance: number, obsType: ObservationType): number {
  try {
    const multiplier = OBSERVATION_TYPES[obsType]?.multiplier ?? 1.0;
    const adjusted = Math.round(baseImportance * multiplier);
    return Math.max(1, Math.min(5, adjusted));
  } catch {
    return baseImportance;
  }
}
