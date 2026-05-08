import type { Database } from 'better-sqlite3';
import type { Probe } from './probe-schema.js';
import type { ArmRunResult } from './types.js';
import { hybridSearchAsync, type ScoredArtifact } from '../../core/hybrid-retrieval.js';

const AGENT_MODEL = 'deepseek-coder-v2:16b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const AGENT_TIMEOUT_MS = 180_000;
const DEFAULT_PROJECT = 'claudex-v3';

export interface RunArmOpts {
  fetcher?: typeof fetch;
  ollamaUrl?: string;
  agentModel?: string;
  timeoutMs?: number;
  /** Project scope for hybrid retrieval. Defaults to claudex-v3 (where the deliberation lives). */
  project?: string;
}

interface AgentInvocationResult {
  response: string;
  latency_ms: number;
}

/**
 * Shared agent invocation. Both arm modules call this with different
 * rendered prompts (A-arm = probe.prompt only; B-arm = probe.prompt +
 * injected transcript spans).
 */
export async function invokeAgent(
  prompt: string,
  opts: RunArmOpts = {},
): Promise<AgentInvocationResult> {
  const f = opts.fetcher ?? fetch;
  const url = opts.ollamaUrl ?? OLLAMA_URL;
  const model = opts.agentModel ?? AGENT_MODEL;
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;

  const t0 = Date.now();
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
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return {
      response: data.message?.content ?? '',
      latency_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A-arm: invokes the agent with the existing v4 hybrid-retrieval surface.
 * NO transcript injection. NO vec_transcript_chunks_v6.
 */
export async function runSummaryArm(
  db: Database,
  probe: Probe,
  opts: RunArmOpts = {},
): Promise<ArmRunResult> {
  const project = opts.project ?? DEFAULT_PROJECT;
  let injected_artifact_count = 0;
  let renderedContext = '';
  try {
    const artifacts: ScoredArtifact[] = await hybridSearchAsync(db, probe.prompt, project, { limit: 10 });
    injected_artifact_count = artifacts.length;
    renderedContext = artifacts
      .map((a, i) => `[ctx-${i + 1}] ${(a.summary ?? a.content ?? '').slice(0, 600)}`)
      .join('\n');
  } catch (err) {
    return {
      arm: 'summary',
      probe_id: probe.id,
      agent_model: opts.agentModel ?? AGENT_MODEL,
      agent_response: '',
      injected_context_summary: { artifact_count: 0, transcript_span_count: 0, retrieval_path: 'none' },
      latency_ms: 0,
      error: `hybridSearchAsync failed: ${String(err)}`,
    };
  }

  const fullPrompt =
    `You are answering a question with the following context retrieved from memory:\n\n` +
    `${renderedContext}\n\n---\n\nQuestion: ${probe.prompt}\n\n` +
    `Answer in 2-4 paragraphs. Cite specific session_ids and turn_indexes when referencing prior conversations.`;

  try {
    const inv = await invokeAgent(fullPrompt, opts);
    return {
      arm: 'summary',
      probe_id: probe.id,
      agent_model: opts.agentModel ?? AGENT_MODEL,
      agent_response: inv.response,
      injected_context_summary: {
        artifact_count: injected_artifact_count,
        transcript_span_count: 0,
        retrieval_path: 'none',
      },
      latency_ms: inv.latency_ms,
    };
  } catch (err) {
    return {
      arm: 'summary',
      probe_id: probe.id,
      agent_model: opts.agentModel ?? AGENT_MODEL,
      agent_response: '',
      injected_context_summary: { artifact_count: injected_artifact_count, transcript_span_count: 0, retrieval_path: 'none' },
      latency_ms: 0,
      error: `agent invocation failed: ${String(err)}`,
    };
  }
}
