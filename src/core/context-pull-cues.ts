/**
 * Phase 12 context-pull cue builders (12-08) + Phase 13 Plan 05 extensions.
 *
 * Six advisory cue surfaces total. All cues are non-blocking — failure never
 * surfaces to the agent.
 *
 * Phase 12 surfaces (existing):
 *   - handoff_read      (Read on context/handoffs/*)
 *   - decision_lock     (Write/Edit on config/*)
 *   - wait_for_direction (Stop hook, when assistant text matches deferral patterns)
 *
 * Phase 13 Plan 05 surfaces (new):
 *   - script_encounter  (Read on src/cli/skills/bin paths or src code files)
 *   - error_investigation (Bash on cat/tail/grep/test patterns)
 *   - package_install    (Bash on npm/bun/pip/uv/cargo/go install commands)
 *
 * Plus shouldFireCue: bespoke per-surface highlight-coverage gate. No
 * embedding calls in hooks (latency budget reserved for reranker fallback only,
 * per CLAUDE.md). Per-cue check function against session_highlights structured
 * fields. Operator-locked per 13-CONTEXT.md Q [13-05/Q2].
 *
 * ANTI-SCOPE: Ambiguous-user-instruction cue surface EXCLUDED (not deferred).
 * Reason: high false-positive cost on legitimate clarifying questions.
 * Revisit in v6.x with retrieved_but_unapplied telemetry calibration data.
 * Operator-locked per 13-CONTEXT.md Q [13-05/Q1].
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { loadConfig } from '../shared/config.js';
import { getLatestHighlights, type SessionHighlightsRecord } from '../intelligence/session-highlights.js';

// ── Config ────────────────────────────────────────────────────────────────────

export function areCuesEnabled(): boolean {
  try {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const v6 = cfg.v6 as Record<string, unknown> | undefined;
    const cues = v6?.cues as Record<string, unknown> | undefined;
    return (cues?.enabled as boolean | undefined) ?? true;
  } catch {
    return true;
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

const MAX_SNIPPET_CHARS = 200;
const MAX_RESULTS = 3;

function formatResult(
  artifactType: string,
  id: number | string,
  summary: string,
): string {
  const snippet = summary.length > MAX_SNIPPET_CHARS
    ? summary.slice(0, MAX_SNIPPET_CHARS) + '…'
    : summary;
  return `[${artifactType}:${id}] ${snippet}`;
}

function buildCueBlock(header: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  const body = lines.slice(0, MAX_RESULTS).join('\n');
  const full = `<system-reminder>\n${header}\n\n${body}\n</system-reminder>`;
  if (full.length > 1024) {
    return `<system-reminder>\n${header}\n\n${body.slice(0, 800)}…\n</system-reminder>`;
  }
  return full;
}

// ── Cue 1: Handoff-reading ────────────────────────────────────────────────────

/**
 * Fires when the agent reads a handoff file.
 * Surfaces top-3 project artifacts mentioning the handoff slug + recent session
 * events, advisory only.
 */
export async function buildHandoffReadCue(
  db: Database,
  handoffPath: string,
  sessionId: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const slug = handoffPath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(md|yaml|yml|json)$/, '')
    ?.toLowerCase() ?? 'handoff';

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE (summary LIKE ? OR summary LIKE ?)
         AND state != 'packed'
       ORDER BY importance DESC, timestamp_epoch_ms DESC
       LIMIT ?`,
    ).all(`%${slug}%`, '%handoff%', MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  if (lines.length < MAX_RESULTS) {
    try {
      const limit = MAX_RESULTS - lines.length;
      const existing = new Set(lines);
      const rows = cachedPrepare(
        db,
        `SELECT id, artifact_type, summary
         FROM artifacts
         WHERE session_id = ?
           AND state != 'packed'
         ORDER BY timestamp_epoch_ms DESC
         LIMIT ?`,
      ).all(sessionId, limit + 2) as Array<{
        id: number;
        artifact_type: string;
        summary: string;
      }>;
      for (const r of rows) {
        const line = formatResult(r.artifact_type, r.id, r.summary);
        if (!existing.has(line)) lines.push(line);
        if (lines.length >= MAX_RESULTS) break;
      }
    } catch { /* non-blocking */ }
  }

  return buildCueBlock(
    '## Context Pull Cue — Handoff Reading\nBefore interpreting this handoff, prior session context that may be relevant:',
    lines,
  );
}

// ── Cue 2: Decision-locking ──────────────────────────────────────────────────

/**
 * Fires when the agent writes to a config or curated-context file.
 * Surfaces prior decisions that may have established, contradicted, or flagged
 * the value being set.
 */
export async function buildDecisionLockCue(
  db: Database,
  filePath: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const basename = filePath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(json|yaml|yml|ts|js|md)$/, '')
    ?.toLowerCase() ?? 'config';

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE artifact_type IN ('decision', 'learning')
         AND (summary LIKE ? OR summary LIKE ?)
         AND state != 'packed'
       ORDER BY importance DESC, timestamp_epoch_ms DESC
       LIMIT ?`,
    ).all(`%${basename}%`, '%UNVALIDATED%', MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  return buildCueBlock(
    '## Context Pull Cue — Decision Locking\nDid any prior session establish, contradict, or flag a value in this file as UNVALIDATED?',
    lines,
  );
}

