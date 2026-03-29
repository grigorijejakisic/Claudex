/**
 * Codebase Indexer — AST parsing, symbol extraction, call graph generation.
 *
 * Local Intelligence Amplifier Phase 3: Structural understanding of active projects.
 *
 * Uses tree-sitter for AST parsing (TypeScript/Python/Rust).
 * Stores results in code_index table for fast retrieval.
 * File watcher triggers incremental re-indexing on changes.
 *
 * Non-throwing — individual file failures don't break the indexer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexedFile {
  project: string;
  filePath: string;
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
  callGraph: CallEdge[];
  astHash: string;
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum' | 'method';
  line: number;
  exported: boolean;
  params?: string;
  returnType?: string;
}

export interface CallEdge {
  caller: string;
  callee: string;
  line: number;
}

// ---------------------------------------------------------------------------
// AST parsing (regex-based for reliability — no native dependency issues)
// ---------------------------------------------------------------------------

// Note: Using regex extraction instead of tree-sitter WASM for now.
// tree-sitter native bindings have Windows build issues with Bun.
// This gives us 90% of the value (function/class/export extraction)
// without the native dependency risk. Can upgrade to tree-sitter later.

/**
 * Extract symbols, imports, exports from a TypeScript file.
 * Regex-based — fast, no native deps, handles most patterns.
 */
function parseTypeScript(content: string, filePath: string): Omit<IndexedFile, 'project' | 'astHash'> {
  const symbols: SymbolInfo[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const callGraph: CallEdge[] = [];
  const lines = content.split('\n');

  let currentFunction: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Imports
    const importMatch = line.match(/^\s*import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      imports.push(importMatch[3]);
      continue;
    }

    // Exported functions
    const exportFuncMatch = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/);
    if (exportFuncMatch) {
      symbols.push({ name: exportFuncMatch[1], kind: 'function', line: lineNum, exported: true, params: exportFuncMatch[2].trim(), returnType: exportFuncMatch[3]?.trim() });
      exports.push(exportFuncMatch[1]);
      currentFunction = exportFuncMatch[1];
      continue;
    }

    // Non-exported functions
    const funcMatch = line.match(/^\s*(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
    if (funcMatch) {
      symbols.push({ name: funcMatch[1], kind: 'function', line: lineNum, exported: false, params: funcMatch[2].trim() });
      currentFunction = funcMatch[1];
      continue;
    }

    // Arrow functions assigned to const (exported)
    const exportArrowMatch = line.match(/^\s*export\s+const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(/);
    if (exportArrowMatch) {
      symbols.push({ name: exportArrowMatch[1], kind: 'function', line: lineNum, exported: true });
      exports.push(exportArrowMatch[1]);
      currentFunction = exportArrowMatch[1];
      continue;
    }

    // Classes
    const classMatch = line.match(/^\s*(export\s+)?class\s+(\w+)/);
    if (classMatch) {
      symbols.push({ name: classMatch[2], kind: 'class', line: lineNum, exported: !!classMatch[1] });
      if (classMatch[1]) exports.push(classMatch[2]);
      continue;
    }

    // Interfaces
    const interfaceMatch = line.match(/^\s*(export\s+)?interface\s+(\w+)/);
    if (interfaceMatch) {
      symbols.push({ name: interfaceMatch[2], kind: 'interface', line: lineNum, exported: !!interfaceMatch[1] });
      if (interfaceMatch[1]) exports.push(interfaceMatch[2]);
      continue;
    }

    // Type aliases
    const typeMatch = line.match(/^\s*(export\s+)?type\s+(\w+)/);
    if (typeMatch) {
      symbols.push({ name: typeMatch[2], kind: 'type', line: lineNum, exported: !!typeMatch[1] });
      if (typeMatch[1]) exports.push(typeMatch[2]);
      continue;
    }

    // Enums
    const enumMatch = line.match(/^\s*(export\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      symbols.push({ name: enumMatch[2], kind: 'enum', line: lineNum, exported: !!enumMatch[1] });
      if (enumMatch[1]) exports.push(enumMatch[2]);
      continue;
    }

    // Call graph: function calls within the current function scope
    if (currentFunction) {
      const calls = line.matchAll(/\b(\w+)\s*\(/g);
      for (const call of calls) {
        const callee = call[1];
        // Skip common non-function patterns
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'import', 'require'].includes(callee)) continue;
        if (callee === currentFunction) continue; // skip self-recursion noise
        callGraph.push({ caller: currentFunction, callee, line: lineNum });
      }
    }

    // Track function scope exit (rough: closing brace at column 0)
    if (line.match(/^}/) && currentFunction) {
      currentFunction = null;
    }
  }

  return { filePath, symbols, imports, exports, callGraph };
}

// ---------------------------------------------------------------------------
// File indexing
// ---------------------------------------------------------------------------

/**
 * Index a single file and store in code_index table.
 * Returns true if file was indexed (new or changed), false if unchanged.
 */
export function indexFile(
  db: Database,
  project: string,
  filePath: string,
): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex');

    // Check if already indexed with same hash
    const existing = cachedPrepare(db,
      `SELECT ast_hash FROM code_index WHERE project = ? AND file_path = ?`
    ).get(project, filePath) as { ast_hash: string } | undefined;

    if (existing?.ast_hash === hash) return false; // unchanged

    // Parse based on file extension
    const ext = path.extname(filePath).toLowerCase();
    let parsed: Omit<IndexedFile, 'project' | 'astHash'> | null = null;

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      parsed = parseTypeScript(content, filePath);
    }
    // TODO: Add parsers for Python, Rust when needed

    if (!parsed) return false;

    // Store in DB
    cachedPrepare(db,
      `INSERT OR REPLACE INTO code_index (project, file_path, last_indexed_epoch, ast_hash, symbols, call_graph, imports, exports)
       VALUES (?, ?, unixepoch(), ?, ?, ?, ?, ?)`
    ).run(
      project,
      filePath,
      hash,
      JSON.stringify(parsed.symbols),
      JSON.stringify(parsed.callGraph),
      JSON.stringify(parsed.imports),
      JSON.stringify(parsed.exports),
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Index all source files in a project directory.
 * Skips node_modules, dist, .git, and other non-source directories.
 */
export function indexProject(
  db: Database,
  project: string,
  projectPath: string,
): { indexed: number; skipped: number; total: number } {
  const result = { indexed: 0, skipped: 0, total: 0 };

  const skipDirs = new Set(['node_modules', 'dist', '.git', '.claude', '.planning', 'context', 'coverage', '.vite']);
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs']);

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) {
            walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile() && sourceExts.has(path.extname(entry.name).toLowerCase())) {
          result.total++;
          const fullPath = path.join(dir, entry.name);
          if (indexFile(db, project, fullPath)) {
            result.indexed++;
          } else {
            result.skipped++;
          }
        }
      }
    } catch { /* directory read failure — skip */ }
  }

  walk(projectPath);
  return result;
}

