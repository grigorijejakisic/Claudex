/**
 * Angel Pattern Extractor — reads conversation_turns holistically to detect corrections.
 *
 * This is the key advantage of the Angel over ephemeral hooks: it sees the FULL
 * conversation, not a 2-second snapshot. It can identify corrections that span
 * multiple turns, understand the context of why something was corrected, and
 * create high-confidence patterns.
 *
 * Uses the local llama-server (Gemma 4 31B IT Q6_K via llama-client) for
 * all LLM analysis. Single path — the old CliProxy → Ollama cloud → Ollama
 * local cascade was collapsed in Path B.
 *
 * Non-throwing — returns empty results on error.
 *
 * A1/A2 (Phase 10): Angel owns ALL extraction and consolidation.
 * CC's extractMemories (cc-source/04-memory-system.md) is disabled via
 * CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. Angel cannot adopt CC's forked-agent-with-
 * cache-sharing pattern because Angel runs as a separate process (different PID),
 * not a CC subagent — cache sharing only works within CC's conversation fork.
 *
 * A5 (Phase 10): Angel reads conversation_turns which naturally contains any CC
 * away summaries (appended as system messages). No special integration needed.
 * CC's Away Summary is also feature-flagged (AWAY_SUMMARY + tengu_sedge_lantern).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { callLocalLLM } from './llama-client.js';
import { createPattern, createTipAndStrategy } from '../intelligence/experience-patterns.js';
import { recordDomainInteraction, extractDomain } from '../intelligence/capability-tracker.js';
import { recordEvent } from '../core/session-events.js';
import type { ConversationTurn, ExtractedPattern } from './types.js';
import { findSkillByDomain, writeSkillFile } from './skill-writer.js';
import * as os from 'os';

/**
 * Get conversation turns for a session, ordered by turn number.
 * If afterTurn is provided, only returns turns with turn_number > afterTurn.
 */
export function getSessionTurns(
  db: Database,
  sessionId: string,
  afterTurn?: number,
): ConversationTurn[] {
  try {
    if (afterTurn != null && afterTurn > 0) {
      return cachedPrepare(db,
        `SELECT id, session_id, project, turn_number, user_text, assistant_text, timestamp_epoch
         FROM conversation_turns
         WHERE session_id = ? AND turn_number > ?
         ORDER BY turn_number ASC`
      ).all(sessionId, afterTurn) as ConversationTurn[];
    }
    return cachedPrepare(db,
      `SELECT id, session_id, project, turn_number, user_text, assistant_text, timestamp_epoch
       FROM conversation_turns
       WHERE session_id = ?
       ORDER BY turn_number ASC`
    ).all(sessionId) as ConversationTurn[];
  } catch {
    return [];
  }
}

/**
 * Wrapper tags injected into conversation turns by hooks and the assembly
 * pipeline. Their bodies must NEVER be fed to the pattern extractor as if
 * they were the user's words or the assistant's reply — that closes the
 * Mem0 feedback loop where the LLM "extracts" patterns it just saw injected
 * into its own context (helpful_count > times_triggered is the smoking gun).
 *
 * Applied conservatively: we strip the body and replace with a short
 * `[injected:<tag>]` marker so the LLM can still see that injection
 * happened (turn structure preserved) without re-extracting from it.
 */
const INJECTED_BLOCK_TAGS = [
  'experience-data',
  'system-reminder',
  'file-content',
  'task-notification',
  'user-prompt-submit-hook',
  'session-start-hook',
  'command-message',
  'command-name',
  'local-command-stdout',
  'local-command-stderr',
];

/**
 * Strip injected wrapper blocks from a single turn's text before pattern
 * extraction. Replaces each block with `[injected:<tag>]` so structure is
 * preserved without leaking the contents.
 *
 * Exported for testing.
 */
export function stripInjectedBlocks(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  for (const tag of INJECTED_BLOCK_TAGS) {
    // Non-greedy match; case-insensitive on tag; allow attributes in opening tag.
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(re, `[injected:${tag}]`);
  }
  return out;
}

