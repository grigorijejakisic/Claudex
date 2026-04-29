/**
 * Phase 4.1 lesson type system — three lesson kinds, layered storage.
 *
 * Locked by 2026-04-28 design session. Source-of-truth schema; do not extend
 * without updating .planning/phases/04.1-memory-md-content-redesign/04.1-CONTEXT.md.
 */

export type LessonType = 'feedback' | 'project' | 'process';

/**
 * Telemetry handles — auto-harvested from session telemetry, ALWAYS populated.
 * Deterministic. Cannot be omitted on a valid lesson file.
 */
export interface TelemetryHandles {
  tools_used: string[];                  // e.g., ['Read', 'Grep', 'Bash']
  files_touched: string[];               // glob-friendly paths or globs (e.g., ['.planning/audits/*'])
  errors_encountered: string[];          // structured error tags or empty array
  user_framing_tokens: string[];         // distinctive content words from user turns
  session_arc: string[];                 // segmentation labels (e.g., ['audit', 'diagnosis', 'design'])
  duration_min: number;                  // session active minutes
  correction_count: number;              // count of detected user corrections
  // Optional: process_* lessons may carry the trigger-set that fired.
  triggered_by?: string[];
}

/**
 * Shape handles — LLM-extracted, drawn from Angel's bounded vocabulary.
 * Optional fields. ABSTAIN allowed: if the LLM has no high-confidence match
 * to a canonical vocabulary value, the field is OMITTED, not guessed.
 *
 * Confidence is recorded inline in a YAML comment on the value line:
 *   shape:
 *     task_shape: design-discussion-before-commit  # confidence: 0.91
 *
 * The parser captures the value but the comment-confidence is not part of
 * the typed structure — it's metadata for humans and offline analysis.
 */
export interface ShapeHandles {
  task_shape?: string;
  failure_mode?: string;
  solution_pattern?: string;
}

export interface LessonFrontmatter {
  type: LessonType;
  created_at_epoch: number;          // ms-precision per CUR-14 lock
  telemetry: TelemetryHandles;
  shape?: ShapeHandles;              // optional — abstain-allowed
  // Tier tracking for foreground/background placement (CONTEXT.md MEMORY.md
  // structural redesign). Default 'foreground' for new lessons; demoted by
  // heartbeat to 'background' after N=8 weeks without firing.
  tier?: 'foreground' | 'background';
  last_fired_at_epoch?: number;
}

/**
 * Result of parsing a lesson file. The body is the raw markdown content
 * after the closing `---` delimiter (whitespace-trimmed at top, preserved
 * mid-content).
 */
export interface ParsedLesson {
  path: string;                          // absolute path to the file
  filename: string;                      // basename (e.g., 'feedback_check_deps.md')
  frontmatter: LessonFrontmatter;
  body: string;                          // narrative-shape salience body
  // Convenience: the type prefix matches frontmatter.type — both are recorded
  // so consumers can verify consistency without re-parsing the filename.
  filenamePrefix: 'feedback' | 'project' | 'process';
}

/**
 * Parameters for writing a new lesson file.
 *
 * The slug becomes the filename suffix (after the type prefix). Example:
 *   { type: 'feedback', slug: 'check-deps', ... } → 'feedback_check-deps.md'
 *
 * Slug rules: lowercase, hyphenated, alphanumeric-and-hyphens only, ≤60 chars.
 * (Planner discretion per CONTEXT.md "Claude's Discretion" — chose hyphen
 * over underscore for visual clarity in pointer lines.)
 */
export interface LessonWriteParams {
  project: string;                       // Claudex project ID or filesystem path
  type: LessonType;
  slug: string;
  frontmatter: Omit<LessonFrontmatter, 'type'>;
  body: string;                          // markdown narrative
}
