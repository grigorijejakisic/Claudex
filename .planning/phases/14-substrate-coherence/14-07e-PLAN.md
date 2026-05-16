---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07e
type: execute
wave: 2
depends_on: ["07-LINKS-SCHEMA"]
files_modified:
  - src/mcp/recall-server.ts
  - src/mcp/tools/claudex-trace.ts (NEW)
  - src/intelligence/link-distance-boost.ts (NEW)
  - src/intelligence/hybrid-retrieval.ts
  - src/tests/mcp/claudex-trace.test.ts (NEW)
  - src/tests/intelligence/link-distance-boost.test.ts (NEW)
  - src/tests/intelligence/hybrid-retrieval-with-boost.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "`claudex_trace` MCP tool walks the link graph from a given artifact and returns the N-hop neighborhood. Reads both soft_link and hard_link (CONFIRMED only — pending hard links not exposed via trace)."
    - "Trace tool parameters: `artifact_id` (required, V17 TEXT), `max_hops` (default 3, capped at 5), `types` (optional filter on link types), `direction` (default 'both'; values: 'outgoing', 'incoming', 'both')."
    - "Trace tool returns: array of `{ artifact_id, hop_distance, path_via_links, kind, summary }`. Result deduplicated — if an artifact is reachable via multiple paths, only the SHORTEST path appears."
    - "Link-distance boost is OFF by default. Feature flag: `CLAUDEX_LINK_DISTANCE_BOOST` env var. Values: unset/`0`/`false` = OFF (current ranking behavior); `1`/`true` = ON. Per CONTEXT position-unless-flagged 1, ships off; operator enables after telemetry observation."
    - "Boost integration in hybrid-retrieval.ts is AT THE RERANK STEP, not at the candidate-pool stage. Reason: link distance is a re-ranking signal, not a candidate-discovery signal. The existing FTS5 + vec0 retrieval + BGE-v2-m3 reranker keeps producing the same candidates; the boost adjusts final ranks only."
    - "Boost formula (locked): `boosted_score = original_score * (1 + boost_weight * (1 / hop_distance))`. boost_weight is configurable env (`CLAUDEX_LINK_DISTANCE_BOOST_WEIGHT`, default 0.1). hop_distance=0 (same artifact) caps at boost_weight * 1.0; hop_distance > max_hops contributes 0."
    - "Boost respects link tier: confirmed hard links contribute full weight; soft links contribute weight/2 (soft links are autonomous-tier and weaker signal). Reason: hard links survived operator review."
    - "Trace tool and boost both READ from the link tables; neither writes. Read-only side of the link substrate."
    - "Boost is project-scoped: only links within the query's project contribute. Per Wave 2 LINKS-SCHEMA denormalization of `project` on link rows, this is a single index scan."
  artifacts:
    - path: "src/mcp/recall-server.ts"
      provides: "Existing MCP server; registers the new claudex_trace tool alongside existing tools (claudex_search, claudex_recall, claudex_message, etc.)"
      contains: "claudex_trace|registerTool"
    - path: "src/mcp/tools/claudex-trace.ts"
      provides: "Handler for the claudex_trace MCP tool. Performs BFS over the link graph; returns the N-hop neighborhood."
      contains: "handleClaudexTrace|bfsLinkGraph|TraceParams|TraceResult"
    - path: "src/intelligence/link-distance-boost.ts"
      provides: "Scoring helper that computes per-candidate link distance to a query artifact and applies the boost formula. Pure function plus a DB query helper."
      contains: "computeLinkDistance|applyLinkDistanceBoost|BOOST_WEIGHT_DEFAULT"
    - path: "src/intelligence/hybrid-retrieval.ts"
      provides: "Existing hybrid retrieval; extended with link-distance boost behind feature flag. Existing ranking math unchanged in flag-off state."
      contains: "CLAUDEX_LINK_DISTANCE_BOOST|applyLinkDistanceBoost"
    - path: "src/tests/mcp/claudex-trace.test.ts"
      provides: "Tests for the trace tool: BFS correctness, hop cap, direction filter, types filter, deduplication of paths"
      contains: "bfs|hop_cap|direction|types|deduplicate"
    - path: "src/tests/intelligence/link-distance-boost.test.ts"
      provides: "Tests for the boost formula: weights, soft vs hard tier, project scoping, flag-off no-op"
      contains: "boost_formula|hard_weight|soft_weight|project_scope|flag_off"
    - path: "src/tests/intelligence/hybrid-retrieval-with-boost.test.ts"
      provides: "Integration tests for boost in retrieval pipeline: flag-on path lifts linked artifacts; flag-off path unchanged"
      contains: "flag_on|flag_off|lifted_rank"
  key_links:
    - from: "src/mcp/tools/claudex-trace.ts"
      to: "src/core/link-writer.ts (listSoftLinks, listConfirmedHardLinks, getDecayCount)"
      via: "Trace tool reads link rows via link-writer's read APIs"
      pattern: "listSoftLinks|listConfirmedHardLinks"
    - from: "src/intelligence/link-distance-boost.ts"
      to: "src/core/link-writer.ts"
      via: "Boost helper reads link rows for distance computation"
      pattern: "listSoftLinks|listConfirmedHardLinks"
    - from: "src/intelligence/hybrid-retrieval.ts"
      to: "src/intelligence/link-distance-boost.ts"
      via: "Hybrid retrieval invokes the boost at rerank step when flag is ON"
      pattern: "CLAUDEX_LINK_DISTANCE_BOOST|applyLinkDistanceBoost"