// ── Cue 3: Wait-for-direction ─────────────────────────────────────────────────

const WAIT_FOR_DIRECTION_PATTERNS = [
  /(?<!previously )(waiting for (your )?direction)/i,
  /let me know (what|how|when)/i,
  /what would you like me to/i,
  /should I proceed/i,
  /awaiting (your )?confirmation/i,
  /\bholding\b.*\bfor\b.*\b(you|direction|input)\b/i,
];

/**
 * Returns true if the assistant's response suggests passive deferral
 * on a task that likely has remaining work.
 */
export function detectsWaitForDirection(assistantText: string): boolean {
  return WAIT_FOR_DIRECTION_PATTERNS.some((p) => p.test(assistantText));
}

/**
 * Fires when the stop hook detects a wait-for-direction phrase.
 * Surfaces the most recent unresolved investigation thread from session artifacts.
 */
export async function buildWaitForDirectionCue(
  db: Database,
  sessionId: string,
): Promise<string | null> {
  if (!areCuesEnabled()) return null;

  const lines: string[] = [];

  try {
    const rows = cachedPrepare(
      db,
      `SELECT id, artifact_type, summary
       FROM artifacts
       WHERE session_id = ?
         AND artifact_type IN ('observation', 'learning', 'decision')
         AND state != 'packed'
       ORDER BY timestamp_epoch_ms DESC
       LIMIT ?`,
    ).all(sessionId, MAX_RESULTS) as Array<{
      id: number;
      artifact_type: string;
      summary: string;
    }>;
    for (const r of rows) {
      lines.push(formatResult(r.artifact_type, r.id, r.summary));
    }
  } catch { /* non-blocking */ }

  return buildCueBlock(
    '## Context Pull Cue — Wait-for-Direction\nLatest session context before pausing — unresolved threads that may still need work:',
    lines,
  );
}

// ── Phase 13 Plan 05: shouldFireCue coverage gate + 3 new cue builders ──────

export type CueType =
  | 'handoff_read' | 'decision_lock' | 'wait_for_direction'
  | 'script_encounter' | 'error_investigation' | 'package_install';

export interface TriggerContext {
  filePath?: string;
  command?: string;
  packageName?: string;
  errorKeyword?: string;
}

type CoverageCheckFn = (h: SessionHighlightsRecord, ctx: TriggerContext) => boolean;

/**
 * Per-surface coverage checks. Each returns true when the latest highlights
 * already cover the trigger (cue suppressed). Operator-locked semantics
 * per 13-CONTEXT.md decisions section.
 */
const COVERAGE_CHECKS: Record<CueType, CoverageCheckFn> = {
  handoff_read: (h, ctx) => {
    if (!ctx.filePath) return false;
    const stem = ctx.filePath
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.md$/, '') ?? '';
    if (!stem) return false;
    const stemLower = stem.toLowerCase();
    return (h.open_questions ?? []).some(q => q.context.toLowerCase().includes(stemLower))
      || (h.mental_model ?? '').toLowerCase().includes(stemLower);
  },
  decision_lock: (h, ctx) => {
    const fp = ctx.filePath ?? '';
    if (!fp) return false;
    return (h.tools_introduced ?? []).some(t => fp.endsWith(t.path) || t.path.endsWith(fp))
      || (h.decisions_not_made ?? []).some(d => d.gray_area.includes(fp));
  },
  wait_for_direction: (h, _ctx) => {
    // Suppress only if there are NO open questions — waiting is the under-oriented case.
    return (h.open_questions ?? []).length === 0;
  },
  script_encounter: (h, ctx) => {
    const fp = ctx.filePath ?? '';
    if (!fp) return false;
    return (h.tools_introduced ?? []).some(t => t.path === fp || fp.endsWith(t.path));
  },
  error_investigation: (h, ctx) => {
    const kw = (ctx.errorKeyword ?? '').toLowerCase();
    if (!kw) return false;
    return (h.open_questions ?? []).some(q => q.context.toLowerCase().includes(kw));
  },
  package_install: (h, ctx) => {
    // Suppress only when the package is already in tools_introduced (in active
    // use — install is redundant or upgrade-noise). When the package is in
    // decisions_not_made, the cue MUST fire and surface the prior rejection —
    // silently suppressing an install against a prior deferral hides a load-
    // bearing signal. CONTEXT's table line is reinterpreted here for that
    // reason; the rejection content is delivered by the cue builder.
    const pkg = (ctx.packageName ?? '').toLowerCase();
    if (!pkg) return false;
    return (h.tools_introduced ?? []).some(t => t.path.toLowerCase().includes(pkg));
  },
};

