# v5 Episodic Memory — Research + Architecture Discussion

**Date:** 2026-04-30
**Status:** Discussion-stage (pre-roadmap)
**Origin:** Mid-pipeline conversation during Phase 9–10 auto-orchestrate run; user's PC crashed earlier same session, surfacing the architectural gap this document captures.
**Intent:** Capture the v5 design conversation + supporting research while context is fresh, so it's revisitable when v4 closes (post-Phase 11) and v5 milestone planning begins.

---

## Why this exists

v4 closes the gap between "agent has memory tools" and "agent uses memory tools organically." It does not close the gap between "agent uses memory tools" and "agent's memory survives the agent's death." When the user's PC crashed earlier this session, no V4 work was lost (atomic per-phase commits) but session-level synthesis (mid-thought decisions, conversational reasoning) WOULD have been lost if the crash had hit before `/endsession`. v5 is the architectural reach for that gap.

The user named the architecture: **"Angel Evolution."** Angel is already a persistent guardian process (extracts patterns, forms opinions, monitors sessions, indexes cross-agent work). Angel today is the *seed* of an episodic memory layer; v5 grows it into the full layer.

---

## Conversation context that led here

1. User asked whether `/starthere` and `/endsession` could be auto-fired in v4/v5 instead of remaining user-invoked slash commands.
2. Initial agent answer: keep slash commands, add hook-based auto-fire for mechanical parts. *(Adequate but missed the deeper move.)*
3. User refined: proposed file-based protocols (CLAUDE.md as a pointer manifest, project-level CLAUDE.md as the rules-of-engagement file referencing protocol files). Lean, editable, version-controlled with project.
4. Agent refined: file-based architecture is structurally good, but only works if hooks INLINE the file body (not just point to it). Hook-as-inliner makes file-based delivery structurally identical to slash-command body delivery — same forcing function, same in-context imperative voice.
5. User clarified: the deeper proposal isn't slash-command refactoring, it's an **external synthesizer process**. A long-lived MCP/Angel-class process that captures the full conversation transcript in real-time, watches for session-end-by-any-means (clean, ctrl+c, OOM, PC crash), and runs the equivalent of `/endsession` post-hoc on the captured transcript from outside any single agent's context window. Agent aliveness becomes irrelevant to memory persistence.
6. Agent recognized this as the missing **episodic memory layer** distinct from working memory (context window) and long-term memory (Claudex DB extracted facts).
7. Research agent dispatched in parallel to survey real-world systems and patterns.
8. Findings below validate the architecture and surface concrete failure modes to defend against.

---

## Architectural distinctions established (from the discussion)

These are the load-bearing distinctions to remember; they shape every implementation choice downstream.

