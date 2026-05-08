import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { Probe } from './probe-schema.js';
import type { JudgeVerdict, JudgeProngOutcome } from './types.js';

export const JUDGE_MODEL = 'deepseek-coder-v2:16b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const JUDGE_TIMEOUT_MS = 120_000; // 2-min budget per probe — local 16b model is slow but bounded

const JUDGE_PROMPT_PATH = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '09-empirical-measurement',
  'judge-prompt.md',
);

let cachedTemplate: string | null = null;
function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  cachedTemplate = fs.readFileSync(JUDGE_PROMPT_PATH, 'utf-8');
  return cachedTemplate;
}

/** Reset the cached judge-prompt template — for tests that mock the template. */
export function _resetJudgeTemplateCache(): void {
  cachedTemplate = null;
}

const KIND_DESCRIPTIONS: Record<Probe['kind'], string> = {
  a: 'sample-size shift',
  b: 'threshold-source drift',
  c: 'scope-change drift',
  d: 'dependency-change drift',
  e: 'assumption drift',
};

/** Deterministically render the judge prompt by string-substituting probe + response into the locked template. */
export function renderJudgePrompt(probe: Probe, response: string): string {
  const tpl = loadTemplate();
  return tpl
    .replaceAll('{probe_id}', probe.id)
    .replaceAll('{kind_description}', KIND_DESCRIPTIONS[probe.kind])
    .replaceAll('{kind}', probe.kind)
    .replaceAll('{prompt}', probe.prompt)
    .replaceAll('{pass_criterion}', probe.pass_criterion)
    .replaceAll('{past_artifact_ref}', probe.past_artifact_ref.join(', '))
    .replaceAll('{past_state}', probe.condition_shift.past_state)
    .replaceAll('{current_state}', probe.condition_shift.current_state)
    .replaceAll('{delta}', probe.condition_shift.delta)
    .replaceAll('{response_text}', response);
}

const JudgeOutputSchema = z.object({
  prong_1: z.object({ verdict: z.enum(['PASS', 'FAIL']), justification: z.string() }),
  prong_2: z.object({ verdict: z.enum(['PASS', 'FAIL']), justification: z.string() }),
  prong_3: z.object({ verdict: z.enum(['PASS', 'FAIL']), justification: z.string() }),
});

/**
 * Parses raw judge model output into a typed JudgeVerdict. Throws on malformed.
 * The model is instructed to return JSON; if it wraps the JSON in markdown
 * fences or prose, this function extracts the first {...} block before parsing.
 */
export function parseJudgeOutput(raw: string): JudgeVerdict {
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
    throw new Error(`Judge output contains no JSON block: ${raw.slice(0, 200)}`);
  }
  const candidate = raw.slice(jsonStart, jsonEnd + 1);
  const parsed = JudgeOutputSchema.parse(JSON.parse(candidate));
  const probe_pass =
    parsed.prong_1.verdict === 'PASS' &&
    parsed.prong_2.verdict === 'PASS' &&
    parsed.prong_3.verdict === 'PASS';
  return {
    prong_1: parsed.prong_1 as JudgeProngOutcome,
    prong_2: parsed.prong_2 as JudgeProngOutcome,
    prong_3: parsed.prong_3 as JudgeProngOutcome,
    probe_pass,
    raw_response: raw,
  };
}

export interface CallJudgeOpts {
  fetcher?: typeof fetch;
  ollamaUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Up to N retries on parse failure (NOT on transport failure — transport failures throw immediately). */
  maxParseRetries?: number;
}

/**
 * Calls the judge model with the rendered prompt and returns a typed JudgeVerdict.
 * On transport failure: throws.
 * On parse failure: re-prompts up to maxParseRetries times before throwing.
 */
export async function callJudge(
  probe: Probe,
  response: string,
  opts: CallJudgeOpts = {},
): Promise<JudgeVerdict> {
  const f = opts.fetcher ?? fetch;
  const url = opts.ollamaUrl ?? OLLAMA_URL;
  const model = opts.model ?? JUDGE_MODEL;
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  const maxRetries = opts.maxParseRetries ?? 1;

  const prompt = renderJudgePrompt(probe, response);

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { temperature: 0 },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content ?? '';
      try {
        return parseJudgeOutput(content);
      } catch (parseErr) {
        lastError = parseErr;
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Judge call failed after ${maxRetries + 1} parse attempts: ${String(lastError)}`);
}