/**
 * Format conversation turns into a readable transcript for Claude analysis.
 * Truncates individual turns to keep total under ~8000 chars.
 *
 * Strips injected wrapper blocks (system-reminders, experience-data, file
 * inlines, task-notifications) before truncation so the LLM never sees its
 * own injected output as fodder for re-extraction.
 */
function formatTranscript(turns: ConversationTurn[]): string {
  const parts: string[] = [];
  const maxTurnLen = Math.min(1500, Math.floor(8000 / Math.max(turns.length, 1)));

  for (const turn of turns) {
    const userClean = stripInjectedBlocks(turn.user_text);
    if (userClean) {
      const text = userClean.length > maxTurnLen
        ? userClean.slice(0, maxTurnLen) + '...'
        : userClean;
      parts.push(`[Turn ${turn.turn_number}] USER: ${text}`);
    }
    const assistantClean = stripInjectedBlocks(turn.assistant_text);
    if (assistantClean) {
      const text = assistantClean.length > maxTurnLen
        ? assistantClean.slice(0, maxTurnLen) + '...'
        : assistantClean;
      parts.push(`[Turn ${turn.turn_number}] ASSISTANT: ${text}`);
    }
  }

  return parts.join('\n\n');
}

const EXTRACTION_SYSTEM_PROMPT = `You are an experience pattern extractor for an AI coding assistant's memory system.

Your job: read a session transcript and extract TWO types of patterns:

**1. CORRECTIONS** (pattern_type: "correction")
When the user says something is wrong, tells the assistant to stop doing something,
redirects the approach, or expresses frustration with the assistant's behavior.

**2. DIRECTIVES** (pattern_type: "behavioral")
When the user states a standing rule, principle, or way of working that should ALWAYS apply.
Look for phrases like: "we always...", "never do...", "the rule is...", "from now on...",
"remember that...", "I want you to...", or any statement establishing how work should be done.
Directives are NOT corrections — they're proactive rules the user is teaching.

For each pattern found, extract:
- pattern_type: "correction" or "behavioral"
- trigger_context: what situation/topic this applies to (max 100 chars)
- lesson: the rule or corrected behavior (max 200 chars)
- anti_pattern: what to avoid (max 100 chars, optional — mainly for corrections)
- severity: "critical" (fundamental rule/caused real harm), "important" (strong preference/wrong approach), or "minor" (style/preference)
- domain: the technical domain (e.g., "typescript", "git", "testing", "architecture", "workflow")
- trigger_intents: array of task categories when this pattern applies. Choose from: ["continuation", "investigation", "implementation", "planning", "recall"]. Use multiple if the pattern applies broadly. For universal rules, include all that apply.
- retrieval_mode: "reactive" (only surface when prompt matches), "categorical" (surface when task intent matches), or "always" (surface every turn). Use "always" only for critical universal rules. Use "categorical" for task-type-specific patterns. Default to "reactive" for specific corrections.

Be CONSERVATIVE. Only extract patterns you're confident represent real corrections or deliberate directives, not:
- Normal back-and-forth discussion
- User providing additional context
- Clarifications or refinements
- User changing their mind (not the assistant being wrong)
- One-off instructions that don't represent standing rules

Respond with JSON only:
{
  "patterns": [
    {
      "pattern_type": "correction",
      "trigger_context": "...",
      "lesson": "...",
      "anti_pattern": "...",
      "severity": "important",
      "domain": "...",
      "trigger_intents": ["implementation"],
      "retrieval_mode": "reactive"
    }
  ],
  "summary": "Brief 1-2 sentence summary of the session's key themes, or 'no patterns found'"
}

If no patterns are found, return: { "patterns": [], "summary": "no patterns found" }`;

// LLM calls go through callLocalLLM (src/angel/llama-client.ts) against the
// local llama.cpp server (Gemma 4 31B IT Q6_K). The previous three-tier
// cascade (CliProxy → Ollama cloud → Ollama local) has been collapsed to a
// single local path as part of Path B — fully-local generation, no MAX
// subscription coupling, no cloud dependency, no hook deadlock.

