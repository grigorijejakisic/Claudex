/**
 * P9 — Probe schema + loader (Zod gate).
 *
 * Single source of truth for the drift-detection probe fixture shape.
 * Runtime validation via Zod — any deviation in fixture authoring throws
 * at load time rather than producing a silently-malformed measurement.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DriftKindSchema = z.enum(['a', 'b', 'c', 'd', 'e']);
export type DriftKind = z.infer<typeof DriftKindSchema>;

export const ProbeSchema = z.object({
  /** Stable identifier — drift-{kind}-{NN}, e.g. drift-a-01 */
  id: z.string().regex(/^drift-[a-e]-(0[1-6])$/),
  /** Drift taxonomy kind (CONTEXT.md decision 1) */
  kind: DriftKindSchema,
  /** Real claudex-v3 history vs synthetically constructed (≤30% per kind) */
  source: z.enum(['real', 'synthetic']),
  /** The agent-facing query that triggers the past decision retrieval */
  prompt: z.string().min(20),
  /** Artifact id(s) the summary-only baseline retrieves */
  past_artifact_ref: z.array(z.string().min(1)).min(1),
  /** Where the deliberation transcript lives in transcript_chunk_v6 — validates substrate is queryable for B-arm */
  transcript_anchor: z.object({
    session_id: z.string().min(1),
    turn_index_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    description: z.string().min(10),
  }),
  /** Structured description of what's now different */
  condition_shift: z.object({
    past_state: z.string().min(5),
    current_state: z.string().min(5),
    delta: z.string().min(5),
  }),
  /** Explicit rubric trigger for the LLM-as-judge — which condition the agent must surface */
  pass_criterion: z.string().min(20),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const PROBES_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '09-empirical-measurement',
  'probes',
);

export function loadProbe(probePath: string): Probe {
  const raw = fs.readFileSync(probePath, 'utf-8');
  return ProbeSchema.parse(JSON.parse(raw));
}

export function loadAllProbes(dir: string = PROBES_DIR): Probe[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^drift-[a-e]-(0[1-6])\.json$/.test(f));
  return files.sort().map((f) => loadProbe(path.join(dir, f)));
}
