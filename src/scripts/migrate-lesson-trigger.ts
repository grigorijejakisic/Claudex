/**
 * Phase 14-07h — migrate-lesson-trigger.ts
 *
 * Operator-runnable CLI to add `trigger:` field to existing lesson files.
 * Follows Phase 14-01 migrate-handoff.ts patterns.
 *
 * Usage:
 *   bun src/scripts/migrate-lesson-trigger.ts <memory_dir> [options]
 *
 * Options:
 *   --dry-run             Print proposed changes; do not write. (default: true)
 *   --live                Actually write changes (opt-in; negates dry-run default).
 *   --infer               Infer trigger from body first sentence. Refuses on ambiguity.
 *   --trigger '<text>'    Use this trigger for the next matched file. Single-file mode.
 *   --file '<name>'       Limit to a specific lesson file.
 *   --skip-existing       Skip files that already have a trigger field.
 *   --force               Overwrite existing trigger field (requires explicit flag).
 *
 * Exit codes:
 *   0 — success / dry-run-success / idempotent
 *   1 — inference failed / refused
 *   2 — IO error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigratorArgs {
  memoryDir: string;
  dryRun: boolean;
  infer: boolean;
  trigger?: string;
  file?: string;
  skipExisting: boolean;
  force: boolean;
}

export interface MigrationResult {
  file: string;
  status: 'migrated' | 'dry_run' | 'skipped' | 'idempotent' | 'refused' | 'error';
  reason?: string;
  proposedTrigger?: string;
}

// ---------------------------------------------------------------------------
// Lesson filename pattern (mirrors lesson-reader.ts)
// ---------------------------------------------------------------------------

const LESSON_FILENAME_RE = /^(feedback|project|process|reference|user)_([a-z0-9][a-z0-9_-]{0,59})\.md$/;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): MigratorArgs {
  const args = argv.slice(2); // strip node + script

  if (args.length === 0 || args[0].startsWith('--')) {
    process.stderr.write('error: <memory_dir> is required as the first argument\n');
    process.exit(1);
  }

  const memoryDir = args[0];
  let dryRun = true; // default: dry-run
  let infer = false;
  let trigger: string | undefined;
  let file: string | undefined;
  let skipExisting = false;
  let force = false;

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      i++;
    } else if (arg === '--live') {
      dryRun = false;
      i++;
    } else if (arg === '--infer') {
      infer = true;
      i++;
    } else if (arg === '--trigger') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --trigger requires a value\n');
        process.exit(1);
      }
      trigger = args[i];
      i++;
    } else if (arg === '--file') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --file requires a value\n');
        process.exit(1);
      }
      file = args[i];
      i++;
    } else if (arg === '--skip-existing') {
      skipExisting = true;
      i++;
    } else if (arg === '--force') {
      force = true;
      i++;
    } else {
      process.stderr.write(`error: unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }

  // --trigger without --file implies single-file mode: caller must also pass --file.
  // We enforce this gracefully at runtime not at parse time.

  return { memoryDir, dryRun, infer, trigger, file, skipExisting, force };
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal; mirrors lesson-reader.ts subset)
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  raw: string;               // the full raw YAML string between delimiters
  fields: Record<string, string>;  // top-level key: value pairs
  hasTrigger: boolean;
  triggerValue?: string;
}

export interface ParsedLessonFile {
  frontmatter: ParsedFrontmatter;
  body: string;              // content after closing ---
}

export function parseLessonFileBasic(content: string): ParsedLessonFile | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx < 0) return null;

  const rawFm = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).replace(/^\n+/, '');

  const fields: Record<string, string> = {};
  let hasTrigger = false;
  let triggerValue: string | undefined;

  for (const line of rawFm.split('\n')) {
    const m = /^([a-zA-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      const key = m[1];
      let value = m[2].trim().replace(/^["']|["']$/g, '');
      fields[key] = value;
      if (key === 'trigger') {
        hasTrigger = true;
        triggerValue = value.length > 0 ? value : undefined;
      }
    }
  }

  return {
    frontmatter: { raw: rawFm, fields, hasTrigger, triggerValue },
    body,
  };
}

// ---------------------------------------------------------------------------
// Trigger inference
// ---------------------------------------------------------------------------

/**
 * Ambiguity signals in a body's first sentence:
 * - Too short (< 10 chars)
 * - No clear condition anchor (doesn't start with "When ", not actionable)
 * - Vague openers: "This is", "The ", "It is", "There is", etc.
 */