---

<objective>
Two deliverables in one plan, both READ-side of the link substrate:

1. **`claudex_trace` MCP tool** — registered in `src/mcp/recall-server.ts`, handled in `src/mcp/tools/claudex-trace.ts`. Walks the link graph (soft + confirmed hard) via BFS from a starting artifact; returns the N-hop neighborhood with hop distance + path. Used by the agent to query "what's connected to this decision?" or "trace back from this lesson to source observations."

2. **Link-distance retrieval boost** — additive scoring modifier in `src/intelligence/link-distance-boost.ts`, integrated into `src/intelligence/hybrid-retrieval.ts` at the rerank step. Behind feature flag `CLAUDEX_LINK_DISTANCE_BOOST` (default OFF per CONTEXT position-unless-flagged). Closer-linked candidates rank higher.

After this plan lands:
- Agent can call `claudex_trace(artifact_id, max_hops=3)` and receive the neighborhood graph.
- Hybrid retrieval has a flag-gated rerank modifier that respects the link graph.
- Telemetry surfaces whether the flag is on/off and what the boost did per query.

| What this plan provides | Why |
|---|---|
| claudex_trace MCP tool | Agent-accessible graph walk |
| Link-distance scoring helper | Per-candidate distance computation |
| Hybrid-retrieval integration | Boost applied at rerank step |
| Feature flag default OFF | Ship conservatively; operator enables after observation |
| Project-scoped boost | Cross-project links ignored |
| Soft vs hard tier weighting | Operator-confirmed links contribute more |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07-LINKS-SCHEMA-PLAN.md
@src/mcp/recall-server.ts
@src/intelligence/hybrid-retrieval.ts
@src/core/link-writer.ts
</context>

<anti_scope>
- Do NOT modify the existing hybrid-retrieval scoring math (FTS5/vec0/BGE-reranker weights). The boost is ADDITIVE at the rerank step only.
- Do NOT include PENDING hard links in the trace tool or boost. Only soft links + CONFIRMED hard links contribute.
- Do NOT expose write paths via the MCP tool; trace is read-only.
- Do NOT change the BGE-v2-m3 reranker config or arctic-embed2 model.
- Do NOT propose or write any links — that's 14-07d (soft writers) / 14-07f (hard proposer) territory.
- Do NOT ship the boost with the flag ON by default. Operator decides flag-on after telemetry observation.
- Do NOT change the candidate-pool stage of retrieval. The boost is rerank-only.
- Do NOT touch session-start surfaces (Wave 3 territory).
- Do NOT modify link-writer.ts; this plan consumes it.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: claudex_trace MCP tool handler</name>
  <files>src/mcp/tools/claudex-trace.ts</files>
  <action>
Create new file with the trace tool handler.

