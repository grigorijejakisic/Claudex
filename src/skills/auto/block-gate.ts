// ── Types ─────────────────────────────────────────────────────────────────────

export type QuestionClass = 'BLOCK' | 'FLAG';
export type QuestionStatus = 'open' | 'answered';

export interface QuestionRecord {
  id: string;
  summary: string;
  classification: QuestionClass;
  status: QuestionStatus;
  default_value?: string;
  answer?: string;
}

export interface BlockGateFiredEvent {
  skill: string;
  phase: string;
  question_id: string;
  attempted_artifact_path: string;
  timestamp_ms: number;
}

// ── Fixed-category floor ──────────────────────────────────────────────────────

// These categories auto-promote to BLOCK regardless of skill's classification.
// Source: 12-CONTEXT.md operator-locked answer Q [12-09/Q1].
const AUTO_BLOCK_PATTERNS = [
  /\bscope\b/i,
  /\bmethodology\b/i,
  /\bprerequisite/i,
  /\bdependenc/i,
  /\bwave structure\b/i,
  /\bin progress\b|\bactive.{0,10}topic\b|\bcurrent.{0,10}session\b/i,
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a question as BLOCK or FLAG.
 * Fixed-category floor: if question matches any auto-BLOCK pattern, it is BLOCK.
 */
export function classifyQuestion(
  question: string,
  activeTopics: string[] = [],
  skillClassification: QuestionClass = 'FLAG',
): QuestionClass {
  const isAutoBlock = AUTO_BLOCK_PATTERNS.some((p) => p.test(question));
  if (isAutoBlock) return 'BLOCK';

  const touchesActiveTopic = activeTopics.some((topic) =>
    question.toLowerCase().includes(topic.toLowerCase()),
  );
  if (touchesActiveTopic) return 'BLOCK';

  return skillClassification;
}

/**
 * Return open BLOCK-class questions from the question log.
 */
export function checkOpenBlockers(questionLog: QuestionRecord[]): QuestionRecord[] {
  return questionLog.filter((q) => q.classification === 'BLOCK' && q.status === 'open');
}

/**
 * Gate function: returns false (do NOT write) if any BLOCK question is open.
 * FLAG questions never block writing.
 */
export function shouldWriteArtifact(questionLog: QuestionRecord[]): boolean {
  return checkOpenBlockers(questionLog).length === 0;
}

/**
 * Build a blocked-marker message for the orchestrator when write is gated.
 */
export function buildBlockedMarker(
  skill: string,
  phase: string,
  openBlockers: QuestionRecord[],
  attemptedArtifactPath: string,
): string {
  const questionList = openBlockers.map((q) => `  - [${q.id}] ${q.summary}`).join('\n');
  return [
    `BLOCK GATE FIRED — ${skill} for phase ${phase}`,
    `Attempted to write: ${attemptedArtifactPath}`,
    `Open BLOCK questions (unanswered):`,
    questionList,
    ``,
    `Skill is IDLE. Will not write until operator answers above questions.`,
    `Send answers to unblock.`,
  ].join('\n');
}

/**
 * Build a terminal "blocked_on_operator" message after ~30 min of no response.
 */
export function buildTerminalBlockMessage(
  skill: string,
  phase: string,
  openBlockers: QuestionRecord[],
): string {
  return JSON.stringify({
    status: 'blocked_on_operator',
    skill,
    phase,
    question: openBlockers[0]?.summary ?? 'unknown question',
    open_count: openBlockers.length,
    action: 'no_artifact_written',
    message:
      'Operator did not respond to BLOCK-class question within 30 min. Skill shut down. Orchestrator must surface via AskUserQuestion.',
  });
}

/**
 * Record a block_gate_fired telemetry event to ~/.claudex/block-gate-log.jsonl.
 * Non-throwing — telemetry failure must never block the skill.
 */
export function recordBlockGateFired(event: BlockGateFiredEvent): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { appendFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { homedir } = require('node:os') as typeof import('node:os');
    const claudexDir = join(homedir(), '.claudex');
    mkdirSync(claudexDir, { recursive: true });
    appendFileSync(join(claudexDir, 'block-gate-log.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // Non-blocking
  }
}