// ---------------------------------------------------------------------------
// Query helpers — used by context assembly
// ---------------------------------------------------------------------------

/**
 * Get the most relevant files for a query based on symbol matching.
 * Returns files that contain symbols matching the query terms.
 */
export function findRelevantFiles(
  db: Database,
  project: string,
  query: string,
  limit: number = 5,
): Array<{ file_path: string; symbols: SymbolInfo[]; relevance: number }> {
  try {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (queryTerms.length === 0) return [];

    const allFiles = cachedPrepare(db,
      `SELECT file_path, symbols, exports FROM code_index WHERE project = ?`
    ).all(project) as Array<{ file_path: string; symbols: string; exports: string }>;

    const scored = allFiles.map(f => {
      const symbols: SymbolInfo[] = JSON.parse(f.symbols || '[]');
      const exportList: string[] = JSON.parse(f.exports || '[]');

      // Score: count matching query terms in symbol names and file path
      let relevance = 0;
      const allNames = [...symbols.map(s => s.name.toLowerCase()), ...exportList.map(e => e.toLowerCase()), f.file_path.toLowerCase()];

      for (const term of queryTerms) {
        for (const name of allNames) {
          if (name.includes(term)) relevance++;
        }
      }

      return { file_path: f.file_path, symbols, relevance };
    }).filter(f => f.relevance > 0);

    return scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get files that changed since a given epoch (for "what changed" context).
 */
export function getChangedFiles(
  db: Database,
  project: string,
  sinceEpoch: number,
): Array<{ file_path: string; symbols: SymbolInfo[] }> {
  try {
    const rows = cachedPrepare(db,
      `SELECT file_path, symbols FROM code_index
       WHERE project = ? AND last_indexed_epoch > ?
       ORDER BY last_indexed_epoch DESC LIMIT 20`
    ).all(project, sinceEpoch) as Array<{ file_path: string; symbols: string }>;

    return rows.map(r => ({
      file_path: r.file_path,
      symbols: JSON.parse(r.symbols || '[]'),
    }));
  } catch {
    return [];
  }
}

/**
 * Get call graph for a specific function — who calls it, what does it call.
 */
export function getCallGraph(
  db: Database,
  project: string,
  functionName: string,
): { callers: CallEdge[]; callees: CallEdge[] } {
  try {
    const allFiles = cachedPrepare(db,
      `SELECT file_path, call_graph FROM code_index WHERE project = ?`
    ).all(project) as Array<{ file_path: string; call_graph: string }>;

    const callers: CallEdge[] = [];
    const callees: CallEdge[] = [];

    for (const f of allFiles) {
      const edges: CallEdge[] = JSON.parse(f.call_graph || '[]');
      for (const edge of edges) {
        if (edge.callee === functionName) callers.push({ ...edge, caller: `${f.file_path}:${edge.caller}` });
        if (edge.caller === functionName) callees.push(edge);
      }
    }

    return { callers, callees };
  } catch {
    return { callers: [], callees: [] };
  }
}
