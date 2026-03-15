/**
 * Extraction dispatcher — routes tool events through the full pipeline.
 * Pipeline: dispatch -> quality gate -> extract -> redact -> classify -> score -> dedup -> store.
 * Non-throwing: returns null on any error.
 */

import type { Database } from 'better-sqlite3';
import { emitTelemetry } from '../observability/telemetry.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';
import type { ExtractorFn } from './extractors/types.js';
import { extractRead } from './extractors/read.js';
import { extractEdit } from './extractors/edit.js';
import { extractWrite } from './extractors/write.js';
import { extractBash } from './extractors/bash.js';
import { extractGrep } from './extractors/grep.js';
import { extractGlob } from './extractors/glob.js';
import { extractWebFetch } from './extractors/web-fetch.js';
import { extractWebSearch } from './extractors/web-search.js';
import { extractTask } from './extractors/task.js';
import { extractNotebookEdit } from './extractors/notebook-edit.js';
import { passesQualityGate } from './quality-gate.js';
import { redactContent } from './redaction.js';
import { sanitizePath } from './redaction.js';
import { classifyCategory } from './scoring.js';
import { scoreImportance } from './scoring.js';
import { classifyObservationType, applyTypePrior } from './type-classifier.js';
import { insertObservation } from '../core/observations.js';
import { CONTENT_MAX_CHARS } from '../shared/constants.js';
import { truncateText } from '../shared/text-utils.js';

/** Input for processToolObservation. */
export interface ProcessToolObservationInput {
  db: Database;
  sessionId: string;
  project: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  /** For path sanitization */
  projectRoot?: string;
}

/** Per-tool extractor dispatch map. */
const EXTRACTOR_MAP: Record<string, ExtractorFn> = {
  Read: extractRead,
  Edit: extractEdit,
  Write: extractWrite,
  Bash: extractBash,
  Grep: extractGrep,
  Glob: extractGlob,
  WebFetch: extractWebFetch,
  WebSearch: extractWebSearch,
  Task: extractTask,
  NotebookEdit: extractNotebookEdit,
};

/**
 * Processes a tool observation through the full extraction pipeline.
 * Returns the observation id if stored, or null if skipped/failed.
 *
 * Pipeline steps:
 * 1. Dispatch to per-tool extractor
 * 2. Quality gate check
 * 3. Extract structured data
 * 4. Redact content + sanitize paths
 * 5. Classify category
 * 6. Score importance
 * 7. Dedup check (same tool+file+category within 5 minutes)
 * 8. Store via insertObservation
 */
export function processToolObservation(input: ProcessToolObservationInput): number | null {
  try {
    const { db, sessionId, project, toolName, toolInput, toolOutput, projectRoot } = input;

    // 1. Dispatch — find extractor for this tool
    const extractor = EXTRACTOR_MAP[toolName];
    if (!extractor) return null;

    // 2. Quality gate — reject low-signal observations
    const gate = passesQualityGate(toolName, toolInput, toolOutput);
    if (!gate.pass) {
      if (gate.reason === 'quality_gate_error') {
        try { emitTelemetry(db, sessionId, 'error', { subsystem: 'extraction/quality_gate_error', error: `tool=${toolName}` }); } catch {}
      }
      return null;
    }

    // 3. Extract — get structured data from tool input/output
    const result = extractor(toolInput, toolOutput);
    if (!result) return null;

    // 3b. Validate — cap files_modified to prevent heavy DB operations
    const MAX_FILES_MODIFIED = 50;
    const MAX_PATH_LENGTH = 500;
    const validFiles = (Array.isArray(result.files_modified) ? result.files_modified : [])
      .filter((f): f is string => typeof f === 'string' && f.length <= MAX_PATH_LENGTH)
      .slice(0, MAX_FILES_MODIFIED);

    // 4. Redact — apply content redaction, title redaction, and path sanitization
    const redactedContent = redactContent(result.content);
    const redactedTitle = redactContent(result.title);
    const sanitizedFiles = validFiles.map((f) => sanitizePath(f, projectRoot));

    // 5. Classify — determine observation category
    const category = classifyCategory(toolName, redactedTitle, redactedContent);

    // 6. Score — determine importance
    const importance = scoreImportance(toolName, category, redactedContent);

    // 6b. Type Prior classification (Upgrade 8) — apply type-based importance multiplier
    const exitCode = toolName === 'Bash' ? (toolOutput?.exitCode as number | undefined) : undefined;
    const obsType = classifyObservationType(redactedContent, toolName, exitCode);
    const adjustedImportance = applyTypePrior(importance, obsType);

    // 7. Dedup — skip if same tool+file+category+project+session within 5 minutes (300 seconds)
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;

    let existing: { id: number } | undefined;
    if (sanitizedFiles.length > 0) {
      // Match on exact files_modified JSON string for precise dedup
      existing = db
        .prepare(
          `SELECT id FROM observations
           WHERE tool_name = ? AND category = ? AND project = ? AND session_id = ?
             AND timestamp_epoch > ? AND files_modified = ?
             AND deleted_at_epoch IS NULL
           LIMIT 1`
        )
        .get(toolName, category, project, sessionId, fiveMinutesAgo, JSON.stringify(sanitizedFiles)) as { id: number } | undefined;
    } else {
      // No files — dedup on tool+category+project+session+title+content+time window
      // (empty files_modified means tools like Bash; include title to avoid collapsing
      // different commands with identical output)
      // Apply the same normalization that insertObservation applies before
      // storage, so the dedup comparison matches what's actually in the DB.
      const canonTitle = redactedTitle.replace(/\[REDACTED_\w+\]/g, '[REDACTED]');
      const canonContent = truncateText(
        redactedContent.replace(/\[REDACTED_\w+\]/g, '[REDACTED]'),
        CONTENT_MAX_CHARS,
      );
      existing = db
        .prepare(
          `SELECT id FROM observations
           WHERE tool_name = ? AND category = ? AND project = ? AND session_id = ?
             AND content = ? AND title = ?
             AND timestamp_epoch > ?
             AND files_modified = '[]'
             AND deleted_at_epoch IS NULL
           LIMIT 1`
        )
        .get(toolName, category, project, sessionId, canonContent, canonTitle, fiveMinutesAgo) as { id: number } | undefined;
    }

    if (existing) return null;

    // 8. Store — tag external tool observations with provenance prefix
    const storedObsType = gate.provenance === 'external_tool'
      ? `external:${obsType}`
      : obsType;

    const id = insertObservation(db, {
      session_id: sessionId,
      project,
      tool_name: toolName,
      category,
      title: redactedTitle,
      content: redactedContent,
      importance: adjustedImportance,
      files_modified: sanitizedFiles,
      obs_type: storedObsType,
    });

    return id;
  } catch (e) {
    emitErrorTelemetry(input.db, input.sessionId, 'extraction/observe', e);
    return null;
  }
}
