#!/usr/bin/env node
/**
 * Phase 7.5 — handoff migration script.
 *
 * Reads `<project-root>/context/handoffs/ACTIVE.md`, archives the original
 * verbatim, and rewrites ACTIVE.md in the new hybrid YAML+ADR shape.
 *
 * Idempotent: re-running on already-migrated input is a no-op (no archive
 * duplicates, no file content changes).
 *
 * Usage:
 *   bun run scripts/migrate-handoff.ts <project-root>
 *   bun run scripts/migrate-handoff.ts            # uses cwd if it has context/handoffs/ACTIVE.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  HandoffInput,
  HandoffStatus,
  parseHandoffHeader,
  writeHandoff,
} from '../src/angel/handoff-writer.js';

interface ExtractedSections {
  whatWeFound: string;
  whatWeDecided: string;
  whatsNext: string;
  whereToLook: string;
  derivedTitle?: string;
}

const NEW_FORMAT_MARKER = /^\*\*What we found:\*\*/m;

function exitUsage(reason?: string): never {
  if (reason) console.error(reason);
  console.error('Usage: bun run scripts/migrate-handoff.ts <project-root>');
  process.exit(1);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveDateAndTopic(
  body: string,
  parsedTopic: string | undefined,
  phase: string,
  createdAtMs: number | undefined,
): { date: string; topic: string } {
  const titleMatch = body.match(/^# (\d{4}-\d{2}-\d{2}) — (.+?)\s*$/m);
  if (titleMatch) {
    return { date: titleMatch[1], topic: parsedTopic ?? titleMatch[2].trim() };
  }
  const date = createdAtMs
    ? new Date(createdAtMs).toISOString().slice(0, 10)
    : todayDate();
  return { date, topic: parsedTopic ?? `phase ${phase} handoff` };
}

/**
 * Split a Markdown body into a map of `## header text` → body lines.
 */
function sectionMap(body: string): Map<string, string> {
  const text = body.replace(/\r\n/g, '\n');
  const sections = new Map<string, string[]>();
  let currentHeader: string | null = null;
  let currentLines: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (currentHeader) sections.set(currentHeader.toLowerCase(), currentLines);
      currentHeader = m[1];
      currentLines = [];
      continue;
    }
    if (currentHeader) currentLines.push(line);
  }
  if (currentHeader) sections.set(currentHeader.toLowerCase(), currentLines);

  const out = new Map<string, string>();
  for (const [k, v] of sections.entries()) {
    out.set(k, v.join('\n').trim());
  }
  return out;
}

function findSection(map: Map<string, string>, predicates: RegExp[]): string {
  for (const [key, value] of map.entries()) {
    if (predicates.some((rx) => rx.test(key))) return value;
  }
  return '';
}

function joinNonEmpty(parts: string[]): string {
  return parts.filter((p) => p && p.trim().length > 0).join('\n\n').trim();
}

function extractWhereToLook(body: string): string {
  // Pull file/path-shaped tokens from the body. If none, fall back to
  // a generic pointer.
  const matches = body.match(/[a-zA-Z0-9_./-]+\.(ts|md|json|test\.ts)/g) ?? [];
  const unique = Array.from(new Set(matches)).slice(0, 8);
  if (unique.length === 0) return 'Files referenced inline above.';
  return unique.join(', ');
}

/**
 * Extract four-section content from a transitional shape (already has YAML
 * header + `## Where we are right now`-style body). Maps the actual headers
 * found in CLAUDEXv3's current ACTIVE.md.
 */
function extractTransitional(body: string): ExtractedSections {
  const map = sectionMap(body);

  const whereWeAre = findSection(map, [/^where we are/]);
  const whatFoundSrc = findSection(map, [/^what we found/]);
  const whatDecidedSrc = findSection(map, [/^what we decided/]);
  const whatNextLiteral = findSection(map, [/^what.?s next/]);
  const howToPickUp = findSection(map, [/^how to pick up/]);

  const whatWeFound = joinNonEmpty([whereWeAre, whatFoundSrc]) || '(see archived original)';
  const whatWeDecided = whatDecidedSrc || '(see archived original)';
  const whatsNext = joinNonEmpty([whatNextLiteral, howToPickUp]) || '(see archived original)';
  const whereToLook = extractWhereToLook(body);

  return { whatWeFound, whatWeDecided, whatsNext, whereToLook };
}

/**
 * Extract from a legacy 372-line schema (no YAML header). Distill the
 * `## Commander's Intent` and `## What's Left To Do` blocks into the new
 * sections heuristically.
 */
