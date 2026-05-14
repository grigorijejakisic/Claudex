"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/one-shot-reindex.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
var os2 = __toESM(require("node:os"), 1);
var path2 = __toESM(require("node:path"), 1);

// src/angel/sessions-indexer.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var os = __toESM(require("node:os"), 1);

// src/core/stmt-cache.ts
var MAX_CACHE_SIZE = 256;
var stmtCache = /* @__PURE__ */ new WeakMap();
function cachedPrepare(db, sql) {
  let map = stmtCache.get(db);
  if (!map) {
    map = /* @__PURE__ */ new Map();
    stmtCache.set(db, map);
  }
  let stmt = map.get(sql);
  if (stmt) {
    map.delete(sql);
    map.set(sql, stmt);
    return stmt;
  }
  if (map.size >= MAX_CACHE_SIZE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  stmt = db.prepare(sql);
  map.set(sql, stmt);
  return stmt;
}

// src/ingestion/upsert-chunk.ts
var UPSERT_SQL = `
INSERT INTO transcript_chunk_v6 (
  session_id, project_id, turn_index, sub_index, role, provenance,
  body, created_at_epoch_ms, wrapper_redacted
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, turn_index, role, sub_index) DO UPDATE SET
  project_id = excluded.project_id,
  provenance = excluded.provenance,
  body = excluded.body,
  created_at_epoch_ms = excluded.created_at_epoch_ms,
  wrapper_redacted = excluded.wrapper_redacted
`;
function upsertChunk(db, chunk) {
  cachedPrepare(db, UPSERT_SQL).run(
    chunk.session_id,
    chunk.project_id,
    chunk.turn_index,
    chunk.sub_index,
    chunk.role,
    chunk.provenance,
    chunk.body,
    chunk.created_at_epoch_ms,
    chunk.wrapper_redacted ? 1 : 0
  );
}

// src/extraction/wrapper-parser.ts
var KNOWN_WRAPPER_TAGS = [
  "task-notification",
  "system-reminder",
  "experience-data",
  "local-command-caveat",
  "command-message",
  "command-name",
  "command-args",
  "local-command-stdout",
  "file-content"
];
var TAGS_ALT = KNOWN_WRAPPER_TAGS.join("|");
var WRAPPER_REGEX = new RegExp(
  `<(${TAGS_ALT})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
  "gi"
);
function parseWrappers(text) {
  if (!text) return { organic: "", injected: [] };
  const injected = [];
  const fresh = new RegExp(WRAPPER_REGEX.source, WRAPPER_REGEX.flags);
  let lastIndex = 0;
  const strippedParts = [];
  let match;
  let matched = false;
  while ((match = fresh.exec(text)) !== null) {
    matched = true;
    if (match.index > lastIndex) {
      strippedParts.push(text.slice(lastIndex, match.index));
    }
    const tag = match[1].toLowerCase();
    const attrsRaw = match[2] ? match[2].trim() : void 0;
    const content = match[3] ?? "";
    injected.push({
      tag,
      content,
      ...attrsRaw ? { attributes: attrsRaw } : {}
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    strippedParts.push(text.slice(lastIndex));
  }
  const organic = (matched ? strippedParts.join("") : text).trim();
  return { organic, injected };
}

// src/ingestion/transcript-chunker-v6.ts
var SOFT_TOKEN_LIMIT = 1500;
var TOKENS_PER_WORD = 0.75;
function approxTokenCount(s) {
  if (!s) return 0;
  return Math.ceil(s.split(/\s+/).filter(Boolean).length / TOKENS_PER_WORD);
}
var HARD_CHAR_CAP = 1900;
function sentenceBoundaries(body) {
  const out = [];
  let inTripleFence = false;
  let inSingleFence = false;
  let sentenceStart = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "`") {
      if (body.slice(i, i + 3) === "```") {
        inTripleFence = !inTripleFence;
        i += 2;
        continue;
      }
      if (!inTripleFence) {
        inSingleFence = !inSingleFence;
        continue;
      }
    }
    if (inTripleFence || inSingleFence) continue;
    if ((ch === "." || ch === "!" || ch === "?") && i + 1 < body.length && /\s/.test(body[i + 1])) {
      let j = i + 1;
      while (j < body.length && /\s/.test(body[j])) j++;
      out.push({ start: sentenceStart, end: j });
      sentenceStart = j;
    }
  }
  if (sentenceStart < body.length) {
    out.push({ start: sentenceStart, end: body.length });
  }
  return out;
}
function splitAtSentences(body) {
  if (approxTokenCount(body) <= SOFT_TOKEN_LIMIT && body.length <= HARD_CHAR_CAP) {
    return [body];
  }
  const boundaries = sentenceBoundaries(body);
  const safeBoundaries = [];
  for (const b of boundaries) {
    const width = b.end - b.start;
    if (width <= HARD_CHAR_CAP) {
      safeBoundaries.push({ ...b, force: false });
      continue;
    }
    for (let pos = b.start; pos < b.end; pos += HARD_CHAR_CAP) {
      safeBoundaries.push({
        start: pos,
        end: Math.min(pos + HARD_CHAR_CAP, b.end),
        force: true
      });
    }
  }
  const subChunks = [];
  let currentStart = -1;
  let currentEnd = -1;
  let currentTokens = 0;
  let currentChars = 0;
  for (const b of safeBoundaries) {
    const slice = body.slice(b.start, b.end);
    const sliceTokens = approxTokenCount(slice);
    const sliceChars = b.end - b.start;
    if (b.force) {
      if (currentStart !== -1) {
        subChunks.push(body.slice(currentStart, currentEnd));
        currentStart = -1;
        currentEnd = -1;
        currentTokens = 0;
        currentChars = 0;
      }
      subChunks.push(slice);
      continue;
    }
    if (currentStart === -1) {
      currentStart = b.start;
      currentEnd = b.end;
      currentTokens = sliceTokens;
      currentChars = sliceChars;
      continue;
    }
    if (currentTokens + sliceTokens > SOFT_TOKEN_LIMIT || currentChars + sliceChars > HARD_CHAR_CAP) {
      subChunks.push(body.slice(currentStart, currentEnd));
      currentStart = b.start;
      currentEnd = b.end;
      currentTokens = sliceTokens;
      currentChars = sliceChars;
    } else {
      currentEnd = b.end;
      currentTokens += sliceTokens;
      currentChars += sliceChars;
    }
  }
  if (currentStart !== -1) subChunks.push(body.slice(currentStart, currentEnd));
  return subChunks.length > 0 ? subChunks : [body];
}
function chunkTranscript(turns) {
  if (turns.length === 0) return [];
  const chunks = [];
  for (const turn of turns) {
    const { organic, injected } = parseWrappers(turn.body);
    const wrapperRedacted = injected.length > 0;
    const subBodies = splitAtSentences(organic);
    for (let i = 0; i < subBodies.length; i++) {
      chunks.push({
        session_id: turn.session_id,
        project_id: turn.project_id,
        turn_index: turn.turn_index,
        role: turn.role,
        provenance: turn.provenance,
        sub_index: i,
        body: subBodies[i],
        created_at_epoch_ms: turn.created_at_epoch_ms,
        wrapper_redacted: wrapperRedacted
      });
    }
  }
  return chunks;
}