/**
 * Coverage gate: returns true (fire) unless the latest highlights already
 * cover the trigger context for this cue type. Returns true when no
 * highlights exist (no coverage signal = always fire).
 */
export function shouldFireCue(
  cueType: CueType,
  triggerContext: TriggerContext,
  project: string,
  db: Database,
): boolean {
  try {
    const latest = getLatestHighlights(db, project, 3);
    if (latest.length === 0) return true;
    const check = COVERAGE_CHECKS[cueType];
    const covered = latest.some(h => check(h, triggerContext));
    return !covered;
  } catch {
    return true; // on error, fire (conservative — false-negative cost is tolerable; false-positive cost = stale guidance)
  }
}

// ── Per-cue-type enabled flag helpers (matches Phase 12 item 8 pattern) ──────

function isCueTypeEnabled(cueType: CueType): boolean {
  try {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const v6 = cfg.v6 as Record<string, unknown> | undefined;
    const cues = v6?.cues as Record<string, unknown> | undefined;
    if ((cues?.enabled as boolean | undefined) === false) return false;
    const specific = cues?.[cueType] as Record<string, unknown> | undefined;
    return (specific?.enabled as boolean | undefined) ?? true;
  } catch {
    return true;
  }
}

// ── script_encounter ─────────────────────────────────────────────────────────

const SCRIPT_PATH_PATTERN = /(?:(?:^|[/\\])(?:scripts|cli|skills|bin)[/\\]|(?:^|[/\\])src[/\\].*\.(?:ts|js|mjs|cjs|py|sh|ps1)$)/;

/** In-memory dedup: same script in the same session fires the cue at most once. */
const sessionEncounterCache = new Set<string>();

/** Test helper: clear the in-memory script-encounter dedup cache. */
export function _resetScriptEncounterCacheForTest(): void {
  sessionEncounterCache.clear();
}

function isPriorSessionScript(db: Database, filePath: string, project: string): boolean {
  try {
    const basename = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const row = cachedPrepare(db, `
      SELECT COUNT(DISTINCT session_id) AS cnt
      FROM session_events
      WHERE project = ?
        AND (entity LIKE ? OR entity LIKE ?)
        AND event_type IN ('file', 'tool_use')
    `).get(project, `%${filePath}%`, `%${basename}%`) as { cnt: number } | undefined;
    return (row?.cnt ?? 0) >= 3;
  } catch {
    return false;
  }
}

/**
 * Fires when the agent reads a script/skill/CLI/source file that has prior-
 * session history (≥3 sessions touching it). Suppresses on:
 *   - master switch off
 *   - per-type switch off
 *   - path doesn't match SCRIPT_PATH_PATTERN
 *   - already covered by session_highlights tools_introduced
 *   - <3 prior sessions touched the path
 *   - file already encountered in this session
 */
export async function buildScriptEncounterCue(
  db: Database,
  filePath: string,
  project: string,
  sessionId: string,
): Promise<string | null> {
  if (!isCueTypeEnabled('script_encounter')) return null;
  if (!SCRIPT_PATH_PATTERN.test(filePath)) return null;
  if (!shouldFireCue('script_encounter', { filePath }, project, db)) return null;
  if (!isPriorSessionScript(db, filePath, project)) return null;

  const dedupKey = `script_encounter:${sessionId}:${filePath}`;
  if (sessionEncounterCache.has(dedupKey)) return null;
  sessionEncounterCache.add(dedupKey);

  const highlights = getLatestHighlights(db, project, 3);
  const prior = highlights.flatMap(h => h.tools_introduced ?? [])
    .find(t => filePath.endsWith(t.path) || t.path.endsWith(filePath));
  const priorNote = prior ? ` Prior context: ${prior.purpose}.` : '';

  return buildCueBlock(
    '## Context Pull Cue — Script Encounter\nThis file has prior-session history in this project.' + priorNote,
    [`[script:${filePath}] consider claudex_search for "${(filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.[^.]+$/, '')}" before reading fresh.`],
  );
}

