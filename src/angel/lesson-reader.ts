/**
 * Phase 4.1 lesson file reader.
 *
 * Parses YAML-subset frontmatter + markdown body. Non-throwing — every
 * malformed-input branch returns null. The caller logs and continues; one
 * malformed file should not stop the consumer.
 *
 * Parsing rules:
 *   - Frontmatter delimited by `---` lines. First and last `---` define bounds.
 *   - YAML subset: `key: value` for scalars, `key: [a, b, c]` for inline
 *     lists, nested `key:` followed by indented `subkey: value` for blocks.
 *   - Comments (` # ...` after a value) are stripped from scalar values;
 *     list items are not comment-stripped (we don't author comments inside
 *     lists).
 *   - Body is everything after the closing `---`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToCcSlug } from '../shared/cc-slug.js';
import { resolveProjectPath } from '../shared/scope-detector.js';
import type {
  ParsedLesson,
  LessonFrontmatter,
  TelemetryHandles,
  ShapeHandles,
  LessonType,
} from './lesson-types.js';

const FILENAME_RE = /^(feedback|project|process)_([a-z0-9][a-z0-9_-]{0,59})\.md$/;

export function parseLessonFile(filePath: string): ParsedLesson | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const filename = path.basename(filePath);
  const filenameMatch = FILENAME_RE.exec(filename);
  if (!filenameMatch) return null;
  const filenamePrefix = filenameMatch[1] as 'feedback' | 'project' | 'process';

  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx < 0) return null;

  const frontmatterRaw = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).replace(/^\n+/, '');

  const fm = parseFrontmatter(frontmatterRaw);
  if (!fm) return null;
  if (fm.type !== filenamePrefix) {
    // Filename-frontmatter mismatch — refuse rather than guess.
    return null;
  }

  return {
    path: filePath,
    filename,
    frontmatter: fm,
    body,
    filenamePrefix,
  };
}

/**
 * List all lesson files for a project. Returns ParsedLesson[] sorted by
 * filename ASC for deterministic ordering. Malformed files are skipped
 * silently — the caller should not get partial/null entries.
 */
export function listLessonsForProject(project: string): ParsedLesson[] {
  const projectPath = resolveProjectPath(project);
  const ccSlug = projectPath
    ? pathToCcSlug(projectPath)
    : (/[\\/:]/.test(project) ? pathToCcSlug(project) : project);
  const memDir = path.join(os.homedir(), '.claude', 'projects', ccSlug, 'memory');

  if (!fs.existsSync(memDir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(memDir);
  } catch {
    return [];
  }

  const out: ParsedLesson[] = [];
  for (const name of entries.sort()) {
    if (!FILENAME_RE.test(name)) continue;
    const parsed = parseLessonFile(path.join(memDir, name));
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal frontmatter parser
// ---------------------------------------------------------------------------

interface ParserState {
  type?: LessonType;
  created_at_epoch_ms?: number;
  telemetry?: Partial<TelemetryHandles>;
  shape?: ShapeHandles;
  tier?: 'foreground' | 'background';
  last_fired_at_epoch?: number;
  // Phase 14-07h: trigger field
  trigger?: string;
}

function parseFrontmatter(raw: string): LessonFrontmatter | null {
  const lines = raw.split('\n');
  const state: ParserState = {};
  let currentBlock: 'telemetry' | 'shape' | null = null;

  for (const line of lines) {
    if (line.length === 0) {
      currentBlock = null;
      continue;
    }

    // Top-level keys (no leading whitespace)
    const topMatch = /^([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (topMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      const [, key, valueRaw] = topMatch;
      const value = valueRaw.trim();
      if (key === 'telemetry') { state.telemetry = {}; currentBlock = 'telemetry'; continue; }
      if (key === 'shape') { state.shape = {}; currentBlock = 'shape'; continue; }
      currentBlock = null;

      if (key === 'type') {
        if (value !== 'feedback' && value !== 'project' && value !== 'process') return null;
        state.type = value as LessonType;
      } else if (key === 'created_at_epoch_ms') {
        // V35+: canonical field name
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        state.created_at_epoch_ms = n;
      } else if (key === 'created_at_epoch') {
        // Legacy field name (pre-V35): auto-upgrade to ms on read
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        // If value looks like seconds (< 1e12), scale to ms
        state.created_at_epoch_ms = n < 1e12 ? n * 1000 : n;
      } else if (key === 'tier') {
        if (value === 'foreground' || value === 'background') state.tier = value;
      } else if (key === 'last_fired_at_epoch') {
        const n = Number(value);
        if (Number.isFinite(n)) state.last_fired_at_epoch = n;
      }
      continue;
    }

    // Block subkeys (indented)
    const subMatch = /^\s+([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (subMatch && currentBlock) {
      const [, key, valueRaw] = subMatch;
      const value = valueRaw.trim();

      if (currentBlock === 'telemetry') {
        const t = state.telemetry!;
        if (key === 'tools_used') t.tools_used = parseInlineList(value);
        else if (key === 'files_touched') t.files_touched = parseInlineList(value);
        else if (key === 'errors_encountered') t.errors_encountered = parseInlineList(value);
        else if (key === 'user_framing_tokens') t.user_framing_tokens = parseInlineList(value);
        else if (key === 'session_arc') t.session_arc = parseInlineList(value);
        else if (key === 'triggered_by') t.triggered_by = parseInlineList(value);
        else if (key === 'duration_min') t.duration_min = Number(value);
        else if (key === 'correction_count') t.correction_count = Number(value);
      } else if (currentBlock === 'shape') {
        if (key === 'task_shape') state.shape!.task_shape = value;
        else if (key === 'failure_mode') state.shape!.failure_mode = value;
        else if (key === 'solution_pattern') state.shape!.solution_pattern = value;
      }
    }
  }

  // Validate: only `type` is strictly required. created_at_epoch_ms + telemetry
  // were Phase 4.1 requirements; relaxed to defaults so user-style memory
  // files (with just `type: feedback / project / process` + originSessionId)
  // also load. Existing telemetry-shaped files preserve their data unchanged.
  // Legacy `created_at_epoch` (pre-V35) is auto-upgraded to ms on read above.
  if (!state.type) return null;
  const t = state.telemetry ?? {};
  return {
    type: state.type,
    created_at_epoch_ms: state.created_at_epoch_ms ?? 0,
    telemetry: {
      tools_used: Array.isArray(t.tools_used) ? t.tools_used : [],
      files_touched: Array.isArray(t.files_touched) ? t.files_touched : [],
      errors_encountered: Array.isArray(t.errors_encountered) ? t.errors_encountered : [],
      user_framing_tokens: Array.isArray(t.user_framing_tokens) ? t.user_framing_tokens : [],
      session_arc: Array.isArray(t.session_arc) ? t.session_arc : [],
      triggered_by: Array.isArray(t.triggered_by) ? t.triggered_by : [],
      duration_min: typeof t.duration_min === 'number' ? t.duration_min : 0,
      correction_count: typeof t.correction_count === 'number' ? t.correction_count : 0,
    } as TelemetryHandles,
    shape: state.shape,
    tier: state.tier,
    last_fired_at_epoch: state.last_fired_at_epoch,
  };
}

function parseInlineList(raw: string): string[] {
  // Expect `[a, b, c]` or `[]`
  const m = /^\[(.*)\]$/.exec(raw);
  if (!m) return [];
  const inner = m[1].trim();
  if (inner.length === 0) return [];
  return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
}