```typescript
import type { Database } from 'better-sqlite3';
import { listSoftLinks, listConfirmedHardLinks } from '../../core/link-writer.js';

/**
 * Phase 14-07e — claudex_trace MCP tool.
 *
 * Walks the link graph via BFS from a starting artifact.
 * Returns the N-hop neighborhood with hop distance + path.
 * Reads soft_link + CONFIRMED hard_link.
 */

export interface TraceParams {
  artifact_id: string;
  max_hops?: number;          // default 3, capped at 5
  types?: string[];           // optional filter; null = all types
  direction?: 'outgoing' | 'incoming' | 'both';  // default 'both'
}

export interface TraceResultRow {
  artifact_id: string;
  kind: string;
  summary: string;
  hop_distance: number;
  path_via_links: Array<{ type: string; via_artifact_id: string }>;
}

export interface TraceResult {
  start_artifact_id: string;
  total_reached: number;
  max_hops_used: number;
  results: TraceResultRow[];   // sorted by hop_distance asc, then artifact_id asc
}

export const MAX_HOPS_CAP = 5;

export function handleClaudexTrace(db: Database, params: TraceParams): TraceResult {
  const max_hops = Math.min(params.max_hops ?? 3, MAX_HOPS_CAP);
  const direction = params.direction ?? 'both';
  const type_filter = params.types ?? null;

  // BFS state
  const visited = new Map<string, TraceResultRow>();   // id → row
  const queue: Array<{ id: string; distance: number; path: TraceResultRow['path_via_links'] }> = [];
  queue.push({ id: params.artifact_id, distance: 0, path: [] });

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;

    // Record this node
    const artifact = lookupArtifact(db, node.id);
    if (!artifact) continue;  // dead reference; skip silently

    visited.set(node.id, {
      artifact_id: node.id,
      kind: artifact.kind,
      summary: artifact.summary,
      hop_distance: node.distance,
      path_via_links: node.path,
    });

    if (node.distance >= max_hops) continue;

    // Outgoing soft links
    if (direction === 'outgoing' || direction === 'both') {
      const out_soft = listSoftLinks(db, node.id, 'outgoing', type_filter as any);
      const out_hard = listConfirmedHardLinks(db, node.id, 'outgoing');
      for (const link of [...out_soft, ...out_hard]) {
        if (type_filter && !type_filter.includes(link.type)) continue;
        if (!visited.has(link.dst)) {
          queue.push({
            id: link.dst,
            distance: node.distance + 1,
            path: [...node.path, { type: link.type, via_artifact_id: node.id }],
          });
        }
      }
    }
    // Incoming
    if (direction === 'incoming' || direction === 'both') {
      const in_soft = listSoftLinks(db, node.id, 'incoming', type_filter as any);
      const in_hard = listConfirmedHardLinks(db, node.id, 'incoming');
      for (const link of [...in_soft, ...in_hard]) {
        if (type_filter && !type_filter.includes(link.type)) continue;
        if (!visited.has(link.src)) {
          queue.push({
            id: link.src,
            distance: node.distance + 1,
            path: [...node.path, { type: link.type, via_artifact_id: node.id }],
          });
        }
      }
    }
  }

  const results = Array.from(visited.values()).sort((a, b) => {
    if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
    return a.artifact_id.localeCompare(b.artifact_id);
  });

  return {
    start_artifact_id: params.artifact_id,
    total_reached: results.length,
    max_hops_used: max_hops,
    results,
  };
}

function lookupArtifact(db: Database, id: string): { kind: string; summary: string } | null {
  const row = db.prepare('SELECT kind, summary FROM artifact WHERE id = ?').get(id) as any;
  return row || null;
}
```
  </action>
  <verification>
- BFS traversal correct for hand-crafted link graphs.
- max_hops cap enforced (param > 5 clamped to 5).
- direction filter restricts BFS expansion.
- types filter restricts link traversal.
- Deduplication: same artifact reachable via multiple paths appears once with shortest hop_distance.
- Dead references (artifact deleted) skipped silently.
- Results sorted by hop_distance asc, then artifact_id asc.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Register claudex_trace in MCP recall server</name>
  <files>src/mcp/recall-server.ts</files>
  <action>
Locate the existing tool registration block (e.g., where `claudex_search` and `claudex_recall` are registered). Add `claudex_trace` registration with the documented schema:

