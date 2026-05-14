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

// scripts/phase-11-curate-memory-md.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
var os6 = __toESM(require("os"), 1);
var path6 = __toESM(require("path"), 1);

// src/angel/memory-md-writer.ts
var fs5 = __toESM(require("fs"), 1);
var os5 = __toESM(require("os"), 1);
var path5 = __toESM(require("path"), 1);
var import_node_crypto = require("node:crypto");

// src/shared/cc-slug.ts
function pathToCcSlug(projectPath) {
  return projectPath.replace(/[:\\/. ]/g, "-");
}

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

// src/shared/scope-detector.ts
var path3 = __toESM(require("path"), 1);
var fs3 = __toESM(require("fs"), 1);

// src/shared/paths.ts
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var CLAUDEX_DIR = ".claudex";
function getClaudexHome() {
  try {
    return path.normalize(path.join(os.homedir(), CLAUDEX_DIR));
  } catch {
    return path.normalize(path.join(".", CLAUDEX_DIR));
  }
}
function getProjectsJsonPath() {
  try {
    return path.normalize(path.join(getClaudexHome(), "projects.json"));
  } catch {
    return path.normalize(path.join(".", CLAUDEX_DIR, "projects.json"));
  }
}

// src/shared/projects-dir.ts
var os2 = __toESM(require("os"), 1);
var path2 = __toESM(require("path"), 1);
var fs = __toESM(require("fs"), 1);
var CLAUDEX_PROJECTS_DIR_ENV = "CLAUDEX_PROJECTS_DIR";
function getProjectsDir() {
  const fromEnv = process.env[CLAUDEX_PROJECTS_DIR_ENV];
  const resolved = fromEnv && fromEnv.length > 0 ? path2.resolve(fromEnv) : path2.join(os2.homedir(), "Projects");
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[projects-dir] mkdir failed for ${resolved}: ${err.message}
`
    );
  }
  return resolved;
}

// src/shared/fs-helpers.ts
var fs2 = __toESM(require("fs"), 1);
var os3 = __toESM(require("os"), 1);
var CACHED_HOME = (() => {
  let home = os3.homedir();
  try {
    if (process.platform === "win32") {
      home = fs2.realpathSync.native(home);
    } else {
      home = fs2.realpathSync(home);
    }
  } catch {
  }
  return home;
})();
function readJsonFile(filePath) {
  try {
    const raw = fs2.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// src/shared/scope-detector.ts
function deriveProjectId(cwd) {
  try {
    const baseName = path3.basename(cwd);
    const sanitized = baseName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
    const hash = simpleHash(normalizePath(path3.resolve(cwd)));
    return `${sanitized}-${hash}`;
  } catch {
    return "unknown";
  }
}
function resolveProjectPath(projectId) {
  try {
    const data = readJsonFile(getProjectsJsonPath());
    if (data?.projects) {
      for (const [key, value] of Object.entries(data.projects)) {
        let projId;
        let projPath;
        if (typeof value === "string") {
          projPath = key;
          projId = value;
        } else if (value && typeof value === "object" && typeof value.path === "string") {
          projPath = value.path;
          projId = key;
        } else {
          continue;
        }
        if (projId === projectId && projPath) return projPath;
      }
    }
    const baseDir = getProjectsDir();
    const entries = fs3.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path3.join(baseDir, entry.name);
      if (deriveProjectId(fullPath) === projectId) return fullPath;
    }
  } catch {
  }
  return null;
}
function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function normalizePath(p) {
  if (!p) return p;
  let normalized = path3.normalize(p);
  if (normalized.endsWith(path3.sep) && normalized.length > 1) {
    const stripped = normalized.slice(0, -1);
    if (stripped.length === 0) {
      normalized = path3.sep;
    } else if (/^[A-Za-z]:$/.test(stripped)) {
      normalized = stripped + path3.sep;
    } else {
      normalized = stripped;
    }
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  normalized = normalized.replace(/[/\\]+$/, "");
  if (normalized === "" || /^[a-zA-Z]:$/.test(normalized)) {
    normalized = normalized + path3.sep;
  }
  return normalized;
}

// src/core/session-events.ts
function recordEvent(db, sessionId, project, eventType, entity, action, detail) {
  try {
    cachedPrepare(
      db,
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, project, eventType, entity, action, detail ?? null);
  } catch {
  }
}

// src/angel/lesson-reader.ts
var fs4 = __toESM(require("fs"), 1);
var os4 = __toESM(require("os"), 1);
var path4 = __toESM(require("path"), 1);
var FILENAME_RE = /^(feedback|project|process)_([a-z0-9][a-z0-9_-]{0,59})\.md$/;
function parseLessonFile(filePath) {
  let raw;
  try {
    raw = fs4.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const filename = path4.basename(filePath);
  const filenameMatch = FILENAME_RE.exec(filename);
  if (!filenameMatch) return null;
  const filenamePrefix = filenameMatch[1];
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx < 0) return null;
  const frontmatterRaw = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).replace(/^\n+/, "");
  const fm = parseFrontmatter(frontmatterRaw);
  if (!fm) return null;
  if (fm.type !== filenamePrefix) {
    return null;
  }
  return {
    path: filePath,
    filename,
    frontmatter: fm,
    body,
    filenamePrefix
  };
}
function listLessonsForProject(project) {
  const projectPath = resolveProjectPath(project);
  const ccSlug = projectPath ? pathToCcSlug(projectPath) : /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
  const memDir = path4.join(os4.homedir(), ".claude", "projects", ccSlug, "memory");
  if (!fs4.existsSync(memDir)) return [];
  let entries;
  try {
    entries = fs4.readdirSync(memDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries.sort()) {
    if (!FILENAME_RE.test(name)) continue;
    const parsed = parseLessonFile(path4.join(memDir, name));
    if (parsed) out.push(parsed);
  }
  return out;
}
function parseFrontmatter(raw) {
  const lines = raw.split("\n");
  const state = {};
  let currentBlock = null;
  for (const line of lines) {
    if (line.length === 0) {
      currentBlock = null;
      continue;
    }
    const topMatch = /^([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("	")) {
      const [, key, valueRaw] = topMatch;
      const value = valueRaw.trim();
      if (key === "telemetry") {
        state.telemetry = {};
        currentBlock = "telemetry";
        continue;
      }
      if (key === "shape") {
        state.shape = {};
        currentBlock = "shape";
        continue;
      }
      currentBlock = null;
      if (key === "type") {
        if (value !== "feedback" && value !== "project" && value !== "process") return null;
        state.type = value;
      } else if (key === "created_at_epoch") {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        state.created_at_epoch = n;
      } else if (key === "tier") {
        if (value === "foreground" || value === "background") state.tier = value;
      } else if (key === "last_fired_at_epoch") {
        const n = Number(value);
        if (Number.isFinite(n)) state.last_fired_at_epoch = n;
      }
      continue;
    }
    const subMatch = /^\s+([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (subMatch && currentBlock) {
      const [, key, valueRaw] = subMatch;
      const value = valueRaw.trim();
      if (currentBlock === "telemetry") {
        const t2 = state.telemetry;
        if (key === "tools_used") t2.tools_used = parseInlineList(value);
        else if (key === "files_touched") t2.files_touched = parseInlineList(value);
        else if (key === "errors_encountered") t2.errors_encountered = parseInlineList(value);
        else if (key === "user_framing_tokens") t2.user_framing_tokens = parseInlineList(value);
        else if (key === "session_arc") t2.session_arc = parseInlineList(value);
        else if (key === "triggered_by") t2.triggered_by = parseInlineList(value);
        else if (key === "duration_min") t2.duration_min = Number(value);
        else if (key === "correction_count") t2.correction_count = Number(value);
      } else if (currentBlock === "shape") {
        if (key === "task_shape") state.shape.task_shape = value;
        else if (key === "failure_mode") state.shape.failure_mode = value;
        else if (key === "solution_pattern") state.shape.solution_pattern = value;
      }
    }
  }
  if (!state.type) return null;
  const t = state.telemetry ?? {};
  return {
    type: state.type,
    created_at_epoch: state.created_at_epoch ?? 0,
    telemetry: {
      tools_used: Array.isArray(t.tools_used) ? t.tools_used : [],
      files_touched: Array.isArray(t.files_touched) ? t.files_touched : [],
      errors_encountered: Array.isArray(t.errors_encountered) ? t.errors_encountered : [],
      user_framing_tokens: Array.isArray(t.user_framing_tokens) ? t.user_framing_tokens : [],
      session_arc: Array.isArray(t.session_arc) ? t.session_arc : [],
      triggered_by: Array.isArray(t.triggered_by) ? t.triggered_by : [],
      duration_min: typeof t.duration_min === "number" ? t.duration_min : 0,
      correction_count: typeof t.correction_count === "number" ? t.correction_count : 0
    },
    shape: state.shape,
    tier: state.tier,
    last_fired_at_epoch: state.last_fired_at_epoch
  };
}
function parseInlineList(raw) {
  const m = /^\[(.*)\]$/.exec(raw);
  if (!m) return [];
  const inner = m[1].trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

// src/angel/handoff-writer.ts
var VALID_STATUSES = ["active", "archived", "paused"];
function validateHandoffHeader(header) {
  const errors = [];
  if (header.status === void 0 || header.status === null) {
    errors.push({ field: "status", reason: "required" });
  } else if (!VALID_STATUSES.includes(header.status)) {
    errors.push({
      field: "status",
      reason: `must be one of ${VALID_STATUSES.join("|")}; got "${String(header.status)}"`
    });
  }
  if (header.phase === void 0 || header.phase === null) {
    errors.push({ field: "phase", reason: "required" });
  } else if (typeof header.phase !== "string" || header.phase.length === 0) {
    errors.push({ field: "phase", reason: "must be non-empty string" });
  }
  return errors;
}
function parseHandoffHeader(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const body = match[1];
  const partial = {};
  for (const line of body.split("\n")) {
    const lineMatch = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (!lineMatch) continue;
    const key = lineMatch[1];
    const value = lineMatch[2].trim();
    if (value.length === 0) continue;
    switch (key) {
      case "status":
        partial.status = value;
        break;
      case "phase":
        partial.phase = value;
        break;
      case "summary":
        partial.summary = value;
        break;
      case "topic":
        partial.topic = value;
        break;
      case "created_at_epoch_ms": {
        const n = Number(value);
        if (Number.isFinite(n)) partial.created_at_epoch_ms = n;
        break;
      }
    }
  }
  const errors = validateHandoffHeader(partial);
  if (errors.length > 0) return null;
  return partial;
}

// src/angel/memory-md-writer.ts
var MAX_BYTES = 25e3;
var MAX_LINES = 200;
var MAX_PREAMBLE_LINES = 5;
var MAX_FRONTMATTER_SNIFF_BYTES = 1024;
var MAX_ACTIVE_PROJECTS = 5;
var MAX_LESSONS_FOREGROUND = 20;
var POINTER_LINE_MAX_CHARS = 140;
var ACTIVE_WINDOW_SECONDS = 7 * 86400;
var HOW_TO_QUERY_STATIC = `## How to Query

- claudex_search("topic") \u2014 decisions, learnings, prior sessions
- claudex_events \u2014 latest session history
- claudex_recall(id|path) \u2014 fetch a specific artifact

See ~/.claude/CLAUDE.md for Claudex tool reference.
`;
var USER_TAIL_DEFAULT = "<!-- USER EDITABLE -->\n\n## User Notes\n\n";
function computeMemoryMdPath(project) {
  const projectPath = resolveProjectPath(project);
  if (projectPath) {
    return path5.join(os5.homedir(), ".claude", "projects", pathToCcSlug(projectPath), "memory", "MEMORY.md");
  }
  const slug = /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
  return path5.join(os5.homedir(), ".claude", "projects", slug, "memory", "MEMORY.md");
}
function toSlug(project) {
  return /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
}
function renderPreamble(slug) {
  try {
    const memDir = path5.join(os5.homedir(), ".claude", "projects", slug, "memory");
    if (!fs5.existsSync(memDir)) return "";
    let entries;
    try {
      entries = fs5.readdirSync(memDir);
    } catch {
      return "";
    }
    const candidates = entries.filter((name) => name.toLowerCase().endsWith(".md") && name !== "MEMORY.md").sort();
    const lines = [];
    for (const name of candidates) {
      if (lines.length >= MAX_PREAMBLE_LINES) break;
      const filePath = path5.join(memDir, name);
      let raw;
      try {
        const fd = fs5.openSync(filePath, "r");
        const buf = Buffer.alloc(MAX_FRONTMATTER_SNIFF_BYTES);
        const n = fs5.readSync(fd, buf, 0, MAX_FRONTMATTER_SNIFF_BYTES, 0);
        fs5.closeSync(fd);
        raw = buf.slice(0, n).toString("utf8");
      } catch {
        continue;
      }
      if (!raw.startsWith("---")) continue;
      const endIdx = raw.indexOf("---", 3);
      if (endIdx < 0) continue;
      const frontmatter = raw.slice(3, endIdx);
      if (!/\btype:\s*user\b/i.test(frontmatter)) continue;
      const descMatch = frontmatter.match(/^\s*description:\s*(.+?)\s*$/im);
      const description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : name.replace(/\.md$/i, "");
      lines.push(`- ${description}`);
    }
    if (lines.length === 0) return "";
    return lines.join("\n") + "\n\n";
  } catch {
    return "";
  }
}
function renderActiveProjects(db) {
  const cutoff = Math.floor(Date.now() / 1e3) - ACTIVE_WINDOW_SECONDS;
  let rows = [];
  try {
    rows = cachedPrepare(
      db,
      `SELECT project_id,
              COUNT(*) AS activity_cnt,
              MAX(updated_at_epoch) AS last_touched
       FROM artifact
       WHERE updated_at_epoch >= ?
         AND project_id IS NOT NULL
         AND project_id != ''
       GROUP BY project_id
       ORDER BY activity_cnt DESC, last_touched DESC, project_id ASC
       LIMIT ${MAX_ACTIVE_PROJECTS}`
    ).all(cutoff);
  } catch {
    rows = [];
  }
  const lines = ["## Active Projects"];
  if (rows.length === 0) {
    lines.push("");
  } else {
    for (const row of rows) {
      lines.push(`- ${row.project_id} \u2014 ${row.activity_cnt} edits in last 7d`);
    }
  }
  return lines.join("\n") + "\n";
}
function renderHandoff(project) {
  const header = "## Handoff\n\n";
  try {
    const projectPath = resolveProjectPath(project);
    if (!projectPath) return header + "No active handoff.\n";
    const handoffPath = path5.join(projectPath, "context", "handoffs", "ACTIVE.md");
    if (!fs5.existsSync(handoffPath)) return header + "No active handoff.\n";
    let raw;
    try {
      raw = fs5.readFileSync(handoffPath, "utf8");
    } catch {
      return header + "No active handoff.\n";
    }
    const parsed = parseHandoffHeader(raw);
    if (!parsed) return header + "No active handoff.\n";
    const phase = parsed.phase;
    const topic = parsed.topic ?? parsed.summary ?? "unspecified";
    switch (parsed.status) {
      case "active":
        return header + `Active handoff at phase ${phase}: ${topic}.
See: context/handoffs/ACTIVE.md
`;
      case "paused":
        return header + `Handoff paused at phase ${phase}.
See: context/handoffs/ACTIVE.md
`;
      case "archived":
      default:
        return header + "No active handoff.\n";
    }
  } catch {
    return header + "No active handoff.\n";
  }
}
function renderLessons(project) {
  const lessons = listLessonsForProject(project);
  const foreground = lessons.filter((l) => (l.frontmatter.tier ?? "foreground") === "foreground");
  foreground.sort((a, b) => {
    const fa = a.frontmatter.last_fired_at_epoch ?? 0;
    const fb = b.frontmatter.last_fired_at_epoch ?? 0;
    if (fa !== fb) return fb - fa;
    const ca = a.frontmatter.created_at_epoch;
    const cb = b.frontmatter.created_at_epoch;
    if (ca !== cb) return cb - ca;
    return a.filename.localeCompare(b.filename);
  });
  const top = foreground.slice(0, MAX_LESSONS_FOREGROUND);
  const lines = ["## Lessons"];
  if (top.length === 0) {
    lines.push("");
    lines.push("No lessons captured yet.");
    return lines.join("\n") + "\n";
  }
  for (const lesson of top) {
    const taskShape = lesson.frontmatter.shape?.task_shape ?? "unclassified";
    const salience = extractLessonSalience(lesson.body);
    const tail = `](${lesson.filename}) \u2014 task-pattern: ${taskShape}`;
    const head = "- [";
    const availableSalienceChars = Math.max(10, POINTER_LINE_MAX_CHARS - head.length - tail.length);
    const truncatedSalience = salience.length > availableSalienceChars ? salience.slice(0, availableSalienceChars - 1) + "\u2026" : salience;
    lines.push(`${head}${truncatedSalience}${tail}`);
  }
  return lines.join("\n") + "\n";
}
function extractLessonSalience(body) {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const cleaned = trimmed.replace(/^#+\s+|^[-*]\s+/, "").replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return "(no salience extracted)";
}
function normalize3(text) {
  let out = text.replace(/\r\n/g, "\n");
  out = out.replace(/[ \t]+$/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/\n+$/, "") + "\n";
  return out;
}
function sentinelLine(normalizedBody) {
  const hash = (0, import_node_crypto.createHash)("sha256").update(normalizedBody, "utf8").digest("hex");
  return `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${hash} -->`;
}
function parseSentinelHash(firstLine) {
  const m = firstLine.match(/^<!-- CLAUDEX-MANAGED: .*? hash=([0-9a-f]{64}) -->$/);
  return m ? m[1] : null;
}
function wrapLegacyUserContent(existing) {
  const normalized = existing.replace(/\r\n/g, "\n");
  if (normalized.replace(/\s/g, "").length === 0) return null;
  const hasUserNotesHeader = /(^|\n)## User Notes\b/.test(normalized);
  const body = hasUserNotesHeader ? normalized : `## User Notes

