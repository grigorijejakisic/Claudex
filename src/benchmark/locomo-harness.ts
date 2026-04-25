/**
 * LoCoMo Benchmark Harness for Claudex
 *
 * Ingests LoCoMo conversations into a fresh Claudex DB,
 * queries via hybrid retrieval, generates answers via Ollama,
 * and scores via LLM-as-a-Judge.
 *
 * Usage: node dist/benchmark/locomo-harness.cjs <path-to-locomo10.json> [--judge ollama|claude]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeSchema } from '../core/migrations.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { EMBED_DIM } from '../embeddings/embed-pipeline.js';
import { hybridSearchAsync } from '../core/hybrid-retrieval.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string;
  blip_caption?: string;
}

interface LoCoMoQA {
  question: string;
  answer: string;
  category: number; // 1=single-hop, 2=multi-hop, 3=temporal, 4=open-domain, 5=adversarial
  evidence: string[]; // e.g. ["D1:3", "D5:7"]
}

interface LoCoMoConversation {
  sample_id: string;
  conversation: {
    speaker_a: string;
    speaker_b: string;
    [key: string]: unknown; // session_N, session_N_date_time
  };
  observation: Record<string, Record<string, Array<[string, string]>>>;
  session_summary: Record<string, string>;
  qa: LoCoMoQA[];
  event_summary?: unknown;
}

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_BASE = 'http://localhost:11434';
const CLIPROXY_BASE = process.env.CLAUDEX_BENCH_CLIPROXY_BASE ?? 'http://127.0.0.1:8317/v1';
const EMBED_MODEL = 'snowflake-arctic-embed2';
// LoCoMo baseline (2026-03-29, 55.5%) used claude-sonnet-4-6 via CLIProxy.
// On this machine CLIProxy no longer serves Claude models (returns
// `unknown provider`). Flip default to a local Ollama model — scores are
// NOT comparable to the 55.5% baseline, but run-to-run consistency
// against deepseek-coder-v2:16b gives a new anchor. Operator can override
// via env to re-target claude-sonnet-4-6 if a proxy serving it is running.
const ANSWER_MODEL = process.env.CLAUDEX_BENCH_ANSWER_MODEL ?? 'deepseek-coder-v2:16b';
const JUDGE_MODEL = process.env.CLAUDEX_BENCH_JUDGE_MODEL ?? 'deepseek-coder-v2:16b';
const TOP_K_RETRIEVAL = 10;
const USE_CLIPROXY = process.env.CLAUDEX_BENCH_USE_CLIPROXY === 'true';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cliproxyGenerate(model: string, prompt: string, maxTokens: number = 500): Promise<string> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${CLIPROXY_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer cliproxy-no-key-needed',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      return (data.choices?.[0]?.message?.content ?? '').trim();
    } catch (e) {
      if (attempt < MAX_RETRIES - 1) {
        // Wait before retry (exponential backoff)
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      process.stderr.write(`  [WARN] CliProxy failed after ${MAX_RETRIES} retries: ${(e as Error).message}\n`);
      return '';
    }
  }
  return '';
}

async function ollamaGenerate(model: string, prompt: string, maxTokens: number = 500): Promise<string> {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: maxTokens },
    }),
  });
  const data = await resp.json() as { response?: string };
  return (data.response ?? '').trim();
}

async function generate(prompt: string, maxTokens: number = 500): Promise<string> {
  if (USE_CLIPROXY) {
    return cliproxyGenerate(ANSWER_MODEL, prompt, maxTokens);
  }
  return ollamaGenerate(ANSWER_MODEL, prompt, maxTokens);
}

async function embedText(provider: EmbeddingProvider, text: string): Promise<number[] | null> {
  const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
  return provider.embed(truncated);
}

function cosineSimilarity(a: number[], b: Float32Array | number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = typeof b[i] === 'number' ? b[i] : 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Ingest: Load LoCoMo conversations into a fresh DB
// ---------------------------------------------------------------------------

function ingestConversation(
  db: Database.Database,
  conv: LoCoMoConversation,
  provider: EmbeddingProvider | null,
): { observationCount: number; sessionCount: number } {
  const sampleId = conv.sample_id;
  let observationCount = 0;
  let sessionCount = 0;

  // Find session keys
  const sessionKeys = Object.keys(conv.conversation)
    .filter(k => k.match(/^session_\d+$/))
    .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

  for (const sessionKey of sessionKeys) {
    const sessionNum = parseInt(sessionKey.split('_')[1]);
    const turns = conv.conversation[sessionKey] as LoCoMoTurn[];
    const dateTime = conv.conversation[`${sessionKey}_date_time`] as string;
    const sessionId = `${sampleId}_${sessionKey}`;

    // Create session record
    cachedPrepare(db,
      `INSERT OR IGNORE INTO sessions (session_id, project, status, created_at_epoch)
       VALUES (?, ?, 'completed', ?)`
    ).run(sessionId, sampleId, sessionNum * 86400); // Use session number as rough epoch

    sessionCount++;

    // Temporal anchor: prefix content with session date so retrieval surfaces dates
    const datePrefix = dateTime ? `[${dateTime}] ` : '';

    // Store each turn as BOTH observation AND artifact (retrieval searches artifacts)
    for (const turn of turns) {
      const turnContent = `${datePrefix}${turn.speaker}: ${turn.text}`;
      const turnEpoch = sessionNum * 86400 + parseInt(turn.dia_id.split(':')[1] || '0');

      cachedPrepare(db,
        `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, timestamp_epoch)
         VALUES (?, ?, 'dialog', 'other', ?, ?, 3, ?)`
      ).run(sessionId, sampleId, `${turn.speaker} [${turn.dia_id}]`, turnContent, turnEpoch);

      // Also store as artifact so hybrid retrieval FTS5 can find it
      cachedPrepare(db,
        `INSERT INTO artifacts (project, session_id, artifact_type, content, summary, importance, timestamp_epoch)
         VALUES (?, ?, 'observation', ?, ?, 3, ?)`
      ).run(sampleId, sessionId, turnContent, `${turn.speaker}: ${turn.text.substring(0, 200)}`, turnEpoch);

      observationCount++;
    }

    // Store observations (pre-extracted facts) as higher-importance artifacts
    const obsKey = `${sessionKey}_observation`;
    const sessionObs = conv.observation?.[obsKey];
    if (sessionObs) {
      for (const [speaker, facts] of Object.entries(sessionObs)) {
        for (const [fact, diaId] of facts) {
          cachedPrepare(db,
            `INSERT INTO artifacts (project, session_id, artifact_type, content, summary, importance, timestamp_epoch)
             VALUES (?, ?, 'observation', ?, ?, 4, ?)`
          ).run(
            sampleId,
            sessionId,
            `${datePrefix}${fact}`,
            `[${speaker}] ${datePrefix}${fact}`,
            sessionNum * 86400,
          );
          observationCount++;
        }
      }
    }

    // Store session summary
    const summaryKey = `session_${sessionNum}_summary`;
    const summary = conv.session_summary?.[summaryKey];
    if (summary) {
      cachedPrepare(db,
        `INSERT INTO artifacts (project, session_id, artifact_type, content, summary, importance, timestamp_epoch)
         VALUES (?, ?, 'session_log', ?, ?, 3, ?)`
      ).run(sampleId, sessionId, `${datePrefix}${summary}`, `Session ${sessionNum} summary (${dateTime || 'unknown date'})`, sessionNum * 86400);
    }
  }

  return { observationCount, sessionCount };
}

// ---------------------------------------------------------------------------
// Embed: Generate embeddings for all artifacts
// ---------------------------------------------------------------------------

async function embedAllArtifacts(db: Database.Database, provider: EmbeddingProvider): Promise<number> {
  const artifacts = db.prepare(
    'SELECT id, content FROM artifacts WHERE embedding IS NULL AND content IS NOT NULL'
  ).all() as Array<{ id: number; content: string }>;

  let count = 0;
  for (const art of artifacts) {
    const emb = await embedText(provider, art.content);
    if (emb) {
      const blob = Buffer.from(new Float32Array(emb).buffer);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, art.id);
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Retrieve: Real Claudex hybrid retrieval (FTS5 + recency + three-factor RRF)
// ---------------------------------------------------------------------------

async function retrieveContext(
  db: Database.Database,
  query: string,
  project: string,
  _queryEmbedding: number[] | null,
  topK: number = TOP_K_RETRIEVAL,
): Promise<Array<{ id: number; content: string; score: number; artifact_type: string }>> {
  // Use the REAL Claudex hybrid retrieval pipeline — ALL channels:
  // FTS5 + Qdrant KNN + recency + MPFP graph walk + temporal + cross-encoder reranking
  const results = await hybridSearchAsync(db, query, project, {
    limit: topK,
    globalScope: false, // Stay within this conversation's project scope
  });

  return results.map(r => ({
    id: r.id,
    content: r.content ?? r.summary ?? '',
    score: r.hybrid_score,
    artifact_type: r.artifact_type,
  }));
}

// ---------------------------------------------------------------------------
// Answer: Generate answer from retrieved context
// ---------------------------------------------------------------------------

async function generateAnswer(question: string, context: string[]): Promise<string> {
  const contextStr = context.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  const prompt = `You are answering questions about a conversation history between two people.

STRICT RULES:
- Answer ONLY from the provided context. Do not use outside knowledge.
- If the EXACT answer is not explicitly stated in the context, say "I don't know."
- Do not infer, guess, or extrapolate. Only state what the context directly says.
- For "when" questions: only answer if a specific date or time is mentioned in the context.
- For "what" questions: only answer if the specific thing is named in the context.
- Be precise: use names, dates, and details exactly as they appear in the context.

Context:
${contextStr}

Question: ${question}

Answer in 1-2 sentences using only facts from the context:`;

  return generate(prompt, 150);
}

// ---------------------------------------------------------------------------
// Judge: Score predicted answer against gold
// ---------------------------------------------------------------------------

async function judgeAnswer(question: string, goldAnswer: string, predicted: string): Promise<boolean> {
  const prompt = `You are evaluating whether a predicted answer is correct given the gold answer.

Question: ${question}
Gold Answer: ${goldAnswer}
Predicted Answer: ${predicted}

Is the predicted answer semantically equivalent to or contains the key information from the gold answer? Consider partial matches as correct if the core fact is present.

Reply with ONLY "yes" or "no":`;

  const response = await generate(prompt, 10);
  return response.toLowerCase().startsWith('yes');
}

// ---------------------------------------------------------------------------
// Main: Run the benchmark
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dataPath = args[0] || 'C:/Users/GRIGOR~1/AppData/Local/Temp/locomo/data/locomo10.json';

  if (!fs.existsSync(dataPath)) {
    console.error('Dataset not found at:', dataPath);
    process.exit(1);
  }

  console.log('=== LoCoMo Benchmark — Claudex Memory System ===');
  console.log('Dataset:', dataPath);
  console.log('Answer model:', ANSWER_MODEL);
  console.log('Judge model:', JUDGE_MODEL);
  console.log('Embedding model:', EMBED_MODEL);
  console.log();

  // Create fresh benchmark DB
  const dbPath = path.join(os.tmpdir(), `claudex_locomo_${Date.now()}.db`);
  const db = new Database(dbPath);
  initializeSchema(db);
  console.log('Benchmark DB:', dbPath);

  // Check FTS5 availability for artifacts
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      content, summary,
      content=artifacts,
      content_rowid=id,
      tokenize='porter unicode61'
    )`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
      INSERT INTO artifacts_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
    END`);
  } catch { /* may already exist */ }

  // Initialize embedding provider
  const provider = new EmbeddingProvider({ baseUrl: OLLAMA_BASE, model: EMBED_MODEL });
  const embAvailable = await provider.isAvailable();
  console.log('Embeddings:', embAvailable ? 'available' : 'unavailable (FTS5 only)');

  // Load dataset
  const data: LoCoMoConversation[] = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log('Conversations:', data.length);

  // Phase 1: Ingest
  console.log('\n--- Phase 1: Ingest ---');
  let totalObs = 0, totalSessions = 0;
  for (const conv of data) {
    const { observationCount, sessionCount } = ingestConversation(db, conv, null);
    totalObs += observationCount;
    totalSessions += sessionCount;
    process.stdout.write(`  ${conv.sample_id}: ${sessionCount} sessions, ${observationCount} observations\n`);
  }
  console.log(`Total: ${totalSessions} sessions, ${totalObs} observations`);

  // Phase 2: Embed artifacts
  console.log('\n--- Phase 2: Embed ---');
  if (embAvailable) {
    const embedded = await embedAllArtifacts(db, provider);
    console.log(`Embedded ${embedded} artifacts at ${EMBED_DIM}-dim`);
  } else {
    console.log('Skipped (Ollama unavailable)');
  }

  // Rebuild FTS5 index
  try {
    db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')");
    console.log('FTS5 index rebuilt');
  } catch (e) {
    console.log('FTS5 rebuild failed:', (e as Error).message);
  }

  // Phase 3: Query + Answer + Judge
  console.log('\n--- Phase 3: Evaluate ---');
  const results: BenchmarkResult[] = [];
  const categoryNames: Record<number, string> = {
    1: 'single-hop',
    2: 'multi-hop',
    3: 'temporal',
    4: 'open-domain',
    5: 'adversarial',
  };

  let totalProcessed = 0;
  const totalScorable = data.reduce((sum, c) => sum + c.qa.filter(q => q.category <= 4).length, 0);

  for (const conv of data) {
    const scorableQa = conv.qa.filter(q => q.category <= 4);
    process.stdout.write(`\n  ${conv.sample_id} (${scorableQa.length} questions):\n`);

    for (const qa of scorableQa) {
      totalProcessed++;

      // Retrieve context via FULL Claudex hybrid retrieval (all channels + reranker)
      const retrieved = await retrieveContext(db, qa.question, conv.sample_id, null);
      const contextTexts = retrieved.map(r => r.content);

      // Generate answer
      const predicted = await generateAnswer(qa.question, contextTexts);

      // Judge
      const correct = await judgeAnswer(qa.question, qa.answer, predicted);

      results.push({
        sample_id: conv.sample_id,
        question: qa.question,
        gold_answer: qa.answer,
        predicted_answer: predicted,
        category: qa.category,
        correct,
        evidence: qa.evidence,
        retrieved_ids: retrieved.map(r => String(r.id)),
      });

      // Progress
      if (totalProcessed % 20 === 0) {
        const currentCorrect = results.filter(r => r.correct).length;
        process.stdout.write(`    [${totalProcessed}/${totalScorable}] running accuracy: ${(currentCorrect / results.length * 100).toFixed(1)}%\n`);
      }
    }
  }

  // Phase 4: Report
  console.log('\n\n=== RESULTS ===\n');

  // Per-category scores
  const catScores: Record<number, { correct: number; total: number }> = {};
  for (const r of results) {
    if (!catScores[r.category]) catScores[r.category] = { correct: 0, total: 0 };
    catScores[r.category].total++;
    if (r.correct) catScores[r.category].correct++;
  }

  console.log('Category Breakdown:');
  console.log('─'.repeat(60));
  let totalCorrect = 0, totalTotal = 0;
  for (const cat of [1, 2, 3, 4]) {
    const s = catScores[cat] || { correct: 0, total: 0 };
    const pct = s.total > 0 ? (s.correct / s.total * 100).toFixed(1) : 'N/A';
    console.log(`  ${categoryNames[cat]?.padEnd(15)} ${String(s.correct).padStart(4)}/${String(s.total).padStart(4)}  ${pct}%`);
    totalCorrect += s.correct;
    totalTotal += s.total;
  }
  console.log('─'.repeat(60));
  const overallPct = totalTotal > 0 ? (totalCorrect / totalTotal * 100).toFixed(1) : 'N/A';
  console.log(`  ${'OVERALL'.padEnd(15)} ${String(totalCorrect).padStart(4)}/${String(totalTotal).padStart(4)}  ${overallPct}%`);

  // Comparison table
  console.log('\n\nComparison with Published Systems:');
  console.log('─'.repeat(40));
  console.log(`  OpenAI Memory      52.9%`);
  console.log(`  Mem0               67.1%`);
  console.log(`  Zep                75.1%`);
  console.log(`  Claudex            ${overallPct}%  ← YOU ARE HERE`);
  console.log(`  Memori             82.0%`);
  console.log(`  MemMachine         84.9%`);
  console.log(`  Hindsight          89.6%`);
  console.log('─'.repeat(40));

  // Save detailed results
  const reportPath = path.join(process.cwd(), 'LOCOMO_RESULTS.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: {
      answer_model: ANSWER_MODEL,
      judge_model: JUDGE_MODEL,
      embed_model: EMBED_MODEL,
      embed_dim: EMBED_DIM,
      top_k: TOP_K_RETRIEVAL,
    },
    overall: { correct: totalCorrect, total: totalTotal, accuracy: parseFloat(overallPct as string) },
    per_category: Object.fromEntries(
      Object.entries(catScores).map(([cat, s]) => [
        categoryNames[parseInt(cat)],
        { correct: s.correct, total: s.total, accuracy: parseFloat((s.correct / s.total * 100).toFixed(1)) },
      ])
    ),
    results,
  }, null, 2));
  console.log(`\nDetailed results saved to: ${reportPath}`);

  db.close();
  console.log('\nDone.');
}

main().catch(console.error);
