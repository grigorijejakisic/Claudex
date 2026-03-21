/**
 * Centralized tool catalog — single source of truth for tool names,
 * key fields, behavior hints, and observation categories.
 * All extraction, quality-gate, and scoring modules import from here.
 */

import type { ObservationCategory } from '../core/observations.js';

/** Metadata for a single known tool. */
export interface ToolDefinition {
  /** Canonical tool name (PascalCase, matches host tool_name). */
  name: string;
  /** Input fields the extractor reads from toolInput. */
  keyFields: string[];
  /** Behavioral tags describing what the tool does. */
  behaviorHints: string[];
  /** Default observation category when no keyword match. */
  defaultCategory: ObservationCategory;
}

/**
 * Authoritative catalog of all known tools.
 * Keys match the exact tool_name strings sent by CC/OpenClaw hosts.
 */
export const TOOL_CATALOG: Record<string, ToolDefinition> = {
  Read: {
    name: 'Read',
    keyFields: ['file_path', 'filePath'],
    behaviorHints: ['file-reading'],
    defaultCategory: 'code',
  },
  Edit: {
    name: 'Edit',
    keyFields: ['file_path', 'filePath', 'old_string', 'oldString', 'new_string', 'newString'],
    behaviorHints: ['file-modifying'],
    defaultCategory: 'code',
  },
  Write: {
    name: 'Write',
    keyFields: ['file_path', 'filePath', 'content'],
    behaviorHints: ['file-creating'],
    defaultCategory: 'code',
  },
  Bash: {
    name: 'Bash',
    keyFields: ['command'],
    behaviorHints: ['command-execution'],
    defaultCategory: 'other',
  },
  Grep: {
    name: 'Grep',
    keyFields: ['pattern'],
    behaviorHints: ['search', 'file-reading'],
    defaultCategory: 'code',
  },
  Glob: {
    name: 'Glob',
    keyFields: ['pattern'],
    behaviorHints: ['search', 'file-reading'],
    defaultCategory: 'code',
  },
  WebFetch: {
    name: 'WebFetch',
    keyFields: ['url', 'URL'],
    behaviorHints: ['network', 'web-reading'],
    defaultCategory: 'other',
  },
  WebSearch: {
    name: 'WebSearch',
    keyFields: ['query'],
    behaviorHints: ['network', 'search'],
    defaultCategory: 'other',
  },
  Task: {
    name: 'Task',
    keyFields: ['description', 'task', 'name'],
    behaviorHints: ['agent-delegation'],
    defaultCategory: 'other',
  },
  NotebookEdit: {
    name: 'NotebookEdit',
    keyFields: ['cell_id', 'cellId', 'cell', 'notebook', 'file_path', 'filePath'],
    behaviorHints: ['file-modifying', 'notebook'],
    defaultCategory: 'code',
  },
} as const;

/**
 * Set of tool names whose default category is 'code'.
 * Used by scoring.ts classifyCategory for the file-related default.
 */
export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(TOOL_CATALOG)
    .filter((def) => def.defaultCategory === 'code')
    .map((def) => def.name)
);

/**
 * Read-only tools whose output is file content, not tool errors.
 * Keyword scanning on these produces false positives (source code containing
 * "error" in try/catch is not an error observation).
 * Used by scoring.ts (classifyCategory) and type-classifier.ts (classifyObservationType).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);

