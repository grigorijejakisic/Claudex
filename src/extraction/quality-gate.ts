/**
 * Per-tool quality gates that filter low-signal observations.
 * Pure function, no DB dependency. Non-throwing.
 * Tool names must match TOOL_CATALOG keys in shared/tool-catalog.ts.
 * @see Architecture Section 5.2 + 5.5 — quality gates
 */

export interface QualityGateResult {
  pass: boolean;
  reason?: string;
}

/** Structural element patterns for Read quality gate. */
const STRUCTURAL_PATTERNS = [
  /function\s/,
  /class\s/,
  /export\s/,
  /interface\s/,
  /type\s/,
  /const\s/,
  /import\s/,
  /module\.exports/,
];

/** Trivial bash commands (first word). */
const TRIVIAL_BASH_COMMANDS = new Set([
  'ls', 'cd', 'pwd', 'echo', 'cat', 'which', 'type',
]);

/**
 * Per-tool quality gate logic.
 * Returns { pass: true } for high-signal observations,
 * { pass: false, reason: string } for low-signal ones.
 */
export function passesQualityGate(
  toolName: string,
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined
): QualityGateResult {
  try {
    switch (toolName) {
      case 'Read': {
        const content = String(output?.content ?? '');
        if (content.length < 100) {
          return { pass: false, reason: 'read_too_short' };
        }
        const hasStructure = STRUCTURAL_PATTERNS.some((p) => p.test(content));
        if (!hasStructure) {
          return { pass: false, reason: 'read_no_structure' };
        }
        return { pass: true };
      }

      case 'Edit':
      case 'Write':
        return { pass: true };

      case 'Bash': {
        const command = String(input?.command ?? '');
        const firstWord = command.split(/\s/)[0];
        if (TRIVIAL_BASH_COMMANDS.has(firstWord)) {
          return { pass: false, reason: 'bash_trivial_command' };
        }
        const exitCode = output?.exitCode;
        if (exitCode !== undefined && exitCode !== 0) {
          return { pass: true };
        }
        const bashOutput = String(output?.output ?? output?.stdout ?? '');
        if (bashOutput.length < 20) {
          return { pass: false, reason: 'bash_no_output' };
        }
        return { pass: true };
      }

      case 'Grep': {
        const matchCount = Number(output?.matchCount ?? 0);
        if (matchCount < 1) {
          return { pass: false, reason: 'grep_no_matches' };
        }
        return { pass: true };
      }

      case 'Glob': {
        const files = output?.files;
        const fileCount = Array.isArray(files) ? files.length : 0;
        if (fileCount < 3) {
          return { pass: false, reason: 'glob_too_few' };
        }
        return { pass: true };
      }

      case 'WebFetch':
      case 'WebSearch':
      case 'Task':
      case 'NotebookEdit':
        return { pass: true };

      default:
        // Unknown tool: always passes (forward-compatible)
        return { pass: true };
    }
  } catch {
    // Non-throwing: default to pass on error
    return { pass: true };
  }
}
