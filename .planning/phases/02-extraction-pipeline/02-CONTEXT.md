# Phase 2: Extraction Pipeline - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Converts raw tool I/O into structured, scored, redacted observations stored in SQLite. Covers per-tool extractors for 10 tool types, three-layer redaction engine, quality gates, importance scoring, and files_modified as JSON arrays. Does NOT include embedding-based enrichment (Phase 4) or context assembly (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Observation Title Generation
- Per-tool heuristic, no LLM involved — pure string extraction
- Format: `{toolName}: {key_detail}`, max 120 chars, truncate with ellipsis
- Read/Write/Edit: use file path basename
- Bash: first 80 chars of command
- Grep/Glob: search pattern + result count
- WebSearch/WebFetch: URL or query
- Task (agent): agent description
- NotebookEdit: cell identifier or change type

### Category Auto-Classification
- Simple keyword map, first match wins, case-insensitive
- `error/exception/fail/crash/bug` → error
- `test/spec/assert/expect` → test
- `config/env/setting/option` → config
- `package/dependency/npm/install` → dependency
- `doc/readme/comment/jsdoc` → documentation
- `perf/latency/slow/optimize` → performance
- `auth/secret/token/credential/vulnerability` → security
- `architect/design/pattern/interface` → architecture
- `decide/chose/agreed/confirmed` → decision
- Default: `code` if file-related, `other` otherwise
- This is heuristic — enrichment (Phase 4) can refine later

### Redaction Sensitivity
- Lean toward safety — over-redacting is safer than under-redacting
- Entropy threshold 4.5 is confirmed
- Base64 strings > 32 chars: redact (likely encoded secrets)
- Long package names: allowlisted via `node_modules/` path prefix
- Encoded strings: redact if they match secret patterns after decoding; skip if no match and < 64 chars

### Content Depth per Extractor
- Truncate at 2000 chars per observation
- Content is meaningful extracted output, not raw stdin/stdout dump
- Read/Write: first 2000 chars of file content
- Bash: full stdout up to 2000 chars
- Grep/Glob: file list + match counts
- Use `truncateText()` from text-utils.ts (built in Phase 0)

### Claude's Discretion
- NotebookEdit title format (no explicit preference given — follow the `{toolName}: {key_detail}` pattern)
- Exact regex patterns for secret detection Layer 1 (architecture provides examples, implementation can expand)
- Specific PII regex patterns (architecture provides categories, implementation chooses exact regexes)
- Quality gate threshold fine-tuning within the ranges specified by architecture

</decisions>

<specifics>
## Specific Ideas

- Title format explicitly `{toolName}: {key_detail}` — consistent, scannable, no prose
- Category classification is intentionally simple (keyword map, first match) — Phase 4 embeddings will refine
- The 84% unused observation stat from v2 means quality gates must be strict — filter aggressively
- Redaction philosophy: safety first, utility second

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-extraction-pipeline*
*Context gathered: 2026-03-10*