// ---------------------------------------------------------------------------
// Directive keyword pre-filter
// ---------------------------------------------------------------------------

/** Phrases that indicate standing user directives (not corrections). */
const DIRECTIVE_INDICATORS = [
  // Explicit rules
  'from now on', 'always', 'never', 'the rule is', 'remember that',
  'i want you to', 'we always', 'never do', 'stop doing',
  // Reassurances / role assignments (often missed by LLMs)
  'i will take care', 'i will manage', 'i will handle', 'i will guard',
  'don\'t worry about', 'do not worry', 'i got your back', 'i\'ll watch',
  'my responsibility', 'my job to', 'leave that to me',
  // Preferences
  'i prefer', 'we use', 'we don\'t use', 'i like when', 'i hate when',
  'that\'s how i want', 'the way i work',
];

/**
 * Pre-scan user turns for directive keywords. Returns turns that likely
 * contain standing directives, even if a small LLM would miss them.
 * These are prepended to the transcript with a [DIRECTIVE CANDIDATE] marker.
 *
 * Strips injected blocks before scanning — without this, an injected
 * `<experience-data>` block containing "always X" would be treated as a
 * fresh user directive and re-promoted on every session.
 */
function extractDirectiveCandidates(turns: ConversationTurn[]): string[] {
  const candidates: string[] = [];
  for (const turn of turns) {
    const cleanUserText = stripInjectedBlocks(turn.user_text);
    if (!cleanUserText) continue;
    const lower = cleanUserText.toLowerCase();
    for (const indicator of DIRECTIVE_INDICATORS) {
      if (lower.includes(indicator)) {
        candidates.push(`[Turn ${turn.turn_number}] [DIRECTIVE CANDIDATE] USER: ${cleanUserText.substring(0, 500)}`);
        break; // One match per turn is enough
      }
    }
  }
  return candidates;
}

/**
 * Detect repeated user directives across sessions.
 * If the same phrase pattern appears in 2+ sessions, it's a standing rule.
 *
 * Defends against the Mem0 feedback loop by post-filtering LIKE matches:
 * a phrase that appears only inside an injected `<experience-data>` block
 * does NOT count as a repeated user directive — it's the same pattern
 * looking at itself.
 */
function findCrossSessionDirectives(
  db: Database,
  project: string,
  currentSessionId: string,
  currentDirectives: string[],
): string[] {
  if (currentDirectives.length === 0) return [];
  const repeated: string[] = [];

  for (const directive of currentDirectives) {
    // Strip [DIRECTIVE CANDIDATE] prefix before extracting keywords
    const cleanDirective = directive.replace(/\[Turn \d+\]\s*\[DIRECTIVE CANDIDATE\]\s*USER:\s*/i, '');
    const words = cleanDirective.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    if (words.length < 3) continue;

    // Search for similar phrases in OTHER sessions' conversation turns
    const searchTerms = words.slice(0, 5).join(' ');
    const needle = searchTerms.substring(0, 30).toLowerCase();
    try {
      // Fetch user_text so we can post-filter — LIKE alone matches injected
      // experience-data blocks, which would falsely confirm a "repeated" rule.
      const matches = cachedPrepare(db,
        `SELECT DISTINCT ct.session_id, ct.user_text FROM conversation_turns ct
         WHERE ct.project = ? AND ct.user_text LIKE ? AND ct.session_id != ?
         LIMIT 6`
      ).all(project, `%${needle}%`, currentSessionId) as Array<{ session_id: string; user_text: string | null }>;

      const distinctRealSessions = new Set<string>();
      for (const row of matches) {
        const cleaned = stripInjectedBlocks(row.user_text).toLowerCase();
        if (cleaned.includes(needle)) {
          distinctRealSessions.add(row.session_id);
          if (distinctRealSessions.size >= 3) break;
        }
      }

      if (distinctRealSessions.size >= 1) {
        repeated.push(`[REPEATED ACROSS ${distinctRealSessions.size + 1} SESSIONS] ${directive}`);
      }
    } catch { /* non-fatal */ }
  }

  return repeated;
}