```typescript
server.registerTool({
  name: 'claudex_trace',
  description: 'Walk the link graph from a given artifact. Returns the N-hop neighborhood with hop distance + path. Reads soft + confirmed hard links.',
  parameters: {
    type: 'object',
    properties: {
      artifact_id: { type: 'string', description: 'V17 TEXT id of the starting artifact' },
      max_hops: { type: 'number', description: 'Default 3; capped at 5', default: 3 },
      types: { type: 'array', items: { type: 'string' }, description: 'Optional filter on link types' },
      direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], default: 'both' },
    },
    required: ['artifact_id'],
  },
  handler: async (params) => {
    return handleClaudexTrace(getDb(), params);
  },
});
```

Verify the registration block syntax matches the existing pattern in recall-server.ts.
  </action>
  <verification>
- claudex_trace appears in the registered tool list at server startup.
- MCP clients can invoke claudex_trace.
- Existing tool handlers (claudex_search, claudex_recall, etc.) unchanged.
  </verification>
</task>

<task type="auto">
  <name>Task 3: link-distance-boost.ts scoring helper</name>
  <files>src/intelligence/link-distance-boost.ts</files>
  <action>
Create new file.

```typescript
import type { Database } from 'better-sqlite3';
import { handleClaudexTrace } from '../mcp/tools/claudex-trace.js';

/**
 * Phase 14-07e — link-distance retrieval boost.
 *
 * Computes per-candidate link distance to a query artifact (or a
 * set of query artifacts) and applies an additive ranking boost.
 * Behind feature flag CLAUDEX_LINK_DISTANCE_BOOST.
 */

export const BOOST_WEIGHT_DEFAULT = 0.1;

export interface Candidate {
  artifact_id: string;
  score: number;
  [key: string]: any;
}

export interface BoostParams {
  candidates: Candidate[];
  query_artifact_ids: string[];   // typically the top-K reranked seeds
  project: string;
  max_hops?: number;
  boost_weight?: number;          // default BOOST_WEIGHT_DEFAULT
}

/**
 * Apply link-distance boost to a candidate list.
 *
 * Formula: boosted_score = original_score * (1 + boost_weight * (1 / hop_distance))
 *   - hop_distance = shortest link path from any query artifact to candidate
 *   - boost_weight = configurable
 *   - hard links contribute full weight; soft links half
 *
 * Returns new candidate list, re-sorted by boosted_score desc.
 */
export function applyLinkDistanceBoost(db: Database, params: BoostParams): Candidate[];

/**
 * Compute link distance from a single source artifact to a target.
 * Returns null if unreachable within max_hops.
 * Returns { hop_distance, link_tier } where link_tier ∈ {'soft', 'hard'}
 * for the WEAKEST link in the path (path is as strong as its weakest link).
 */
export function computeLinkDistance(
  db: Database,
  src_id: string,
  dst_id: string,
  max_hops: number
): { hop_distance: number; link_tier: 'soft' | 'hard' } | null;
```

Implementation:

- `computeLinkDistance` uses `handleClaudexTrace` internally with the target as the query artifact and walks outward looking for the destination. Returns the shortest hop_distance found.
- `applyLinkDistanceBoost` iterates candidates; for each, computes the MINIMUM hop_distance from any query_artifact_id in the set; applies the boost formula.
- Project scoping: link queries via listSoftLinks / listConfirmedHardLinks naturally respect the project column on link rows.
- The weakest-link semantics: a path of `soft → soft → hard` is `soft` tier overall (weakest wins). A path of all-hard is hard tier.
- Hard tier weight multiplier: 1.0. Soft tier: 0.5.

Final formula:
```
tier_multiplier = link_tier === 'hard' ? 1.0 : 0.5
boost = boost_weight * tier_multiplier * (1 / hop_distance)
boosted_score = original_score * (1 + boost)
```

Where hop_distance is bounded (≥1; max_hops cap).
  </action>
  <verification>
- computeLinkDistance returns null for unreachable target.
- computeLinkDistance returns 1 for directly-linked source-target.
- computeLinkDistance returns 2 for two-hop path.
- Weakest-link tier semantics correct.
- applyLinkDistanceBoost: linked candidates get higher boosted_score than unlinked.
- applyLinkDistanceBoost: candidates re-sorted by boosted_score desc.
- Project scoping: cross-project links don't contribute.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Hybrid-retrieval integration behind feature flag</name>
  <files>src/intelligence/hybrid-retrieval.ts</files>
  <action>
