/**
 * CM Adapter — 4-Tier Decision Extraction
 *
 * @experimental These modules support cm-stop hook which is not yet
 * registerable in Claude Code. Built for future use when Stop hook
 * registration is supported.
 *
 * Ported from OpenClaw Context Manager's extractDecisionFromResponse.
 * Extracts meaningful decision lines from assistant responses using
 * tiered heuristics with quality gates.
 */

import { linesOutsideCodeFences } from './code-fence.js';
import { truncateText } from '../shared/text-utils.js';

const ACTION_VERBS = new Set([
  'use', 'add', 'remove', 'replace', 'create', 'implement', 'switch', 'move',
  'keep', 'skip', 'merge', 'split', 'export', 'import', 'change', 'fix',
  'update', 'deploy', 'persist', 'store', 'read', 'write', 'inject', 'filter',
  'track', 'chose', 'decided',
]);

const FILLER_RE = /^(you're right|ohoho|haha|hmm|well,|okay so|sure,|yeah|ok |ah |oh )/i;

function hasActionVerb(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).slice(0, 10);
  return words.some(w => ACTION_VERBS.has(w.replace(/[^a-z]/g, '')));
}

function hasStructuralMarker(text: string): boolean {
  return /\*\*/.test(text) || /^[-*]\s/.test(text) || /^\d+\.\s/.test(text) || /:\s/.test(text);
}

function passesQualityGate(text: string): boolean {
  if (FILLER_RE.test(text)) return false;
  if (text.trimEnd().endsWith('?')) return false;
  if (!hasActionVerb(text) && !hasStructuralMarker(text)) return false;
  return true;
}

/**
 * Extract a decision line from an assistant response.
 *
 * Tier 1: Explicit markers (Decision:, Plan:, Going with, Chose, Choosing)
 * Tier 2: Action intent (I'll, We'll, Let's, The approach is)
 * Tier 3: Structured formats (bold-prefixed bullets, bold headings with action verbs)
 * Tier 4: Action-verb bullets (plain/numbered bullets with action verbs in first 5 words)
 *
 * Code fences are skipped. Quality gate rejects filler and questions.
 */
export function extractDecisionFromResponse(text: string): string | null {
  const candidates: Array<{ tier: number; line: string }> = [];

  for (const { raw, trimmed } of linesOutsideCodeFences(text)) {
    // Tier 1: Explicit decision markers
    if (/^(Decision:|Plan:|Approach:|Going with|Chose|Choosing)/i.test(trimmed)) {
      candidates.push({ tier: 1, line: raw.trim() });
      continue;
    }

    // Tier 2: Action intent
    if (
      /^(I'll|We'll|Let's|I will|We will|I'm going to|We're going to)/i.test(trimmed) ||
      /^(The approach is|The plan is|The fix is|The solution is)/i.test(trimmed)
    ) {
      candidates.push({ tier: 2, line: raw.trim() });
      continue;
    }

    // Tier 3: Structured formats
    if (/^[-*]\s+\*\*[^*]+\*\*/.test(trimmed)) {
      candidates.push({ tier: 3, line: raw.trim() });
      continue;
    }
    if (trimmed.startsWith('**') && hasActionVerb(trimmed)) {
      candidates.push({ tier: 3, line: raw.trim() });
      continue;
    }

    // Tier 4: Action-verb bullets
    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      const words = trimmed.split(/\s+/).slice(0, 5);
      if (words.some(w => ACTION_VERBS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) {
        candidates.push({ tier: 4, line: raw.trim() });
      }
    }
  }

  candidates.sort((a, b) => a.tier - b.tier);

  for (const c of candidates) {
    if (passesQualityGate(c.line)) {
      return truncateText(c.line, 200);
    }
  }

  return null;
}

/**
 * Detect if a user message is a short confirmation of a prior agent proposal.
 * Used to trigger decision extraction from the preceding agent response.
 */
export function isConfirmationMessage(userText: string): boolean {
  const trimmed = userText.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith('?')) return false;
  if (/\b(no|don't|stop|wait|cancel)\b/i.test(trimmed)) return false;

  const hasConfirmKeyword = /\b(yes|go|do it|ship it|pick|approve|proceed|let's go|sounds good|go ahead|implement|fix|ok|okay|sure|agreed|confirm|da|ja|oui|si|sim|vai)\b/i.test(trimmed);

  return hasConfirmKeyword && trimmed.length < 50;
}