// src/angel/sessions-indexer.ts
var CLAUDEX_PROJECTS_JSON = path.join(os.homedir(), ".claudex", "projects.json");
var mtimeCache = /* @__PURE__ */ new Map();
function getRegisteredProjectDirs() {
  try {
    if (!fs.existsSync(CLAUDEX_PROJECTS_JSON)) return [];
    const raw = JSON.parse(fs.readFileSync(CLAUDEX_PROJECTS_JSON, "utf-8"));
    const projects = raw.projects ?? {};
    const out = [];
    for (const [projectId, info] of Object.entries(projects)) {
      const p = info?.path;
      if (typeof p === "string" && p.length > 0) {
        out.push({ projectId, projectDir: p });
      }
    }
    return out;
  } catch {
    return [];
  }
}
function ensureCursorTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_index_cursor (
        file_path TEXT PRIMARY KEY,
        last_indexed_mtime_ms INTEGER NOT NULL DEFAULT 0
      )
    `);
  } catch {
  }
}
async function scanAndIndexSessions(db, projectDirs) {
  const result = { files_scanned: 0, files_indexed: 0, chunks_upserted: 0, errors: 0 };
  ensureCursorTable(db);
  const targets = projectDirs ?? getRegisteredProjectDirs();
  for (const { projectId, projectDir } of targets) {
    const sessionsDir = path.join(projectDir, "Sessions");
    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const filename of files) {
      const filePath = path.join(sessionsDir, filename);
      result.files_scanned++;
      try {
        const stat = fs.statSync(filePath);
        const mtimeMs = stat.mtimeMs;
        const cached = mtimeCache.get(filePath);
        const lastIndexed = cached ?? getLastIndexedMtime(db, filePath);
        if (mtimeMs <= lastIndexed) {
          continue;
        }
        const sessionId = extractSessionId(filename);
        if (!sessionId) continue;
        const markdown = fs.readFileSync(filePath, "utf8");
        const chunks = buildChunksFromSessionMarkdown(markdown, sessionId, projectId);
        for (const chunk of chunks) {
          upsertChunk(db, chunk);
          result.chunks_upserted++;
        }
        mtimeCache.set(filePath, mtimeMs);
        setLastIndexedMtime(db, filePath, mtimeMs);
        result.files_indexed++;
      } catch {
        result.errors++;
      }
    }
  }
  return result;
}
function buildChunksFromSessionMarkdown(markdown, sessionId, projectId) {
  const lines = markdown.split("\n");
  const TURN_HEADER = /^## (User|Assistant|ToolResult(?:: .+)?)\s*$/;
  const turns = [];
  let turnIndex = -1;
  let currentRole = "user";
  let currentProvenance = "organic";
  let currentLines = [];
  let currentTimestamp = 0;
  const flushTurn = () => {
    if (turnIndex < 0) return;
    const rawBody = currentLines.join("\n").trim();
    if (!rawBody) return;
    turns.push({
      session_id: sessionId,
      project_id: projectId,
      turn_index: turnIndex,
      role: currentRole,
      body: rawBody,
      created_at_epoch_ms: currentTimestamp || Date.now(),
      provenance: currentProvenance
    });
  };
  for (const line of lines) {
    const headerMatch = line.match(TURN_HEADER);
    if (headerMatch) {
      flushTurn();
      turnIndex++;
      const headerKind = headerMatch[1];
      if (headerKind === "User") {
        currentRole = "user";
        currentProvenance = "organic";
      } else if (headerKind === "Assistant") {
        currentRole = "assistant";
        currentProvenance = "organic";
      } else {
        currentRole = "tool";
        currentProvenance = "tool_result";
      }
      currentLines = [];
      currentTimestamp = 0;
      continue;
    }
    if (turnIndex >= 0 && currentTimestamp === 0 && /^_\d{4}-\d{2}-\d{2}T/.test(line)) {
      const tsStr = line.replace(/^_/, "").replace(/_$/, "");
      const parsed = new Date(tsStr).getTime();
      if (!Number.isNaN(parsed)) currentTimestamp = parsed;
      continue;
    }
    if (turnIndex >= 0) {
      currentLines.push(line);
    }
  }
  flushTurn();
  return chunkTranscript(turns);
}
function extractSessionId(filename) {
  const match = filename.match(/^\d{4}-\d{2}-\d{2}_(.+)\.md$/);
  return match?.[1] ?? null;
}
function getLastIndexedMtime(db, filePath) {
  try {
    const row = cachedPrepare(
      db,
      `SELECT last_indexed_mtime_ms FROM sessions_index_cursor WHERE file_path = ?`
    ).get(filePath);
    return row?.last_indexed_mtime_ms ?? 0;
  } catch {
    return 0;
  }
}
function setLastIndexedMtime(db, filePath, mtimeMs) {
  try {
    cachedPrepare(db, `
      INSERT INTO sessions_index_cursor (file_path, last_indexed_mtime_ms)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET last_indexed_mtime_ms = excluded.last_indexed_mtime_ms
    `).run(filePath, mtimeMs);
  } catch {
  }
}

// scripts/one-shot-reindex.ts
(async () => {
  const dbPath = path2.join(os2.homedir(), ".claudex/db/claudex.db");
  const db = new import_better_sqlite3.default(dbPath);
  console.log("=== registered projects ===");
  const projects = getRegisteredProjectDirs();
  console.log("count:", projects.length);
  const claudexV3 = projects.find((p) => p.projectId === "claudex-v3");
  console.log("claudex-v3 entry:", claudexV3);
  console.log("=== running scanAndIndexSessions ===");
  const result = await scanAndIndexSessions(db);
  console.log("result:", result);
  console.log("=== chunks for our session post-scan ===");
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM transcript_chunk_v6 WHERE session_id = '523e018e-299a-4be7-acb4-af625e7a9742'`).get();
  console.log("chunks:", cnt);
  const violets = db.prepare(`SELECT COUNT(*) AS n FROM transcript_chunk_v6 WHERE session_id = '523e018e-299a-4be7-acb4-af625e7a9742' AND body LIKE '%violets%'`).get();
  console.log("violets-bearing chunks:", violets);
  db.close();
})().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});
