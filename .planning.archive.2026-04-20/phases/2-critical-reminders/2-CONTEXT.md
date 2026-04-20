# Phase 2 Context: Critical Reminders Tier

> Phase: 2 of 12 (CC Source-Informed Upgrades)
> Spec: `context/specs/CRITICAL_REMINDERS_TIER.md`
> Research: `context/research/STREET_KNOWLEDGE_CRITICAL_REMINDERS.md` (5-layer, ~250 sources)
> Discussion: 2026-04-03, session 44

---

## Problem Statement

Rules injected at session start decay from effective attention as conversation grows. Softmax attention is zero-sum — every new token steals from prior tokens. Claudex currently has NO reinforcement between session start and compaction for CLAUDE.md behavioral rules. The "Rules Reminder" section only fires post-compaction. Proven principles (500 token cap, every turn) draw from experience patterns, not CLAUDE.md behavioral rules.

Evidence:
- Lacuna Betting session 3: agent saw all CLAUDE.md rules at turn 1, violated every one by turn 10
- Dongre et al.: drift stabilizes at non-zero equilibrium D* without intervention
- "Lost in the Middle" (TACL 2024): 30%+ accuracy loss on middle-positioned information
- Ceremonial compliance: meta-instructions ("verify before done") degrade into false claims

## Design Decisions (Confirmed)

### 1. Hybrid Rule Selection: Author + System

**Author-marked baseline:** CLAUDE.md rules tagged with `<!-- critical -->` HTML comment markers form the static rule pool. Parsed at session-start (every session) and upserted into `critical_rules` table.

**System-promoted:** Rules that experience patterns show get violated are auto-promoted. Threshold: `correction_rate >= 30%` with `>= 5 interactions` (from `capability_tracker` domain data). Promotion cap: max 10 system-promoted rules. Demotion: when `correction_rate` drops below 15%, rule is demoted back to normal.

### 2. Injection Triggers: Decay + Activity-Gated + First-Encounter

**Decay trigger (variable-interval):** Per-rule TTL based on drift risk:
- Safety rules (deadlock, scope lock, verify-before-done): TTL = 5-8 turns + jitter +/-2
- Working method rules (systematic, analysis-first): TTL = 8-12 turns + jitter +/-3
- Style rules (concise, no narration): TTL = 15-25 turns + jitter +/-5

Jitter prevents fixed-interval scalloping (Skinner). On compliance evidence: extend TTL (Leitner advance). On violation evidence: reset TTL to minimum (Leitner reset).

**Activity gate (phase-transition):** Fires BEFORE these actions regardless of decay state:
- Multi-file write operations (PostToolUse detects)
- Git commit/push operations
- Team/agent spawning
- Topic shift detected by embeddings
- Post-compaction

Does NOT fire mid-operation (reconsolidation trap). Inject at the decision point, not during execution.

**First-encounter gate:** Track which rule domains have appeared in the session. On first appearance of a domain (e.g., first bash tool call -> inject bash safety rules), inject relevant rules regardless of TTL. After first encounter, fall back to decay/activity triggers.

### 3. Token Budget: 200-300 Tokens

- Per-injection: 200-300 tokens (hard cap)
- Separate from proven principles (500 cap) and experience patterns (500 cap)
- Combined every-turn max: 800 tokens (proven principles + critical reminders when both fire)
- Budget scaling: same `scaleBudget()` logic as other sections

### 4. Content Format: Minimal + Varied

Phrasing varies across injections to defeat habituation. Rule database stores semantic rule_text; a `variants` JSON column stores 3-4 pre-authored surface form templates per rule. Renderer rotates through variants deterministically (injection_count mod variant_count). No LLM call required.

