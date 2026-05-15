/**
 * Phase 14 Plan 14-01 — handoff schema migrator.
 *
 * Reads <projectDir>/context/handoffs/ACTIVE.md (or --file override) and
 * rewrites it as the canonical handoff-writer.ts schema. Idempotent on
 * canonical input. Refuses on inference ambiguity. Operator-invoked.
 *
 * Usage:
 *   bun src/scripts/migrate-handoff.ts <projectDir> [--dry-run] [--phase <p>]
 *     [--epoch-ms <ms>] [--file <name>]
 *
 * Exit codes:
 *   0 — migrated OR idempotent_noop OR dry-run-success
 *   1 — inference failed, missing required input, or refused
 *   2 — IO error (file unreadable, write failed)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  parseHandoffHeader,
  renderHandoffMarkdown,
} from '../angel/handoff-writer.js';
import type { HandoffInput, HandoffStatus } from '../angel/handoff-writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigratorArgs {
  projectDir: string;
  dryRun: boolean;
  phase?: string;
  epochMs?: number;
  file: string;
}

interface ExtractedFrontmatter {
  /** All key-value pairs found in frontmatter, raw string values. */
  fm: Record<string, string>;
  /** Body content after frontmatter block (or entire content if no block). */
  body: string;
  /** [start, end] byte offsets of the frontmatter block, or null if absent. */
  bounds: [number, number] | null;
}

interface CanonicalFields {
  status: HandoffStatus;
  phase: string;
  summary?: string;
  topic?: string;
  createdAtEpochMs: number;
}

