/**
 * Canonical Session IR — intermediate representation for cross-agent sessions.
 *
 * Normalizes session transcripts from different agents into a common format
 * that can be stored, searched, and transferred between systems.
 *
 * Inspired by CASS's cross_agent_session_resumer (13+ format support).
 * Non-throwing throughout.
 */

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
}

export interface CanonicalSession {
  id: string;
  provider: string;
  project?: string;
  topic?: string;
  messages: CanonicalMessage[];
  startedAt?: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Normalize a Claude Code JSONL transcript to canonical format.
 */
export function fromClaudeCode(jsonlContent: string, sessionId?: string): CanonicalSession | null {
  try {
    const messages: CanonicalMessage[] = [];
    for (const line of jsonlContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.message?.role) {
          const content = typeof msg.message.content === 'string'
            ? msg.message.content
            : Array.isArray(msg.message.content)
              ? msg.message.content
                  .filter((b: Record<string, unknown>) => b.type === 'text')
                  .map((b: Record<string, unknown>) => b.text)
                  .join('')
              : '';
          if (content) {
            messages.push({
              role: msg.message.role as CanonicalMessage['role'],
              content: content.slice(0, 2000),
              timestamp: msg.timestamp ? Math.floor(new Date(msg.timestamp as string).getTime() / 1000) : undefined,
            });
          }
        }
      } catch { /* skip malformed */ }
    }
    if (messages.length === 0) return null;
    return { id: sessionId ?? `cc-${Date.now()}`, provider: 'claude-code', messages };
  } catch { return null; }
}

/**
 * Normalize a Codex session to canonical format.
 * Codex uses similar JSONL with role/content structure.
 */
export function fromCodex(jsonlContent: string, sessionId?: string): CanonicalSession | null {
  try {
    const messages: CanonicalMessage[] = [];
    for (const line of jsonlContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const role = msg.role ?? msg.type;
        const content = typeof msg.content === 'string' ? msg.content
          : msg.text ?? msg.message ?? '';
        if (role && content) {
          messages.push({
            role: role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant',
            content: content.slice(0, 2000),
            timestamp: msg.timestamp ? Math.floor(new Date(msg.timestamp as string).getTime() / 1000) : undefined,
          });
        }
      } catch { /* skip */ }
    }
    if (messages.length === 0) return null;
    return { id: sessionId ?? `codex-${Date.now()}`, provider: 'codex', messages };
  } catch { return null; }
}

/**
 * Normalize a Gemini CLI session.
 */
export function fromGeminiCli(jsonContent: string, sessionId?: string): CanonicalSession | null {
  try {
    const data = JSON.parse(jsonContent);
    const messages: CanonicalMessage[] = [];

    const history = Array.isArray(data) ? data : data.history ?? data.messages ?? [];
    for (const msg of history) {
      const role = msg.role ?? (msg.author === 'user' ? 'user' : 'assistant');
      const content = typeof msg.content === 'string' ? msg.content
        : msg.parts?.map((p: Record<string, unknown>) => p.text).filter(Boolean).join('') ?? '';
      if (content) {
        messages.push({
          role: role === 'user' ? 'user' : 'assistant',
          content: content.slice(0, 2000),
        });
      }
    }

    if (messages.length === 0) return null;
    return { id: sessionId ?? `gemini-${Date.now()}`, provider: 'gemini-cli', messages };
  } catch { return null; }
}

/**
 * Normalize an Aider chat history (markdown format).
 */
export function fromAider(markdownContent: string, sessionId?: string): CanonicalSession | null {
  try {
    const messages: CanonicalMessage[] = [];
    // Aider uses #### headers to separate messages
    const blocks = markdownContent.split(/^#{1,4}\s+/m).filter(b => b.trim().length > 20);

    for (const block of blocks) {
      const isUser = /^(user|human|prompt)/i.test(block);
      messages.push({
        role: isUser ? 'user' : 'assistant',
        content: block.slice(0, 2000).trim(),
      });
    }

    if (messages.length === 0) return null;
    return { id: sessionId ?? `aider-${Date.now()}`, provider: 'aider', messages };
  } catch { return null; }
}

/**
 * Auto-detect provider and parse.
 */
export function autoDetectAndParse(
  content: string,
  filePath?: string,
  sessionId?: string,
): CanonicalSession | null {
  // Try JSONL first (Claude Code, Codex)
  if (content.trim().startsWith('{')) {
    const lines = content.split('\n').filter(l => l.trim().startsWith('{'));
    if (lines.length > 1) {
      // JSONL — check for Claude Code markers
      if (content.includes('"slug"') || content.includes('"sessionId"')) {
        return fromClaudeCode(content, sessionId);
      }
      return fromCodex(content, sessionId);
    }
    // Single JSON — likely Gemini
    return fromGeminiCli(content, sessionId);
  }

  // Markdown — likely Aider
  if (content.includes('####') || filePath?.includes('aider')) {
    return fromAider(content, sessionId);
  }

  return null;
}

/**
 * Export a canonical session to a readable summary string.
 */
export function toSummary(session: CanonicalSession, maxTokens: number = 2000): string {
  const lines: string[] = [];
  lines.push(`Provider: ${session.provider} | Messages: ${session.messages.length}`);
  if (session.topic) lines.push(`Topic: ${session.topic}`);

  let chars = lines.join('\n').length;
  const charBudget = maxTokens * 4; // ~4 chars per token

  for (const msg of session.messages) {
    const line = `[${msg.role}] ${msg.content.slice(0, 200)}`;
    if (chars + line.length > charBudget) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join('\n');
}