No meta-instructions in injected content. "Verify before done", "check your work", etc. are enforced by hooks (deterministic checks), not prompts (ceremonial compliance anti-pattern #4).

### 5. Assembly Cascade Placement: Priority 4a.5

In `assembleRegularPrompt`, the priority structure is:
- 4a: Proven principles (always-inject, 500 token cap, every turn)
- **4a.5: Critical Reminders (conditional — fires when trigger condition met)**
- 4b: Intent-triggered patterns (categorical)
- 4c: Reactive FTS5+vector warnings

Critical reminders have a different firing cadence from proven principles (conditional vs. unconditional). They must not be in the same conditional block — the assembler handles them as a separate priority level.

### 6. Turn Number Tracking

Derived from `conversation_turns` count per session. No new column needed — already persisted by the split-write pattern (UserPromptSubmit creates row with user_text, Stop completes with assistant_text).

### 7. Stop Hook Enforcement (Meta-Rules)

Two deterministic behavioral checks as non-blocking `systemMessage` warnings:
1. **Read before editing:** Check `session_events` for Read tool call before Edit on same file
2. **Run tests before done:** Check for Bash tool calls containing test/vitest keywords

Uses existing `runHookStep` infrastructure. Output as `systemMessage` (same pattern as build gate warning and idle warning). Non-blocking — warnings only, not blocks.

---

## Integration Points

### UserPromptSubmit (`src/adapters/cc-hooks/user-prompt-submit.ts`)

New function: `assembleCriticalReminders(db, sessionId, turnNumber, currentToolContext, topicKey)`

Returns: `{ section: string, tokenCost: number, injectedRuleIds: string[], applyEffects: () => void }`

Called after experience pattern assembly, before final payload construction. Side effects (update per-rule turn counters, log injection events) deferred to `applyEffects()` — committed only when payload survives budget check. Same deferred-effects pattern as `renderExperienceWarnings()`.

Inputs available in hook scope:
- `db` — from `ctx.db`
- `sessionId` — from `input.session_id`
- `turnNumber` — derived from `conversation_turns` count
- `currentToolContext` — from experience flags `pending_trigger_domains`
- `topicKey` — from `thread_state` via `getThreadState()`

### PostToolUse (`src/adapters/cc-hooks/post-tool-use.ts`)

Two new responsibilities:

1. **Activity gate flagging:** When multi-file edits, git operations, or agent spawning detected, set flag in experience_flags. New field: `critical_activity_gate: boolean`. The existing `setExperienceFlags` mechanism works. PostToolUse already detects workflow phases at lines 181-206 — extend this block.

2. **First-encounter tracking:** Track seen tool domains per session. New field: `seen_rule_domains: string[]`. On each tool call, extract domain (bash, git, edit, agent, etc.) and append to set if not already present.

### Stop Hook (`src/adapters/cc-hooks/stop.ts`)

New `runHookStep` entries for deterministic meta-rule enforcement:

1. `read_before_edit_check` — query `session_events` for Edit events without prior Read on same file path
2. `tests_before_done_check` — query `session_events` for Bash events containing test/vitest keywords

Output via `systemMessage` warnings appended to existing `warnings` array (lines 592-593).

### Assembler (`src/assembly/assembler.ts`)

New priority level 4a.5 in `assembleRegularPrompt` (between proven principles at 4a and intent-triggered patterns at 4b). The critical reminders block:
1. Reads trigger state (decay expired? activity gate set? first-encounter domain?)
2. If any trigger fires: scores rules against current context
3. Selects top 3-5 most relevant rules
4. Renders with phrasing variation
5. Caps at 300 tokens
6. Returns with deferred `applyEffects`

### Schema (`src/core/schema.ts` + `src/core/migration-steps.ts`)

New `critical_rules` table:

```sql
CREATE TABLE IF NOT EXISTS critical_rules (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  variants TEXT,                    -- JSON array of 3-4 surface form templates
  source TEXT NOT NULL,             -- 'author' or 'system-promoted'
  drift_risk TEXT NOT NULL,         -- 'safety', 'working-method', 'style'
  domain_tags TEXT,                 -- JSON array: ['bash', 'git', 'multi-file', 'team']
  base_ttl INTEGER NOT NULL,       -- turns before re-injection
  current_ttl INTEGER,             -- adjusted by compliance/violation
  last_injected_turn INTEGER,
  injection_count INTEGER DEFAULT 0,
  violation_count INTEGER DEFAULT 0,
  compliance_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Additive migration — no destructive changes. Added as part of existing migration chain.

---

## Implementation Decomposition (8 Work Units)

### WU1: Schema + Migration
- DDL for `critical_rules` table
- Migration step in `migration-steps.ts`
- Index on `(project, source)` for efficient queries

### WU2: CLAUDE.md Marker Parser
- Parse `<!-- critical -->` markers from global + project CLAUDE.md files
- Extract rule text, infer drift_risk and domain_tags from content
- Upsert into `critical_rules` with source='author'
- Called at session-start

### WU3: System Promotion Bridge
- Query `capability_tracker` for domains with correction_rate >= 30% and >= 5 interactions
- Map domains to experience patterns with high harmful_count
- Auto-insert into `critical_rules` with source='system-promoted'
- Promotion cap: max 10 system-promoted rules
- Demotion: correction_rate < 15% -> remove from critical_rules
- Runs at session-start after marker parsing

### WU4: Decay Engine (TTL + Jitter)
- `shouldInjectRule(db, ruleId, sessionId, turnNumber) -> boolean`
- Per-rule TTL tracking: `last_injected_turn` + `current_ttl`
- Jitter applied per drift_risk tier
- Leitner advance on compliance evidence (extend current_ttl)
- Leitner reset on violation evidence (reset current_ttl to base_ttl minimum)

### WU5: Activity Gate + First-Encounter Gate
- PostToolUse: set `critical_activity_gate` flag on multi-file/git/agent/topic-shift detection
- PostToolUse: track `seen_rule_domains` per session
- UserPromptSubmit: read flags, determine which rules to force-inject
- Clear `critical_activity_gate` after consumption

### WU6: Phrasing Variation Renderer
- `renderRuleVariant(rule, injectionCount) -> string`
- Select variant by `injection_count % variants.length`
- Fallback to `rule_text` if no variants defined
- Token estimation per rendered variant

### WU7: `assembleCriticalReminders()` + Cascade Integration
- Core assembly function in new `src/intelligence/critical-reminders.ts`
- Score rules against current context (domain match, TTL expired, activity gate, first-encounter)
- Select top 3-5 most relevant rules
- Render with phrasing variation (WU6)
- Cap at 300 tokens
- Integrate at priority 4a.5 in `assembleRegularPrompt`
- Deferred `applyEffects` pattern

### WU8: Stop Hook Deterministic Enforcement
- `read_before_edit_check` runHookStep
- `tests_before_done_check` runHookStep
- Query `session_events` for behavioral proxies
- Output as systemMessage warnings

---

## Risk Mitigation

### Feedback Loop (Medium Risk)
System promotion bridge could create: rule promoted -> injected more -> more corrections -> higher rate -> more injection. Mitigated by:
- Promotion cap (max 10 system-promoted rules)
- Demotion mechanism (correction_rate < 15% -> demote)
- Compliance evidence extends TTL (reduces injection frequency)

### Phrasing Drift (Medium Risk)
Varied phrasings could semantically drift from original rule. Mitigated by:
- Pre-authored templates (not generated)
- Author reviews variants at creation time
- Fallback to canonical rule_text

### Budget Creep (Low Risk)
Critical reminders + proven principles could exceed combined budget. Mitigated by:
- Hard cap: 300 tokens per critical reminders injection
- Combined max: 800 tokens (proven principles 500 + critical reminders 300)
- Same `scaleBudget()` logic as other sections

---

## Success Criteria (from spec)

1. Rules marked `<!-- critical -->` in CLAUDE.md are re-injected at phase transitions
2. No single injection exceeds 300 tokens
3. Variable timing -- no two consecutive injections at same interval
4. First-encounter gating works (bash safety only appears on first bash call)
5. Meta-instructions enforced by hooks, not by prompt injection
6. Lacuna-scenario prevention: agent that starts building without approval gets reminded BEFORE the first write tool call, not 20 turns later

---

## Files Touched

**Modified (6):**
- `src/core/schema.ts` — critical_rules DDL
- `src/core/migration-steps.ts` — migration step
- `src/adapters/cc-hooks/user-prompt-submit.ts` — assembleCriticalReminders call
- `src/adapters/cc-hooks/post-tool-use.ts` — activity gate + first-encounter flags
- `src/adapters/cc-hooks/stop.ts` — deterministic meta-rule enforcement
- `src/assembly/assembler.ts` — priority 4a.5 in assembleRegularPrompt

**New (2):**
- `src/intelligence/critical-reminders.ts` — decay engine, assembly function, promotion bridge
- `src/intelligence/critical-reminders.test.ts` — tests for all trigger conditions and budget limits

**Optionally touched:**
- `src/adapters/cc-hooks/session-start.ts` — CLAUDE.md marker parsing + seeding at session start
- `src/intelligence/experience-flags.ts` — new fields (critical_activity_gate, seen_rule_domains)
