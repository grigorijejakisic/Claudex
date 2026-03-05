/**
 * Claudex v2 — PreCompact Hook
 *
 * Captures a transcript snapshot before context compaction.
 * Copies the transcript file to ~/.claudex/transcripts/<session_id>/
 * with a timestamped filename and writes a .meta.json sidecar.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runHook, logToFile } from './_infrastructure.js';
import { transcriptDir, completionMarkerPath, findCurrentSessionLog, dailyMemoryPath, PATHS, sanitizeSessionId } from '../shared/paths.js';
import type { PreCompactInput } from '../shared/types.js';
import type { HookStdin } from '../shared/types.js';
import type { ReasoningChain } from '../shared/types.js';
import type { Scope } from '../shared/types.js';
import { SCHEMAS } from '../shared/types.js';
import { detectScope } from '../shared/scope-detector.js';
import { getDatabase } from '../db/connection.js';
import { insertReasoning } from '../db/reasoning.js';
import { getCheckpointState, upsertCheckpointState } from '../db/checkpoint.js';
import { getObservationsSince } from '../db/observations.js';
import { readTokenGaugeWithDetection } from '../lib/token-gauge.js';
import { writeCheckpoint } from '../checkpoint/writer.js';
import { redactSensitive } from '../lib/redaction.js';
import type Database from 'better-sqlite3';

/**
 * Extract unique file paths from observations' files_read + files_modified.
 * Returns deduplicated list, max 10 entries.
 */
function extractActiveFiles(observations: Array<{ files_read?: string[]; files_modified?: string[] }>): string[] {
  const seen = new Set<string>();
  for (const obs of observations) {
    if (obs.files_read) for (const f of obs.files_read) seen.add(f);
    if (obs.files_modified) for (const f of obs.files_modified) seen.add(f);
  }
  return Array.from(seen).slice(0, 10);
}

/**
 * Write compact checkpoint data to session log, handoff, and daily memory.
 * Each write is independent — one failure does not block others.
 */