function extractLegacy(body: string): ExtractedSections {
  const map = sectionMap(body);
  const intent = findSection(map, [/^commander.?s?\s+intent/]);
  const whatsLeft = findSection(map, [/^what.?s?\s+left\s+to\s+do/]);
  const sbar = findSection(map, [/^sbar/]);

  const whatWeFound = intent || body.slice(0, 1200) || '(see archived original)';
  const whatWeDecided = intent
    ? '(see archived original — distilled into "What we found")'
    : '(see archived original)';
  const whatsNext = whatsLeft || '(see archived original)';
  const whereToLook = sbar || extractWhereToLook(body);

  return { whatWeFound, whatWeDecided, whatsNext, whereToLook };
}

function deriveSummary(
  parsed: ReturnType<typeof parseHandoffHeader>,
  whatsNext: string,
  phase: string,
): string {
  if (parsed?.summary) return parsed.summary;
  const firstLine = whatsNext
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) {
    const stripped = firstLine
      .replace(/^[#*\->\s]+/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (stripped.length > 0) {
      return stripped.length <= 140 ? stripped : stripped.slice(0, 137) + '...';
    }
  }
  return `Resume phase ${phase} handoff`;
}

function uniqueArchivePath(archiveDir: string, baseName: string): string {
  const target = path.join(archiveDir, `${baseName}.md`);
  if (!fs.existsSync(target)) return target;
  let n = 2;
  while (fs.existsSync(path.join(archiveDir, `${baseName}-${n}.md`))) n++;
  return path.join(archiveDir, `${baseName}-${n}.md`);
}

function resolveProjectRoot(arg: string | undefined): string {
  if (arg && arg !== '--help' && arg !== '-h') {
    if (!fs.existsSync(arg)) exitUsage(`project-root not found: ${arg}`);
    return path.resolve(arg);
  }
  if (arg === '--help' || arg === '-h') exitUsage();
  const cwd = process.cwd();
  const probe = path.join(cwd, 'context', 'handoffs', 'ACTIVE.md');
  if (fs.existsSync(probe)) return cwd;
  exitUsage('no <project-root> provided and cwd does not contain context/handoffs/ACTIVE.md');
}

function main(): number {
  const arg = process.argv[2];
  const projectRoot = resolveProjectRoot(arg);
  const handoffPath = path.join(projectRoot, 'context', 'handoffs', 'ACTIVE.md');

  if (!fs.existsSync(handoffPath)) {
    console.log('no active handoff to migrate');
    return 0;
  }

  const raw = fs.readFileSync(handoffPath, 'utf8');
  const parsed = parseHandoffHeader(raw);
  const bodyAfterHeader = raw.replace(/^---\n[\s\S]*?\n---\n/, '');

  if (parsed && NEW_FORMAT_MARKER.test(bodyAfterHeader)) {
    console.log('already in new format');
    return 0;
  }

  // 1. Archive the pre-migration file verbatim BEFORE writing.
  const archiveDir = path.join(projectRoot, 'context', 'handoffs', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  const phase = parsed?.phase ?? '0';
  const status: HandoffStatus = (parsed?.status as HandoffStatus) ?? 'active';
  const createdAtMs = parsed?.created_at_epoch_ms;

  // 2. Distill body sections from current shape.
  const sections = parsed
    ? extractTransitional(bodyAfterHeader)
    : extractLegacy(raw);

  const { date, topic } = deriveDateAndTopic(
    bodyAfterHeader,
    parsed?.topic,
    phase,
    createdAtMs,
  );

  const archiveBase = `${date}-${slugify(topic) || 'handoff'}`;
  const archivePath = uniqueArchivePath(archiveDir, archiveBase);
  fs.writeFileSync(archivePath, raw, 'utf8');

  // 3. Build new HandoffInput and write atomically.
  const summary = deriveSummary(parsed, sections.whatsNext, phase);

  const input: HandoffInput = {
    status,
    phase,
    summary,
    topic: parsed?.topic ?? slugify(`${date}-phase-${phase}`),
    created_at_epoch_ms: createdAtMs ?? Date.now(),
    whatWeFound: sections.whatWeFound,
    whatWeDecided: sections.whatWeDecided,
    whatsNext: sections.whatsNext,
    whereToLook: sections.whereToLook,
  };

  writeHandoff(handoffPath, input);

  console.log(`migrated ${handoffPath} → archive ${archivePath}`);
  return 0;
}

process.exit(main());
