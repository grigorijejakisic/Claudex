# Experience Patterns — Learning from Mistakes

**Status:** Spec v1
**Date:** 2026-03-16
**Author:** Crux (Session 13)
**Research:** r1-github, r2-reddit (parallel research agents)

## Problem

Claudex stores learnings and observations across sessions, but treats all knowledge equally. When the same mistake is repeated (e.g., forgetting OAuth token transfer during server migration — happened on Vesna AND Linux server), Claudex has no mechanism to:

1. Detect that a user correction signals a repeated failure pattern
2. Store the pattern with enough context to trigger on similar future situations
3. Actively warn with elevated priority (vs burying in passive context)
4. Track whether patterns are validated across sessions or are one-off noise

The result: mistakes get stored as flat learnings that compete for attention with everything else. The LLM "hopes to notice" rather than being explicitly warned.

## Prior Art (Verified)

| System | Pattern | What We Take |
|---|---|---|
| Reflexion (NeurIPS) | Failure → LLM reflection → bounded memory (1-3 items) → inject | Core loop, cap at 3 |
| ExpeL (AAAI-24) | Pairwise success/failure comparison, voted rules (ADD +2, AGREE +1, REMOVE -1, die at 0) | Quality gate scoring |
| ICAL (AAAI) | Success-gate: only store corrected version, discard raw failures | Storage filter |
| Mem0 | ADD/UPDATE/DELETE/NONE grammar with LLM-as-judge for contradictions | Conflict handling |
| TaskWeaver (Microsoft) | Summarization prompt catches user dissatisfaction phrases as failure signal | Correction detection |
| Vexp | Passive behavioral detection (dead-end exploration, file thrashing) at <1ms overhead | PostToolUse signals |
| Anthropic Docs | XML tags, position warnings at top, examples > rules, no "CRITICAL:" in Claude 4.6 | Injection format |

## Novel Contributions

1. **Correction phrase detection** — regex/embedding cascade (no existing system does this)
2. **Cross-session failure pattern matching** — trigger warnings when current context resembles past failure contexts
3. **Active warning injection** as separate priority class in assembly (not buried in general context)

## Design

### Schema

```sql
CREATE TABLE experience_patterns (
  id TEXT PRIMARY KEY,                    -- ULID
  pattern_type TEXT NOT NULL,             -- 'correction', 'behavioral', 'discovery'
  trigger_context TEXT NOT NULL,          -- FTS5-searchable situation description
  lesson TEXT NOT NULL,                   -- what to do differently (the corrected approach)
  anti_pattern TEXT,                      -- what went wrong (optional, for examples)
  severity TEXT NOT NULL DEFAULT 'important', -- 'critical', 'important', 'minor'
  score INTEGER NOT NULL DEFAULT 2,       -- ExpeL model: starts at 2, +1 validate, -1 false positive, remove at 0
  times_triggered INTEGER NOT NULL DEFAULT 0,
  times_useful INTEGER NOT NULL DEFAULT 0,  -- user didn't correct after trigger = useful
  source_session TEXT,                    -- session that created this
  source_project TEXT,                    -- project scope (or '__global__')
  created_at_epoch INTEGER NOT NULL,
  last_triggered_epoch INTEGER
);

-- FTS5 index for trigger matching
CREATE VIRTUAL TABLE experience_patterns_fts USING fts5(
  trigger_context,
  lesson,
  anti_pattern,
  content='experience_patterns',
  content_rowid='rowid'
);

-- Keep FTS in sync
CREATE TRIGGER experience_patterns_ai AFTER INSERT ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;
CREATE TRIGGER experience_patterns_ad AFTER DELETE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
END;
CREATE TRIGGER experience_patterns_au AFTER UPDATE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;
```

### Detection Layer

Two detection sources, both lightweight:

#### 1. Behavioral Detection (PostToolUse hook)

Detect anti-patterns in real-time tool usage:

```typescript
interface BehavioralSignal {
  type: 'file_thrashing' | 'loop_detected' | 'dead_end';
  evidence: string;       // "edited src/foo.ts 4 times in 3 minutes"
  files?: string[];
  tool_pattern?: string;  // "Edit→Edit→Edit same file"
}
```

**Triggers:**
- Same file edited 3+ times within a session → `file_thrashing`
- Same tool + same input pattern 3+ cycles → `loop_detected`
- 5+ tool calls with no productive output (no file changes, no new info) → `dead_end`

**Implementation:** Counter map in `infrastructure.ts` shared state (already exists as `hookSharedState`). Increment on PostToolUse, check thresholds. Zero cost when not triggered.

