/**
 * Shared transcript tail reader -- reads last N bytes of a JSONL transcript
 * and parses user/assistant message entries.
 */
import * as fs from 'node:fs';

export interface TranscriptEntry {
  role: string;
  text: string;
}

/**
 * Read the tail of a JSONL transcript file and extract message entries.
 * @param transcriptPath Path to the .jsonl transcript
 * @param bytesToRead Max bytes to read from end (default 30000)
 * @returns Array of parsed entries with role and text
 */
export function readTranscriptTail(
  transcriptPath: string,
  bytesToRead = 30000,
): TranscriptEntry[] {
  if (!fs.existsSync(transcriptPath)) return [];

  const fd = fs.openSync(transcriptPath, 'r');
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(bytesToRead, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    text = buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }

  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const role = typeof entry?.message?.role === 'string' ? entry.message.role : undefined;
      const content = entry?.message?.content;
      if (!role || !content) continue;

      let messageText = '';
      if (typeof content === 'string') {
        messageText = content;
      } else if (Array.isArray(content)) {
        messageText = content
          .filter((b: Record<string, unknown>) => b?.type === 'text')
          .map((b: Record<string, unknown>) => (typeof b?.text === 'string' ? b.text : ''))
          .join('\n');
      }

      if (messageText) {
        entries.push({ role, text: messageText });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
