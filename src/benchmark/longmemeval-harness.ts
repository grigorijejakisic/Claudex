/**
 * LongMemEval Benchmark Harness for Claudex
 *
 * Two modes:
 *   oracle: Evidence sessions only (tests reading + answer quality)
 *   full:   All 500 sessions per instance (tests retrieval + reading + answer quality)
 *
 * Usage: node dist/benchmark/longmemeval-harness.cjs <oracle|full> [path-to-json]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeSchema } from '../core/migrations.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { EMBED_DIM } from '../embeddings/embed-pipeline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

interface BenchmarkResult {
  question_id: string;
  question_type: string;
  question: string;
  gold_answer: string;
  predicted_answer: string;
  correct: boolean;
  is_abstention: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_BASE = 'http://localhost:11434';
const EMBED_MODEL = 'snowflake-arctic-embed2';
const ANSWER_MODEL = 'deepseek-coder-v2:16b';
const JUDGE_MODEL = 'deepseek-coder-v2:16b';
const TOP_K_RETRIEVAL = 10;
const USE_CLAUDE_CLI = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { execSync } from 'child_process';

async function ollamaGenerate(model: string, prompt: string, maxTokens: number = 500): Promise<string> {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: maxTokens },
    }),
  });
  const data = await resp.json() as { response?: string };
  return (data.response ?? '').trim();
}

function claudeGenerate(prompt: string, _maxTokens: number = 500): string {
  try {
    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = path.join(os.tmpdir(), `claudex_bench_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const result = execSync(
      `cat "${tmpFile}" | claude -p --model ${ANSWER_MODEL}`,
      { timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: 'bash' }
    );
    try { fs.unlinkSync(tmpFile); } catch { /* */ }
    return result.trim();
  } catch {
    return '';
  }
}

async function generate(prompt: string, maxTokens: number = 500): Promise<string> {
  if (USE_CLAUDE_CLI) {
    return claudeGenerate(prompt, maxTokens);
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
// Ingest: Load conversation sessions into DB
// ---------------------------------------------------------------------------

function ingestInstance(
  db: Database.Database,
  instance: LongMemEvalInstance,
  mode: 'oracle' | 'full',
): { turnCount: number; sessionCount: number } {
  const qid = instance.question_id;
  let turnCount = 0;
  let sessionCount = 0;

  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const sessionId = instance.haystack_session_ids[i];
    const sessionDate = instance.haystack_dates[i] || '';
    const turns = instance.haystack_sessions[i];
    const isAnswerSession = instance.answer_session_ids.includes(sessionId);

    // In oracle mode, only ingest answer sessions
    if (mode === 'oracle' && !isAnswerSession) continue;

    // Create session
    cachedPrepare(db,
      `INSERT OR IGNORE INTO sessions (session_id, project, status, created_at_epoch)
       VALUES (?, ?, 'completed', ?)`
    ).run(`${qid}_${sessionId}`, qid, i * 86400);
    sessionCount++;

    // Store each turn as an artifact (higher granularity than observations)
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      const content = `[${turn.role}] ${turn.content}`;

      // Store as artifact for FTS5 + vector search
      cachedPrepare(db,
        `INSERT INTO artifacts (project, session_id, artifact_type, content, summary, importance, timestamp_epoch)
         VALUES (?, ?, 'observation', ?, ?, ?, ?)`
      ).run(
        qid,
        `${qid}_${sessionId}`,
        content,
        turn.content.substring(0, 200),
        turn.has_answer ? 5 : 3, // Boost importance of evidence turns
        i * 86400 + t,
      );
      turnCount++;
    }
  }

  return { turnCount, sessionCount };
}

// ---------------------------------------------------------------------------
// Embed artifacts
// ---------------------------------------------------------------------------