${normalized}`;
  const normalizedBody = body.replace(/\n+$/, "") + "\n";
  return `<!-- USER EDITABLE -->

${normalizedBody}`;
}
function findUserTailStart(content) {
  const marker = "<!-- USER EDITABLE -->";
  const normalized = content.replace(/\r\n/g, "\n");
  let offset = 0;
  for (const line of normalized.split("\n")) {
    if (line === marker) return offset;
    offset += line.length + 1;
  }
  return -1;
}
function recordRefusal(db, project, filePath, reason) {
  recordEvent(db, "angel-memory-writer", project, "memory_curation_refused", filePath, "refuse", reason);
}
function enforceSizeCap(body, sections) {
  const fits = (s) => Buffer.byteLength(s, "utf8") <= MAX_BYTES && s.split("\n").length <= MAX_LINES;
  const rebuild = () => normalize3(
    [sections.preamble, sections.projects, sections.lessons, sections.handoff, sections.howTo].filter(Boolean).join("\n")
  );
  if (fits(body)) return body;
  const trimTail = (section) => {
    const lines = section.split("\n");
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].startsWith("- ")) {
        lines.splice(i, 1);
        return lines.join("\n");
      }
    }
    return section;
  };
  while (!fits(body) && /^- /m.test(sections.lessons)) {
    sections.lessons = trimTail(sections.lessons);
    body = rebuild();
  }
  while (!fits(body) && /^- /m.test(sections.projects)) {
    sections.projects = trimTail(sections.projects);
    body = rebuild();
  }
  while (!fits(body) && /^- /m.test(sections.handoff)) {
    sections.handoff = trimTail(sections.handoff);
    body = rebuild();
  }
  return body;
}
function curateMemoryMd(db, project) {
  let memoryMdPath = "";
  try {
    memoryMdPath = computeMemoryMdPath(project);
    if (!fs5.existsSync(path5.dirname(memoryMdPath))) {
      return { path: memoryMdPath, written: false, reason: "no_project_dir" };
    }
    const sections = {
      preamble: renderPreamble(toSlug(project)),
      projects: renderActiveProjects(db),
      lessons: renderLessons(project),
      handoff: renderHandoff(project),
      howTo: HOW_TO_QUERY_STATIC
    };
    let body = normalize3(
      [sections.preamble, sections.projects, sections.lessons, sections.handoff, sections.howTo].filter(Boolean).join("\n")
    );
    body = enforceSizeCap(body, sections);
    const sentinel = sentinelLine(body);
    const existing = fs5.existsSync(memoryMdPath) ? fs5.readFileSync(memoryMdPath, "utf8") : "";
    let userTail = USER_TAIL_DEFAULT;
    const normalizedExisting = existing.replace(/\r\n/g, "\n");
    const markerIdx = findUserTailStart(normalizedExisting);
    if (markerIdx >= 0) {
      userTail = normalizedExisting.slice(markerIdx);
      if (!userTail.endsWith("\n")) userTail += "\n";
      const firstLine = normalizedExisting.split("\n", 1)[0];
      if (!parseSentinelHash(firstLine)) {
        recordRefusal(db, project, memoryMdPath, "sentinel_missing");
        return { path: memoryMdPath, written: false, reason: "sentinel_missing" };
      }
    } else if (normalizedExisting.length > 0) {
      const firstLine = normalizedExisting.split("\n", 1)[0];
      if (parseSentinelHash(firstLine)) {
        recordRefusal(db, project, memoryMdPath, "sentinel_invalid");
        return { path: memoryMdPath, written: false, reason: "sentinel_invalid" };
      }
      const wrapped = wrapLegacyUserContent(normalizedExisting);
      if (wrapped) userTail = wrapped;
    }
    const fullNew = `${sentinel}