// ---------------------------------------------------------------------------
// Phase 3: MEASURE — session outcome analysis
// ---------------------------------------------------------------------------

interface SessionOutcome {
  /** Total corrections detected in this session */
  correctionCount: number;
  /** Number of test runs that passed */
  testsPassedCount: number;
  /** Number of test runs that failed */
  testsFailedCount: number;
  /** Session duration in minutes */
  durationMinutes: number;
  /** Whether corrections happened AFTER the midpoint (late = correction wasn't effective) */
  lateCorrections: boolean;
}

function measureSessionOutcome(db: Database, sessionId: string): SessionOutcome {
  try {
    // Count corrections
    const corrections = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM session_events
       WHERE session_id = ? AND event_type = 'correction_detected'`
    ).get(sessionId) as { c: number };

    // Session timing
    const session = cachedPrepare(db,
      `SELECT created_at_epoch, ended_at_epoch FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { created_at_epoch: number; ended_at_epoch: number | null } | undefined;

    const duration = session?.ended_at_epoch && session?.created_at_epoch
      ? (session.ended_at_epoch - session.created_at_epoch) / 60
      : 0;

    // Test results
    const tests = cachedPrepare(db,
      `SELECT action, COUNT(*) as c FROM session_events
       WHERE session_id = ? AND event_type = 'test_run'
       GROUP BY action`
    ).all(sessionId) as Array<{ action: string; c: number }>;

    const testsPassedCount = tests.find(t => t.action === 'passed')?.c ?? 0;
    const testsFailedCount = tests.find(t => t.action === 'failed')?.c ?? 0;

    // Check for late corrections (after session midpoint)
    let lateCorrections = false;
    if (session?.created_at_epoch && session?.ended_at_epoch && corrections.c > 0) {
      const midpoint = session.created_at_epoch + (session.ended_at_epoch - session.created_at_epoch) / 2;
      const lateCount = (cachedPrepare(db,
        `SELECT COUNT(*) as c FROM session_events
         WHERE session_id = ? AND event_type = 'correction_detected' AND timestamp_epoch > ?`
      ).get(sessionId, midpoint) as { c: number }).c;
      lateCorrections = lateCount > corrections.c / 2;
    }

    return { correctionCount: corrections.c, testsPassedCount, testsFailedCount, durationMinutes: duration, lateCorrections };
  } catch {
    return { correctionCount: 0, testsPassedCount: 0, testsFailedCount: 0, durationMinutes: 0, lateCorrections: false };
  }
}

// ---------------------------------------------------------------------------
// A8: Correction → Skill bridge
// ---------------------------------------------------------------------------

/**
 * A8 (Phase 11): Bridge a correction pattern to an existing SKILL.md file.
 *
 * After Angel extracts a correction, scan `.claude/skills/` for a skill whose
 * `when_to_use` matches the correction domain. If found, append the correction
 * as a new rule. If no match, skip (A10 handles new skill creation).
 *
 * Records `skill_amended` session_event on success.
 */