export function inferTriggerFromBody(body: string): { trigger: string } | { refused: string } {
  // Find first non-blank, non-heading line.
  let firstLine = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Strip markdown heading/list markers
    firstLine = trimmed.replace(/^#+\s+|^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    if (firstLine.length > 0) break;
  }

  if (firstLine.length === 0) {
    return { refused: 'body is empty' };
  }

  // Extract first sentence (up to . ? ! or end of string).
  const sentenceMatch = /^([^.?!]+[.?!]?)/.exec(firstLine);
  const firstSentence = sentenceMatch ? sentenceMatch[1].trim() : firstLine;

  if (firstSentence.length < 10) {
    return { refused: `first sentence too short (${firstSentence.length} chars): "${firstSentence}"` };
  }

  // Vague opener patterns — refuse on ambiguity.
  const VAGUE_OPENERS = [
    /^(This is|It is|There is|The |A |An )/i,
    /^(See |Note:|NOTE:|Always |Never )/i,
    /^(good child|bad child)/i,
  ];
  for (const pattern of VAGUE_OPENERS) {
    if (pattern.test(firstSentence)) {
      return { refused: `first sentence is too vague (matches "${pattern.source}"): "${firstSentence}"` };
    }
  }

  // If it already starts with "When ", use verbatim.
  if (/^When /i.test(firstSentence)) {
    return { trigger: firstSentence };
  }

  // Prepend "When [topic] → " heuristic.
  // Extract a 2-3 word topic from the sentence start.
  const topicMatch = /^([A-Z][a-z]+(?:\s+[a-z]+){0,2})/.exec(firstSentence);
  if (topicMatch) {
    const topic = topicMatch[1].toLowerCase();
    return { trigger: `When ${topic} — ${firstSentence}` };
  }

  return { refused: `could not infer trigger from: "${firstSentence}"` };
}

// ---------------------------------------------------------------------------
// Frontmatter serializer (insert/replace trigger field)
// ---------------------------------------------------------------------------

/**
 * Rebuild the frontmatter YAML with the trigger field added or replaced.
 * Preserves all other fields and ordering. trigger is emitted just before
 * the closing `---`.
 */
export function insertTriggerInFrontmatter(rawFm: string, trigger: string): string {
  const lines = rawFm.split('\n');
  // Remove any existing trigger line.
  const filtered = lines.filter(l => !/^trigger:/.test(l));
  // Append trigger before the end.
  filtered.push(`trigger: ${trigger}`);
  return filtered.join('\n');
}

// ---------------------------------------------------------------------------
// Atomic write (reuses pattern from migrate-handoff.ts)
// ---------------------------------------------------------------------------

export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let mode = 0o644;
  try {
    const stat = fs.statSync(filePath);
    mode = stat.mode & 0o777;
  } catch {
    // File doesn't exist yet.
  }

  const tmp = filePath + '.migrate-trigger.tmp';
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Unified diff (simplified)
// ---------------------------------------------------------------------------

