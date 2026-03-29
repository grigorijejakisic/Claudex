/**
 * Angel Pattern Extractor — reads conversation_turns holistically to detect corrections.
 *
 * This is the key advantage of the Angel over ephemeral hooks: it sees the FULL
 * conversation, not a 2-second snapshot. It can identify corrections that span
 * multiple turns, understand the context of why something was corrected, and
 * create high-confidence patterns.
 *
 * Uses Claude API for analysis — the Angel has time and the user has MAX subscription.
 *
 * Non-throwing — returns empty results on error.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { createPattern, createTipAndStrategy } from '../intelligence/experience-patterns.js';
import { recordDomainInteraction, extractDomain } from '../intelligence/capability-tracker.js';
import { recordEvent } from '../core/session-events.js';
import type { ConversationTurn, ExtractedPattern } from './types.js';

/**
 * Get all conversation turns for a session, ordered by turn number.
 */
export function getSessionTurns(
  db: Database,
  sessionId: string,
): ConversationTurn[] {
  try {
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
 * Format conversation turns into a readable transcript for Claude analysis.
 * Truncates individual turns to keep total under ~8000 chars.
 */
function formatTranscript(turns: ConversationTurn[]): string {
  const parts: string[] = [];
  const maxTurnLen = Math.min(1500, Math.floor(8000 / Math.max(turns.length, 1)));

  for (const turn of turns) {
    if (turn.user_text) {
      const text = turn.user_text.length > maxTurnLen
        ? turn.user_text.slice(0, maxTurnLen) + '...'
        : turn.user_text;
      parts.push(`[Turn ${turn.turn_number}] USER: ${text}`);
    }
    if (turn.assistant_text) {
      const text = turn.assistant_text.length > maxTurnLen
        ? turn.assistant_text.slice(0, maxTurnLen) + '...'
        : turn.assistant_text;
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

/**
 * Call Ollama for simple LLM tasks (classification, short extraction).
 * Local, no hooks, no phantom sessions.
 * Returns the response text or throws on failure.
 */
async function callOllama(prompt: string, model: string): Promise<string> {
  const resp = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json() as { response: string };
  return (data.response ?? '').trim();
}

/**
 * Call CliProxy (OpenAI-compatible) for high-quality extraction.
 * Uses Sonnet via local proxy — no API key needed, uses MAX subscription.
 */
async function callCliProxy(system: string, prompt: string, model: string = 'claude-sonnet-4-6'): Promise<string> {
  const resp = await fetch('http://127.0.0.1:8317/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer cliproxy-no-key-needed',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2048,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`CliProxy ${resp.status}`);
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

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
 */
function extractDirectiveCandidates(turns: ConversationTurn[]): string[] {
  const candidates: string[] = [];
  for (const turn of turns) {
    if (!turn.user_text) continue;
    const lower = turn.user_text.toLowerCase();
    for (const indicator of DIRECTIVE_INDICATORS) {
      if (lower.includes(indicator)) {
        candidates.push(`[Turn ${turn.turn_number}] [DIRECTIVE CANDIDATE] USER: ${turn.user_text.substring(0, 500)}`);
        break; // One match per turn is enough
      }
    }
  }
  return candidates;
}

/**
 * Detect repeated user directives across sessions.
 * If the same phrase pattern appears in 2+ sessions, it's a standing rule.
 */
function findCrossSessionDirectives(
  db: Database,
  project: string,
  currentDirectives: string[],
): string[] {
  if (currentDirectives.length === 0) return [];
  const repeated: string[] = [];

  for (const directive of currentDirectives) {
    // Extract key phrases (3+ word sequences) from the directive
    const words = directive.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    if (words.length < 3) continue;

    // Search for similar phrases in other sessions' conversation turns
    const searchTerms = words.slice(0, 5).join(' ');
    try {
      const matches = cachedPrepare(db,
        `SELECT DISTINCT ct.session_id FROM conversation_turns ct
         WHERE ct.project = ? AND ct.user_text LIKE ? AND ct.session_id != ?
         LIMIT 3`
      ).all(project, `%${searchTerms.substring(0, 30)}%`, 'current') as Array<{ session_id: string }>;

      if (matches.length >= 1) {
        repeated.push(`[REPEATED ACROSS ${matches.length + 1} SESSIONS] ${directive}`);
      }
    } catch { /* non-fatal */ }
  }

  return repeated;
}

/**
 * Extract patterns from a completed session using Claude API.
 * Reads conversation_turns, sends to Claude for analysis, creates experience_patterns.
 *
 * Returns the number of patterns created.
 */
export async function extractPatternsFromSession(
  db: Database,
  sessionId: string,
  project: string,
  client: Anthropic,
  model: string,
  maxPatterns: number = 5,
  localModel: string = 'llama3.2',
): Promise<{ patternsCreated: number; summary: string }> {
  try {
    const turns = getSessionTurns(db, sessionId);
    if (turns.length < 2) {
      return { patternsCreated: 0, summary: 'too few turns' };
    }

    // Pre-filter: extract directive candidates from user turns BEFORE truncation
    const directiveCandidates = extractDirectiveCandidates(turns);
    const crossSessionDirectives = findCrossSessionDirectives(db, project, directiveCandidates);

    const transcript = formatTranscript(turns);
    if (transcript.length < 100) {
      return { patternsCreated: 0, summary: 'insufficient content' };
    }

    // Prepend directive candidates to transcript so LLM sees them prominently
    const directiveSection = [...crossSessionDirectives, ...directiveCandidates].length > 0
      ? `\n\n--- FLAGGED DIRECTIVE CANDIDATES (pay special attention) ---\n${[...crossSessionDirectives, ...directiveCandidates].join('\n')}\n--- END FLAGGED ---\n\n`
      : '';

    const enrichedTranscript = directiveSection + transcript;

    // Call LLM for pattern extraction
    // Priority: CliProxy (Sonnet) → Anthropic API → Ollama fallback
    // Never use Claude CLI subprocess — it triggers hooks and creates phantom sessions.
    const userPrompt = `Analyze this session transcript for correction and directive patterns:\n\n${enrichedTranscript}`;
    let responseText = '';

    // Priority 1: CliProxy (Sonnet via local proxy — best quality for directive detection)
    try {
      responseText = await callCliProxy(EXTRACTION_SYSTEM_PROMPT, userPrompt);
    } catch { /* CliProxy unavailable — fall through */ }

    // Priority 2: Anthropic API (direct — CliProxy may be down)
    if (!responseText) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        });
        responseText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('');
      } catch { /* API failed — fall through to Ollama */ }
    }

    // Priority 3: Ollama cloud models (capable, free via Ollama cloud routing)
    if (!responseText) {
      const cloudModels = ['deepseek-v3.2:cloud', 'cogito-2.1:671b-cloud', 'qwen3.5:397b-cloud'];
      for (const cloudModel of cloudModels) {
        try {
          const fullPrompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n${userPrompt}`;
          responseText = await callOllama(fullPrompt, cloudModel);
          if (responseText) break;
        } catch { /* try next model */ }
      }
    }

    // Priority 4: Ollama local (last resort — small model, lower quality)
    if (!responseText) {
      try {
        const fullPrompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n${userPrompt}`;
        responseText = await callOllama(fullPrompt, localModel);
      } catch {
        return { patternsCreated: 0, summary: 'no LLM available (CliProxy + API + Ollama cloud + local all failed)' };
      }
    }

    if (!responseText) {
      return { patternsCreated: 0, summary: 'empty LLM response' };
    }

    let parsed: { patterns: ExtractedPattern[]; summary: string };
    try {
      // Extract JSON from response (may have markdown code fences)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { patternsCreated: 0, summary: 'no JSON in response' };
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { patternsCreated: 0, summary: 'failed to parse response' };
    }

    if (!parsed.patterns || !Array.isArray(parsed.patterns)) {
      return { patternsCreated: 0, summary: parsed.summary ?? 'no patterns array' };
    }

    // Create patterns (capped at maxPatterns)
    let created = 0;
    for (const p of parsed.patterns.slice(0, maxPatterns)) {
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
        }
      } catch {
        // Individual pattern creation failure — continue with others
      }
    }

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

    // For complex topics, use Ollama (local, no hooks, no phantom sessions)
    let domain = '';
    const classifyPrompt = `Classify this session topic into a single technical domain (1-2 words, lowercase). Topic: "${thread.topic}". Respond with just the domain name, nothing else.`;

    try {
      domain = (await callOllama(classifyPrompt, localModel)).toLowerCase().split('\n')[0];
    } catch { /* Ollama not available — skip classification */ }

    if (domain && domain.length < 50) {
      recordDomainInteraction(db, project, domain, false);
      return 1;
    }

    return 0;
  } catch {
    return 0;
  }
}