Locate the rerank step in hybrid-retrieval.ts. Currently the flow is:

```
candidates = candidatePool(query)
candidates = applyBgeReranker(candidates)
return candidates
```

Insert the boost AFTER the BGE reranker, BEFORE the return:

```typescript
if (process.env.CLAUDEX_LINK_DISTANCE_BOOST === '1' || process.env.CLAUDEX_LINK_DISTANCE_BOOST === 'true') {
  // Telemetry: boost enabled
  emitTelemetry(db, {
    event_kind: 'link_distance_boost_applied',
    session_id: session_id,
    detail: { candidates_in: candidates.length, max_hops: 3 },
  });

  const boost_weight = parseFloat(process.env.CLAUDEX_LINK_DISTANCE_BOOST_WEIGHT ?? String(BOOST_WEIGHT_DEFAULT));
  const query_seeds = candidates.slice(0, 3).map(c => c.artifact_id);  // top-3 reranked seeds

  candidates = applyLinkDistanceBoost(db, {
    candidates,
    query_artifact_ids: query_seeds,
    project,
    max_hops: 3,
    boost_weight,
  });
}
```

The flag-off path (default) is the existing behavior, byte-equivalent. Verify via diff inspection.

Add `// 14-07e: link-distance boost (flag-gated)` comment marker.
  </action>
  <verification>
- Flag-off: existing tests pass with no observable change.
- Flag-on (env var set): boost applied; candidates re-ranked; telemetry emitted.
- Diff inspection confirms no change to scoring math outside the boost block.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Tests for claudex_trace</name>
  <files>src/tests/mcp/claudex-trace.test.ts</files>
  <action>
New test file. Tests:

1. `trace: direct outgoing link → 1 result at hop=1`
2. `trace: two-hop chain → 2 results at hop=1 and hop=2`
3. `trace: max_hops=2 caps result set`
4. `trace: max_hops>5 clamped to 5`
5. `trace: direction=outgoing excludes incoming`
6. `trace: direction=incoming excludes outgoing`
7. `trace: direction=both returns union`
8. `trace: types filter restricts traversal`
9. `trace: deduplication — same artifact via two paths returns once with shortest distance`
10. `trace: dead reference (linked artifact deleted) skipped silently`
11. `trace: pending hard links excluded (only confirmed)`
12. `trace: results sorted by hop_distance asc, artifact_id asc`
13. `trace: empty neighborhood (no outgoing/incoming links) returns just the start artifact`
14. `trace: missing start artifact returns total_reached=0`
  </action>
  <verification>
- 14 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 6: Tests for link-distance-boost</name>
  <files>src/tests/intelligence/link-distance-boost.test.ts</files>
  <action>
New test file. Tests:

1. `computeLinkDistance: directly linked → 1`
2. `computeLinkDistance: two-hop → 2`
3. `computeLinkDistance: unreachable within max_hops → null`
4. `computeLinkDistance: weakest-link tier (soft → hard → soft = soft overall)`
5. `applyLinkDistanceBoost: linked candidate's boosted_score > unlinked`
6. `applyLinkDistanceBoost: candidates re-sorted by boosted_score desc`
7. `applyLinkDistanceBoost: hard link contributes more boost than soft link`
8. `applyLinkDistanceBoost: project scoping — cross-project links don't contribute`
9. `applyLinkDistanceBoost: empty query_artifact_ids → no boost applied; unchanged ordering`
10. `applyLinkDistanceBoost: respects custom boost_weight`
  </action>
  <verification>
- 10 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 7: Hybrid-retrieval integration tests</name>
  <files>src/tests/intelligence/hybrid-retrieval-with-boost.test.ts</files>
  <action>
New test file. Tests for flag-on / flag-off behavior of hybrid-retrieval:

1. `flag off (default): existing ranking unchanged`
2. `flag on: candidates with links lifted in rank`
3. `flag on: candidates without links unchanged relative position to other unlinked`
4. `flag on: emit link_distance_boost_applied telemetry`
5. `flag on: cross-project links ignored`
6. `flag on with custom weight env var: boost magnitude follows`
7. `flag on with no links in DB: same ordering as flag-off (no panic, no error)`
  </action>
  <verification>
