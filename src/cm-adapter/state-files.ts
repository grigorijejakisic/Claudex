/**
 * CM adapter in-session state persistence layer. Distinct from core checkpoint state-files (src/checkpoint/).
 *
 * Ported from OpenClaw Context Manager's context-state.ts.
 * Reads/writes decisions, open_items, learnings, resources
 * to ~/.echo/context/state/{sessionId}/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSemanticDuplicate } from './dedup.js';
import { normalizeLearningFingerprint } from './fingerprint.js';
import { sanitizeSessionId, isContainedPath } from '../shared/paths.js';
import { readJsonFile, writeJsonFile } from '../shared/fs-helpers.js';
import {
  ECHO_HOME,
  MAX_DECISIONS,
  MAX_OPEN_ITEMS,
  MAX_LEARNINGS,
  MAX_TOOLS,
  MAX_FILES,
} from './constants.js';
import type { StateFiles, FileAccess } from './types.js';

const STATE_ROOT = path.join(ECHO_HOME, 'context', 'state');

function resolveStateDir(sessionId: string): string {
  const safe = sanitizeSessionId(sessionId);
  if (!safe) throw new Error('Invalid session ID');
  if (safe !== sessionId) throw new Error('Invalid session ID: contains disallowed characters');
  const dir = path.join(STATE_ROOT, safe);
  if (!isContainedPath(dir, STATE_ROOT)) {
    throw new Error('Session ID resolves outside state root');
  }
  return dir;
}

function emptyResources(): StateFiles['resources'] {
  return { files: [], tools_used: [] };
}

export async function ensureStateDir(sessionId: string): Promise<string> {
  const dir = resolveStateDir(sessionId);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type StateFileField = 'decisions' | 'thread' | 'resources' | 'open_items' | 'learnings';

export async function readStateFiles(
  sessionId: string,
  fields?: StateFileField[],
): Promise<Partial<StateFiles>> {
  const dir = resolveStateDir(sessionId);
  const result: Partial<StateFiles> = {};
  const all = !fields;

  const reads: Promise<void>[] = [];

  if (all || fields!.includes('decisions'))
    reads.push(readJsonFile<StateFiles['decisions']>(path.join(dir, 'decisions.json'), []).then(v => { result.decisions = v; }));
  if (fields?.includes('thread'))
    reads.push(readJsonFile<StateFiles['thread']>(path.join(dir, 'thread.json'), []).then(v => { result.thread = v; }));
  if (all || fields!.includes('resources'))
    reads.push(readJsonFile<StateFiles['resources']>(path.join(dir, 'resources.json'), emptyResources()).then(v => { result.resources = v; }));
  if (all || fields!.includes('open_items'))
    reads.push(readJsonFile<StateFiles['open_items']>(path.join(dir, 'open_items.json'), []).then(v => { result.open_items = v; }));
  if (all || fields!.includes('learnings'))
    reads.push(readJsonFile<StateFiles['learnings']>(path.join(dir, 'learnings.json'), []).then(v => { result.learnings = v; }));

  await Promise.all(reads);
  return result;
}

export async function appendDecision(
  sessionId: string,
  decision: { what: string; when: string },
): Promise<void> {
  await ensureStateDir(sessionId);
  const dir = resolveStateDir(sessionId);
  const filePath = path.join(dir, 'decisions.json');

  const decisions = await readJsonFile<StateFiles['decisions']>(filePath, []);
  if (decisions.length >= MAX_DECISIONS) return;
  if (decisions.some(d => isSemanticDuplicate(d.what, decision.what))) return;

  const id = `d${decisions.length + 1}`;
  decisions.push({ id, ...decision });
  await writeJsonFile(filePath, decisions);
}

export async function appendOpenItem(sessionId: string, item: string): Promise<void> {
  await ensureStateDir(sessionId);
  const dir = resolveStateDir(sessionId);
  const filePath = path.join(dir, 'open_items.json');

  const items = await readJsonFile<StateFiles['open_items']>(filePath, []);
  if (items.some(existing => isSemanticDuplicate(existing, item))) return;
  if (items.length >= MAX_OPEN_ITEMS) return;

  items.push(item);
  await writeJsonFile(filePath, items);
}

export async function batchAppendOpenItems(sessionId: string, newItems: string[]): Promise<void> {
  if (newItems.length === 0) return;

  await ensureStateDir(sessionId);
  const dir = resolveStateDir(sessionId);
  const filePath = path.join(dir, 'open_items.json');

  const items = await readJsonFile<StateFiles['open_items']>(filePath, []);

  for (const item of newItems) {
    if (items.length >= MAX_OPEN_ITEMS) break;
    if (items.some(existing => isSemanticDuplicate(existing, item))) continue;
    items.push(item);
  }

  await writeJsonFile(filePath, items);
}

export async function appendLearning(
  sessionId: string,
  learning: { text: string; when: string },
): Promise<void> {
  await ensureStateDir(sessionId);
  const dir = resolveStateDir(sessionId);
  const filePath = path.join(dir, 'learnings.json');

  const learnings = await readJsonFile<StateFiles['learnings']>(filePath, []);
  if (learnings.length >= MAX_LEARNINGS) return;

  const fp = normalizeLearningFingerprint(learning.text);
  if (learnings.some(l => normalizeLearningFingerprint(l.text) === fp)) return;

  learnings.push(learning);
  await writeJsonFile(filePath, learnings);
}

export function scoreFileAccess(file: FileAccess, now: Date = new Date()): number {
  const lastAccessed = new Date(file.last_accessed).getTime();
  const ageMinutes = Number.isNaN(lastAccessed)
    ? 0
    : Math.max(0, (now.getTime() - lastAccessed) / 60000);
  const recency = Math.exp(-0.003 * ageMinutes);
  const kindBonus = file.kind === 'modified' ? 1.5 : 1.0;
  return file.access_count * recency * kindBonus;
}

export async function appendResourceUsage(
  sessionId: string,
  toolName: string,
  filePath?: string | null,
  kind?: 'read' | 'modified',
): Promise<void> {
  await ensureStateDir(sessionId);
  const dir = resolveStateDir(sessionId);
  const resourcesPath = path.join(dir, 'resources.json');

  const resources = await readJsonFile<StateFiles['resources']>(resourcesPath, emptyResources());
  let changed = false;

  // Track tool
  if (!resources.tools_used.includes(toolName) && resources.tools_used.length < MAX_TOOLS) {
    resources.tools_used.push(toolName);
    changed = true;
  }

  // Track file
  if (filePath && kind) {
    const now = new Date().toISOString();
    const existing = resources.files.find(f => f.path === filePath);

    if (existing) {
      existing.access_count++;
      existing.last_accessed = now;
      changed = true;
      if (kind === 'modified' && existing.kind === 'read') {
        existing.kind = 'modified';
      }
    } else {
      if (resources.files.length >= MAX_FILES) {
        const nowDate = new Date();
        let minIdx = 0;
        let minScore = scoreFileAccess(resources.files[0]!, nowDate);
        for (let i = 1; i < resources.files.length; i++) {
          const s = scoreFileAccess(resources.files[i]!, nowDate);
          if (s < minScore) { minScore = s; minIdx = i; }
        }
        resources.files.splice(minIdx, 1);
      }
      resources.files.push({ path: filePath, access_count: 1, last_accessed: now, kind });
      changed = true;
    }
  }

  if (!changed) return;
  await writeJsonFile(resourcesPath, resources);
}

export async function resetStateFiles(
  sessionId: string,
  fields?: StateFileField[],
): Promise<void> {
  const dir = resolveStateDir(sessionId);
  const filesToReset = fields
    ? fields.filter(f => f !== 'thread')
    : (['decisions', 'open_items', 'learnings', 'resources'] as const);

  await Promise.all(
    filesToReset.map(f =>
      writeJsonFile(path.join(dir, `${f}.json`), f === 'resources' ? emptyResources() : []),
    ),
  );
}