#### 2. Linguistic Detection (UserPromptSubmit hook)

Detect user correction signals in prompt text:

```typescript
const CORRECTION_PATTERNS = [
  /\b(?:I\s+told\s+you|we\s+(?:already|did\s+this)|same\s+mistake|again\b.*\bwrong)/i,
  /\b(?:remember\s+(?:when|last\s+time)|didn't\s+I\s+say|how\s+many\s+times)/i,
  /\b(?:that's\s+(?:not|wrong)|no[,.]?\s+(?:actually|not\s+that))/i,
  /\b(?:should\s+be\s+remembered|learn\s+from\s+(?:experience|this))/i,
  /\b(?:you\s+keep|stop\s+doing|don't\s+(?:do\s+that|repeat))/i,
];

function detectCorrectionSignal(prompt: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(prompt));
}
```

**When detected:** Flag the turn. At Stop hook, extract the correction pattern from the assistant's response (the assistant will have acknowledged and corrected).

### Extraction (Stop hook)

When a correction signal was detected during the turn:

```typescript
interface ExtractionResult {
  trigger_context: string;  // "server migration, OAuth token transfer"
  lesson: string;           // "Always copy OAuth token from ~/.claude/.credentials.json"
  anti_pattern: string;     // "Assumed old token would work on new machine"
  severity: 'critical' | 'important' | 'minor';
  pattern_type: 'correction' | 'behavioral' | 'discovery';
}
```

**Extraction approach:** Two-stage (consistent with existing Claudex decision capture):
1. **Regex scan** of assistant text for structured correction patterns ("the problem was...", "the fix is...", "next time...")
2. **Heuristic assembly** — if regex captures enough signal, skip LLM. Otherwise, use existing enrichment path (Ollama if available, else heuristic-only)

**Quality gate (ICAL success-gate):** Only store the pattern if the session ends without the user re-correcting the same issue. If the user corrects again in the same session, the extraction was wrong — discard or revise.

### Storage CRUD

```typescript
// Core operations
function createPattern(db: Database, pattern: ExtractionResult, sessionId: string, project: string): string;
function findMatchingPatterns(db: Database, prompt: string, project: string, limit?: number): ExperiencePattern[];
function updatePatternScore(db: Database, id: string, delta: number): void;  // +1 useful, -1 false positive
function incrementTriggerCount(db: Database, id: string): void;
function pruneDeadPatterns(db: Database): number;  // remove score <= 0
function deduplicatePatterns(db: Database, newPattern: ExtractionResult): 'add' | 'update' | 'skip';
```

**Deduplication:** Before adding a new pattern, FTS5 search for similar `trigger_context`. If match with score > 0.7 similarity:
- Same lesson → increment score (+1 AGREE), skip add
- Different lesson → LLM-as-judge: UPDATE existing or ADD new? (Mem0 pattern)
- Contradicting lesson → UPDATE with newer lesson, reset score to 2

### Trigger Matching (UserPromptSubmit hook)

On every prompt (lightweight — FTS5 query only, no embedding):

```typescript
function matchExperiencePatterns(
  db: Database,
  prompt: string,
  project: string,
  toolContext?: string  // current tool names, file paths
): ExperiencePattern[] {
  // 1. Tokenize prompt (reuse existing tokenizeQuery from artifacts.ts)
  // 2. FTS5 MATCH against experience_patterns_fts
  // 3. Filter: score >= 2 (validated patterns only)
  // 4. Filter: rank by FTS5 relevance * score weight
  // 5. Cap at 3 results (Reflexion limit)
  // 6. Return sorted by severity (critical first)
  return patterns;
}
```

**Threshold:** Only inject patterns with `score >= 2` (validated at least once beyond initial creation). New patterns (score = 2) are eligible immediately — they need one false positive to drop below threshold.

**Scope:** Search current project first, then `__global__`. Cross-project patterns (like "OAuth token transfer during migration") are global.

### Assembly Injection

New section in `assembler.ts`, injected at **Priority 1.5** (after Identity, before Project):

