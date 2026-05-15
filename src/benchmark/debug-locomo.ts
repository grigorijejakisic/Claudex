/**
 * Debug script: run 5 LoCoMo questions with full pipeline visibility
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeSchema } from '../core/migrations.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { EMBED_DIM } from '../embeddings/embed-pipeline.js';

const OLLAMA_BASE = 'http://localhost:11434';
const CLIPROXY_BASE = 'http://127.0.0.1:8317/v1';
const EMBED_MODEL = 'snowflake-arctic-embed2';

interface LoCoMoQA { question: string; answer: string; category: number; evidence: string[]; }
interface LoCoMoTurn { speaker: string; dia_id: string; text: string; }
interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  observation: Record<string, Record<string, Array<[string, string]>>>;
  session_summary: Record<string, string>;
  qa: LoCoMoQA[];
}

function cosineSimilarity(a: number[], b: Float32Array | number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = typeof b[i] === 'number' ? b[i] : 0;
    dot += ai * bi; normA += ai * ai; normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function cliproxyGenerate(model: string, prompt: string, maxTokens: number): Promise<string> {
  const resp = await fetch(`${CLIPROXY_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer cliproxy-no-key-needed' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

async function ollamaGenerate(model: string, prompt: string, maxTokens: number): Promise<string> {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: maxTokens } }),
  });
  const data = await resp.json() as { response?: string };
  return (data.response ?? '').trim();
}

async function main() {
  const dataPath = 'C:/Users/GRIGOR~1/AppData/Local/Temp/locomo/data/locomo10.json';
  const data: LoCoMoConversation[] = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const conv = data[0]; // first conversation

  // Setup DB
  const dbPath = path.join(os.tmpdir(), `claudex_debug_${Date.now()}.db`);
  const db = new Database(dbPath);
  initializeSchema(db);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(content, summary, content=artifacts, content_rowid=id, tokenize='porter unicode61')`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN INSERT INTO artifacts_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary); END`);

  // Ingest
  const sessionKeys = Object.keys(conv.conversation).filter(k => k.match(/^session_\d+$/)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));
  for (const sk of sessionKeys) {
    const sn = parseInt(sk.split('_')[1]);
    const turns = conv.conversation[sk] as LoCoMoTurn[];
    const sid = `${conv.sample_id}_${sk}`;
    cachedPrepare(db, `INSERT OR IGNORE INTO sessions (session_id, project, status, created_at_epoch_ms) VALUES (?, ?, 'completed', ?)`).run(sid, conv.sample_id, sn * 86400000);
    for (const turn of turns) {
      cachedPrepare(db, `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, timestamp_epoch) VALUES (?, ?, 'dialog', 'other', ?, ?, 3, ?)`).run(sid, conv.sample_id, `${turn.speaker} [${turn.dia_id}]`, turn.text, sn * 86400 + parseInt(turn.dia_id.split(':')[1] || '0'));
    }
    const obsKey = `${sk}_observation`;
    const sessionObs = conv.observation?.[obsKey];
    if (sessionObs) {
      for (const [speaker, facts] of Object.entries(sessionObs)) {
        for (const [fact] of facts) {
          cachedPrepare(db, `INSERT INTO artifacts (project, session_id, artifact_type, content, summary, importance, timestamp_epoch) VALUES (?, ?, 'observation', ?, ?, 4, ?)`).run(conv.sample_id, sid, fact, `[${speaker}] ${fact}`, sn * 86400);
        }
      }
    }
  }

  // Embed
  const provider = new EmbeddingProvider({ baseUrl: OLLAMA_BASE, model: EMBED_MODEL });
  const artifacts = db.prepare('SELECT id, content FROM artifacts WHERE embedding IS NULL AND content IS NOT NULL').all() as Array<{ id: number; content: string }>;
  for (const art of artifacts) {
    const emb = await provider.embed(art.content.substring(0, 8000));
    if (emb) { db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(new Float32Array(emb).buffer), art.id); }
  }
  db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')");

  // Test 5 questions from different categories
  const cats = [1, 2, 3, 4];
  const picked: LoCoMoQA[] = [];
  for (const cat of cats) {
    const q = conv.qa.find(q => q.category === cat && !picked.includes(q));
    if (q) picked.push(q);
  }
  picked.push(conv.qa.find(q => q.category === 1 && !picked.includes(q))!);

  const catNames: Record<number, string> = { 1: 'single-hop', 2: 'multi-hop', 3: 'temporal', 4: 'open-domain' };

  for (const qa of picked) {
    if (!qa) continue;
    console.log('\n' + '='.repeat(80));
    console.log(`CATEGORY: ${catNames[qa.category]} | EVIDENCE: ${qa.evidence.join(', ')}`);
    console.log(`QUESTION: ${qa.question}`);
    console.log(`GOLD: ${qa.answer}`);

    // Retrieve
    const queryEmb = await provider.embed(qa.question.substring(0, 8000));
    const results = new Map<number, { content: string; score: number }>();

    // FTS5
    try {
      const safeQ = qa.question.replace(/['"()*:^~]/g, ' ').trim();
      const words = safeQ.split(/\s+/).filter(w => w.length > 2).slice(0, 10);
      if (words.length > 0) {
        const ftsQ = words.join(' OR ');
        const ftsR = db.prepare(`SELECT a.id, a.content, bm25(artifacts_fts) as rank FROM artifacts a JOIN artifacts_fts fts ON fts.rowid = a.id WHERE artifacts_fts MATCH ? AND a.project = ? ORDER BY rank LIMIT 20`).all(ftsQ, conv.sample_id) as any[];
        for (let i = 0; i < ftsR.length; i++) results.set(ftsR[i].id, { content: ftsR[i].content, score: 1.0 / (60 + i) });
      }
    } catch {}

    // Vector
    if (queryEmb) {
      const cands = db.prepare('SELECT id, content, embedding FROM artifacts WHERE project = ? AND embedding IS NOT NULL ORDER BY importance DESC LIMIT 200').all(conv.sample_id) as any[];
      const scored = cands.map((c: any) => ({ id: c.id, content: c.content, sim: cosineSimilarity(queryEmb, new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4)) })).sort((a: any, b: any) => b.sim - a.sim);
      for (let i = 0; i < Math.min(scored.length, 20); i++) {
        const r = scored[i];
        results.set(r.id, { content: r.content, score: (results.get(r.id)?.score ?? 0) + 1.0 / (60 + i) });
      }
    }

    const topCtx = [...results.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10).map(([, { content }]) => content);
    console.log(`\nRETRIEVED (${topCtx.length} chunks):`);
    topCtx.forEach((c, i) => console.log(`  [${i + 1}] ${c.substring(0, 120)}...`));

    const answerPrompt = `You are answering questions about a conversation history. Use ONLY the provided context. If the answer is not in the context, say "I don't know."\n\nContext:\n${topCtx.map((c, i) => `[${i + 1}] ${c}`).join('\n')}\n\nQuestion: ${qa.question}\n\nAnswer concisely in 1-2 sentences:`;

    // Compare both models
    const sonnetAnswer = await cliproxyGenerate('claude-sonnet-4-6', answerPrompt, 150);
    const deepseekAnswer = await ollamaGenerate('deepseek-coder-v2:16b', answerPrompt, 150);

    console.log(`\nSONNET ANSWER: ${sonnetAnswer}`);
    console.log(`DEEPSEEK ANSWER: ${deepseekAnswer}`);

    // Judge both with Sonnet
    const judgePrompt = (predicted: string) => `You are evaluating whether a predicted answer is correct given the gold answer.\n\nQuestion: ${qa.question}\nGold Answer: ${qa.answer}\nPredicted Answer: ${predicted}\n\nIs the predicted answer semantically equivalent to or contains the key information from the gold answer? Consider partial matches as correct if the core fact is present.\n\nReply with ONLY "yes" or "no":`;

    const sonnetJudgeSonnet = await cliproxyGenerate('claude-sonnet-4-6', judgePrompt(sonnetAnswer), 10);
    const sonnetJudgeDeepseek = await cliproxyGenerate('claude-sonnet-4-6', judgePrompt(deepseekAnswer), 10);

    // Also judge with deepseek
    const deepseekJudgeSonnet = await ollamaGenerate('deepseek-coder-v2:16b', judgePrompt(sonnetAnswer), 10);
    const deepseekJudgeDeepseek = await ollamaGenerate('deepseek-coder-v2:16b', judgePrompt(deepseekAnswer), 10);

    console.log(`\nJUDGE MATRIX:`);
    console.log(`                    Sonnet judges    Deepseek judges`);
    console.log(`  Sonnet answer:    ${sonnetJudgeSonnet.padEnd(16)} ${deepseekJudgeSonnet}`);
    console.log(`  Deepseek answer:  ${sonnetJudgeDeepseek.padEnd(16)} ${deepseekJudgeDeepseek}`);
  }

  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
}

main().catch(console.error);