- 7 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/mcp/claudex-trace.test.ts src/tests/intelligence/link-distance-boost.test.ts src/tests/intelligence/hybrid-retrieval-with-boost.test.ts` — 14 + 10 + 7 = 31 new tests pass.
- `npx vitest run` — full suite green.
- `bun run vesna` — SC#1 PASS (flag off; existing behavior preserved).
- Manual smoke: invoke MCP claudex_trace tool against fixture DB and verify response shape.
  </action>
  <verification>
- Build green.
- 31 new tests pass.
- Full suite green.
- Vesna SC#1 PASS unchanged (flag-off mode).
- MCP smoke OK.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `claudex_trace` MCP tool registered in recall-server; invokable.
- AC-2: BFS traversal correct: handles outgoing/incoming/both, hop caps, type filters, deduplication.
- AC-3: Pending hard links excluded from trace; only soft + confirmed hard contribute.
- AC-4: `applyLinkDistanceBoost` correctly applies the formula with tier-aware multiplier (hard 1.0, soft 0.5).
- AC-5: Project scoping enforced — cross-project links don't contribute.
- AC-6: Hybrid-retrieval integration is flag-gated (`CLAUDEX_LINK_DISTANCE_BOOST`).
- AC-7: Flag-off path byte-equivalent to pre-plan behavior; Vesna SC#1 PASS preserved.
- AC-8: Flag-on path lifts linked candidates in rank; telemetry row emitted per query.
- AC-9: All 31 new tests pass.
- AC-10: No regression in v6.6.0 + Wave 1 + LINKS-SCHEMA + 14-07d test baseline (flag-off mode).
</acceptance_criteria>

<risks>
- **Risk 1: BFS over the link graph is slow on large projects.** As link counts grow, the BFS may become a bottleneck. Mitigation: max_hops capped at 5; per-hop query uses indexed (src, type) / (dst, type) indexes. Acceptable at v7.0.0 ship scale.
- **Risk 2: Link-distance boost interacts badly with the BGE reranker.** Reranker outputs are calibrated; multiplying their scores by an arbitrary factor could distort the ranking landscape. Mitigation: flag-OFF default; Vesna in flag-on state runs at gate-time to validate.
- **Risk 3: Boost magnitude wrong.** 0.1 weight × 1.0 (hop 1) = 10% lift. Could be too much or too little. Mitigation: configurable via env var; future tuning post-ship; Vesna runs in flag-on state catch egregious cases.
- **Risk 4: Trace tool exposes internal artifact summaries.** If a project has sensitive artifact content, claudex_trace returns it. Mitigation: same access model as existing claudex_search and claudex_recall — local-only MCP, per-machine.
- **Risk 5: Multiple paths to same artifact lead to ambiguity in tier semantics.** "Weakest link" is the chosen semantics; alternative is "strongest link in shortest path." Mitigation: weakest-link is the conservative choice (links a chain is only as strong as its weakest link); locked.
- **Risk 6: Feature flag env var introduces config-drift.** Operator may forget the flag is set. Mitigation: telemetry `link_distance_boost_applied` per query makes flag state observable. Session-start surface could expose flag state (Wave 3 / 14-07h?).
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) BFS correctness — does the traversal handle cycles, dead refs, and self-loops cleanly?
- (b) Tier semantics — weakest-link vs strongest-in-shortest-path debate; is the chosen semantics defensible?
- (c) Flag-off byte-equivalence — does the flag-off path actually produce identical rankings to pre-plan?
- (d) Boost formula stability — is the 1/hop_distance factor sensible? Linear, quadratic, exponential alternatives?
- (e) Project scoping — confirm cross-project links cannot leak boost.

NO-SIGNOFF triggers PM escalation.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (31 new tests).
3. Live-wiring smoke: MCP smoke + Vesna SC#1 in flag-off mode.
4. No "MVP" shortcuts — flag-gated rollout is the production-quality pattern; soft/hard tier separation respects the Good Child policy.
5. Negative results valid: if Vesna SC#3 regresses in flag-on state, surface and revise boost weight; do not loosen the gate.
6. Cross-family external review per the gate above.
7. No time estimates.
</methodology_gates>
