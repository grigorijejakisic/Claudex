/**
 * Cross-Agent Session Indexer — learn from sessions across multiple coding agents.
 *
 * Indexes sessions from other agents (Codex, Gemini CLI, Cursor, Aider) by
 * reading their transcript/history files, normalizing to a common format,
 * and extracting observations + decisions into Claudex's DB.
 *
 * Known agent transcript locations (Windows):
 *   - Codex: ~/.codex/sessions/
 *   - Gemini CLI: ~/.gemini/sessions/
 *   - Cursor: ~/.cursor/chat/ (SQLite)
 *   - Aider: .aider.chat.history.md (per-project)
 *   - Claude Code: ~/.claude/projects/ (JSONL)
 *
 * Inspired by CASS's 11+ provider indexing.
 * Non-throwing throughout.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export interface AgentProvider {
  name: string;
  detectPaths: () => string[];
  parseTranscript: (filePath: string) => ParsedTurn[];
}

export interface ParsedTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: number;
  toolName?: string;
}

export interface IndexResult {
  provider: string;
  sessionsFound: number;
  sessionsIndexed: number;
  observationsCreated: number;
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const HOME = os.homedir();

function detectCodexSessions(): string[] {
  try {
    const dir = path.join(HOME, '.codex', 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
      .map(f => path.join(dir, f))
      .slice(-20); // Last 20 sessions
  } catch { return []; }
}

function detectGeminiSessions(): string[] {
  try {
    const dir = path.join(HOME, '.gemini', 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
      .map(f => path.join(dir, f))
      .slice(-20);
  } catch { return []; }
}

function detectAiderHistory(): string[] {
  try {
    // Aider stores history in project root
    const candidates = [
      path.join(process.cwd(), '.aider.chat.history.md'),
      path.join(process.cwd(), '.aider.history'),
    ];
    return candidates.filter(f => fs.existsSync(f));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Transcript parsing (lightweight — extract key exchanges)
// ---------------------------------------------------------------------------

function parseJsonlTranscript(filePath: string): ParsedTurn[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const turns: ParsedTurn[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const role = msg.role ?? (msg.type === 'user' ? 'user' : 'assistant');
        const text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter((b: Record<string, unknown>) => b.type === 'text').map((b: Record<string, unknown>) => b.text).join('')
          : msg.message?.content ?? '';

        if (text && text.length > 10) {
          turns.push({
            role: role as ParsedTurn['role'],
            content: text.slice(0, 500),
            timestamp: msg.timestamp ? Math.floor(new Date(msg.timestamp).getTime() / 1000) : undefined,
          });
        }
      } catch { /* skip malformed lines */ }
    }

    return turns;
  } catch { return []; }
}

function parseAiderHistory(filePath: string): ParsedTurn[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const turns: ParsedTurn[] = [];
    const blocks = content.split(/^#{1,4}\s/m);

    for (const block of blocks) {
      if (!block.trim() || block.length < 20) continue;
      const isUser = block.startsWith('user') || block.startsWith('User');
      turns.push({
        role: isUser ? 'user' : 'assistant',
        content: block.slice(0, 500).trim(),
      });
    }

    return turns;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const PROVIDERS: AgentProvider[] = [
  {
    name: 'codex',
    detectPaths: detectCodexSessions,
    parseTranscript: parseJsonlTranscript,
  },
  {
    name: 'gemini-cli',
    detectPaths: detectGeminiSessions,
    parseTranscript: parseJsonlTranscript,
  },
  {
    name: 'aider',
    detectPaths: detectAiderHistory,
    parseTranscript: parseAiderHistory,
  },
];

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Track which files have been indexed to avoid re-processing.
 */
function isAlreadyIndexed(db: Database, filePath: string): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM observations
       WHERE tool_name = 'cross_agent_index' AND title LIKE ?
       LIMIT 1`
    ).get(`%${path.basename(filePath)}%`) as { c: number };
    return row.c > 0;
  } catch { return false; }
}

/**
 * Extract key observations from a parsed session transcript.
 * Focuses on decisions, learnings, and important exchanges.
 */
function extractKeyObservations(
  turns: ParsedTurn[],
  provider: string,
  filePath: string,
): Array<{ title: string; content: string; importance: number }> {
  const observations: Array<{ title: string; content: string; importance: number }> = [];

  // Extract user directives and corrections (high value)
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const lower = turn.content.toLowerCase();

    // Decisions/directives
    if (/\b(always|never|don't|must|should|from now on|remember)\b/i.test(turn.content)) {
      observations.push({
        title: `[${provider}] User directive: ${turn.content.slice(0, 80)}`,
        content: turn.content.slice(0, 300),
        importance: 4,
      });
    }

    // Corrections
    if (/\b(no|wrong|that's not|actually|instead)\b/.test(lower) && turn.content.length > 30) {
      observations.push({
        title: `[${provider}] User correction: ${turn.content.slice(0, 80)}`,
        content: turn.content.slice(0, 300),
        importance: 3,
      });
    }
  }

  // Session summary observation
  if (turns.length > 0) {
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.content.slice(0, 100));
    observations.push({
      title: `[${provider}] Session indexed: ${path.basename(filePath)}`,
      content: `${turns.length} turns. User topics: ${userTurns.slice(0, 3).join(' | ')}`,
      importance: 2,
    });
  }

  return observations.slice(0, 10); // Cap at 10 per session
}

/**
 * Index sessions from all detected agent providers.
 * Called by Angel heartbeat periodically.
 */
export function indexCrossAgentSessions(
  db: Database,
  sessionId: string,
  project: string,
): IndexResult[] {
  const results: IndexResult[] = [];

  for (const provider of PROVIDERS) {
    const result: IndexResult = {
      provider: provider.name,
      sessionsFound: 0,
      sessionsIndexed: 0,
      observationsCreated: 0,
    };

    try {
      const paths = provider.detectPaths();
      result.sessionsFound = paths.length;

      for (const filePath of paths) {
        if (isAlreadyIndexed(db, filePath)) continue;

        const turns = provider.parseTranscript(filePath);
        if (turns.length === 0) continue;

        const observations = extractKeyObservations(turns, provider.name, filePath);

        for (const obs of observations) {
          try {
            cachedPrepare(db,
              `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified)
               VALUES (?, ?, 'cross_agent_index', 'other', ?, ?, ?, '[]')`
            ).run(sessionId, project, obs.title, obs.content, obs.importance);
            result.observationsCreated++;
          } catch { /* dedup or insert failure — skip */ }
        }

        result.sessionsIndexed++;
      }
    } catch { /* provider failure — skip */ }

    results.push(result);
  }

  return results;
}

/**
 * Get supported provider names.
 */
export function getSupportedProviders(): string[] {
  return PROVIDERS.map(p => p.name);
}