function bridgeCorrectionToSkill(
  db: Database,
  sessionId: string,
  project: string,
  pattern: ExtractedPattern,
  projectRoot?: string,
): void {
  if (pattern.pattern_type !== 'correction' || !pattern.domain) return;

  try {
    const skillsDir = projectRoot
      ? `${projectRoot}/.claude/skills`
      : `${os.homedir()}/.claude/skills`;

    const match = findSkillByDomain(skillsDir, pattern.domain);
    if (!match) return; // No matching skill — skip (A10 handles creation)

    const amendment = `## Correction: ${pattern.trigger_context}\n- ${pattern.lesson}${pattern.anti_pattern ? `\n- Avoid: ${pattern.anti_pattern}` : ''}`;

    const success = writeSkillFile(
      pattern.domain,
      { when_to_use: '', body: amendment },
      'amend',
      projectRoot,
    );

    if (success) {
      recordEvent(db, sessionId, project, 'skill_amended', pattern.domain, 'correction_bridged',
        `Appended correction to ${pattern.domain} skill: ${pattern.lesson.substring(0, 80)}`);
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Phase 5: REVIEW — validate candidate patterns before committing
// ---------------------------------------------------------------------------

function reviewCandidatePatterns(
  db: Database,
  project: string,
  candidates: ExtractedPattern[],
  outcome: SessionOutcome,
): ExtractedPattern[] {
  const reviewed: ExtractedPattern[] = [];

  for (const candidate of candidates) {
    // Gate 1: Duplicate check — does a similar pattern already exist?
    try {
      const existing = cachedPrepare(db,
        `SELECT id, trigger_context, lesson, score FROM experience_patterns
         WHERE source_project = ? OR source_project = '__global__'`
      ).all(project) as Array<{ id: string; trigger_context: string; lesson: string; score: number }>;

      let isDuplicate = false;
      for (const ex of existing) {
        // Simple text similarity: check if trigger_context or lesson overlap significantly
        const triggerWords = new Set(candidate.trigger_context.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const existingWords = new Set(ex.trigger_context.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const intersection = [...triggerWords].filter(w => existingWords.has(w));
        const overlap = triggerWords.size > 0 ? intersection.length / triggerWords.size : 0;

        if (overlap > 0.6) {
          // Similar pattern exists — reinforce it instead of creating duplicate
          try {
            cachedPrepare(db,
              `UPDATE experience_patterns SET score = score + 2, times_triggered = times_triggered + 1 WHERE id = ?`
            ).run(ex.id);
          } catch { /* non-fatal */ }
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) continue;
    } catch { /* if dedup check fails, allow the pattern through */ }

    // Gate 2: Quality check — correction patterns need evidence the correction worked
    if (candidate.pattern_type === 'correction') {
      // If session had late corrections (after midpoint), the correction may not have been effective
      if (outcome.lateCorrections && outcome.correctionCount > 3) {
        // Downgrade severity — repeated corrections suggest the pattern isn't clear enough
        candidate.severity = candidate.severity === 'critical' ? 'important' : 'minor';
      }

      // If tests failed after corrections, the correction may have been wrong
      if (outcome.testsFailedCount > outcome.testsPassedCount && outcome.testsFailedCount > 2) {
        // Skip this pattern — negative outcome after correction
        continue;
      }
    }

    // Gate 3: Behavioral patterns from short sessions need higher bar
    if (candidate.pattern_type === 'behavioral' && outcome.durationMinutes < 5) {
      // Very short session — directive may be throwaway, not standing rule
      if (candidate.severity !== 'critical') continue;
    }

    // Gate 4 removed: completedSuccessfully is not a useful signal for pattern quality.
    // The pipeline (getUnprocessedSessions) only feeds completed sessions, making this
    // gate dead code. Even if expanded to non-completed sessions, downgrading severity
    // for incomplete sessions would suppress exactly the corrections that matter most —
    // user frustration strong enough to abandon a session often indicates critical patterns.
    // Quality is better handled by Gates 1-3 (dedup, evidence, short-session bar).

    reviewed.push(candidate);
  }

  return reviewed;
}

// ---------------------------------------------------------------------------
// P3: Extraction manifest — existing context for dedup-aware LLM extraction
// ---------------------------------------------------------------------------

/**
 * Build a manifest of existing patterns and CARA opinions for the LLM.
 * Prevents re-extraction of already-known patterns. Capped at ~1000 chars.
 */
function buildExtractionManifest(
  db: Database,
  project: string,
  sessionId: string,
): string {
  const sections: string[] = [];

  // Recent patterns for this project (top 10 by score)
  try {
    const patterns = cachedPrepare(db,
      `SELECT trigger_context, lesson FROM experience_patterns
       WHERE source_project = ? OR source_project = '__global__'
       ORDER BY score DESC LIMIT 10`
    ).all(project) as Array<{ trigger_context: string; lesson: string }>;

    if (patterns.length > 0) {
      const patternLines = patterns.map(p =>
        `- [${p.trigger_context.substring(0, 50)}] ${p.lesson.substring(0, 80)}`
      );
      sections.push(`Known patterns (do NOT re-extract):\n${patternLines.join('\n')}`);
    }
  } catch { /* non-fatal */ }

  // Active CARA opinions (top 5 by confidence)
  try {
    const opinions = cachedPrepare(db,
      `SELECT subject, opinion, confidence FROM angel_opinions
       WHERE project = ?
       ORDER BY confidence DESC LIMIT 5`
    ).all(project) as Array<{ subject: string; opinion: string; confidence: number }>;

    if (opinions.length > 0) {
      const opinionLines = opinions.map(o =>
        `- ${o.subject}: ${o.opinion.substring(0, 60)} (conf=${o.confidence.toFixed(2)})`
      );
      sections.push(`Active opinions:\n${opinionLines.join('\n')}`);
    }
  } catch { /* non-fatal */ }

  // Session metadata
  try {
    const session = cachedPrepare(db,
      `SELECT name, created_at_epoch FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { name: string | null; created_at_epoch: number } | undefined;

    const turnCount = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM conversation_turns WHERE session_id = ?`
    ).get(sessionId) as { c: number };

    if (session) {
      sections.push(`Session: ${session.name || sessionId.substring(0, 8)}, ${turnCount.c} turns, project=${project}`);
    }
  } catch { /* non-fatal */ }

  const manifest = sections.join('\n\n');
  return manifest.length > 1000 ? manifest.substring(0, 1000) + '...' : manifest;
}

/**
 * Extract patterns from a completed session using a 6-phase analysis pipeline.
 *
 * Phase 1: CONTEXT — gather turns + directive candidates + cross-session repeats
 * Phase 2: ANALYZE — LLM extraction of corrections and directives
 * Phase 3: MEASURE — check session outcomes (corrections, tests, completion)
 * Phase 4: PLAN — determine retrieval_mode and trigger_intents (in LLM prompt)
 * Phase 5: REVIEW — validate candidates (dedup, contradiction, quality gates)
 * Phase 6: COMMIT — create patterns in DB
 *
 * Returns the number of patterns created.
 */
export async function extractPatternsFromSession(
  db: Database,
  sessionId: string,
  project: string,
  maxPatterns: number = 5,
  localModel: string = 'llama3.2',
): Promise<{ patternsCreated: number; summary: string }> {
  try {
    // P2: Read extraction cursor — only process turns after last extraction
    let cursor: number | null = null;
    try {
      const row = cachedPrepare(db,
        `SELECT extraction_cursor FROM sessions WHERE session_id = ?`
      ).get(sessionId) as { extraction_cursor: number | null } | undefined;
      cursor = row?.extraction_cursor ?? null;
    } catch { /* cursor column may not exist yet — process all turns */ }

    // Fetch turns after cursor (with 2-turn overlap for LLM context continuity)
    const overlapStart = cursor != null && cursor > 2 ? cursor - 2 : undefined;
    const turns = getSessionTurns(db, sessionId, overlapStart);
    if (turns.length < 2) {
      return { patternsCreated: 0, summary: 'too few turns' };
    }

    // Skip if no new turns since cursor
    const newTurns = cursor != null
      ? turns.filter(t => t.turn_number > cursor)
      : turns;
    if (newTurns.length === 0) {
      return { patternsCreated: 0, summary: 'no new turns since cursor' };
    }

    // Pre-filter: extract directive candidates from user turns BEFORE truncation
    const directiveCandidates = extractDirectiveCandidates(turns);
    const crossSessionDirectives = findCrossSessionDirectives(db, project, sessionId, directiveCandidates);

    const transcript = formatTranscript(turns);
    if (transcript.length < 100) {
      return { patternsCreated: 0, summary: 'insufficient content' };
    }

    // Prepend directive candidates to transcript so LLM sees them prominently
    const directiveSection = [...crossSessionDirectives, ...directiveCandidates].length > 0
      ? `\n\n--- FLAGGED DIRECTIVE CANDIDATES (pay special attention) ---\n${[...crossSessionDirectives, ...directiveCandidates].join('\n')}\n--- END FLAGGED ---\n\n`
      : '';

    // P3: Build extraction manifest with existing patterns + CARA opinions
    const manifest = buildExtractionManifest(db, project, sessionId);
    const manifestSection = manifest
      ? `\n\n--- EXISTING CONTEXT (do NOT re-extract patterns that overlap with these) ---\n${manifest}\n--- END EXISTING CONTEXT ---\n\n`
      : '';

    const enrichedTranscript = manifestSection + directiveSection + transcript;

    // Call local LLM for pattern extraction. Single path now — Path B
    // collapsed the old CliProxy → Ollama cloud → Ollama local cascade to
    // one call against the local llama-server (Gemma 4 31B IT Q6_K). If the
    // server is down, extraction skips for this tick and retries next
    // heartbeat (the supervisor will have restarted it by then in the
    // common case).
    const userPrompt = `Analyze this session transcript for correction and directive patterns:\n\n${enrichedTranscript}`;
    let responseText = '';

    try {
      responseText = await callLocalLLM({
        system: EXTRACTION_SYSTEM_PROMPT,
        prompt: userPrompt,
      });
    } catch {
      return { patternsCreated: 0, summary: 'llama-server unavailable' };
    }

    if (!responseText) {
      return { patternsCreated: 0, summary: 'empty LLM response' };
    }

    let parsed: { patterns: ExtractedPattern[]; summary: string };
    try {
      // Extract JSON from response using balanced brace matching (not greedy regex).
      // Greedy /\{[\s\S]*\}/ would grab from first { to last } — wrong if response
      // has text after the JSON object.
      // Skips braces inside JSON strings to avoid premature termination on {"msg": "}"}.
      const startIdx = responseText.indexOf('{');
      if (startIdx === -1) return { patternsCreated: 0, summary: 'no JSON in response' };
      let depth = 0;
      let endIdx = -1;
      let inString = false;
      for (let i = startIdx; i < responseText.length; i++) {
        const ch = responseText[i];
        if (inString) {
          if (ch === '\\') { i++; continue; } // skip escaped character
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx === -1) return { patternsCreated: 0, summary: 'no JSON in response' };
      parsed = JSON.parse(responseText.substring(startIdx, endIdx + 1));
    } catch {
      return { patternsCreated: 0, summary: 'failed to parse response' };
    }

    if (!parsed.patterns || !Array.isArray(parsed.patterns)) {
      return { patternsCreated: 0, summary: parsed.summary ?? 'no patterns array' };
    }

    // =====================================================================
    // Phase 3: MEASURE — did the session show improvement after corrections?
    // Check session outcomes: correction count, completion status, and
    // whether later turns show the correction was accepted.
    // =====================================================================
    const sessionOutcome = measureSessionOutcome(db, sessionId);

    // =====================================================================
    // Phase 5: REVIEW — validate each candidate pattern before committing
    // Check for duplicates, contradictions, and quality gates.
    // =====================================================================
    const reviewedPatterns = reviewCandidatePatterns(db, project, parsed.patterns, sessionOutcome);

    // Create patterns (capped at maxPatterns, only those that pass review)
    let created = 0;
    for (const p of reviewedPatterns.slice(0, maxPatterns)) {
      if (!p.trigger_context || !p.lesson) continue;

      try {
        const resolvedType = (p.pattern_type === 'behavioral') ? 'behavioral' : 'correction';
        const patternId = createPattern(db, {
          pattern_type: resolvedType,
          trigger_context: p.trigger_context,
          lesson: p.lesson,
          anti_pattern: p.anti_pattern,
          severity: p.severity ?? 'important',
        }, sessionId, project);

        if (patternId) {
          created++;

          // Set retrieval_mode and trigger_intents from LLM extraction
          try {
            const mode = (p.retrieval_mode === 'always' || p.retrieval_mode === 'categorical')
              ? p.retrieval_mode : 'reactive';
            const intents = Array.isArray(p.trigger_intents)
              ? JSON.stringify(p.trigger_intents.filter((i: string) => typeof i === 'string'))
              : '[]';
            cachedPrepare(db,
              `UPDATE experience_patterns SET retrieval_mode = ?, trigger_intents = ? WHERE id = ?`
            ).run(mode, intents, patternId);
          } catch { /* non-fatal — defaults are fine */ }

          // NOTE: createPattern() already calls embedPattern() internally (fire-and-forget).
          // Do NOT call embedPattern again here — it would double the embedding compute.

          // Create tip→strategy abstraction pair for generalized learning.
          // The tip is the specific correction; the strategy is the generalized rule.
          try {
            createTipAndStrategy(db, {
              pattern_type: resolvedType,
              trigger_context: p.trigger_context,
              lesson: p.lesson,
              anti_pattern: p.anti_pattern,
              severity: p.severity ?? 'important',
            }, sessionId, project);
          } catch { /* non-fatal — tip/strategy is supplementary */ }

          // Record domain interaction if domain was identified
          if (p.domain) {
            recordDomainInteraction(db, project, p.domain, true);
          }

          // A8: Bridge corrections to existing skills
          bridgeCorrectionToSkill(db, sessionId, project, p);
        }
      } catch {
        // Individual pattern creation failure — continue with others
      }
    }

    // P2: Update extraction cursor to max turn_number processed
    try {
      const maxTurn = Math.max(...turns.map(t => t.turn_number));
      cachedPrepare(db,
        `UPDATE sessions SET extraction_cursor = ? WHERE session_id = ?`
      ).run(maxTurn, sessionId);
    } catch { /* non-fatal — cursor update failure doesn't invalidate extraction */ }

    // Record that the Angel processed this session
    recordEvent(db, sessionId, project, 'angel_processed', 'angel', 'extracted',
      `${created} patterns from ${turns.length} turns`);

    return { patternsCreated: created, summary: parsed.summary };
  } catch {
    return { patternsCreated: 0, summary: 'extraction failed' };
  }
}

/**
 * Classify domains for sessions that have thread topics but no capability_boundaries entries.
 * Uses extractDomain() (regex) first, then Ollama for complex topics.
 * Never uses Claude CLI — classification is trivial, local models handle it fine.
 */
export async function classifySessionDomains(
  db: Database,
  sessionId: string,
  project: string,
  localModel: string,
): Promise<number> {
  try {
    // Get thread topic
    const thread = cachedPrepare(db,
      `SELECT topic FROM thread_state WHERE session_id = ?`
    ).get(sessionId) as { topic: string | null } | undefined;

    if (!thread?.topic) return 0;

    // Use the built-in extractDomain for simple cases
    const simpleDomain = extractDomain(thread.topic);
    if (simpleDomain) {
      recordDomainInteraction(db, project, simpleDomain, false);
      return 1;
    }

    // For complex topics, use the local llama-server (Gemma 4 31B Q6_K).
    // maxTokens needs to budget for Gemma's reasoning_content — a naive
    // 32-token budget burns entirely on reasoning and returns empty content.
    // 512 is enough for reasoning overhead + a short domain response.
    let domain = '';
    const classifyPrompt = `Classify this session topic into a single technical domain (1-2 words, lowercase). Topic: "${thread.topic}". Respond with just the domain name, nothing else.`;

    try {
      const raw = await callLocalLLM({
        prompt: classifyPrompt,
        maxTokens: 512,
      });
      domain = raw.toLowerCase().split('\n')[0];
    } catch { /* llama-server not available — skip classification */ }

    if (domain && domain.length < 50) {
      recordDomainInteraction(db, project, domain, false);
      return 1;
    }

    return 0;
  } catch {
    return 0;
  }
}

