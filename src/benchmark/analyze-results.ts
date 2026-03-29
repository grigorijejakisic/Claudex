/**
 * LoCoMo Results Analyzer — identifies failure patterns for Claudex improvement
 *
 * Usage: node dist/benchmark/analyze-results.cjs [path-to-results.json]
 */

import * as fs from 'fs';

interface BenchmarkResult {
  sample_id: string;
  question: string;
  gold_answer: string;
  predicted_answer: string;
  category: number;
  correct: boolean;
  evidence: string[];
  retrieved_ids: string[];
}

interface ResultsFile {
  timestamp: string;
  config: Record<string, unknown>;
  overall: { correct: number; total: number; accuracy: number };
  per_category: Record<string, { correct: number; total: number; accuracy: number }>;
  results: BenchmarkResult[];
}

const categoryNames: Record<number, string> = {
  1: 'single-hop',
  2: 'multi-hop',
  3: 'temporal',
  4: 'open-domain',
};

function analyzeFailures(data: ResultsFile): void {
  const { results } = data;

  // 1. Per-category accuracy
  console.log('\n=== PER-CATEGORY ACCURACY ===\n');
  const catStats: Record<number, { correct: number; total: number; failures: BenchmarkResult[] }> = {};
  for (const r of results) {
    if (!catStats[r.category]) catStats[r.category] = { correct: 0, total: 0, failures: [] };
    catStats[r.category].total++;
    if (r.correct) catStats[r.category].correct++;
    else catStats[r.category].failures.push(r);
  }

  for (const cat of [1, 2, 3, 4]) {
    const s = catStats[cat];
    if (!s) continue;
    const pct = (s.correct / s.total * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(s.correct / s.total * 30)) + '░'.repeat(30 - Math.round(s.correct / s.total * 30));
    console.log(`  ${(categoryNames[cat] ?? 'unknown').padEnd(15)} ${bar} ${pct}% (${s.correct}/${s.total})`);
  }

  // 2. Per-conversation accuracy
  console.log('\n=== PER-CONVERSATION ACCURACY ===\n');
  const convStats: Record<string, { correct: number; total: number }> = {};
  for (const r of results) {
    if (!convStats[r.sample_id]) convStats[r.sample_id] = { correct: 0, total: 0 };
    convStats[r.sample_id].total++;
    if (r.correct) convStats[r.sample_id].correct++;
  }
  const sorted = Object.entries(convStats).sort((a, b) => (b[1].correct / b[1].total) - (a[1].correct / a[1].total));
  for (const [conv, s] of sorted) {
    const pct = (s.correct / s.total * 100).toFixed(1);
    console.log(`  ${conv.padEnd(10)} ${pct}% (${s.correct}/${s.total})`);
  }

  // 3. Failure pattern analysis — classify WHY answers failed
  console.log('\n=== FAILURE PATTERN ANALYSIS ===\n');
  const failures = results.filter(r => !r.correct);
  const patterns: Record<string, number> = {
    'no_answer': 0,        // Model said "I don't know"
    'wrong_entity': 0,     // Answered about wrong person/thing
    'missing_date': 0,     // Temporal info missing
    'partial_answer': 0,   // Close but incomplete
    'hallucination': 0,    // Made up information
    'vague_answer': 0,     // Too generic
  };

  for (const f of failures) {
    const pred = String(f.predicted_answer ?? '').toLowerCase();
    const gold = String(f.gold_answer ?? '').toLowerCase();

    if (pred.includes("don't know") || pred.includes('not in the context') || pred.includes('no information') || pred.length < 10) {
      patterns.no_answer++;
    } else if (f.category === 3 && (pred.includes('recently') || pred.includes('unknown date') || !pred.match(/\d{4}/))) {
      patterns.missing_date++;
    } else {
      // Check if the predicted answer contains ANY words from the gold answer
      const goldWords = gold.split(/\s+/).filter(w => w.length > 3);
      const predWords = new Set(pred.split(/\s+/));
      const overlap = goldWords.filter(w => predWords.has(w)).length;
      const overlapRatio = goldWords.length > 0 ? overlap / goldWords.length : 0;

      if (overlapRatio > 0.3) {
        patterns.partial_answer++;
      } else if (overlapRatio === 0 && pred.length > 20) {
        patterns.hallucination++;
      } else {
        patterns.vague_answer++;
      }
    }
  }

  const totalFailures = failures.length;
  console.log(`  Total failures: ${totalFailures}/${results.length} (${(totalFailures / results.length * 100).toFixed(1)}%)\n`);
  for (const [pattern, count] of Object.entries(patterns).sort((a, b) => b[1] - a[1])) {
    if (count === 0) continue;
    const pct = (count / totalFailures * 100).toFixed(1);
    console.log(`  ${pattern.padEnd(20)} ${count} (${pct}% of failures)`);
  }

  // 4. Sample failures per category — concrete examples for debugging
  console.log('\n=== SAMPLE FAILURES (3 per category) ===\n');
  for (const cat of [1, 2, 3, 4]) {
    const s = catStats[cat];
    if (!s || s.failures.length === 0) continue;
    console.log(`--- ${categoryNames[cat]} (${s.failures.length} failures) ---`);
    for (const f of s.failures.slice(0, 3)) {
      console.log(`  Q: ${f.question}`);
      console.log(`  Gold: ${f.gold_answer}`);
      console.log(`  Pred: ${f.predicted_answer.substring(0, 150)}`);
      console.log(`  Evidence needed: ${f.evidence.join(', ')}`);
      console.log();
    }
  }

  // 5. Retrieval gap analysis — questions where retrieval found 0 relevant docs
  console.log('\n=== RETRIEVAL QUALITY INDICATORS ===\n');
  const noRetrieval = failures.filter(f => {
    const pred = f.predicted_answer.toLowerCase();
    return pred.includes("don't know") || pred.includes('not in the context') || pred.includes('no information');
  });
  console.log(`  Complete retrieval failures (model abstained): ${noRetrieval.length}/${totalFailures} (${(noRetrieval.length / totalFailures * 100).toFixed(1)}%)`);
  console.log(`  → These are retrieval problems, not answer-model problems`);
  console.log(`  → The remaining ${totalFailures - noRetrieval.length} failures had SOME context but wrong/incomplete\n`);

  // 6. Cross-session questions (multi-hop) failure rate
  const multiHopFailRate = catStats[2] ? (1 - catStats[2].correct / catStats[2].total) : 0;
  const singleHopFailRate = catStats[1] ? (1 - catStats[1].correct / catStats[1].total) : 0;
  console.log(`  Single-hop fail rate: ${(singleHopFailRate * 100).toFixed(1)}%`);
  console.log(`  Multi-hop fail rate:  ${(multiHopFailRate * 100).toFixed(1)}%`);
  console.log(`  Multi-hop penalty:    ${((multiHopFailRate - singleHopFailRate) * 100).toFixed(1)} percentage points`);
  console.log(`  → This gap shows how much cross-session retrieval costs us\n`);

  // 7. Save analysis as actionable improvement targets
  console.log('\n=== ACTIONABLE IMPROVEMENT TARGETS ===\n');
  const targets = [];

  if (patterns.no_answer > totalFailures * 0.2) {
    targets.push(`RETRIEVAL: ${patterns.no_answer} questions got no relevant context — improve recall (FTS5 query expansion, lower similarity thresholds)`);
  }
  if (patterns.missing_date > 5) {
    targets.push(`TEMPORAL: ${patterns.missing_date} temporal questions missing dates — verify temporal channel is ingesting date metadata`);
  }
  if (patterns.partial_answer > totalFailures * 0.2) {
    targets.push(`MULTI-HOP: ${patterns.partial_answer} questions got partial answers — need better cross-session entity linking`);
  }
  if (patterns.hallucination > totalFailures * 0.1) {
    targets.push(`HALLUCINATION: ${patterns.hallucination} questions got fabricated answers — tighten answer prompt constraints`);
  }
  if (multiHopFailRate - singleHopFailRate > 0.15) {
    targets.push(`GRAPH WALK: Multi-hop penalty is ${((multiHopFailRate - singleHopFailRate) * 100).toFixed(0)}pp — MPFP graph walk needs stronger cross-session edges`);
  }

  if (targets.length === 0) {
    console.log('  No critical improvement targets identified — system performing well.');
  } else {
    targets.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  }

  // Save failure data for potential RL training
  const failureExport = failures.map(f => ({
    question: f.question,
    gold: f.gold_answer,
    predicted: f.predicted_answer,
    category: categoryNames[f.category],
    evidence: f.evidence,
    conversation: f.sample_id,
  }));
  const exportPath = 'LOCOMO_FAILURES.json';
  fs.writeFileSync(exportPath, JSON.stringify(failureExport, null, 2));
  console.log(`\n  Failure data exported to: ${exportPath} (${failureExport.length} entries)`);
  console.log('  → Use this to train retrieval RL or improve FTS5 query expansion\n');
}

// Main
const args = process.argv.slice(2);
const resultsPath = args[0] || 'LOCOMO_RESULTS.json';

if (!fs.existsSync(resultsPath)) {
  console.error('Results file not found:', resultsPath);
  console.error('Run the benchmark first: node dist/benchmark/locomo-harness.cjs');
  process.exit(1);
}

const data: ResultsFile = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
console.log(`\n=== CLAUDEX LOCOMO FAILURE ANALYSIS ===`);
console.log(`  Results from: ${data.timestamp}`);
console.log(`  Config: ${JSON.stringify(data.config)}`);
console.log(`  Overall: ${data.overall.accuracy}% (${data.overall.correct}/${data.overall.total})`);

analyzeFailures(data);