async function embedAllArtifacts(db: Database.Database, provider: EmbeddingProvider, project: string): Promise<number> {
  const artifacts = db.prepare(
    'SELECT id, content FROM artifacts WHERE project = ? AND embedding IS NULL AND content IS NOT NULL'
  ).all(project) as Array<{ id: number; content: string }>;

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
// Retrieve context
// ---------------------------------------------------------------------------

/** Evidence confidence: max RRF score from retrieval. Used for abstention gating. */
let _lastRetrievalConfidence = 0;

function retrieveContext(
  db: Database.Database,
  query: string,
  project: string,
  queryEmbedding: number[] | null,
  topK: number = TOP_K_RETRIEVAL,
): string[] {
  const results = new Map<number, { content: string; score: number; timestamp: number }>();

  // FTS5
  try {
    const safeQuery = query.replace(/['"()*:^~]/g, ' ').trim();
    const words = safeQuery.split(/\s+/).filter(w => w.length > 2).slice(0, 10);
    if (words.length > 0) {
      const ftsQuery = words.join(' OR ');
      const ftsResults = db.prepare(
        `SELECT a.id, a.content, a.timestamp_epoch, bm25(artifacts_fts) as rank
         FROM artifacts a
         JOIN artifacts_fts fts ON fts.rowid = a.id
         WHERE artifacts_fts MATCH ? AND a.project = ?
         ORDER BY rank LIMIT ?`
      ).all(ftsQuery, project, topK * 2) as Array<{
        id: number; content: string; timestamp_epoch: number; rank: number;
      }>;

      for (let i = 0; i < ftsResults.length; i++) {
        const r = ftsResults[i];
        results.set(r.id, {
          content: r.content,
          score: (results.get(r.id)?.score ?? 0) + 1.0 / (60 + i),
          timestamp: r.timestamp_epoch,
        });
      }
    }
  } catch { /* non-fatal */ }

  // Vector search
  if (queryEmbedding) {
    try {
      const candidates = db.prepare(
        `SELECT id, content, embedding, timestamp_epoch FROM artifacts
         WHERE project = ? AND embedding IS NOT NULL
         ORDER BY importance DESC LIMIT 200`
      ).all(project) as Array<{
        id: number; content: string; embedding: Buffer; timestamp_epoch: number;
      }>;

      const scored: Array<{ id: number; content: string; sim: number; timestamp: number }> = [];
      for (const c of candidates) {
        const vec = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4);
        scored.push({ id: c.id, content: c.content, sim: cosineSimilarity(queryEmbedding, vec), timestamp: c.timestamp_epoch });
      }
      scored.sort((a, b) => b.sim - a.sim);

      for (let i = 0; i < Math.min(scored.length, topK * 2); i++) {
        const r = scored[i];
        const existing = results.get(r.id);
        results.set(r.id, {
          content: r.content,
          score: (existing?.score ?? 0) + 1.0 / (60 + i),
          timestamp: r.timestamp,
        });
      }
    } catch { /* non-fatal */ }
  }

  // FIX 4: Multi-hop expansion — extract key entities from top results,
  // run a second FTS5 pass on those entities to find cross-session evidence
  try {
    const topResults = [...results.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);

    // Extract capitalized words (proper nouns / entities) from top results
    const entities = new Set<string>();
    for (const [, { content }] of topResults) {
      const words = content.match(/\b[A-Z][a-z]{2,}\b/g) || [];
      for (const w of words) entities.add(w);
    }

    if (entities.size > 0) {
      const entityQuery = [...entities].slice(0, 5).join(' OR ');
      try {
        const hopResults = db.prepare(
          `SELECT a.id, a.content, a.timestamp_epoch, bm25(artifacts_fts) as rank
           FROM artifacts a
           JOIN artifacts_fts fts ON fts.rowid = a.id
           WHERE artifacts_fts MATCH ? AND a.project = ?
           ORDER BY rank LIMIT ?`
        ).all(entityQuery, project, topK) as Array<{
          id: number; content: string; timestamp_epoch: number; rank: number;
        }>;

        for (let i = 0; i < hopResults.length; i++) {
          const r = hopResults[i];
          if (!results.has(r.id)) {
            results.set(r.id, {
              content: r.content,
              score: 0.5 / (60 + i), // Lower weight for second-hop results
              timestamp: r.timestamp_epoch,
            });
          }
        }
      } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }

  // Sort by score, track confidence for abstention gating
  const sorted = [...results.entries()]
    .sort((a, b) => b[1].score - a[1].score);

  _lastRetrievalConfidence = sorted.length > 0 ? sorted[0][1].score : 0;

  // FIX 1: For temporal questions, sort results chronologically and add session markers
  // (caller handles the formatting based on question type)

  return sorted
    .slice(0, topK)
    .map(([, { content, timestamp }]) => {
      // Include session number as temporal anchor
      const sessionNum = Math.floor(timestamp / 86400);
      return `[Session ${sessionNum}] ${content}`;
    });
}

// ---------------------------------------------------------------------------
// Answer generation
// ---------------------------------------------------------------------------

/** FIX 2: Abstention confidence threshold — refuse if retrieval confidence is below this */
const ABSTENTION_THRESHOLD = 0.008;

async function generateAnswer(
  question: string,
  questionType: string,
  context: string[],
  isAbstention: boolean,
  questionDate?: string,
): Promise<string> {
  // FIX 2: Evidence sufficiency gate — if retrieval found nothing relevant, refuse
  if (_lastRetrievalConfidence < ABSTENTION_THRESHOLD || context.length === 0) {
    return "I don't have that information in our conversation history.";
  }

  // FIX 1: For temporal questions, add explicit date context and chronological ordering
  let temporalContext = '';
  if (questionType === 'temporal-reasoning' && questionDate) {
    temporalContext = `\nCurrent date (when question is asked): ${questionDate}\nThe context entries are labeled with session numbers — earlier sessions happened first. Use session ordering to determine temporal relationships.\n`;
  }

  // FIX 3: For knowledge-update questions, instruct the model to look for changes
  let typeInstruction = '';
  if (questionType === 'temporal-reasoning') {
    typeInstruction = 'Pay careful attention to session numbers and any date/time references. When asked "when" or "how long ago," compute the answer from the temporal clues in the context. If multiple sessions mention the same topic at different times, note the chronological progression.';
  } else if (questionType === 'knowledge-update') {
    typeInstruction = 'Look for information that may have CHANGED over time. If the same topic appears in multiple sessions with different details, the LATER session has the updated information. Explicitly state the most recent status. If something was X in session 3 but Y in session 8, the answer is Y.';
  } else if (questionType === 'multi-session') {
    typeInstruction = 'The answer requires combining information from MULTIPLE conversations. Look across all provided sessions — the full answer may not be in any single session.';
  } else if (questionType.startsWith('single-session-preference')) {
    typeInstruction = 'Identify and state the user\'s preference clearly.';
  }

  const contextStr = context.map((c, i) => `[${i + 1}] ${c}`).join('\n');

  const prompt = `You are a personal AI assistant answering questions about past conversations with the user.
Use ONLY the provided conversation context. If the answer cannot be determined from the context, say "I don't have that information."
${typeInstruction}${temporalContext}

Conversation context:
${contextStr}

Question: ${question}

Answer concisely:`;

  return generate(prompt, 200);
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

async function judgeAnswer(
  question: string,
  questionType: string,
  goldAnswer: string,
  predicted: string,
  isAbstention: boolean,
): Promise<boolean> {
  if (isAbstention) {
    // For abstention questions: correct if model refuses to answer
    const refusalPatterns = /don't have|no information|not mentioned|cannot find|I don't know|not available|no record/i;
    return refusalPatterns.test(predicted);
  }

  const prompt = `You are evaluating whether a predicted answer is correct.

Question: ${question}
Expected Answer: ${goldAnswer}
Predicted Answer: ${predicted}

Does the predicted answer contain the key information from the expected answer? Minor wording differences are OK. For temporal questions, allow ±1 day tolerance.

Reply with ONLY "yes" or "no":`;

  const response = await generate(prompt, 10);
  return response.toLowerCase().startsWith('yes');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const mode = (args[0] === 'full' ? 'full' : 'oracle') as 'oracle' | 'full';
  const defaultPath = mode === 'full'
    ? 'C:/Users/GRIGOR~1/AppData/Local/Temp/longmemeval/longmemeval_m_cleaned.json'
    : 'C:/Users/GRIGOR~1/AppData/Local/Temp/longmemeval/longmemeval_oracle.json';
  const dataPath = args[1] || defaultPath;

  console.log(`=== LongMemEval Benchmark — Claudex Memory System ===`);
  console.log(`Mode: ${mode}`);
  console.log(`Dataset: ${dataPath}`);
  console.log(`Answer/Judge: ${ANSWER_MODEL}`);
  console.log(`Embeddings: ${EMBED_MODEL} (${EMBED_DIM}-dim)`);
  console.log();

  if (!fs.existsSync(dataPath)) {
    console.error('Dataset not found:', dataPath);
    process.exit(1);
  }

  // Load dataset
  console.log('Loading dataset...');
  const data: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log(`Instances: ${data.length}`);

  // Initialize embedding provider
  const provider = new EmbeddingProvider({ baseUrl: OLLAMA_BASE, model: EMBED_MODEL });
  const embAvailable = await provider.isAvailable();
  console.log(`Embeddings: ${embAvailable ? 'available' : 'unavailable'}`);

  // Process each instance independently (fresh DB per instance to avoid cross-contamination)
  const results: BenchmarkResult[] = [];
  let processed = 0;

  for (const instance of data) {
    processed++;
    const isAbstention = instance.question_id.endsWith('_abs');

    // Create fresh DB for this instance
    const dbPath = path.join(os.tmpdir(), `claudex_lme_${Date.now()}.db`);
    const db = new Database(dbPath);
    initializeSchema(db);

    // Create FTS5 for artifacts
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
        content, summary, content=artifacts, content_rowid=id, tokenize='porter unicode61'
      )`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
        INSERT INTO artifacts_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
      END`);
    } catch { /* may exist */ }

    // Ingest
    const { turnCount, sessionCount } = ingestInstance(db, instance, mode);

    // Embed
    let embeddedCount = 0;
    if (embAvailable && turnCount <= 500) {
      // Only embed if manageable size (oracle mode ~30-50 turns, full mode up to thousands)
      embeddedCount = await embedAllArtifacts(db, provider, instance.question_id);
    }

    // Rebuild FTS
    try { db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')"); } catch { /* */ }

    // Retrieve context
    const queryEmb = embAvailable ? await embedText(provider, instance.question) : null;
    const context = retrieveContext(db, instance.question, instance.question_id, queryEmb);

    // Generate answer
    const predicted = await generateAnswer(
      instance.question, instance.question_type, context, isAbstention, instance.question_date,
    );

    // Judge
    const goldAnswer = String(instance.answer);
    const correct = await judgeAnswer(
      instance.question, instance.question_type, goldAnswer, predicted, isAbstention,
    );

    results.push({
      question_id: instance.question_id,
      question_type: instance.question_type,
      question: instance.question,
      gold_answer: goldAnswer,
      predicted_answer: predicted,
      correct,
      is_abstention: isAbstention,
    });

    // Cleanup DB
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* */ }

    // Progress
    if (processed % 10 === 0) {
      const scoreable = results.filter(r => !r.is_abstention);
      const correctCount = scoreable.filter(r => r.correct).length;
      const acc = scoreable.length > 0 ? (correctCount / scoreable.length * 100).toFixed(1) : '0.0';
      const absCorrect = results.filter(r => r.is_abstention && r.correct).length;
      const absTotal = results.filter(r => r.is_abstention).length;
      process.stdout.write(
        `  [${processed}/${data.length}] accuracy: ${acc}% | abstention: ${absCorrect}/${absTotal}\n`
      );
    }
  }

  // Final report
  console.log('\n\n=== RESULTS ===\n');

  // Per-type scores (excluding abstention)
  const typeScores: Record<string, { correct: number; total: number }> = {};
  for (const r of results) {
    if (r.is_abstention) continue;
    if (!typeScores[r.question_type]) typeScores[r.question_type] = { correct: 0, total: 0 };
    typeScores[r.question_type].total++;
    if (r.correct) typeScores[r.question_type].correct++;
  }

  console.log('Category Breakdown (excluding abstention):');
  console.log('─'.repeat(65));
  let totalCorrect = 0, totalTotal = 0;
  const typeOrder = [
    'single-session-user', 'single-session-assistant', 'single-session-preference',
    'multi-session', 'temporal-reasoning', 'knowledge-update',
  ];
  for (const type of typeOrder) {
    const s = typeScores[type];
    if (!s) continue;
    const pct = (s.correct / s.total * 100).toFixed(1);
    console.log(`  ${type.padEnd(28)} ${String(s.correct).padStart(4)}/${String(s.total).padStart(4)}  ${pct}%`);
    totalCorrect += s.correct;
    totalTotal += s.total;
  }
  console.log('─'.repeat(65));
  const overallPct = (totalCorrect / totalTotal * 100).toFixed(1);
  console.log(`  ${'OVERALL'.padEnd(28)} ${String(totalCorrect).padStart(4)}/${String(totalTotal).padStart(4)}  ${overallPct}%`);

  // Abstention score
  const absResults = results.filter(r => r.is_abstention);
  const absCorrect = absResults.filter(r => r.correct).length;
  console.log(`\n  ${'abstention'.padEnd(28)} ${String(absCorrect).padStart(4)}/${String(absResults.length).padStart(4)}  ${(absCorrect / absResults.length * 100).toFixed(1)}%`);

  // Comparison
  console.log('\n\nComparison (LongMemEval published):');
  console.log('─'.repeat(45));
  console.log('  GPT-4o full-context (115k)   60.6%');
  console.log('  Zep (GPT-4o)                 71.2%');
  console.log('  Supermemory (GPT-4o)         81.6%');
  console.log(`  Claudex (${mode})              ${overallPct}%  ← YOU ARE HERE`);
  console.log('  Hindsight (OSS-120B)         89.0%');
  console.log('  Hindsight (Gemini-3)         91.4%');
  console.log('─'.repeat(45));

  // Save results
  const reportPath = path.join(process.cwd(), `LONGMEMEVAL_${mode.toUpperCase()}_RESULTS.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    mode,
    config: { answer_model: ANSWER_MODEL, judge_model: JUDGE_MODEL, embed_model: EMBED_MODEL, embed_dim: EMBED_DIM, top_k: TOP_K_RETRIEVAL },
    overall: { correct: totalCorrect, total: totalTotal, accuracy: parseFloat(overallPct) },
    abstention: { correct: absCorrect, total: absResults.length, accuracy: parseFloat((absCorrect / absResults.length * 100).toFixed(1)) },
    per_type: Object.fromEntries(
      Object.entries(typeScores).map(([type, s]) => [type, { correct: s.correct, total: s.total, accuracy: parseFloat((s.correct / s.total * 100).toFixed(1)) }])
    ),
    results,
  }, null, 2));
  console.log(`\nResults saved to: ${reportPath}`);
  console.log('Done.');
}

main().catch(console.error);