function writeCompactCheckpoint(
  sessionId: string,
  scope: Scope,
  db: Database.Database,
  trigger: string,
  _cwd: string,
): void {
  const HOOK_NAME = 'pre-compact';
  const nowMs = Date.now();
  const timeStr = new Date(nowMs).toISOString().split('T')[1]!.replace(/\.\d+Z$/, '');

  // Check completion marker + delta — skip if completed and no new observations
  const hasCompletionMarker = fs.existsSync(completionMarkerPath(sessionId));
  const checkpointState = getCheckpointState(db, sessionId);
  const lastEpoch = checkpointState?.last_epoch ?? 0;

  // Query for observations since last checkpoint
  const project = scope.type === 'project' ? scope.name : null;
  const newObservations = getObservationsSince(db, lastEpoch, project);

  if (hasCompletionMarker && newObservations.length === 0) {
    logToFile(HOOK_NAME, 'DEBUG', 'Completion marker exists and no new observations — skipping checkpoint writes');
    return;
  }

  const activeFiles = extractActiveFiles(newObservations);
  const scopeStr = scope.type === 'project' ? `project:${scope.name}` : 'global';
  const checkpointContent = [
    '',
    `## Compact Checkpoint — ${timeStr}`,
    '',
    `- **Trigger**: ${trigger}`,
    `- **Session**: ${sessionId}`,
    `- **Scope**: ${scopeStr}`,
    `- **Observations since last checkpoint**: ${newObservations.length}`,
    `- **Files touched**: ${activeFiles.length > 0 ? activeFiles.join(', ') : 'none'}`,
    '',
  ].join('\n');

  let anyWriteSucceeded = false;

  // 1a. Session log write
  try {
    let sessionsDir: string;
    if (scope.type === 'project') {
      sessionsDir = path.join(scope.path, 'context', 'sessions');
    } else {
      sessionsDir = PATHS.sessions;
    }

    const existingLog = findCurrentSessionLog(sessionId, sessionsDir);

    if (existingLog) {
      // Append checkpoint to existing session log
      fs.appendFileSync(existingLog, checkpointContent, 'utf-8');
      logToFile(HOOK_NAME, 'DEBUG', `Checkpoint appended to session log: ${existingLog}`);
    } else {
      // Create standalone checkpoint file
      fs.mkdirSync(sessionsDir, { recursive: true });
      const today = new Date(nowMs).toISOString().split('T')[0]!;

      let compactNum = 1;
      if (scope.type === 'project') {
        // Find next compact number
        try {
          const existing = fs.readdirSync(sessionsDir);
          const pattern = new RegExp(`^${today}_compact-(\\d+)\\.md$`);
          for (const f of existing) {
            const m = f.match(pattern);
            if (m) compactNum = Math.max(compactNum, parseInt(m[1]!, 10) + 1);
          }
        } catch { /* ignore */ }
        const newPath = path.join(sessionsDir, `${today}_compact-${compactNum}.md`);
        fs.writeFileSync(newPath, checkpointContent.trimStart(), 'utf-8');
        logToFile(HOOK_NAME, 'DEBUG', `Checkpoint session log created: ${newPath}`);
      } else {
        // Global scope: <session_id>_compact-1.md
        try {
          const existing = fs.readdirSync(sessionsDir);
          const safeId = sanitizeSessionId(sessionId);
          const pattern = new RegExp(`^${safeId}_compact-(\\d+)\\.md$`);
          for (const f of existing) {
            const m = f.match(pattern);
            if (m) compactNum = Math.max(compactNum, parseInt(m[1]!, 10) + 1);
          }
        } catch { /* ignore */ }
        const safeId = sanitizeSessionId(sessionId);
        const newPath = path.join(sessionsDir, `${safeId}_compact-${compactNum}.md`);
        fs.writeFileSync(newPath, checkpointContent.trimStart(), 'utf-8');
        logToFile(HOOK_NAME, 'DEBUG', `Checkpoint session log created: ${newPath}`);
      }
    }
    anyWriteSucceeded = true;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Checkpoint session log write failed (non-fatal):', err);
  }

  // 1b. Handoff state update (project scope only)
  try {
    if (scope.type === 'project') {
      const activeMdPath = path.join(scope.path, 'context', 'handoffs', 'ACTIVE.md');
      if (fs.existsSync(activeMdPath)) {
        const handoffSection = [
          '',
          `## Compact Checkpoint — ${timeStr}`,
          `- Observations: ${newObservations.length} since last checkpoint`,
          `- Files touched: ${activeFiles.length > 0 ? activeFiles.join(', ') : 'none'}`,
          '',
        ].join('\n');
        fs.appendFileSync(activeMdPath, handoffSection, 'utf-8');
        logToFile(HOOK_NAME, 'DEBUG', `Checkpoint appended to ACTIVE.md: ${activeMdPath}`);
        anyWriteSucceeded = true;
      }
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Checkpoint ACTIVE.md write failed (non-fatal):', err);
  }

  // 1c. Daily memory append
  try {
    if (newObservations.length > 0) {
      const today = new Date(nowMs).toISOString().split('T')[0]!;
      const dailyPath = dailyMemoryPath(today);
      const dailyDir = path.dirname(dailyPath);
      fs.mkdirSync(dailyDir, { recursive: true });

      const dailyEntry = fs.existsSync(dailyPath)
        ? `\n### Compact Checkpoint — ${timeStr} (${scopeStr})\n- ${newObservations.length} observations captured since last checkpoint\n`
        : `# Daily Log — ${today}\n\n### Compact Checkpoint — ${timeStr} (${scopeStr})\n- ${newObservations.length} observations captured since last checkpoint\n`;

      fs.appendFileSync(dailyPath, dailyEntry, 'utf-8');
      logToFile(HOOK_NAME, 'DEBUG', `Checkpoint appended to daily memory: ${dailyPath}`);
      anyWriteSucceeded = true;
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Checkpoint daily memory write failed (non-fatal):', err);
  }

  // Only advance checkpoint_state if at least one write succeeded (Codex finding #1)
  if (anyWriteSucceeded) {
    upsertCheckpointState(db, sessionId, nowMs, activeFiles);
    logToFile(HOOK_NAME, 'DEBUG', `Checkpoint state updated: last_epoch=${nowMs}, active_files=${activeFiles.length}`);
  } else {
    logToFile(HOOK_NAME, 'WARN', 'All checkpoint writes failed — not advancing last_epoch');
  }
}

runHook('pre-compact', async (input: HookStdin) => {
  const { session_id, transcript_path } = input;
  const trigger = (input as PreCompactInput).trigger ?? 'auto';
  // Sanitize trigger for safe filesystem use (R09)
  const safeTrigger = trigger.replace(/[^a-zA-Z0-9_-]/g, '');

  // Guard: missing transcript_path
  if (!transcript_path) {
    logToFile('pre-compact', 'WARN', 'transcript_path missing from input — skipping');
    return {};
  }

  // Guard: file does not exist
  if (!fs.existsSync(transcript_path)) {
    logToFile('pre-compact', 'WARN', `Transcript file does not exist: ${transcript_path}`);
    return {};
  }

  // Guard: empty file
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcript_path);
  } catch (err) {
    logToFile('pre-compact', 'WARN', `Cannot stat transcript: ${transcript_path}`, err);
    return {};
  }

  if (stat.size === 0) {
    logToFile('pre-compact', 'WARN', `Transcript is empty (0 bytes): ${transcript_path}`);
    return {};
  }

  // Build destination path
  const destDir = transcriptDir(session_id);
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to create transcript dir: ${destDir}`, err);
    return {};
  }

  // Timestamp with hyphens (filesystem-safe), includes millis for uniqueness
  const now = new Date();
  const ts = now.toISOString()
    .replace(/:/g, '-')     // HH:mm:ss → HH-mm-ss
    .replace('.', '-')      // .123Z → -123Z
    .replace('Z', '');      // strip trailing Z

  const filename = `${ts}-precompact-${safeTrigger}.jsonl`;
  const destPath = path.join(destDir, filename);

  // Copy transcript
  let content: Buffer;
  try {
    content = fs.readFileSync(transcript_path);
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to read transcript: ${transcript_path}`, err);
    return {};
  }

  try {
    fs.writeFileSync(destPath, content);
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to write transcript copy: ${destPath}`, err);
    return {};
  }

  // Compute SHA256
  const sha256 = createHash('sha256').update(content).digest('hex');

  // Write .meta.json
  const metaPath = destPath + '.meta.json';
  const meta = {
    schema: SCHEMAS.TRANSCRIPT_SNAPSHOT.schema,
    version: SCHEMAS.TRANSCRIPT_SNAPSHOT.version,
    session_id,
    trigger: 'precompact',
    source: 'pre-compact hook',
    timestamp: now.toISOString(),
    transcript_path,
    snapshot_path: destPath,
    sha256,
    size_bytes: stat.size,
  };

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to write metadata: ${metaPath}`, err);
    return {};
  }

  logToFile('pre-compact', 'INFO',
    `Snapshot saved: ${filename} (${stat.size} bytes, sha256=${sha256})`);

  // =========================================================================
  // Reasoning chain capture — store pre-compaction reasoning to DB + flat file
  // =========================================================================
  const HOOK_NAME = 'pre-compact';
  const MAX_REASONING_LENGTH = 10000;

  try {
    // 1. Detect scope
    const scope = detectScope(input.cwd);
    logToFile(HOOK_NAME, 'DEBUG', `Scope detected: ${scope.type}${scope.type === 'project' ? ` (${scope.name})` : ''}`);

    // 2. Open DB
    const db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping reasoning capture');
      return {};
    }

    try {
      // 3. Reuse transcript buffer from snapshot copy above (O12: avoid second read)
      const transcriptContent: string | undefined = content ? content.toString('utf-8') : undefined;

      // Truncate to last MAX_REASONING_LENGTH chars (most recent reasoning is most valuable)
      let reasoning = transcriptContent || 'Transcript unavailable';
      if (reasoning.length > MAX_REASONING_LENGTH) {
        reasoning = reasoning.slice(-MAX_REASONING_LENGTH);
        logToFile(HOOK_NAME, 'DEBUG', `Reasoning truncated to last ${MAX_REASONING_LENGTH} chars`);
      }

      // C13 fix: redact secrets/PII from reasoning before storage
      reasoning = redactSensitive(reasoning);

      // 4. Build reasoning chain
      const chainTimestamp = new Date().toISOString();
      const chain: Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'> = {
        session_id,
        project: scope.type === 'project' ? scope.name : undefined,
        timestamp: chainTimestamp,
        timestamp_epoch: Date.now(),
        trigger: 'pre_compact',
        title: `Pre-compaction reasoning snapshot — session ${session_id}`,
        reasoning,
        importance: 3,
      };

      // 5. Insert into DB
      const result = insertReasoning(db, chain);
      logToFile(HOOK_NAME, 'DEBUG', `Reasoning chain inserted with id=${result.id}`);

      // 6. Write flat-file mirror
      const safeTsForFile = chainTimestamp
        .replace(/:/g, '-')
        .replace('.', '-')
        .replace('Z', '');

      let reasoningDir: string;
      if (scope.type === 'project') {
        reasoningDir = path.join(scope.path, 'context', 'reasoning', session_id);
      } else {
        reasoningDir = path.join(os.homedir(), '.claudex', 'reasoning', session_id);
      }

      fs.mkdirSync(reasoningDir, { recursive: true });

      const mirrorFilename = `pre_compact_${safeTsForFile}.md`;
      const mirrorPath = path.join(reasoningDir, mirrorFilename);

      const mirrorContent = [
        `# ${chain.title}`,
        '',
        `**Trigger**: ${chain.trigger}`,
        `**Session**: ${session_id}`,
        `**Timestamp**: ${chainTimestamp}`,
        `**Importance**: ${chain.importance}/5`,
        scope.type === 'project' ? `**Project**: ${scope.name}` : '**Scope**: global',
        '',
        '---',
        '',
        chain.reasoning,
        '',
      ].join('\n');

      fs.writeFileSync(mirrorPath, mirrorContent, 'utf-8');
      logToFile(HOOK_NAME, 'DEBUG', `Reasoning flat-file mirror written: ${mirrorPath}`);

      // =====================================================================
      // Compact checkpoint writes — session log, handoff, daily memory
      // =====================================================================
      try {
        writeCompactCheckpoint(session_id, scope, db, safeTrigger, input.cwd);
      } catch (cpErr) {
        logToFile(HOOK_NAME, 'ERROR', 'Compact checkpoint writes failed (non-fatal):', cpErr);
      }

      // =====================================================================
      // Structured YAML checkpoint — safety net for the checkpoint system
      // Catches the case where UserPromptSubmit's 80% trigger didn't fire
      // =====================================================================
      try {
        const projectDir = scope.type === 'project' ? scope.path : PATHS.home;

        // Debounce: skip if latest.yaml modified <60s ago (UserPromptSubmit already wrote)
        const latestPath = path.join(projectDir, 'context', 'checkpoints', 'latest.yaml');
        let shouldWrite = true;
        try {
          const latestStat = fs.statSync(latestPath);
          if (Date.now() - latestStat.mtimeMs < 60_000) {
            shouldWrite = false;
            logToFile(HOOK_NAME, 'DEBUG', 'Structured checkpoint debounced — written <60s ago by UserPromptSubmit');
          }
        } catch { /* latest.yaml doesn't exist — should write */ }

        if (shouldWrite) {
          const gauge = readTokenGaugeWithDetection(transcript_path);
          const scopeStr = scope.type === 'project' ? `project:${scope.name}` : 'global';
          const result = writeCheckpoint({
            projectDir,
            sessionId: session_id,
            scope: scopeStr,
            trigger: 'pre-compact',
            gaugeReading: gauge,
            db,
          });
          if (result) {
            logToFile(HOOK_NAME, 'INFO', `Structured checkpoint written: ${result.checkpointId}`);
          }
        }
      } catch (structCpErr) {
        logToFile(HOOK_NAME, 'WARN', 'Structured checkpoint write failed (non-fatal)', structCpErr);
      }
    } finally {
      // 7. Close DB
      db.close();
    }
  } catch (reasoningErr) {
    // Reasoning capture failure must NOT fail the hook — transcript snapshot is already saved
    logToFile(HOOK_NAME, 'ERROR', 'Reasoning chain capture failed (non-fatal):', reasoningErr);
  }

  return {};
});
