/**
 * CM Adapter — Cross-Session Learnings
 *
 * Ported from OpenClaw Context Manager's context-learnings.ts.
 * Agent-scoped storage at ~/.echo/context/learnings/echo/learnings.json
 * with promotion counts, 50-entry cap, and fingerprint dedup.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CrossSessionLearningsStore } from './types.js';

const ECHO_HOME = path.join(os.homedir(), '.echo');
const AGENT_ID = 'echo';
const MAX_ENTRIES = 50;

function learningsDir(): string {
  return path.join(ECHO_HOME, 'context', 'learnings', AGENT_ID);
}

function learningsPath(): string {
  return path.join(learningsDir(), 'learnings.json');
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  await fs.promises.writeFile(tmp, content, { encoding: 'utf-8' });

  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM' || code === 'EEXIST') {
      await fs.promises.copyFile(tmp, filePath);
      await fs.promises.chmod(filePath, 0o600).catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      return;
    }
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

const EMPTY_STORE: CrossSessionLearningsStore = { version: 1, max_entries: 50, learnings: [] };

export async function readCrossSessionLearnings(): Promise<CrossSessionLearningsStore> {
  try {
    const raw = await fs.promises.readFile(learningsPath(), 'utf-8');
    return JSON.parse(raw) as CrossSessionLearningsStore;
  } catch {
    return { ...EMPTY_STORE, learnings: [] };
  }
}

async function writeCrossSessionLearnings(store: CrossSessionLearningsStore): Promise<void> {
  const dir = learningsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await atomicWriteFile(learningsPath(), JSON.stringify(store, null, 2));
}

function fingerprint(text: string): string {
  return text.toLowerCase().trim().replace(/^[-*\u2022]\s*/, '').replace(/\s+/g, ' ');
}

/**
 * Promote in-session learnings to cross-session store.
 * Increments promotion_count for existing entries, adds new ones,
 * evicts oldest when over capacity.
 */
export async function promoteLearnings(
  learnings: Array<{ text: string; when: string }>,
  checkpointId: string,
  sessionId: string,
): Promise<void> {
  const store = await readCrossSessionLearnings();
  const now = new Date().toISOString();

  for (const learning of learnings) {
    const fp = fingerprint(learning.text);
    const existing = store.learnings.find(l => fingerprint(l.text) === fp);

    if (existing) {
      if (existing.last_checkpoint_id === checkpointId) continue;
      existing.promotion_count++;
      existing.last_promoted_at = now;
      existing.last_checkpoint_id = checkpointId;
    } else {
      store.learnings.push({
        id: crypto.randomUUID(),
        text: learning.text,
        source_session: sessionId,
        created_at: learning.when || now,
        last_promoted_at: now,
        promotion_count: 1,
        last_checkpoint_id: checkpointId,
      });
    }
  }

  if (store.learnings.length > MAX_ENTRIES) {
    store.learnings.sort(
      (a, b) => new Date(a.last_promoted_at).getTime() - new Date(b.last_promoted_at).getTime(),
    );
    store.learnings = store.learnings.slice(-MAX_ENTRIES);
  }

  await writeCrossSessionLearnings(store);
}
