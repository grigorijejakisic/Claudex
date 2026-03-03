/**
 * Claudex v3 — Token Gauge (WP-1)
 *
 * Reads Claude Code's transcript JSONL to extract exact context window
 * utilization from API response metadata. Foundation for the checkpoint
 * system — tells UserPromptSubmit when context hits 75%.
 *
 * NEVER throws. Always returns a GaugeReading.
 */

import * as fs from 'node:fs';
import { recordMetric } from '../shared/metrics.js';

// =============================================================================
// Types
// =============================================================================

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

type GaugeThreshold = 'normal' | 'approaching' | 'checkpoint' | 'critical' | 'unavailable';

export interface GaugeReading {
  status: 'ok' | 'unavailable';
  usage: TokenUsage;
  window_size: number;
  utilization: number;
  formatted: string;
  threshold: GaugeThreshold;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_WINDOW_SIZE = 200_000;
const GAUGE_BAR_WIDTH = 10;
const BOM = '\uFEFF';

/**
 * Incremental checkpoint thresholds (absolute token counts).
 * First threshold matches old 200k compact point (~167k).
 * Subsequent thresholds at ~133k intervals.
 */
export const INCREMENTAL_THRESHOLDS = [
  167_000,  // ~83.5% of 200k — matches old compact behavior
  300_000,  // ~30% of 1M
  450_000,  // ~45% of 1M
  600_000,  // ~60% of 1M
  750_000,  // ~75% of 1M
  900_000,  // ~90% of 1M
] as const;

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const UNAVAILABLE_READING: GaugeReading = {
  status: 'unavailable',
  usage: { ...ZERO_USAGE },
  window_size: DEFAULT_WINDOW_SIZE,
  utilization: 0,
  formatted: '[Token gauge unavailable]',
  threshold: 'unavailable',
};

// =============================================================================
// Threshold Logic
// =============================================================================

function classifyThreshold(utilization: number): GaugeThreshold {
  if (utilization >= 0.95) return 'critical';
  if (utilization >= 0.75) return 'checkpoint';
  if (utilization >= 0.65) return 'approaching';
  return 'normal';
}

// =============================================================================
// Gauge Bar Formatting
// =============================================================================

/**
 * Format a visual gauge bar with utilization percentage and token counts.
 *
 * Example: "[████████░░ 81% | 162k/200k]"
 */
export function formatGauge(utilization: number, inputTokens: number, windowSize: number): string {
  const pct = Math.round(utilization * 100);
  const clampedUtil = Math.min(Math.max(utilization, 0), 1);
  const filled = Math.round(clampedUtil * GAUGE_BAR_WIDTH);
  const empty = GAUGE_BAR_WIDTH - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const formatK = (n: number): string => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  return `[${bar} ${pct}% | ${formatK(inputTokens)}/${formatK(windowSize)}]`;
}

// =============================================================================
// JSONL Parsing (backwards scan)
// =============================================================================

/**
 * Extract TokenUsage from the last assistant message in a JSONL transcript.
 * Reads backwards to find the most recent entry with message.usage.input_tokens.
 * Handles:
 * - Partial/malformed trailing line (actively being written)
 * - CRLF line endings
 * - BOM at start of file
 */
function extractLastUsage(content: string): TokenUsage | null {
  // Strip BOM if present
  let text = content;
  if (text.startsWith(BOM)) {
    text = text.slice(1);
  }

  // Split into lines, filter empties
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

  // Scan backwards — most recent lines are most relevant
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);

      // Look for message.usage.input_tokens
      const usage = parsed?.message?.usage;
      if (usage && typeof usage.input_tokens === 'number') {
        return {
          input_tokens: usage.input_tokens,
          output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
          cache_read_input_tokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
        };
      }
    } catch {
      // Malformed line — skip and try next
      continue;
    }
  }

  return null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Read token utilization from a Claude Code transcript JSONL file.
 *
 * @param transcriptPath - Path to the transcript JSONL file. If undefined/empty, returns unavailable.
 * @param windowSize - Context window size in tokens. Defaults to 200,000.
 * @returns GaugeReading — never throws.
 */
export function readTokenGauge(transcriptPath: string | undefined, windowSize?: number): GaugeReading {
  const start = Date.now();
  const ws = windowSize ?? DEFAULT_WINDOW_SIZE;

  try {
    // Guard: missing/empty transcript path
    if (!transcriptPath) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Guard: file doesn't exist
    if (!fs.existsSync(transcriptPath)) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Guard: empty file
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    if (stat.size === 0) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Read file content
    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Extract usage from last assistant message
    const usage = extractLastUsage(content);
    if (!usage) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Compute utilization — sum all input token types (uncached + cache creation + cache read)
    const totalInput = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    const utilization = ws > 0 ? totalInput / ws : 0;
    const threshold = classifyThreshold(utilization);
    const formatted = formatGauge(utilization, totalInput, ws);

    return {
      status: 'ok',
      usage,
      window_size: ws,
      utilization,
      formatted,
      threshold,
    };
  } catch {
    // NEVER throw — return unavailable
    return { ...UNAVAILABLE_READING, window_size: ws };
  } finally {
    const duration = Date.now() - start;
    recordMetric('token_gauge_read', duration);
  }
}