${body}
${userTail}`;
    if (normalizedExisting === fullNew) {
      const firstLine = normalizedExisting.split("\n", 1)[0];
      return {
        path: memoryMdPath,
        written: false,
        reason: "idempotent_noop",
        bytes: Buffer.byteLength(existing, "utf8"),
        lines: existing.split("\n").length,
        hash: parseSentinelHash(firstLine) ?? void 0
      };
    }
    const tmp = memoryMdPath + ".tmp";
    try {
      fs5.writeFileSync(tmp, fullNew, "utf8");
    } catch {
      try {
        fs5.unlinkSync(tmp);
      } catch {
      }
      return { path: memoryMdPath, written: false, reason: "write_io_error" };
    }
    try {
      fs5.renameSync(tmp, memoryMdPath);
    } catch {
      const start = Date.now();
      while (Date.now() - start < 50) {
      }
      try {
        fs5.renameSync(tmp, memoryMdPath);
      } catch {
        try {
          fs5.unlinkSync(tmp);
        } catch {
        }
        return { path: memoryMdPath, written: false, reason: "write_io_error" };
      }
    }
    return {
      path: memoryMdPath,
      written: true,
      reason: "wrote",
      bytes: Buffer.byteLength(fullNew, "utf8"),
      lines: fullNew.split("\n").length,
      hash: parseSentinelHash(sentinel) ?? void 0
    };
  } catch {
    return { path: memoryMdPath, written: false, reason: "write_io_error" };
  }
}

// scripts/phase-11-curate-memory-md.ts
var TARGET_SLUGS = [
  "claudex-v3",
  "lacuna-betting-9f1d552c",
  "oracle-3951898e",
  "big-mozzy-v2",
  "desktop-01dcc792",
  "nexus-e53c6c93"
];
function main() {
  const dbPath = path6.join(os6.homedir(), ".claudex", "db", "claudex.db");
  const db = new import_better_sqlite3.default(dbPath);
  for (const slug of TARGET_SLUGS) {
    try {
      const r = curateMemoryMd(db, slug);
      console.log(`${slug} \u2192 ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`${slug} \u2192 ERROR: ${err.message}`);
    }
  }
  db.close();
}
main();