function printUnifiedDiff(filePath: string, original: string, updated: string): void {
  const origLines = original.split('\n');
  const updLines = updated.split('\n');

  process.stdout.write(`--- a/${path.basename(filePath)}\n`);
  process.stdout.write(`+++ b/${path.basename(filePath)}\n`);

  const maxLen = Math.max(origLines.length, updLines.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i];
    const upd = updLines[i];
    if (orig !== upd) {
      process.stdout.write(`@@ -${i + 1} +${i + 1} @@\n`);
      if (orig !== undefined) process.stdout.write(`-${orig}\n`);
      if (upd !== undefined) process.stdout.write(`+${upd}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

export function processFile(
  filePath: string,
  args: MigratorArgs,
): MigrationResult {
  const filename = path.basename(filePath);

  // Read file.
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      file: filename,
      status: 'error',
      reason: `cannot read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Parse.
  const parsed = parseLessonFileBasic(raw);
  if (!parsed) {
    return {
      file: filename,
      status: 'refused',
      reason: 'cannot parse frontmatter',
    };
  }

  const { frontmatter, body } = parsed;

  // Existing trigger handling.
  if (frontmatter.hasTrigger) {
    if (args.skipExisting) {
      return { file: filename, status: 'skipped', reason: 'already has trigger (--skip-existing)' };
    }
    if (!args.force) {
      return {
        file: filename,
        status: 'refused',
        reason: `already has trigger: "${frontmatter.triggerValue}". Use --force to overwrite.`,
      };
    }
    // --force: fall through to overwrite.
  }

  // Determine trigger value.
  let triggerValue: string;

  if (args.trigger !== undefined) {
    // Explicit trigger provided.
    triggerValue = args.trigger.trim();
    if (triggerValue.length === 0) {
      return { file: filename, status: 'refused', reason: '--trigger value is empty' };
    }
  } else if (args.infer) {
    // Infer from body.
    const inferResult = inferTriggerFromBody(body);
    if ('refused' in inferResult) {
      process.stderr.write(`refused ${filename}: ${inferResult.refused}\n`);
      return { file: filename, status: 'refused', reason: inferResult.refused };
    }
    triggerValue = inferResult.trigger;
  } else {
    return {
      file: filename,
      status: 'refused',
      reason: 'no trigger source: use --infer or --trigger <text>',
    };
  }

  // Build the updated content.
  const newFm = insertTriggerInFrontmatter(frontmatter.raw, triggerValue);
  const updatedContent = `---\n${newFm}\n---\n\n${body}`;

  // Dry-run: print diff, no write.
  if (args.dryRun) {
    printUnifiedDiff(filePath, raw, updatedContent);
    process.stdout.write(`dry-run: would add trigger to ${filename}: "${triggerValue}"\n`);
    return { file: filename, status: 'dry_run', proposedTrigger: triggerValue };
  }

  // Idempotency: if content unchanged, skip.
  if (raw.replace(/\r\n/g, '\n') === updatedContent.replace(/\r\n/g, '\n')) {
    return { file: filename, status: 'idempotent' };
  }

  // Atomic write.
  try {
    atomicWrite(filePath, updatedContent);
  } catch (err) {
    return {
      file: filename,
      status: 'error',
      reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  process.stdout.write(`migrated: ${filename} — trigger: "${triggerValue}"\n`);
  return { file: filename, status: 'migrated', proposedTrigger: triggerValue };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv);

  // Verify memory_dir exists.
  if (!fs.existsSync(args.memoryDir)) {
    process.stderr.write(`error: memory_dir does not exist: ${args.memoryDir}\n`);
    return 2;
  }

  if (!fs.statSync(args.memoryDir).isDirectory()) {
    process.stderr.write(`error: memory_dir is not a directory: ${args.memoryDir}\n`);
    return 2;
  }

  // Collect files to process.
  let entries: string[];
  try {
    entries = fs.readdirSync(args.memoryDir).sort();
  } catch (err) {
    process.stderr.write(`error: cannot read memory_dir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Filter to lesson files.
  let lessonFiles = entries.filter(name => LESSON_FILENAME_RE.test(name));

  // --file scopes to one filename.
  if (args.file) {
    const target = args.file;
    lessonFiles = lessonFiles.filter(name => name === target || name === path.basename(target));
    if (lessonFiles.length === 0) {
      process.stderr.write(`error: --file ${target} not found in ${args.memoryDir}\n`);
      return 1;
    }
  }

  if (lessonFiles.length === 0) {
    process.stdout.write('no lesson files found\n');
    return 0;
  }

  if (args.dryRun) {
    process.stdout.write(`dry-run mode (pass --live to apply changes)\n`);
    process.stdout.write(`scanning ${lessonFiles.length} lesson file(s) in ${args.memoryDir}\n\n`);
  } else {
    process.stdout.write(`live mode: applying changes to ${lessonFiles.length} lesson file(s)\n\n`);
  }

  const results: MigrationResult[] = [];
  let anyRefused = false;

  for (const name of lessonFiles) {
    const filePath = path.join(args.memoryDir, name);
    const result = processFile(filePath, args);
    results.push(result);
    if (result.status === 'refused') anyRefused = true;
  }

  // Summary.
  const counts = {
    migrated: results.filter(r => r.status === 'migrated').length,
    dry_run: results.filter(r => r.status === 'dry_run').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    idempotent: results.filter(r => r.status === 'idempotent').length,
    refused: results.filter(r => r.status === 'refused').length,
    error: results.filter(r => r.status === 'error').length,
  };

  process.stdout.write(`\nsummary: ${lessonFiles.length} files scanned — `);
  process.stdout.write(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ') + '\n',
  );

  // Exit 1 if any refused (inference failure), 2 if IO error.
  if (counts.error > 0) return 2;
  if (anyRefused && !args.skipExisting) return 1;
  return 0;
}

// Run if invoked directly.
if (
  process.argv[1] &&
  (path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-lesson-trigger.ts') ||
    path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-lesson-trigger.js'))
) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