### 1. Hook-as-inliner vs hook-as-pointer
- **Wrong:** Hook injects `<system-reminder>READ X.md NOW</system-reminder>`. Agent has to recognize → Read → parse → follow. Three drift points. Equivalent to passive injection — the failure mode named by `feedback_max_subscription.md` (file existed, was injected, agent didn't read it; surfaced 202 times).
- **Right:** Hook reads the file, **inlines the full body** as a `<system-reminder>` payload. Agent sees imperative protocol body in-context, identical to what happens when a user types a slash command. One step, structurally enforced.
- **Storage choice (skill vs file) is downstream of delivery mechanism (inlined vs pointed-at).** The real axis is delivery, not storage. Inlined wins.

### 2. Slash commands vs file-based protocols
- **Slash command** = user-triggered → body inlined → agent follows. Forcing function depends on user typing.
- **File-based + hook-inlined** = hook-triggered → body inlined → agent follows. Forcing function depends on hook firing correctly (deterministic, fixable).
- **File-based + hook-pointed** = hook-triggered → pointer injected → agent should-but-might-not read. Inherits the v3 drift pattern. Avoid.
- **Best practice for v5:** all three invocation paths converge on the same canonical body inlined as `<system-reminder>`. Three triggers, one body, one delivery mechanism.

### 3. In-session synthesis vs post-hoc external synthesis
- **In-session** = agent runs `/endsession` while alive. Quality high (lived the session). Reliability low (depends on agent surviving + having budget).
- **Post-hoc external** = synthesizer process reads completed transcript after session ends. Reliability high (independent of agent lifetime). Quality lower than in-session because synthesizer didn't live the session — has to reconstruct intent from text.
- **Production design implication:** capture both. Raw transcript persists always. Agent leaves "I think this matters" breadcrumbs while alive. External synthesizer prefers in-session breadcrumbs when present, falls back to inferring from transcript when not.

### 4. The "external brain" framing as cognition externalization
- LLM agents have working memory (context, bounded) and long-term memory (DB, structured). They are missing **episodic memory** — records of actual conversation events, not selectively synthesized facts.
- v5 builds the missing layer. From the agent's perspective: "self" lives partly outside the context window. From the system's perspective: agent instances are interchangeable; episodic continuity belongs to the system, not the agent.
- The arxiv paper "Externalization in LLM Agents" (2604.08224, April 2026) frames agent capability progression as "moving cognitive burdens out of the context window into runtime infrastructure." This is the academic grounding for the architecture.

---

## Real-world systems landscape (research findings)

### Mem0 — passive extraction, "facts only" (cautionary tale)
Sits on top of an agent, runs extraction pipeline on `add()` calls. **Critical flaw documented in [mem0#4573](https://github.com/mem0ai/mem0/issues/4573):** user audited 10,134 entries over 32 days, 97.8% were junk. The "Vim infestation": a 2B model hallucinated "User prefers Vim" once, it entered storage, was recalled into the next session, was re-extracted as ground truth, and ballooned to **808 entries asserting a false preference**. Root cause: extraction model has no signal that it is reading prior memory vs. new turn. Issue [#3009](https://github.com/mem0ai/mem0/issues/3009) reports memory creation **fails ~80% of the time** silently. Direct lesson for v5: tag recalled items as `source: recall` in context; synthesis prompt must explicitly skip them when extracting new facts. Add a REJECT action alongside ADD/UPDATE/DELETE.

### Letta / MemGPT — agent-managed memory tiers
Memory split into Core (RAM/context), Recall (searchable history outside context), Archival (tool-queried). Agent self-edits memory mid-reasoning. Tradeoff: every self-edit breaks prompt caching; quality depends entirely on model judgment; weaker/local models struggle. [vectorize.io 2026 comparison](https://vectorize.io/articles/mem0-vs-letta) recommends "if you need memory in production by next quarter, start elsewhere." Lesson: avoid agent-self-managed memory tiers; system manages, agent queries.

### A-MEM — Zettelkasten agentic memory
[arxiv 2502.12110](https://arxiv.org/abs/2502.12110). When memory added, system generates structured note (description, keywords, tags), analyzes historical memories to form *links* with similar notes, updates existing notes when new ones provide context. 2x better multi-hop performance than baseline. **First widely-cited system to treat memory consolidation as first-class graph operation, not just embedding+ANN.** Still operates on extracted notes, not raw transcripts.

### ChatGPT memory — the "bitter lesson" approach
Multiple reverse-engineering write-ups ([llmrefs.com](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory), [Khemani](https://www.shloked.com/writing/chatgpt-memory-bitter-lesson)) converge: **explicit user-confirmed facts** + **lightweight cross-chat interest map** + **per-session recent-conversation summaries**. Notably does NOT use RAG/vector search over full transcripts. Lesson: deliberate, user-confirmed storage beats aggressive auto-extraction. Don't auto-extract what wasn't confirmed.

### Cognition Devin — Snapshots + Knowledge
[Cognition's blog](https://cognition.ai/blog/devin-annual-performance-review-2025): Snapshots = VM-state save points, Knowledge = curated tips/docs auto-recalled. Recently moved sessions from "end after inactivity" to "sleep and resume." Closer to VM-checkpointing than episodic memory in cognitive sense. Doesn't retain raw transcripts as primary store.

### claude-mem (closest comparable to Claudex)
[thedotmack/claude-mem, 46K stars](https://github.com/thedotmack/claude-mem). Built around the same five Claude Code lifecycle hooks Claudex uses. Captures **tool-use observations, not full transcripts**. Compresses at SessionEnd via worker on port 37777. **README is silent on crash handling** — ties compression to the SessionEnd hook, which (see below) fails on most abnormal exit paths. **This is the architectural gap a v5 episodic layer should explicitly close.** Claudex v5 has the opportunity to ship what claude-mem and every other comparable system is missing.

### Stanford Generative Agents (the academic touchstone)
[arxiv 2304.03442](https://arxiv.org/pdf/2304.03442). Memory stream + reflection architecture: every observation appended to immutable stream in natural language, retrieval is `recency × importance × relevance`, separate **reflection pass** synthesizes higher-level abstractions and writes them back. **Ablation result is load-bearing: removing reflection alone collapsed believability scores below human roleplay.** Direct empirical evidence that episodic capture + post-hoc synthesis is qualitatively different from synthesize-as-you-go. **Validates the entire v5 thesis.**

---

## Session-end detection — the hard finding

**Claude Code's `SessionEnd` hook is unreliable.** Multiple GitHub issues prove this:
- [#17885](https://github.com/anthropics/claude-code/issues/17885), [#35892](https://github.com/anthropics/claude-code/issues/35892): doesn't fire on `/exit`
- [#6428](https://github.com/anthropics/claude-code/issues/6428): doesn't fire on `/clear` despite docs claiming
- [#20197](https://github.com/anthropics/claude-code/issues/20197): doesn't fire on API 500 errors
- [#16047](https://github.com/anthropics/claude-code/issues/16047): hooks stop after ~2.5 hours
- [#29881](https://github.com/anthropics/claude-code/issues/29881): Stop hook doesn't fire when Claude stalls mid-turn
- [#54130](https://github.com/anthropics/claude-code/issues/54130): zombie subprocesses corrupt JSONL
- [#53417](https://github.com/anthropics/claude-code/issues/53417): version upgrades silently kill JSONL writes

**The user's intuition that hook reliability is a real concern is empirically validated.** v5 cannot rely on `SessionEnd` for any load-bearing state.

**The fix (validated across watchdog/heartbeat literature):** multi-modal external detection in the long-lived guardian.
1. **fsnotify on the JSONL directory** — every write updates `last_activity` timestamp in DB. Watch parent dir not files (atomic-write tools rename).
2. **Heartbeat row from session itself** — UserPromptSubmit/PreToolUse/PostToolUse hooks UPDATE `session.last_heartbeat`. Guardian decides death from outside.
3. **Idle-timeout sweep** — guardian polls; sessions with no JSONL writes for &gt; T → `dormant` → `terminated` after grace window. **Only path that survives PC-reboot, OOM-kill, hard ctrl-c, segfault.**
4. **PID-file with stale detection** — combine with heartbeat. Aliveness = `(PID exists) AND (heartbeat updated within window) AND (JSONL had write within window)`.
5. **Compare lastHeartbeat before cleanup** — exact pattern Claude Code team adopted in their cleanup.sh. Avoids the "Session Amnesia" failure mode where orphan-detection deletes legitimate live state.

---

## Event sourcing maps cleanly to episodic memory

| Event sourcing | v5 episodic memory |
|---|---|
| Append-only log of immutable events | Raw transcript JSONL captured by guardian |
| Snapshot pattern | Synthesized session summaries (decisions/learnings/patterns) |
| Projections / read models | Materialized views by topic, entity, FTS, vector index |
| Replay to rebuild projections | Re-synthesize summaries when prompt template improves |
| Schema versioning + upcasters | Transcript schema evolution |
| Idempotent event handlers | Synthesis must be idempotent — guardian *will* re-process under retry |

**Key anti-pattern flagged by event-sourcing literature: "Property Sourcing".** Recording `Read(file=foo.ts)` is property-sourced and useless. Record `Investigated('reranker fallback root cause')` with intent. Capture **agent actions with intent**, not raw tool calls. Claudex partially does this with experience patterns — extend to episodic events.

**Other lessons:**
- Snapshots are a smell of poor stream boundaries — maybe a 6-hour session is two episodes. Per-task / per-feature episode boundaries triggered by detectable transitions (commit, deploy, /endsession) may be the right unit.
- Projection rebuild must work without downtime (blue-green: build new projection table, swap atomically).
- Idempotent handlers + dedup via deterministic event IDs (e.g., `session_id + msg_offset`).

---

## Game AI lessons (F.E.A.R.)

[Three States and a Plan](https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf) — Orkin, GDC 2006. Each AI maintains **WorkingMemory** of typed facts (with confidence + recency). Actions have preconditions/effects against this memory. Lesson: **typed structured beliefs with explicit recency outperform free-text recall** for action selection. v5 implication: synthesize typed structures (`decision`, `learning`, `pattern`, `correction`, `unresolved_question`) each with `confidence × recency × source_session × scope`. Claudex already has this layer — keep it, layer raw transcript *underneath*, not in place of.

**Don't tie memory to a tick loop.** Game NPCs synthesize at 60Hz; LLM agents shouldn't — synthesis is expensive, post-hoc-after-session-end is correct.

---

## Direct architectural recommendations for v5

1. **Angel guardian is the source of truth for session-end detection.** Do not rely on `SessionEnd` hooks for load-bearing state. Combine fsnotify + heartbeat row + idle-timeout sweep + PID liveness with heartbeat-compare-before-cleanup.

2. **Capture raw transcripts append-only; synthesis is a projection.** Raw JSONL = event log. Decisions/learnings/patterns = projections. Prompt-improvement → projection-rebuild trivial. Deletion is cascade-clean. **Never iterate synthesis on synthesis** — always re-synthesize from raw to defend against drift.

3. **Defend explicitly against the Mem0 feedback loop.** Tag recalled items `source: recall`. Synthesis prompt explicitly skips them when extracting new facts. Quality gate (small classifier or LLM judge) between extraction and storage. Add REJECT action alongside ADD/UPDATE/DELETE/NONE. None of these are speculative — Mem0's audit author named exactly these as the missing fixes.

4. **Synthesize typed structures, not just prose** (F.E.A.R.). Claudex already does this for the long-term layer; keep it, layer raw transcript underneath, not in place of. Both layers serve different queries.

5. **Privacy is structural, not bolted on.** Every event row gets `scope` (`private | project | global`) and `retention_class` (`ephemeral | session | promoted | permanent`) at write time. Cascaded deletion is first-class. Real-time PII redaction beats post-hoc; if you can't do real-time, raw-transcript capture is OFF by default and explicitly opted into (separately from extracted-facts opt-in). DPIA before shipping.

6. **All protocol invocation paths converge on inlined body delivery.** Slash command, hook trigger, and recognition heuristic each load the same canonical body as `<system-reminder>` payload. Three triggers, one body, one delivery mechanism. The "agent forgets to read the pointer" failure mode disappears.

7. **Capture in-session breadcrumbs as well as transcripts.** Andy-Matuschak-style: externalized memory only works when the act of writing-to-it is itself thinking-restructuring. Synthesizer prefers in-session breadcrumbs ("I think this matters") when present; falls back to transcript inference when not. Both layers complement; neither replaces the other.

8. **Push critical episodic surfacing into the assembly pipeline (system-reminder injection), not into a tool the agent has to remember to call.** HN production observation: agents under-invoke retrieval tools. The Claudex assembly pipeline already does this for facts; extend to episodic surfacing.

---

## Proposed v5 phasing (sketch)

| Phase | Scope | Risk |
|---|---|---|
| **v5.1 — Hook-as-inliner pattern** | Refactor `/starthere` and `/endsession` skill bodies into files; hooks inline body as system-reminder; slash commands stay as override. The "easy" architectural win. | Low. Mostly mechanical. |
| **v5.2 — Session-end-detector** | Angel module: fsnotify + heartbeat + idle-timeout + PID-liveness. Detection only, no synthesizer yet — observability validates trigger heuristics across all termination paths. | Medium. The trigger reliability is the foundation; if this doesn't work, nothing downstream works. |
| **v5.3 — Post-hoc synthesizer (degraded)** | Synthesizer runs ONLY on sessions that didn't have clean `/endsession`. Output is conservative — writes "session interrupted at decision X; resume here" handoffs. Doesn't try to be heroic. | Medium-high. Synthesis quality from transcript-only is the unknown. Conservative output mitigates risk. |
| **v5.4 — Post-hoc synthesizer (full)** | Once degraded path proves stable: cross-session pattern extraction, lessons promotion, curated context proposals from full transcripts. | High. This is where field-validated failure modes (Mem0 feedback loop, drift, staleness) hit hardest. The 5 defenses above are non-optional. |
| **v5.5 — Episodic memory retrieval surface** | New retrieval channel: agent can fetch the actual transcript turn where X was discussed, not just the synthesized fact. Targets the in-session vs post-hoc quality gap (when synthesis lost fidelity, raw is available). | Medium. Adds query surface complexity; tradeoff between episodic fidelity and token cost. |

**Sequence rationale:** detection before synthesis (foundation first); degraded before full (conservative output validates substrate); episodic retrieval last (depends on stable raw-transcript storage).

---

## Open questions to resolve before locking v5 scope

1. **Concrete head-to-head: in-session vs post-hoc synthesis quality.** No published benchmark. Generative Agents proves "post-hoc reflection > no reflection"; nobody has cleanly compared "post-hoc by external agent" vs "in-session by same agent." This is a ~1-week ablation Claudex's Vesna probe suite (Phase 10) could run on itself. **Should be designed as a v5 verification probe upfront.**

2. **Episode boundary unit.** Per-session? Per-task? Per-commit? Per-feature? Game AI uses ticks; ChatGPT uses sessions; event sourcing literature warns "the session" may be the wrong unit. The "complete the books" pattern from event sourcing suggests sub-session episodes triggered by detectable transitions. Untested.

3. **Cost/latency at scale.** Average session ~50K tokens × 500 sessions per rebuild = 25M tokens. Local models (deepseek-coder-v2:16b already used for benchmarks) probably absorb this; Claude API needs a budget plan. Episodic-rebuild as a periodic operation has a real cost.

4. **Cross-project episodic recall scope.** Existing `__global__` vs project scope handles extracted facts. For raw transcripts, cross-project recall risks leaking project A context into project B replies. Need explicit consent model: does episodic ever cross project boundaries, and on what basis?

5. **In-session breadcrumb format.** What does the agent write? When? How does it not pollute the conversation? Andy Matuschak's "writing is thinking" principle says the breadcrumb itself should be useful synthesis work, not just a marker. Design space open.

6. **Privacy opt-in surface.** Raw transcripts vs extracted facts are different consent surfaces. UX for explaining the difference to users is non-trivial — most won't immediately grasp why one is more invasive than the other.

7. **What ChatGPT's session-summary infrastructure actually looks like.** Public reverse-engineering covers what gets injected, not how summaries are produced (post-hoc external worker? in-session agent?). The answer would directly inform our design but isn't in the public record. *(Treat as gap, not solvable from outside.)*

---

## Sources

**Production systems:**
- [Mem0 vs Letta (vectorize.io, 2026)](https://vectorize.io/articles/mem0-vs-letta)
- [Mem0 audit: 97.8% junk rate (#4573)](https://github.com/mem0ai/mem0/issues/4573)
- [Mem0 fact extraction failure (#3009)](https://github.com/mem0ai/mem0/issues/3009)
- [A-MEM paper (arxiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [Externalization in LLM Agents (arxiv 2604.08224)](https://arxiv.org/abs/2604.08224)
- [Generative Agents: Smallville (arxiv 2304.03442)](https://arxiv.org/pdf/2304.03442)
- [How ChatGPT Memory Works, Reverse Engineered (llmrefs.com)](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory)
- [ChatGPT Memory and the Bitter Lesson (Khemani)](https://www.shloked.com/writing/chatgpt-memory-bitter-lesson)
- [Cognition Devin 2025 Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025)
- [claude-mem GitHub (thedotmack)](https://github.com/thedotmack/claude-mem)

**Session-end detection / Claude Code reliability:**
- [SessionEnd doesn't fire on /exit (#17885)](https://github.com/anthropics/claude-code/issues/17885)
- [SessionEnd doesn't fire on API 500 (#20197)](https://github.com/anthropics/claude-code/issues/20197)
- [Zombie subprocesses corrupt JSONL (#54130)](https://github.com/anthropics/claude-code/issues/54130)
- [JSONL writer silent failure on upgrade (#53417)](https://github.com/anthropics/claude-code/issues/53417)
- [fsnotify cross-platform watcher](https://pkg.go.dev/github.com/fsnotify/fsnotify)
- [trbs/pid PID-file with stale detection](https://github.com/trbs/pid)
- [Kestra liveness/heartbeat post](https://kestra.io/blogs/2024-04-22-liveness-heartbeat)

**Event sourcing patterns:**
- [Event Sourcing Anti-Patterns (Chaos and Order, 2026)](https://www.youngju.dev/blog/architecture/2026-03-07-architecture-event-sourcing-cqrs-production-patterns.en)
- [Property Sourcing anti-pattern (event-driven.io)](https://event-driven.io/en/property-sourcing/)
- [Snapshots in Event Sourcing (Kurrent)](https://www.kurrent.io/blog/snapshots-in-event-sourcing)
- [Things I wish I knew with Event Sourcing (SoftwareMill)](https://softwaremill.com/things-i-wish-i-knew-when-i-started-with-event-sourcing-part-1/)

**Game AI:**
- [Three States and a Plan: F.E.A.R. AI (Orkin GDC 2006)](https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf)

**Privacy:**
- [Hamming AI PII redaction guide](https://hamming.ai/resources/pii-redaction-voice-agents-compliance-architecture-guide)
- [Sigma AI LLM privacy guide](https://sigma.ai/llm-privacy-security-phi-pii-best-practices/)

**Engineer reflections:**
- [Ask HN: Are we close to figuring out Agent Memory](https://news.ycombinator.com/item?id=47449389)
- [The Problem with AI Agent Memory (Dan Giannone)](https://medium.com/@DanGiannone/the-problem-with-ai-agent-memory-9d47924e7975)
- [Why I stopped putting LLMs in my agent memory retrieval path (Aarjay Singh)](https://dev.to/aarjay_singh_0f76e7ca03bf/why-i-stopped-putting-llms-in-my-agent-memory-retrieval-path-4bia)

---

## Capture metadata

- **Captured by:** Claude Opus 4.7 (1M context) during Phase 9–10 auto-orchestrate run
- **Conversation phase:** Mid-pipeline; v4 not yet shipped
- **Triggering event:** User's PC crashed earlier same session, surfacing the gap that crash-resilient memory addresses
- **Linked phases:** Phase 11 (final v4 validation) closes before v5 milestone planning starts; revisit this document at that boundary
- **Status convention:** This is research + discussion notes, NOT a roadmap commitment. v5 milestone planning will use this as input, not as locked scope.

---

## Next-step pointer for the agent reading this cold

When Phase 11 closes and you're about to start v5 milestone planning:
1. Read this document fully — discussion context matters as much as findings
2. Cross-reference with `.planning/STATE.md` and `.planning/ROADMAP.md` to see what v4 actually shipped vs what was scoped
3. Run a fresh `/street-knowledge` if &gt;2 weeks have passed — agent memory field moves fast
4. Use the 8 architectural recommendations as the v5 PROJECT.md skeleton
5. Use the 7 open questions to scope `/gsd:new-milestone` Q&A
6. Use the proposed v5.1–v5.5 phasing as the initial ROADMAP.md draft, but treat it as suggestion not mandate — milestone planning may resequence based on what v4 actually shipped
