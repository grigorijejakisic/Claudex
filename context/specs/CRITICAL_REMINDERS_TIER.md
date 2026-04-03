# Spec: Critical Reminders Injection Tier

> Status: APPROVED (design discussion 2026-04-03, session 44)
> Research: `context/research/STREET_KNOWLEDGE_CRITICAL_REMINDERS.md` (5-layer, ~250 sources)
> Constraint on: Token Optimization phases of auto-orchestrate

## Problem

Rules injected at session start decay from effective attention as conversation grows. Proven by:
- Lacuna Betting session 3: agent saw all CLAUDE.md rules at turn 1, violated every one by turn 10
- Dongre et al.: drift stabilizes at non-zero equilibrium D* without intervention
- "Lost in the Middle" (TACL 2024): 30%+ accuracy loss on middle-positioned information
- Ceremonial compliance: meta-instructions ("verify before done") degrade into false claims

Current Claudex assembly has NO reinforcement between session start and compaction for CLAUDE.md rules. The "Rules Reminder" section only fires post-compaction. Proven principles (500 token cap, every turn) draw from experience patterns, not CLAUDE.md behavioral rules.

## Design

### New Assembly Section: Critical Reminders

A compact, distilled block of behavioral rules injected into `<system-reminder>` tags in UserPromptSubmit hook output. Placed at END of additionalContext (recency position).

### Rule Selection: Hybrid (Author + System)

**Author-marked baseline**: CLAUDE.md rules tagged with `<!-- critical -->` markers. These form the static rule pool.

**System-promoted**: Rules that experience patterns show get violated are auto-promoted to the critical pool. The experience pattern system already tracks violation frequency — rules with high correction rates bubble up.

**Per-injection scoping**: Not all critical rules every time. DRIFT approach: score rules against current action context, inject only the top 3-5 most relevant. Max 200-300 tokens per injection.

### Injection Triggers: Decay + Activity-Gated + Variable

Three trigger conditions (any one fires injection):

**1. Decay trigger (variable-interval)**
- Track turns since last injection per-rule
- Each rule has a TTL based on drift risk:
  - **Safety rules** (deadlock, scope lock, verify-before-done): TTL = 5-8 turns + random jitter ±2
  - **Working method rules** (systematic, analysis-first): TTL = 8-12 turns + jitter ±3
  - **Style rules** (concise, no narration): TTL = 15-25 turns + jitter ±5
- Jitter prevents fixed-interval scalloping (Skinner, Layer 4)
- On compliance evidence: extend TTL (Leitner advance)
- On violation evidence: reset TTL to minimum (Leitner reset)

**2. Activity gate (phase-transition)**
- Fires BEFORE these actions regardless of decay state:
  - Multi-file write operations (PreToolUse can detect)
  - Git commit/push operations
  - Team/agent spawning
  - Topic shift detected by embeddings (existing system)
  - Post-compaction (already exists, but add critical reminders to it)
- Does NOT fire mid-operation (reconsolidation trap, Layer 4)
- The key: inject at the decision point, not during execution

**3. First-encounter gate**
- Track which rule domains have appeared in the session
- On first appearance of a domain (e.g., first bash tool call → inject bash safety rules), inject relevant rules regardless of TTL
- After first encounter, fall back to decay/activity triggers

### Content Format: Minimal + Varied

```
## Critical Reminders
- [Rule 1 — most relevant to current context]
- [Rule 2]
- [Rule 3]
```

**Vary the phrasing** across injections to defeat habituation. Don't repeat identical text. The rule database stores the semantic rule; the renderer produces varied surface forms.

**Never include meta-instructions** that require self-monitoring ("verify before done", "check your work"). These degrade into ceremonial compliance. They MUST be enforced by hooks (PostToolUse, Stop hook) via deterministic checks.

### Token Budget

- **Per-injection**: 200-300 tokens (hard cap)
- **Separate from** proven principles (500 cap) and experience patterns (500 cap)
- **Combined every-turn max**: 800 tokens (proven principles + critical reminders when both fire)
- **Budget scaling**: same scaleBudget() logic as other sections

### Integration Points

**UserPromptSubmit hook** (`user-prompt-submit.ts`):
- After experience pattern assembly, before final payload construction
- New function: `assembleCriticalReminders(db, sessionId, turnNumber, currentToolContext, topicKey)`
- Returns: `{ section: string, tokenCost: number, injectedRuleIds: string[], applyEffects: () => void }`
- Side effects (deferred): update per-rule turn counters, log injection events

**PostToolUse hook** (`post-tool-use.ts`):
- Activity gate detection: flag high-risk tool calls for next-turn injection
- First-encounter detection: track seen tool domains per session
- Compliance signal detection: behavioral proxies in tool output

**Assembly cascade** (`assembler.ts`):
- New priority level between proven principles (4a) and intent-triggered patterns (4b)
- Priority 4a.5: Critical Reminders
- Only fires when a trigger condition is met (not every turn)
- Respects the "zero injection default" — most turns inject nothing

**Stop hook** (`stop.ts`):
- Deterministic enforcement of meta-rules (verify-before-done)
- Not prompt-based — check actual tool usage, test execution, etc.

### Rule Database

New table or extension to existing patterns:

```sql
CREATE TABLE critical_rules (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  rule_text TEXT NOT NULL,          -- semantic content
  source TEXT NOT NULL,             -- 'author' or 'system-promoted'
  drift_risk TEXT NOT NULL,         -- 'safety', 'working-method', 'style'
  domain_tags TEXT,                 -- JSON array: ['bash', 'git', 'multi-file', 'team']
  base_ttl INTEGER NOT NULL,       -- turns before re-injection
  current_ttl INTEGER,             -- adjusted by compliance/violation
  last_injected_turn INTEGER,
  injection_count INTEGER DEFAULT 0,
  violation_count INTEGER DEFAULT 0,
  compliance_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### PID-Inspired Drift Signal (Future Enhancement)

For V2, implement a composite drift signal:
- P: current turn's behavioral proxy (tool call patterns, output structure)
- I: accumulated drift across N turns (violation count trending up)
- D: drift velocity (rate of change in compliance)

Signal = P × α + I × β - D × γ

When signal > threshold → trigger injection regardless of TTL state.

This is a future enhancement. V1 uses simpler TTL + activity gates.

## What This Spec Does NOT Cover

- Full CLAUDE.md re-injection (handled by existing Rules Reminder post-compaction)
- Proven principles injection (unchanged, continues as-is)
- Experience pattern injection (unchanged, continues as-is)
- Contradiction detection in CLAUDE.md (separate concern, flagged for future)
- Model-level steering vectors (frontier, not available for hosted API)

## Success Criteria

1. Rules marked `<!-- critical -->` in CLAUDE.md are re-injected at phase transitions
2. No single injection exceeds 300 tokens
3. Variable timing — no two consecutive injections at same interval
4. First-encounter gating works (bash safety only appears on first bash call)
5. Meta-instructions enforced by hooks, not by prompt injection
6. Lacuna-scenario prevention: agent that starts building without approval gets reminded BEFORE the first write tool call, not 20 turns later

## Research Attribution

This spec is grounded in 5-layer street knowledge research:
- Full report: `context/research/STREET_KNOWLEDGE_CRITICAL_REMINDERS.md`
- Key papers: Dongre et al. (drift equilibria), Du et al. (length hurts beyond retrieval), Jaroslawicz et al. (instruction density), Liu et al. (lost in the middle)
- Key cross-domain: Skinner (variable-interval), Rasmussen (practical drift), reconsolidation timing, watchdog timers