// ── error_investigation ─────────────────────────────────────────────────────

const ERROR_INVESTIGATION_PATTERNS = [
  /\b(cat|tail|less|head)\s+[^|]*\.log\b/i,
  /\b(grep|rg)\b.*\b(error|stack|trace|exception|failed)\b/i,
  /\b(?:npm\s+test|bun\s+test|vitest|pytest)\b.*(?:--reporter|-v\b|--verbose\b)/i,
  /\b(journalctl|docker\s+logs)\b/i,
];

function extractErrorKeyword(command: string): string {
  const m = command.match(/\b(error|stack|trace|exception|failed|crash|timeout)\b/i);
  return m?.[1]?.toLowerCase() ?? 'error';
}

export async function buildErrorInvestigationCue(
  db: Database,
  command: string,
  project: string,
): Promise<string | null> {
  if (!isCueTypeEnabled('error_investigation')) return null;
  if (!ERROR_INVESTIGATION_PATTERNS.some(p => p.test(command))) return null;

  const errorKeyword = extractErrorKeyword(command);
  if (!shouldFireCue('error_investigation', { command, errorKeyword }, project, db)) return null;

  const highlights = getLatestHighlights(db, project, 3);
  const relatedQuestions = highlights
    .flatMap(h => h.open_questions ?? [])
    .filter(q =>
      q.context.toLowerCase().includes(errorKeyword)
      || q.question.toLowerCase().includes(errorKeyword)
    )
    .slice(0, 2);

  if (relatedQuestions.length === 0) {
    return buildCueBlock(
      '## Context Pull Cue — Error Investigation\nSimilar error/log investigation patterns may exist in prior sessions.',
      [`Consider: claudex_search("${errorKeyword} investigation")`],
    );
  }

  const lines = relatedQuestions.map(q => `[open-question] "${q.question}" — ${q.context.slice(0, MAX_SNIPPET_CHARS)}`);
  return buildCueBlock(
    `## Context Pull Cue — Error Investigation\nPrior sessions have open questions related to "${errorKeyword}":`,
    lines,
  );
}

// ── package_install ─────────────────────────────────────────────────────────

const PACKAGE_INSTALL_PATTERN =
  /^(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+|^bun\s+(?:install|add)\s+|^pip\s+install\s+|^uv\s+(?:pip\s+)?install\s+|^cargo\s+add\s+|^go\s+get\s+/i;

function extractPackageName(command: string): string {
  const trimmed = command.trim();
  // Skip the verb tokens; take the first remaining non-flag token.
  const parts = trimmed.split(/\s+/);
  // Skip leading verbs / subcommands.
  const skipTokens = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'cargo', 'go', 'install', 'add', 'get', 'i']);
  for (const p of parts) {
    if (skipTokens.has(p.toLowerCase())) continue;
    if (p.startsWith('-')) continue;
    return p;
  }
  return '';
}

export async function buildPackageInstallCue(
  db: Database,
  command: string,
  project: string,
): Promise<string | null> {
  if (!isCueTypeEnabled('package_install')) return null;
  if (!PACKAGE_INSTALL_PATTERN.test(command)) return null;

  const packageName = extractPackageName(command);
  if (!packageName) return null;
  if (!shouldFireCue('package_install', { command, packageName }, project, db)) return null;

  const highlights = getLatestHighlights(db, project, 3);
  const rejected = highlights
    .flatMap(h => h.decisions_not_made ?? [])
    .find(d => d.gray_area.toLowerCase().includes(packageName.toLowerCase()));

  if (rejected) {
    return buildCueBlock(
      `## Context Pull Cue — Package Install\nPackage "${packageName}" was previously deferred — check if the prior reason still applies.`,
      [`[deferred] ${rejected.gray_area} — ${rejected.why_deferred}`],
    );
  }

  const priorTool = highlights
    .flatMap(h => h.tools_introduced ?? [])
    .find(t => t.path.toLowerCase().includes(packageName.toLowerCase()));
  if (priorTool) {
    return buildCueBlock(
      `## Context Pull Cue — Package Install\nPackage "${packageName}" has prior context in this project.`,
      [`[tool] ${priorTool.path}: ${priorTool.purpose}`],
    );
  }

  return buildCueBlock(
    `## Context Pull Cue — Package Install\nInstalling "${packageName}" — check claudex_search before adding the dependency.`,
    [`Suggestion: claudex_search("${packageName}") for prior evaluation in this project.`],
  );
}