```typescript
function renderExperienceWarnings(patterns: ExperiencePattern[]): string {
  if (patterns.length === 0) return '';

  let section = '## Past Experience — Relevant Patterns\n\n';
  section += 'You have encountered similar situations before. ';
  section += 'These patterns are from past sessions:\n\n';

  for (const p of patterns) {
    section += `### ${p.severity === 'critical' ? 'Critical' : 'Important'}: ${p.trigger_context}\n`;
    if (p.anti_pattern) {
      section += `**What went wrong:** ${p.anti_pattern}\n`;
    }
    section += `**Correct approach:** ${p.lesson}\n`;
    section += `*Validated ${p.score} times across ${p.times_triggered} triggers*\n\n`;
  }

  return section;
}
```

**Format decisions (research-backed):**
- No "CRITICAL:" caps — causes overtriggering in Claude 4.6 (Anthropic docs)
- "What went wrong / Correct approach" pairs — examples > rules (LangGraph finding)
- Validation count shown — builds trust in the warning's relevance
- Max 3 patterns — Reflexion's empirically validated cap
- Priority 1.5 — above project context, below identity. Warnings must be seen early.

### Feedback Loop

After a turn where experience patterns were injected:

```typescript
// At Stop hook, check: did the user correct the same issue again?
// If NO correction detected this turn → pattern was useful
//   → incrementScore(pattern.id, +1)
//   → incrementUseful(pattern.id)
// If YES correction detected → pattern was either wrong or insufficient
//   → updateScore(pattern.id, -1)
//   → optionally: update the lesson text with the new correction
```

**Score lifecycle:**
- Created: score = 2
- Each session where it triggers and NO correction follows: score += 1 (max 10)
- Each session where it triggers and correction follows: score -= 1
- score reaches 0: pattern is deleted (ExpeL model)
- score >= 5: pattern is considered "established" — could be promoted to a learning

### Integration Points

| Hook | What Happens |
|---|---|
| **UserPromptSubmit** | 1. Check prompt against correction patterns (regex). 2. FTS5 match against experience_patterns. 3. If matches found, include in assembly at Priority 1.5. |
| **PostToolUse** | Check behavioral signals (file thrashing, loops, dead ends). Flag if detected. |
| **Stop** | 1. If correction was flagged this turn → extract pattern → store. 2. If experience patterns were injected this turn → evaluate usefulness → update scores. |

### Latency Budget

| Operation | Target | Actual Estimate |
|---|---|---|
| Regex correction detection | <1ms | ~0.1ms |
| FTS5 pattern match | <5ms | ~2ms (small table) |
| Pattern assembly rendering | <1ms | ~0.5ms |
| Behavioral signal check | <1ms | Counter increment |
| Pattern extraction at Stop | <10ms | Regex + heuristic |
| **Total added per turn** | **<10ms** | Well within budget |

### Migration

New migration in `migrations.ts`:
- Create `experience_patterns` table
- Create `experience_patterns_fts` FTS5 virtual table
- Create sync triggers (INSERT, UPDATE, DELETE)
- No data migration needed (new feature)

### Files to Create/Modify

| File | Change |
|---|---|
| `src/intelligence/experience-patterns.ts` | **NEW** — CRUD, matching, extraction, scoring |
| `src/core/migrations.ts` | Add migration for new table + FTS5 |
| `src/adapters/cc-hooks/user-prompt-submit.ts` | Add correction detection + pattern matching + assembly injection |
| `src/adapters/cc-hooks/post-tool-use.ts` | Add behavioral signal detection |
| `src/adapters/cc-hooks/stop.ts` | Add pattern extraction + score feedback |
| `src/adapters/cc-hooks/infrastructure.ts` | Add behavioral counter to shared state |
| `src/assembly/assembler.ts` | Add experience warnings section at Priority 1.5 |
| `src/assembly/sections.ts` | Add `renderExperienceWarnings()` |
| `src/tests/intelligence/experience-patterns.test.ts` | **NEW** — CRUD, matching, scoring, dedup tests |
| `src/tests/integration/experience-patterns-e2e.test.ts` | **NEW** — full loop: detect → store → match → inject → feedback |

### Success Criteria

1. When a user corrects the same mistake twice, the second correction creates an experience pattern
2. On the third occurrence, the pattern is injected as an active warning BEFORE the mistake is made
3. Patterns that prove useful (no re-correction after warning) gain score and persist
4. Patterns that prove useless (re-correction despite warning) lose score and eventually die
5. Total latency added per turn: <10ms
6. Maximum 3 patterns injected per assembly (no context bloat)
7. All existing tests continue to pass (no regressions)

### What This Doesn't Do (Explicit Non-Goals)

- **LLM-based correction classification** — regex only for v1. Embedding/LLM tiers are future work.
- **Cross-agent pattern sharing** — patterns are per-Claudex-instance for now. Cross-agent is a Paperclip feature.
- **Automatic behavioral pattern creation** — behavioral signals are detected but v1 only logs them. Auto-creation from behavioral signals is v2.
- **Pattern editing UI** — patterns are managed via DB. CLI/UI is future work.
