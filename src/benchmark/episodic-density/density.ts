/**
 * Phase 2 IDX-04 — density signal computation (CONTEXT.md item 4 verbatim).
 *
 *   Noise floor — random-pair similarity baseline:
 *     1. Shuffle indexed events. Compute pairwise Jaccard similarity for
 *        1000 random pairs.
 *     2. Take the 95th percentile as the noise floor.
 *     3. Any cluster with mean intra-cluster similarity > noise_floor + 2σ
 *        is "signal."
 *
 *   Cluster definition:
 *     - Edge condition: similarity > T (= noise_floor + 2σ)
 *     - Membership: ≥ K members
 *     - Strength tiers: K=2 (weak), K≥5 (strong)
 *
 *   Density meaningful: ≥30% of high-similarity pairs are intra-project.
 *
 * Density similarity is Jaccard over the SHINGLE space (NOT the embedding
 * space) — internally consistent with Variant B's retrieval scoring so the
 * decision rule numbers are commensurate.
 */

import type { IndexedEvent } from './types.js';

export interface DensitySignal {
  noise_floor: number;
  noise_sigma: number;
  cluster_threshold: number;
  cluster_count: { weak_K2: number; strong_K5: number };
  intra_project_share: number;
  density_meaningful: boolean;
  random_pair_sample_size: number;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  for (const k of small) if (large.has(k)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

class UnionFind {
  private parent: number[];
  private size: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.size[rx] < this.size[ry]) {
      this.parent[rx] = ry;
      this.size[ry] += this.size[rx];
    } else {
      this.parent[ry] = rx;
      this.size[rx] += this.size[ry];
    }
  }
  rootSizes(): number[] {
    const sizes: Record<number, number> = {};
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      sizes[r] = (sizes[r] ?? 0) + 1;
    }
    return Object.values(sizes);
  }
}

export function computeDensitySignal(
  events: IndexedEvent[],
  opts?: { sample?: number; seed?: number },
): DensitySignal {
  const sample = opts?.sample ?? 1000;
  const seed = opts?.seed ?? 4242;
  const sorted = [...events].sort((a, b) => a.episode_event_id - b.episode_event_id);
  const n = sorted.length;
  const shingles = sorted.map(e => new Set(e.shingles));

  // Noise floor: `sample` random pairs.
  const rand = mulberry32(seed);
  const randomSimilarities: number[] = [];
  if (n >= 2) {
    for (let i = 0; i < sample; i++) {
      const a = Math.floor(rand() * n);
      let b = Math.floor(rand() * n);
      if (b === a) b = (b + 1) % n;
      randomSimilarities.push(jaccard(shingles[a], shingles[b]));
    }
  }
  randomSimilarities.sort((x, y) => x - y);
  const noise_floor = percentile(randomSimilarities, 0.95);
  const meanRand =
    randomSimilarities.reduce((acc, v) => acc + v, 0) /
    Math.max(1, randomSimilarities.length);
  const variance =
    randomSimilarities.reduce((acc, v) => acc + (v - meanRand) ** 2, 0) /
    Math.max(1, randomSimilarities.length);
  const noise_sigma = Math.sqrt(variance);
  const cluster_threshold = noise_floor + 2 * noise_sigma;

  // High-similarity edges: enumerate (i,j), i<j.
  const uf = new UnionFind(n);
  let intraProjectEdges = 0;
  let totalEdges = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccard(shingles[i], shingles[j]);
      if (sim > cluster_threshold) {
        totalEdges++;
        if (sorted[i].project === sorted[j].project) intraProjectEdges++;
        uf.union(i, j);
      }
    }
  }

  const sizes = uf.rootSizes();
  let weak_K2 = 0;
  let strong_K5 = 0;
  for (const s of sizes) {
    if (s >= 5) strong_K5++;
    else if (s >= 2) weak_K2++;
  }

  const intra_project_share = totalEdges === 0 ? 0 : intraProjectEdges / totalEdges;
  return {
    noise_floor,
    noise_sigma,
    cluster_threshold,
    cluster_count: { weak_K2, strong_K5 },
    intra_project_share,
    density_meaningful: intra_project_share >= 0.30,
    random_pair_sample_size: sample,
  };
}
