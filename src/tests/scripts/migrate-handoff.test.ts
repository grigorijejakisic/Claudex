/**
 * Tests for Phase 14-01 — migrate-handoff.ts CLI script.
 *
 * Each test gets its own tmp dir via mkdtempSync + afterEach cleanup.
 * main() is called directly (not via child_process) for speed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  main,
  parseArgs,
  extractFrontmatter,
  inferCanonicalFields,
  extractCanonicalBody,
  serializeLegacyComments,
  renderMigrated,
} from '../../scripts/migrate-handoff.js';
import { parseHandoffHeader } from '../../angel/handoff-writer.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-handoff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Set up a project directory with context/handoffs/<filename> containing content.
 * Returns the full path to the handoff file.
 */
function setupHandoffFile(content: string, filename = 'ACTIVE.md'): string {
  const handoffDir = path.join(tmpDir, 'context', 'handoffs');
  fs.mkdirSync(handoffDir, { recursive: true });
  const filePath = path.join(handoffDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Read the handoff file back from the tmp project dir.
 */
function readHandoffFile(filename = 'ACTIVE.md'): string {
  return fs.readFileSync(
    path.join(tmpDir, 'context', 'handoffs', filename),
    'utf8',
  );
}

/**
 * SHA-256 of a string for idempotency checks.
 */
function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Minimal claudex/handoff v1 fixture (big-mozzy-v2 shape).
 */
const CLAUDEX_V1_FIXTURE = `---
schema: claudex/handoff
version: 1
handoff_id: bm2-handoff-46
status: active
created_at: 2026-05-15T00:16:00+02:00
updated_at: 2026-05-15T00:16:00+02:00
origin_session_id: a5789b33-43bf-9ff8-bb60-60f919d48e86
supersedes: bm2-handoff-45
---

# Handoff: Phase 13 shipped

Date: 2026-05-14

## What happened

Bot is off tonight. FL365 outage.

## Next session

1. Restart FL365 cleanly.
2. Restart bot.

## Context

Load-bearing principle: optimize total net, not precision.
`;

/**
 * Canonical handoff fixture (already in canonical schema).
 */
const CANONICAL_FIXTURE = `---
status: active
phase: 13
summary: Phase 13 shipped plus bot outage notes
topic: phase-13-ship
created_at_epoch_ms: 1747266960000
---
# 2026-05-15 — phase-13-ship

**What we found:** Phase 13 shipped; FL365 went silent.

**What we decided:** Bot off tonight. Restart FL365 tomorrow.

**What's next:** Restart FL365 and bot. Check 10:00 task.

**Where to look:** MoneyMaker/bot/src/launcher.ts, zap/fastlane365.mjs
`;

// ---------------------------------------------------------------------------
// Test 1: migrates a claudex/handoff v1 sample to canonical
// ---------------------------------------------------------------------------

describe('test 1: migrates a claudex/handoff v1 sample to canonical', () => {
  it('migrated file parses as canonical; legacy fields present as comments; body content preserved', async () => {
    setupHandoffFile(CLAUDEX_V1_FIXTURE);

    // Run with explicit --phase since inference from handoff_id extracts a number.
    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '13']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();

    // parseHandoffHeader accepts it.
    const header = parseHandoffHeader(migrated);
    expect(header).not.toBeNull();
    expect(header!.status).toBe('active');
    expect(header!.phase).toBe('13');

    // Legacy fields preserved as comments.
    expect(migrated).toContain('<!-- legacy-frontmatter: schema: claudex/handoff -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: handoff_id: bm2-handoff-46 -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: supersedes: bm2-handoff-45 -->');

    // Original body content present (in preserved body section).
    expect(migrated).toContain('Bot is off tonight');
    expect(migrated).toContain('Restart FL365 cleanly');
  });
});

// ---------------------------------------------------------------------------
// Test 2: idempotent on already-canonical sample
// ---------------------------------------------------------------------------

describe('test 2: idempotent on already-canonical sample', () => {
  it('SHA-256 unchanged after migration; stdout includes idempotent_noop', async () => {
    setupHandoffFile(CANONICAL_FIXTURE);
    const before = sha256(readHandoffFile());

    // Capture stdout to verify message.
    const origWrite = process.stdout.write.bind(process.stdout);
    const stdoutLines: string[] = [];
    process.stdout.write = (chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await main(['node', 'migrate-handoff.ts', tmpDir]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(code!).toBe(0);
    expect(stdoutLines.join('')).toContain('idempotent_noop');

    const after = sha256(readHandoffFile());
    expect(before).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// Test 3: dry-run prints unified diff and does not write
// ---------------------------------------------------------------------------

describe('test 3: dry-run prints unified diff and does not write', () => {
  it('stdout contains diff markers; file mtime + content unchanged', async () => {
    setupHandoffFile(CLAUDEX_V1_FIXTURE);
    const filePath = path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md');
    const statBefore = fs.statSync(filePath);
    const contentBefore = readHandoffFile();

    const origWrite = process.stdout.write.bind(process.stdout);
    const stdoutChunks: string[] = [];
    process.stdout.write = (chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await main(['node', 'migrate-handoff.ts', tmpDir, '--dry-run', '--phase', '13']);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(code!).toBe(0);
    const stdout = stdoutChunks.join('');
    // Diff markers must be present.
    expect(stdout).toMatch(/---|\+\+\+/);

    // File content unchanged.
    expect(readHandoffFile()).toBe(contentBefore);

    // Mtime unchanged (file not written).
    const statAfter = fs.statSync(filePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// Test 4: --phase flag overrides inference
// ---------------------------------------------------------------------------

describe('test 4: --phase flag overrides inference', () => {
  const NO_PHASE_FIXTURE = `---
schema: claudex/handoff
version: 1
handoff_id: myproject-handoff-alpha
status: active
created_at: 2026-01-01T00:00:00Z
---

# Some notes without any phase reference

No phase number in any heading or section marker.
`;

  it('with --phase 14.1: succeeds; written file has phase: "14.1"', async () => {
    setupHandoffFile(NO_PHASE_FIXTURE);
    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '14.1']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();
    const header = parseHandoffHeader(migrated);
    expect(header).not.toBeNull();
    expect(header!.phase).toBe('14.1');
  });

  it('without --phase: exits 1 with stderr "phase inference failed"', async () => {
    setupHandoffFile(NO_PHASE_FIXTURE);

    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await main(['node', 'migrate-handoff.ts', tmpDir]);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(code!).toBe(1);
    expect(stderrChunks.join('')).toContain('phase inference failed');
  });
});

// ---------------------------------------------------------------------------
// Test 5: --epoch-ms flag overrides inference
// ---------------------------------------------------------------------------

describe('test 5: --epoch-ms flag overrides inference', () => {
  const NO_DATE_FIXTURE = `---
schema: claudex/handoff
version: 1
handoff_id: test-handoff-1
status: active
---

# Phase 5 notes

No date info anywhere.
`;

  it('with --epoch-ms: succeeds; written file has created_at_epoch_ms equal to supplied value', async () => {
    setupHandoffFile(NO_DATE_FIXTURE);
    const EPOCH_MS = 1700000000000;
    const code = await main([
      'node', 'migrate-handoff.ts', tmpDir,
      '--phase', '5',
      '--epoch-ms', String(EPOCH_MS),
    ]);
    expect(code).toBe(0);

    const migrated = readHandoffFile();
    const header = parseHandoffHeader(migrated);
    expect(header).not.toBeNull();
    expect(header!.created_at_epoch_ms).toBe(EPOCH_MS);
  });

  it('without --epoch-ms: falls back to mtime then current time (no crash)', async () => {
    setupHandoffFile(NO_DATE_FIXTURE);
    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '5']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();
    const header = parseHandoffHeader(migrated);
    expect(header).not.toBeNull();
    expect(typeof header!.created_at_epoch_ms).toBe('number');
    expect(header!.created_at_epoch_ms).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: preserves operator body content verbatim
// ---------------------------------------------------------------------------

describe('test 6: preserves operator body content verbatim', () => {
  it('every non-frontmatter character of the original body present in migrated file', async () => {
    // Build a long body (500+ lines worth of content).
    const longBodyLines = Array.from({ length: 50 }, (_, i) =>
      `Line ${i + 1}: Important operational note about the system state at this point.`
    );
    const longBody = longBodyLines.join('\n');

    const fixture = `---
schema: claudex/handoff
version: 1
handoff_id: big-project-handoff-99
status: active
created_at: 2026-03-01T10:00:00Z
---

# Phase 7 handoff

${longBody}

## Additional Notes

The system is stable. Review these notes carefully.
`;

    setupHandoffFile(fixture);
    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '7']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();

    // Every line of the original body must appear in the migrated file.
    for (const line of longBodyLines) {
      expect(migrated).toContain(line);
    }
    expect(migrated).toContain('The system is stable. Review these notes carefully.');
  });
});

// ---------------------------------------------------------------------------
// Test 7: serializes legacy frontmatter as comments
// ---------------------------------------------------------------------------

describe('test 7: serializes legacy frontmatter as comments', () => {
  it('each legacy field appears as <!-- legacy-frontmatter: key: value --> comment', async () => {
    const fixture = `---
schema: claudex/handoff
version: 1
handoff_id: project-handoff-123
status: active
created_at: 2026-05-01T00:00:00Z
supersedes: project-handoff-122
origin_session_id: abc123
---

# Phase 10 notes

Body content here.
`;

    setupHandoffFile(fixture);
    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '10']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();
    expect(migrated).toContain('<!-- legacy-frontmatter: schema: claudex/handoff -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: version: 1 -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: handoff_id: project-handoff-123 -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: supersedes: project-handoff-122 -->');
    expect(migrated).toContain('<!-- legacy-frontmatter: origin_session_id: abc123 -->');
    // created_at (ISO) is a legacy-only field (canonical uses created_at_epoch_ms), so it also appears as a comment.
    expect(migrated).toContain('<!-- legacy-frontmatter: created_at: 2026-05-01T00:00:00Z -->');

    // The five strictly canonical keys must NOT appear as comments.
    expect(migrated).not.toContain('<!-- legacy-frontmatter: status:');
    expect(migrated).not.toContain('<!-- legacy-frontmatter: phase:');
    expect(migrated).not.toContain('<!-- legacy-frontmatter: created_at_epoch_ms:');
  });
});

// ---------------------------------------------------------------------------
// Test 8: refuses to write on inference failure
// ---------------------------------------------------------------------------

describe('test 8: refuses to write on inference failure', () => {
  it('exit 1, stderr non-empty, target file unchanged', async () => {
    const emptyBody = `---
schema: claudex/handoff
version: 1
status: active
---

No phase info anywhere.
`;
    setupHandoffFile(emptyBody);
    const filePath = path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md');
    const contentBefore = readHandoffFile();

    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await main(['node', 'migrate-handoff.ts', tmpDir]);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(code!).toBe(1);
    expect(stderrChunks.join('')).not.toBe('');
    expect(readHandoffFile()).toBe(contentBefore);
  });
});

// ---------------------------------------------------------------------------
// Test 9: refuses to overwrite already-canonical file with --phase flag
// ---------------------------------------------------------------------------

describe('test 9: refuses overwrite on already-canonical without --force', () => {
  it('exit 1 with refusal explanation; file unchanged', async () => {
    setupHandoffFile(CANONICAL_FIXTURE);
    const contentBefore = readHandoffFile();

    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '99']);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(code!).toBe(1);
    expect(stderrChunks.join('')).toContain('refuses');
    expect(readHandoffFile()).toBe(contentBefore);
  });
});

// ---------------------------------------------------------------------------
// Test 10: --file flag targets ACTIVE-agent2.md
// ---------------------------------------------------------------------------

describe('test 10: --file flag targets ACTIVE-agent2.md', () => {
  it('ACTIVE-agent2.md migrated; ACTIVE.md untouched', async () => {
    // Set up both files.
    const handoffDir = path.join(tmpDir, 'context', 'handoffs');
    fs.mkdirSync(handoffDir, { recursive: true });

    // ACTIVE.md is canonical — should be untouched.
    fs.writeFileSync(path.join(handoffDir, 'ACTIVE.md'), CANONICAL_FIXTURE, 'utf8');

    // ACTIVE-agent2.md is v1 format — should be migrated.
    const agent2Fixture = `---
schema: claudex/handoff
version: 2
handoff_id: bm2-handoff-41-a2
status: active
created_at: 2026-05-12T00:30:00+02:00
agent: 2
---

# Phase 8 Agent 2 work

Agent 2 added VAR-tolerant tracker and daily cap.
`;
    fs.writeFileSync(path.join(handoffDir, 'ACTIVE-agent2.md'), agent2Fixture, 'utf8');

    const code = await main([
      'node', 'migrate-handoff.ts', tmpDir,
      '--file', 'ACTIVE-agent2.md',
      '--phase', '8',
    ]);
    expect(code).toBe(0);

    // ACTIVE.md unchanged.
    const activeMd = fs.readFileSync(path.join(handoffDir, 'ACTIVE.md'), 'utf8');
    expect(activeMd).toBe(CANONICAL_FIXTURE);

    // ACTIVE-agent2.md now parses as canonical.
    const agent2Md = fs.readFileSync(path.join(handoffDir, 'ACTIVE-agent2.md'), 'utf8');
    const header = parseHandoffHeader(agent2Md);
    expect(header).not.toBeNull();
    expect(header!.phase).toBe('8');
    expect(agent2Md).toContain('<!-- legacy-frontmatter: schema: claudex/handoff -->');
  });
});

// ---------------------------------------------------------------------------
// Test 11: IO error — missing file exits 2
// ---------------------------------------------------------------------------

describe('test 11: IO error — missing projectDir/context/handoffs/ACTIVE.md exits 2', () => {
  it('exits with code 2', async () => {
    // Don't create the handoff file.
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    const mockExit = (code?: number | string | null) => {
      exitCode = Number(code ?? 0);
      throw new Error(`process.exit(${code})`);
    };
    (process as NodeJS.Process).exit = mockExit as typeof process.exit;

    try {
      await main(['node', 'migrate-handoff.ts', tmpDir]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('process.exit')) throw err;
    } finally {
      (process as NodeJS.Process).exit = origExit;
    }

    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 12: migrated file round-trips through parseHandoffHeader
// ---------------------------------------------------------------------------

describe('test 12: migrated file round-trips through parseHandoffHeader', () => {
  it('after migration, parseHandoffHeader returns HandoffHeader with status/phase/summary populated', async () => {
    setupHandoffFile(CLAUDEX_V1_FIXTURE);

    const code = await main(['node', 'migrate-handoff.ts', tmpDir, '--phase', '13']);
    expect(code).toBe(0);

    const migrated = readHandoffFile();
    const header = parseHandoffHeader(migrated);

    expect(header).not.toBeNull();
    expect(header!.status).toBe('active');
    expect(header!.phase).toBe('13');
    // created_at_epoch_ms should be the parsed ISO date from created_at field.
    expect(typeof header!.created_at_epoch_ms).toBe('number');
    expect(header!.created_at_epoch_ms).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for individual exported functions
// ---------------------------------------------------------------------------

describe('extractFrontmatter', () => {
  it('extracts all fields including legacy ones', () => {
    const raw = `---
schema: claudex/handoff
version: 1
handoff_id: test-123
status: active
phase: 5
created_at: 2026-01-01T00:00:00Z
---

Body here.
`;
    const { fm, body, bounds } = extractFrontmatter(raw);
    expect(fm['schema']).toBe('claudex/handoff');
    expect(fm['version']).toBe('1');
    expect(fm['handoff_id']).toBe('test-123');
    expect(fm['status']).toBe('active');
    expect(fm['phase']).toBe('5');
    expect(fm['created_at']).toBe('2026-01-01T00:00:00Z');
    expect(bounds).not.toBeNull();
    expect(body.trim()).toBe('Body here.');
  });

  it('returns empty fm and full body when no frontmatter block', () => {
    const raw = `# Just a heading\n\nBody.`;
    const { fm, body, bounds } = extractFrontmatter(raw);
    expect(Object.keys(fm)).toHaveLength(0);
    expect(bounds).toBeNull();
    expect(body).toBe(raw);
  });
});

describe('serializeLegacyComments', () => {
  it('emits comment lines for non-canonical keys only', () => {
    const fm = {
      status: 'active',
      phase: '5',
      schema: 'claudex/handoff',
      handoff_id: 'test-123',
      created_at_epoch_ms: '1700000000000',
    };
    const comments = serializeLegacyComments(fm);
    expect(comments).toContain('<!-- legacy-frontmatter: schema: claudex/handoff -->');
    expect(comments).toContain('<!-- legacy-frontmatter: handoff_id: test-123 -->');
    expect(comments).not.toContain('status');
    expect(comments).not.toContain('phase');
    expect(comments).not.toContain('created_at_epoch_ms');
  });
});
