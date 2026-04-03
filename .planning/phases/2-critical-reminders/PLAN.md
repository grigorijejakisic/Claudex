# Phase 2 Plan: Critical Reminders Tier

**Phase:** 2 of 12
**Spec:** `context/specs/CRITICAL_REMINDERS_TIER.md`
**Research:** `context/research/STREET_KNOWLEDGE_CRITICAL_REMINDERS.md`
**Context:** `.planning/phases/2-critical-reminders/2-CONTEXT.md`
**Status:** PLANNED

---

## Overview

Build the Critical Reminders injection tier — a system that re-injects distilled CLAUDE.md behavioral rules into the context at strategic moments (phase transitions, TTL expiry, first-encounter domains) to prevent instruction drift in long conversations. This is the anti-drift backbone: rules decay from attention as conversations grow, and this system counteracts that decay.

8 work units across 3 waves. 6 existing files modified, 2 new files created.

---

## Wave 1 — Schema + Core Engine (WU1, WU4, WU6)

### WU1: Schema + Migration

**Files:** `src/core/schema.ts`, `src/core/migration-steps.ts`, `src/core/migrations.ts`

#### schema.ts — Add `critical_rules` DDL

Append the `critical_rules` CREATE TABLE after the existing schema string (add to end of `SCHEMA_V3` template literal, before the closing backtick):

```sql
-- critical_rules: behavioral rules that need periodic re-injection to prevent drift
CREATE TABLE IF NOT EXISTS critical_rules (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  variants TEXT,                    -- JSON array of 3-4 surface form templates
  source TEXT NOT NULL CHECK (source IN ('author', 'system-promoted')),
  drift_risk TEXT NOT NULL CHECK (drift_risk IN ('safety', 'working-method', 'style')),
  domain_tags TEXT,                 -- JSON array: ['bash', 'git', 'multi-file', 'team']
  base_ttl INTEGER NOT NULL,       -- turns before re-injection
  current_ttl INTEGER,             -- adjusted by compliance/violation (Leitner)
  last_injected_turn INTEGER,
  injection_count INTEGER DEFAULT 0,
  violation_count INTEGER DEFAULT 0,
  compliance_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_critical_rules_project_source
  ON critical_rules(project, source);
```

#### migration-steps.ts — Add `migrateV12toV13`

New function at end of file:

```typescript
export function migrateV12toV13(db: Database): void {
  // Create critical_rules table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS critical_rules (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        variants TEXT,
        source TEXT NOT NULL CHECK (source IN ('author', 'system-promoted')),
        drift_risk TEXT NOT NULL CHECK (drift_risk IN ('safety', 'working-method', 'style')),
        domain_tags TEXT,
        base_ttl INTEGER NOT NULL,
        current_ttl INTEGER,
        last_injected_turn INTEGER,
        injection_count INTEGER DEFAULT 0,
        violation_count INTEGER DEFAULT 0,
        compliance_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_critical_rules_project_source
        ON critical_rules(project, source);
    `);
  } catch { /* non-fatal — table may exist from SCHEMA_V3 */ }
}
```

#### migrations.ts — Wire V12→V13

1. Import `migrateV12toV13` from `./migration-steps.js`
2. Change `TARGET_VERSION` from 12 to 13
3. Add migration entry: `[12, () => migrateV12toV13(db)]`
4. Update `initializeSchema` to set `user_version = 13`

### WU4: Decay Engine (TTL + Jitter)

**File:** `src/intelligence/critical-reminders.ts` (NEW)

Core function:

```typescript
export function shouldInjectRule(
  rule: CriticalRule,
  turnNumber: number,
): boolean
```

Logic:
1. If `last_injected_turn` is null → inject (never injected)
2. Compute elapsed = `turnNumber - last_injected_turn`
3. Compute effective TTL = `current_ttl ?? base_ttl`
4. Apply jitter based on `drift_risk`:
   - `'safety'` → jitter = ±2 (seeded from rule.id + turnNumber)
   - `'working-method'` → jitter = ±3
   - `'style'` → jitter = ±5
5. If elapsed >= effective TTL + jitter → inject

Jitter uses deterministic hash `(rule.id * 7 + turnNumber) % (2 * jitterRange + 1) - jitterRange` — no Math.random() (deterministic for testing, variable-interval per Skinner).

Leitner functions:

```typescript
export function advanceTTL(db: Database, ruleId: number): void
// current_ttl = min(current_ttl * 1.5, base_ttl * 3), compliance_count++