interface CanonicalBody {
  whatWeFound: string;
  whatWeDecided: string;
  whatsNext: string;
  whereToLook: string;
  preservedBody?: string;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): MigratorArgs {
  const args = argv.slice(2); // strip node + script

  if (args.length === 0 || args[0].startsWith('--')) {
    process.stderr.write('error: <projectDir> is required as the first argument\n');
    process.exit(1);
  }

  const projectDir = args[0];
  let dryRun = false;
  let phase: string | undefined;
  let epochMs: number | undefined;
  let file = 'ACTIVE.md';

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      i++;
    } else if (arg === '--phase') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --phase requires a value\n');
        process.exit(1);
      }
      phase = args[i];
      i++;
    } else if (arg === '--epoch-ms') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --epoch-ms requires a value\n');
        process.exit(1);
      }
      const n = Number(args[i]);
      if (!Number.isFinite(n)) {
        process.stderr.write(`error: --epoch-ms value is not a valid number: ${args[i]}\n`);
        process.exit(1);
      }
      epochMs = n;
      i++;
    } else if (arg === '--file') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --file requires a value\n');
        process.exit(1);
      }
      file = args[i];
      i++;
    } else {
      process.stderr.write(`error: unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }

  return { projectDir, dryRun, phase, epochMs, file };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function readInput(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: cannot read ${filePath}: ${msg}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

/**
 * Extract ALL frontmatter key-value pairs from the raw file content.
 * Unlike parseHandoffHeader, this captures every field (canonical + legacy).
 */
export function extractFrontmatter(raw: string): ExtractedFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match || match.index === undefined) {
    return { fm: {}, body: raw, bounds: null };
  }

  const fmBlock = match[1];
  const blockEnd = match[0].length;
  const fm: Record<string, string> = {};

  for (const line of fmBlock.split('\n')) {
    // Accept both `key: value` and `key: "quoted value"` forms.
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    // Strip surrounding quotes if present.
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (value.length > 0) {
      fm[key] = value;
    }
  }

  return {
    fm,
    body: raw.slice(blockEnd),
    bounds: [0, blockEnd],
  };
}

// ---------------------------------------------------------------------------
// Canonical field inference
// ---------------------------------------------------------------------------

/**
 * Valid canonical status values.
 */
const VALID_STATUSES: ReadonlyArray<HandoffStatus> = ['active', 'archived', 'paused'];

/**
 * Infer canonical field values from existing frontmatter, body content, and
 * CLI args. Throws (with a human-readable message) on inference failure.
 */
export function inferCanonicalFields(
  fm: Record<string, string>,
  body: string,
  filePath: string,
  args: { phase?: string; epochMs?: number },
): CanonicalFields {
  // ---- status ----
  let status: HandoffStatus = 'active';
  const rawStatus = fm['status'];
  if (rawStatus) {
    const normalized = rawStatus.toLowerCase() as HandoffStatus;
    if (VALID_STATUSES.includes(normalized)) {
      status = normalized;
    } else {
      // Non-canonical status — default to active, preserve original in comments.
      status = 'active';
    }
  }

  // ---- phase ----
  let phase: string | undefined;

  // 1. Explicit CLI flag wins.
  if (args.phase !== undefined && args.phase.trim().length > 0) {
    phase = args.phase.trim();
  }

  // 2. Parse from body's first H1 heading (e.g., "# 2026-05-15 — Phase 13 shipped").
  if (!phase) {
    const h1Match = body.match(/^# .*?[Pp]hase\s+(\d+(?:\.\d+)?)/m);
    if (h1Match) {
      phase = h1Match[1];
    }
  }

  // 3. Parse from section headers like "## Phase N:" or "## Phase N.M".
  if (!phase) {
    const sectionMatch = body.match(/^##\s+[Pp]hase\s+(\d+(?:\.\d+)?)/m);
    if (sectionMatch) {
      phase = sectionMatch[1];
    }
  }

  // 4. Parse from frontmatter (e.g., "handoff_id: bm2-handoff-13" → phase "13").
  if (!phase) {
    const handoffIdMatch = fm['handoff_id']?.match(/-(\d+)(?:-a\d+)?$/);
    if (handoffIdMatch) {
      phase = handoffIdMatch[1];
    }
  }

  // 5. Refuse if still no phase.
  if (!phase || phase.trim().length === 0) {
    throw new Error(
      'phase inference failed; supply --phase <p> to specify the phase explicitly',
    );
  }

  // ---- created_at_epoch_ms ----
  let createdAtEpochMs: number;

  // 1. Explicit CLI flag wins.
  if (args.epochMs !== undefined) {
    createdAtEpochMs = args.epochMs;
  } else if (fm['created_at_epoch_ms']) {
    // 2. Existing canonical field.
    const n = Number(fm['created_at_epoch_ms']);
    createdAtEpochMs = Number.isFinite(n) ? n : Date.now();
  } else if (fm['created_at']) {
    // 3. ISO created_at from claudex/handoff v1.
    const parsed = Date.parse(fm['created_at']);
    createdAtEpochMs = Number.isFinite(parsed) ? parsed : Date.now();
  } else {
    // 4. File mtime, fallback to now.
    try {
      const stat = fs.statSync(filePath);
      createdAtEpochMs = stat.mtimeMs;
    } catch {
      createdAtEpochMs = Date.now();
    }
  }

  // ---- optional fields ----
  const summary = fm['summary'];
  const topic = fm['topic'];

  return {
    status,
    phase,
    summary: summary || undefined,
    topic: topic || undefined,
    createdAtEpochMs,
  };
}

// ---------------------------------------------------------------------------
// Body content extraction
// ---------------------------------------------------------------------------

/**
 * Try to extract canonical body sections from the handoff body text.
 * When canonical markers are present (e.g., "**What we found:**"), extract
 * them. Otherwise, produce a best-effort body and put the original content
 * in a `## Preserved Body` section.
 */
export function extractCanonicalBody(body: string, fm: Record<string, string>): CanonicalBody {
  const whatWeFoundMarker = /\*\*What we found:\*\*/i;
  const whatWeDecidedMarker = /\*\*What we decided:\*\*/i;
  const whatsNextMarker = /\*\*What'?s next:\*\*/i;
  const whereToLookMarker = /\*\*Where to look:\*\*/i;

  const hasCanonicalMarkers =
    whatWeFoundMarker.test(body) &&
    whatWeDecidedMarker.test(body) &&
    whatsNextMarker.test(body) &&
    whereToLookMarker.test(body);

  if (hasCanonicalMarkers) {
    // Extract sections between markers.
    const extractSection = (startPattern: RegExp, endPatterns: RegExp[]): string => {
      const startMatch = body.match(startPattern);
      if (!startMatch || startMatch.index === undefined) return '(see preserved body)';

      const startIdx = startMatch.index + startMatch[0].length;
      let endIdx = body.length;
      for (const endPat of endPatterns) {
        const endMatch = body.slice(startIdx).match(endPat);
        if (endMatch && endMatch.index !== undefined) {
          endIdx = Math.min(endIdx, startIdx + endMatch.index);
        }
      }

      return body.slice(startIdx, endIdx).trim() || '(see preserved body)';
    };

    const whatWeFound = extractSection(whatWeFoundMarker, [whatWeDecidedMarker, whatsNextMarker, whereToLookMarker]);
    const whatWeDecided = extractSection(whatWeDecidedMarker, [whatsNextMarker, whereToLookMarker]);
    const whatsNext = extractSection(whatsNextMarker, [whereToLookMarker]);
    const whereToLook = extractSection(whereToLookMarker, []);

    return { whatWeFound, whatWeDecided, whatsNext, whereToLook };
  }

  // No canonical markers — build best-effort fields from H1 + first paragraph.
  const h1Match = body.match(/^# (.+)$/m);
  const title = h1Match?.[1] ?? fm['handoff_id'] ?? 'Migrated handoff';

  // First non-heading paragraph for summary.
  const firstParagraph = body
    .split(/\n\n+/)
    .find(p => p.trim().length > 0 && !p.trim().startsWith('#'))
    ?.trim() ?? '';

  return {
    whatWeFound: firstParagraph || `See preserved body. Title: ${title}`,
    whatWeDecided: 'See preserved body.',
    whatsNext: 'See preserved body.',
    whereToLook: 'See preserved body.',
    preservedBody: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// Legacy frontmatter serialization
// ---------------------------------------------------------------------------

/**
 * Canonical keys — these are rendered in the frontmatter proper, not as comments.
 */
const CANONICAL_KEYS = new Set([
  'status', 'phase', 'summary', 'topic', 'created_at_epoch_ms',
]);

/**
 * Emit non-canonical frontmatter fields as HTML comment lines.
 * These are embedded in the body so operator information is preserved.
 */
export function serializeLegacyComments(fm: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (!CANONICAL_KEYS.has(key)) {
      lines.push(`<!-- legacy-frontmatter: ${key}: ${value} -->`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Migration rendering
// ---------------------------------------------------------------------------

/**
 * Render the migrated canonical handoff content by:
 * 1. Invoking renderHandoffMarkdown with canonical fields + body sections.
 * 2. Injecting legacy frontmatter comments after the frontmatter block.
 * 3. Appending a `## Preserved Body` section when the body couldn't be
 *    mapped to canonical sections.
 */
export function renderMigrated(
  canonical: CanonicalFields,
  bodyContent: CanonicalBody,
  legacyComments: string,
): string {
  const input: HandoffInput = {
    status: canonical.status,
    phase: canonical.phase,
    summary: canonical.summary,
    topic: canonical.topic,
    created_at_epoch_ms: canonical.createdAtEpochMs,
    whatWeFound: bodyContent.whatWeFound,
    whatWeDecided: bodyContent.whatWeDecided,
    whatsNext: bodyContent.whatsNext,
    whereToLook: bodyContent.whereToLook,
  };

  let rendered = renderHandoffMarkdown(input);

  // Inject legacy comments after the closing `---` line of the frontmatter block.
  if (legacyComments.length > 0) {
    const fmEnd = rendered.indexOf('\n---\n');
    if (fmEnd !== -1) {
      const insertAt = fmEnd + 5; // after `\n---\n`
      rendered =
        rendered.slice(0, insertAt) +
        legacyComments + '\n\n' +
        rendered.slice(insertAt);
    }
  }

  // Append preserved body section when body wasn't mappable.
  if (bodyContent.preservedBody) {
    rendered +=
      '\n\n## Preserved Body\n\n' +
      '<!-- The following is the original handoff body, preserved verbatim. -->\n\n' +
      bodyContent.preservedBody +
      '\n';
  }

  return rendered;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Atomically write content to filePath using tmp + renameSync.
 * Preserves file permissions (mode 0644 default, source-matched when readable).
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Determine target mode.
  let mode = 0o644;
  try {
    const stat = fs.statSync(filePath);
    mode = stat.mode & 0o777;
  } catch {
    // File doesn't exist yet; use default.
  }

  const tmp = filePath + '.migrate.tmp';
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Unified diff printer
// ---------------------------------------------------------------------------

/**
 * Print a basic unified diff to stdout comparing original to migrated content.
 * Not a full Myers diff — uses line-by-line comparison for clarity.
 */
function printUnifiedDiff(originalPath: string, original: string, migrated: string): void {
  const origLines = original.split('\n');
  const migrLines = migrated.split('\n');

  process.stdout.write(`--- a/${path.basename(originalPath)}\n`);
  process.stdout.write(`+++ b/${path.basename(originalPath)}\n`);

  const maxLen = Math.max(origLines.length, migrLines.length);
  let i = 0;
  let inDiff = false;
  const CONTEXT = 3;
  let pendingContext: string[] = [];

  for (i = 0; i < maxLen; i++) {
    const orig = origLines[i] ?? undefined;
    const migr = migrLines[i] ?? undefined;

    if (orig === migr) {
      if (inDiff) {
        pendingContext.push(` ${orig ?? ''}`);
        if (pendingContext.length >= CONTEXT) {
          for (const l of pendingContext) process.stdout.write(l + '\n');
          pendingContext = [];
          inDiff = false;
        }
      }
    } else {
      inDiff = true;
      const hunkStart = Math.max(0, i - CONTEXT) + 1;
      process.stdout.write(`@@ -${hunkStart},${origLines.length} +${hunkStart},${migrLines.length} @@\n`);
      if (orig !== undefined) process.stdout.write(`-${orig}\n`);
      if (migr !== undefined) process.stdout.write(`+${migr}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv);

  // Resolve the target file path.
  const targetPath = path.join(args.projectDir, 'context', 'handoffs', args.file);

  // Read the file.
  const raw = readInput(targetPath);

  // Check if already canonical (idempotent guard).
  const existingHeader = parseHandoffHeader(raw);
  if (existingHeader !== null) {
    // Canonical check: does the current file parse cleanly?
    // If a --phase override is supplied alongside a canonical file, refuse.
    if (args.phase !== undefined) {
      process.stderr.write(
        `error: ${targetPath} already has a valid canonical schema. ` +
        `The migrator refuses to overwrite a valid canonical file with --phase. ` +
        `Edit the file by hand if you need to change the phase.\n`,
      );
      return 1;
    }

    process.stdout.write(`idempotent_noop: ${targetPath}\n`);
    return 0;
  }

  // Extract all frontmatter (canonical + legacy).
  const { fm, body } = extractFrontmatter(raw);

  // Infer canonical fields.
  let canonical: CanonicalFields;
  try {
    canonical = inferCanonicalFields(fm, body, targetPath, {
      phase: args.phase,
      epochMs: args.epochMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  // Extract canonical body sections.
  const bodyContent = extractCanonicalBody(body, fm);

  // Serialize legacy frontmatter as comments.
  const legacyComments = serializeLegacyComments(fm);

  // Render the migrated content.
  const migrated = renderMigrated(canonical, bodyContent, legacyComments);

  // Verify the migrated output round-trips through parseHandoffHeader.
  const roundTrip = parseHandoffHeader(migrated);
  if (roundTrip === null) {
    process.stderr.write(
      'error: internal error — migrated output does not parse through parseHandoffHeader. ' +
      'This is a bug in the migrator. The file has NOT been written.\n',
    );
    return 1;
  }

  // Dry-run mode: print diff and exit.
  if (args.dryRun) {
    if (migrated === raw) {
      process.stdout.write(`dry-run: no changes (idempotent): ${targetPath}\n`);
    } else {
      printUnifiedDiff(targetPath, raw, migrated);
      process.stdout.write(`dry-run: would migrate ${targetPath} (phase=${canonical.phase}, epoch_ms=${canonical.createdAtEpochMs})\n`);
    }
    return 0;
  }

  // Live mode: write atomically.
  try {
    atomicWrite(targetPath, migrated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: failed to write ${targetPath}: ${msg}\n`);
    return 2;
  }

  // Verify SHA-256 is different (it must change since input wasn't canonical).
  const hashBefore = sha256(raw);
  const hashAfter = sha256(migrated);
  const changed = hashBefore !== hashAfter;

  process.stdout.write(
    `migrated: ${targetPath} (phase=${canonical.phase}, epoch_ms=${canonical.createdAtEpochMs}, changed=${changed})\n`,
  );
  return 0;
}

// Run if invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-handoff.ts') ||
    process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-handoff.js')) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