export function resetTTL(db: Database, ruleId: number): void
// current_ttl = base_ttl, violation_count++
```

### WU6: Phrasing Variation Renderer

**File:** `src/intelligence/critical-reminders.ts` (same file)

```typescript
export function renderRuleVariant(rule: CriticalRule, injectionCount: number): string
```

Logic:
1. Parse `rule.variants` as `string[]` (JSON)
2. If no variants or parse fails → return `rule.rule_text`
3. Select variant by `injectionCount % variants.length`
4. Return selected variant

No LLM call. Pure deterministic rotation.

#### Types defined in this file

```typescript
export interface CriticalRule {
  id: number;
  project: string;
  rule_text: string;
  variants: string | null;
  source: 'author' | 'system-promoted';
  drift_risk: 'safety' | 'working-method' | 'style';
  domain_tags: string | null;  // JSON array
  base_ttl: number;
  current_ttl: number | null;
  last_injected_turn: number | null;
  injection_count: number;
  violation_count: number;
  compliance_count: number;
}

export interface CriticalRemindersResult {
  section: string;
  tokenCost: number;
  injectedRuleIds: number[];
  applyEffects: () => void;
}
```

---

## Wave 2 — Rule Sources + Assembly (WU2, WU3, WU5, WU7)

### WU2: CLAUDE.md Marker Parser

**File:** `src/intelligence/critical-reminders.ts`

```typescript
export function parseCriticalMarkers(content: string): ParsedCriticalRule[]
export function seedCriticalRules(db: Database, project: string, projectDir: string): void
```

#### parseCriticalMarkers

Scans CLAUDE.md content for `<!-- critical -->` HTML comment markers. The marker applies to the **next** numbered list item or bullet point after it. Parsing logic:

1. Split content by lines
2. When a line contains `<!-- critical -->`, flag the next non-empty line as critical
3. Extract the rule text (strip markdown list prefix)
4. Infer `drift_risk` from keywords:
   - Contains "never"/"deadlock"/"scope"/"verify"/"safety" → `'safety'` (base_ttl=6)
   - Contains "systematic"/"analysis"/"method"/"read"/"before" → `'working-method'` (base_ttl=10)
   - Default → `'style'` (base_ttl=20)
5. Infer `domain_tags` from keywords:
   - "bash"/"command"/"shell" → `['bash']`
   - "git"/"commit"/"push" → `['git']`
   - "file"/"edit"/"modify" → `['multi-file']`
   - "team"/"agent"/"spawn" → `['team']`
   - Can have multiple tags

Returns `ParsedCriticalRule[]` (rule_text, drift_risk, domain_tags, base_ttl).

#### seedCriticalRules

Called at session-start. Reads both:
- Global CLAUDE.md: `~/.claude/CLAUDE.md`
- Project CLAUDE.md: `{projectDir}/CLAUDE.md`

Parses both with `parseCriticalMarkers()`. Upserts into `critical_rules` with `source='author'`. Uses `rule_text` as natural key for dedup (INSERT OR REPLACE keyed on project + rule_text hash).

### WU3: System Promotion Bridge

**File:** `src/intelligence/critical-reminders.ts`

```typescript
export function promoteFromCapabilityTracker(db: Database, project: string): void
```

Logic:
1. Call `getWeakDomains(db, project, 0.3, 5)` — domains with >=30% correction rate and >=5 interactions
2. For each weak domain:
   - Check if already in `critical_rules` with `source='system-promoted'`
   - If not, and count of system-promoted rules < 10 (cap): INSERT
   - Generate rule_text from domain advisory: `generateDomainAdvisory(db, project, domain)`
   - Set `drift_risk = 'working-method'`, `base_ttl = 8`
   - Set `domain_tags = [domain]`
3. Demotion check: query existing system-promoted rules, check their domain's correction_rate. If < 15%, DELETE the rule.

Called at session-start after `seedCriticalRules()`.

### WU5: Activity Gate + First-Encounter Gate

**File:** `src/adapters/cc-hooks/post-tool-use.ts` (modified), `src/intelligence/experience-flags.ts` (modified)

#### experience-flags.ts changes

Add two new fields to `ExperienceFlags` interface:

```typescript
/** True when a phase-transition activity was detected — consumed by next UPS turn. */
critical_activity_gate: boolean;
/** Rule domains seen this session. Set grows monotonically — never cleared. */
seen_rule_domains: string[];
```

Add defaults in `getExperienceFlags`: `critical_activity_gate: false`, `seen_rule_domains: []`.

Add to `setExperienceFlags` merge logic (same pattern as other fields).

Add to the deserialization block in `getExperienceFlags` (same pattern as `pending_trigger_domains`).

#### post-tool-use.ts changes

After the existing workflow phase detection block (lines 176-206), add a new block:

```typescript
// ---------------------------------------------------------------------------
// Critical reminders: activity gate + first-encounter tracking
// Flags phase-transition moments and tracks new rule domains for injection.
// ---------------------------------------------------------------------------
try {
  const flags = getExperienceFlags(ctx.db, input.session_id);
  let gateTriggered = false;
  const newDomains: string[] = [...flags.seen_rule_domains];

  // Activity gate: multi-file edits
  const editFiles = Object.keys(flags_behavioral?.file_edit_counts ?? {});
  if (editFiles.length >= 2) gateTriggered = true;

  // Activity gate: git operations
  if (toolLower === 'bash' && (inputStr.includes('git commit') || inputStr.includes('git push'))) {
    gateTriggered = true;
  }

  // Activity gate: agent spawning
  if (toolLower === 'task' || toolLower === 'agent' || toolLower === 'subagent') {
    gateTriggered = true;
  }

  // First-encounter: track tool domain
  const toolDomain = mapToolToDomain(toolName);
  if (toolDomain && !newDomains.includes(toolDomain)) {
    newDomains.push(toolDomain);
  }

  if (gateTriggered || newDomains.length !== flags.seen_rule_domains.length) {
    setExperienceFlags(ctx.db, input.session_id, {
      critical_activity_gate: gateTriggered || flags.critical_activity_gate,
      seen_rule_domains: newDomains,
    }, flags);
  }
} catch (e) {
  emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/critical_gate', e);
}
```

Helper function `mapToolToDomain` (in critical-reminders.ts, exported):

```typescript
export function mapToolToDomain(toolName: string): string | null {
  const lower = toolName.toLowerCase();
  if (lower === 'bash') return 'bash';
  if (lower === 'edit' || lower === 'write') return 'multi-file';
  if (lower === 'read' || lower === 'glob' || lower === 'grep') return 'read';
  if (lower === 'task' || lower === 'agent') return 'team';
  return null;
}
```

### WU7: `assembleCriticalReminders()` + Cascade Integration

**Files:** `src/intelligence/critical-reminders.ts`, `src/assembly/assembler.ts`

#### assembleCriticalReminders (in critical-reminders.ts)

```typescript
export function assembleCriticalReminders(
  db: Database,
  sessionId: string,
  turnNumber: number,
  project: string,
  activityGate: boolean,
  seenDomains: string[],
  contextWindowTokens?: number,
): CriticalRemindersResult | null
```

Logic:
1. Query all `critical_rules` for this project
2. Score each rule against current context:
   - **Decay expired?** `shouldInjectRule(rule, turnNumber)` → score += 3
   - **Activity gate set?** `activityGate && rule.drift_risk === 'safety'` → score += 5
   - **First-encounter?** Rule has domain_tag that's in `seenDomains` but wasn't in `seenDomains` on last check → score += 4
   - **Domain match?** Rule's domain_tags overlap with current tool context → score += 1
3. Filter rules with score > 0
4. Sort by score DESC, take top 5
5. Render each with `renderRuleVariant(rule, rule.injection_count)`
6. Format as:
   ```
   ## Critical Reminders
   - [rendered rule 1]
   - [rendered rule 2]
   - [rendered rule 3]
   ```
7. Estimate tokens with `estimateTokens()`
8. Hard cap: `scaleBudget(300, contextWindowTokens)` tokens. If over budget, drop lowest-scored rules until under.
9. Return `CriticalRemindersResult` with deferred `applyEffects`:
   - Update `last_injected_turn` to current turn for each injected rule
   - Increment `injection_count` for each
   - Clear `critical_activity_gate` flag

Returns `null` if no rules qualified or all scored 0.

#### assembler.ts changes

In `assembleRegularPrompt`, between the proven principles block (4a, ending ~line 834) and the intent-triggered patterns block (4b, starting ~line 836):

```typescript
// 4a.5: Critical Reminders — conditional re-injection of CLAUDE.md behavioral rules.
// Fires on decay TTL expiry, activity gate (phase transitions), or first-encounter domains.
// Separate from proven principles (experience patterns) — these are CLAUDE.md rules.
if (params.sessionId) {
  try {
    const flags = getExperienceFlags(params.db, params.sessionId);
    const turnCount = getTurnCount(params.db, params.sessionId);
    const reminders = assembleCriticalReminders(
      params.db,
      params.sessionId,
      turnCount,
      params.project,
      flags.critical_activity_gate,
      flags.seen_rule_domains,
      params.gauge?.contextWindowTokens,
    );
    if (reminders && reminders.tokenCost <= scaleBudget(300, params.gauge?.contextWindowTokens)) {
      parts.push(reminders.section);
      totalTokens += reminders.tokenCost;
      srcs.push('critical_reminders');
      // Chain commit: both experience warning effects AND critical reminder effects
      const prevCommit = commitFn;
      commitFn = () => {
        prevCommit?.();
        reminders.applyEffects();
      };
    }
  } catch { /* non-fatal */ }
}
```

New helper (in assembler.ts, private):

```typescript
function getTurnCount(db: Database, sessionId: string): number {
  try {
    const row = cachedPrepare(db,
      'SELECT COUNT(*) as cnt FROM conversation_turns WHERE session_id = ?'
    ).get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch { return 0; }
}
```

New imports in assembler.ts:
- `import { assembleCriticalReminders } from '../intelligence/critical-reminders.js';`
- `scaleBudget` is already imported

Also needs `RegularPromptParams` to remain unchanged — the assembler reads experience flags itself (same pattern as existing code).

---

## Wave 3 — Stop Hook Enforcement + Session-Start Seeding (WU8, WU2 wiring)

### WU8: Stop Hook Deterministic Enforcement

**File:** `src/adapters/cc-hooks/stop.ts`

Add two new `runHookStep` calls before the existing warnings block (before line 564, after the last existing `runHookStep`):

#### read_before_edit_check

```typescript
let readBeforeEditWarning = '';
runHookStep('read_before_edit_check', () => {
  const edits = cachedPrepare(ctx.db,
    `SELECT DISTINCT entity FROM session_events
     WHERE session_id = ? AND type = 'file' AND action = 'edit'`
  ).all(input.session_id) as Array<{ entity: string }>;

  for (const edit of edits) {
    const readExists = cachedPrepare(ctx.db,
      `SELECT 1 FROM session_events
       WHERE session_id = ? AND type = 'file' AND action = 'read' AND entity = ?
       LIMIT 1`
    ).get(input.session_id, edit.entity);
    if (!readExists) {
      readBeforeEditWarning = `## Behavioral Warning\nFile "${edit.entity}" was edited without being read first this session. Read before editing to understand existing code.`;
      break; // One warning is enough
    }
  }
}, ctx.db, input.session_id);
```

#### tests_before_done_check

```typescript
let testWarning = '';
runHookStep('tests_before_done_check', () => {
  // Only check if stop_reason suggests completion
  const stopReason = (input.stop_reason as string) ?? '';
  if (stopReason !== 'end_turn') return; // Only warn on natural end-of-turn

  const hasTests = cachedPrepare(ctx.db,
    `SELECT 1 FROM session_events
     WHERE session_id = ? AND type = 'command'
       AND (entity LIKE '%test%' OR entity LIKE '%vitest%')
     LIMIT 1`
  ).get(input.session_id);

  const hasEdits = cachedPrepare(ctx.db,
    `SELECT 1 FROM session_events
     WHERE session_id = ? AND type = 'file' AND action IN ('edit', 'write')
     LIMIT 1`
  ).get(input.session_id);

  if (hasEdits && !hasTests) {
    testWarning = '## Behavioral Warning\nCode was modified this session but no tests were run. Consider running tests before concluding.';
  }
}, ctx.db, input.session_id);
```

Then modify the warnings aggregation (line 592):

```typescript
const warnings = [gateWarning, idleWarning, readBeforeEditWarning, testWarning].filter(Boolean).join('\n\n');
```

### Session-Start Seeding (WU2 wiring)

**File:** `src/adapters/cc-hooks/session-start.ts`

After the existing session creation and before the assembly call, add:

```typescript
// Seed critical rules from CLAUDE.md markers (Phase 2: Critical Reminders Tier)
try {
  seedCriticalRules(ctx.db, ctx.project, input.cwd);
  promoteFromCapabilityTracker(ctx.db, ctx.project);
} catch { /* non-fatal — critical reminders are best-effort */ }
```

New import: `import { seedCriticalRules, promoteFromCapabilityTracker } from '../../intelligence/critical-reminders.js';`

---

## Wave 4 — Tests

### WU-Test: `src/intelligence/critical-reminders.test.ts` (NEW)

Test groups:

#### 1. Schema + CRUD
- `critical_rules` table created by migration
- INSERT/SELECT round-trip with all fields
- Index exists on `(project, source)`

#### 2. CLAUDE.md Marker Parser
- Parses single `<!-- critical -->` marker + following bullet
- Parses multiple markers in sequence
- Ignores markers without following content
- Infers drift_risk from keywords (safety/method/style)
- Infers domain_tags from keywords

#### 3. Decay Engine
- Rule with null `last_injected_turn` always injects
- Rule within TTL does not inject
- Rule past TTL injects
- Jitter varies across different turnNumbers (deterministic)
- No two consecutive injections at identical interval (success criterion 3)

#### 4. Leitner Advance/Reset
- `advanceTTL` increases `current_ttl` by 1.5x, caps at 3x base
- `resetTTL` sets `current_ttl` back to `base_ttl`

#### 5. Phrasing Variation
- Rotates through variants by injection_count
- Falls back to rule_text when no variants
- Handles invalid JSON in variants column

#### 6. Activity Gate + First-Encounter
- Multi-file edit triggers activity gate
- Git commit triggers activity gate
- Agent spawn triggers activity gate
- First bash tool call populates seen_rule_domains
- Second bash tool call does not re-add

#### 7. assembleCriticalReminders Integration
- Returns null when no rules exist
- Returns null when no rules qualify (all within TTL, no gate)
- Returns section when decay TTL expired
- Returns section when activity gate set
- Returns section when first-encounter domain matches
- Token cap enforced (drops lowest-scored rules)
- `applyEffects` updates last_injected_turn + injection_count
- `applyEffects` clears critical_activity_gate

#### 8. System Promotion Bridge
- Promotes domain with correction_rate >= 30%
- Does not promote domain with < 5 interactions
- Cap: max 10 system-promoted rules
- Demotes rule when correction_rate drops below 15%

#### 9. Stop Hook Enforcement
- Warns when file edited without prior read
- Does not warn when file was read before edit
- Warns when code edited but no tests run
- Does not warn when tests were run

#### 10. Success Criteria (spec validation)
- SC1: Rules marked `<!-- critical -->` appear in injection output
- SC2: No single injection exceeds 300 tokens
- SC3: Variable timing across consecutive injections
- SC4: First bash call injects bash safety rules
- SC5: Meta-instructions enforced by hooks, not prompt (test absence)
- SC6: Write tool call triggers pre-write reminder injection

---

## File Summary

| File | Action | Wave |
|------|--------|------|
| `src/core/schema.ts` | Add critical_rules DDL | 1 |
| `src/core/migration-steps.ts` | Add migrateV12toV13 | 1 |
| `src/core/migrations.ts` | Wire migration, bump TARGET_VERSION | 1 |
| `src/intelligence/critical-reminders.ts` | **NEW** — all core logic | 1+2 |
| `src/intelligence/experience-flags.ts` | Add 2 new flag fields | 2 |
| `src/adapters/cc-hooks/post-tool-use.ts` | Activity gate + first-encounter | 2 |
| `src/assembly/assembler.ts` | Priority 4a.5 integration | 2 |
| `src/adapters/cc-hooks/stop.ts` | 2 new runHookStep entries | 3 |
| `src/adapters/cc-hooks/session-start.ts` | Seed rules at session start | 3 |
| `src/intelligence/critical-reminders.test.ts` | **NEW** — 10 test groups | 4 |

**Lines added (estimated):** ~450 new code + ~500 test code
**Lines modified:** ~40 across 6 existing files

---

## Verification Checklist

After all waves complete:

- [ ] `bun run build` succeeds
- [ ] `bun run test` passes (all 2020+ existing tests + new tests)
- [ ] SC1: `<!-- critical -->` rules parsed and stored
- [ ] SC2: 300 token hard cap enforced
- [ ] SC3: Jitter produces variable intervals (test covers)
- [ ] SC4: First-encounter gating works
- [ ] SC5: No meta-instructions in injected content
- [ ] SC6: Lacuna scenario prevented (activity gate fires before first write)
- [ ] Migration is additive (no destructive DDL)
- [ ] Deferred effects pattern followed (applyEffects only after budget check)
- [ ] No CC API calls from hooks (deadlock rule)
