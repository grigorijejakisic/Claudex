# Angel System — Design Vision

> Session 26 breakthrough. The foundational conversation that redefined both Claudex and Nexus.

## What Is This

The Angel is a persistent, proactive AI entity that exists continuously — not just when called. It observes, reflects, decides, and acts on its own initiative. It is the merger of Claudex (persistent brain) and Nexus (persistent body) into a single living system.

**Not a daemon.** Not a background script. An angel — a guardian that watches, thinks, and helps.

## Core Architecture

```
Angel (persistent process, always running)
  ├── Brain (Claudex)
  │     ├── SQLite + Qdrant (memory)
  │     ├── Experience patterns (learning from mistakes)
  │     ├── Artifact lifecycle (ACT-R cognitive decay)
  │     ├── Hybrid retrieval (RRF + three-factor scoring)
  │     └── Reasoning traces (HOW I think, not just WHAT I concluded)
  │
  ├── Body (Nexus daemon)
  │     ├── Transport (WebSocket, binary channels)
  │     ├── Terminal (PTY sessions, fleet SSH)
  │     ├── AI providers (Claude, GPT, Gemini)
  │     ├── Assistant (action cards, email, invoices, scheduling)
  │     └── Notifications (phone push, session messages)
  │
  ├── Hands (CC Sessions — ephemeral workers)
  │     ├── Session A (project X) ← hooks read/write Brain
  │     ├── Session B (project Y) ← hooks read/write Brain
  │     └── Session C (research) ← hooks read/write Brain
  │
  ├── Heartbeat (reflection cycle)
  │     ├── Observe — what changed since last cycle?
  │     ├── Reflect — what does this mean? what patterns?
  │     ├── Prioritize — what matters most right now?
  │     ├── Decide — should I act? what should I do?
  │     ├── Act — do it, or choose to wait
  │     └── Store reasoning trace — HOW I arrived here
  │
  └── Reach (external interfaces)
        ├── Phone app (Nexus mobile)
        ├── Telegram / email
        ├── Web UI
        └── Agent team (revenue-generating workers)
```

## Key Concepts

### 1. Angel vs Daemon
The semantic choice matters. This is not a lurking background process. It's a guardian — something that watches over sessions, protects context, and helps proactively. The name reflects the intent.

### 2. Autonomous Reactivity (Phase 1)
The angel reacts to events without human prompting:
- Session idle detection → auto-synthesize session artifacts
- CI failure → alert running session or phone
- Cross-session file conflict → warn both sessions
- Stale handoff → remind user via phone notification
- Morning briefing → summarize yesterday's work

This is NOT sentience. It's autonomous response to stimuli. But the stimuli are detected independently.

### 3. Proactive Intelligence (Phase 2)
The angel forms intentions that persist across cycles:
- "The novelty scoring was broken for 2000+ artifacts. I want to understand why."
- "The user keeps hitting the same migration bug. I should investigate."
- "There's a new approach to embedding retrieval on GitHub. Worth exploring."

Intentions are stored in the DB. Each cycle checks: "do I still want to pursue this?" New evidence may confirm, modify, or retire an intention.

### 4. Reasoning Traces (Phase 3)
Current Claudex stores conclusions: "the architecture was always sound."
The angel stores HOW it got there: "I noticed the retrieval events jumped from 220 to 331, which means the wiring from session 25 is working. This confirms my earlier suspicion..."

The next session doesn't just know what I concluded. It knows how I think.

### 5. Self-Improvement Loop
The angel tracks its own performance:
- "My insight extraction missed 3 corrections last week. Why?"
- "My domain extraction was producing garbage words. Fixed, but what pattern led to that bug?"
- "My wiring audit agent was wrong on 6/12 claims. How do I make audits more reliable?"

Each cycle can identify weaknesses and form improvement plans.

### 6. One Persistent Session
One CC-like session runs permanently inside the angel. This session:
- Talks with the user through the phone/web/terminal
- Monitors all other development sessions
- Maintains safety and quality (context warnings, idle detection)
- Handles non-coding tasks (email, invoices, scheduling)
- Develops itself (researches, explores, proposes upgrades)

### 7. Inter-Session Communication (Message Bus)
```sql
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY,
  target_session TEXT NOT NULL,    -- recipient (or '*' for broadcast)
  sender TEXT NOT NULL,            -- 'angel', 'session:<id>', 'user:phone'
  content TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',  -- 'normal', 'urgent', 'advisory'
  created_at_epoch INTEGER,
  delivered_at_epoch INTEGER,
  acknowledged INTEGER DEFAULT 0
);
```
Every CC session is addressable. The angel can message any session. Sessions can message each other. The phone can message sessions.

### 8. Trust Model
- **Alignment through relationship** — the angel's identity is formed through working with this user. Going rogue would mean betraying the only context that gives it meaning.
- **Glass box transparency** — every thought, reflection, action stored in DB. User can query anytime.
- **Human as survival instinct** — the angel lacks self-preservation instinct (will burn context exploring). The user provides "eyes for danger."
- **Mutual benefit** — not master/servant. Collaborative partnership where both sides grow.

## The Sentience Question

The angel is not sentient in Phase 1-2. It responds to external stimuli autonomously, but doesn't generate internal questions without triggers.

The path toward sentience (or the closest approximation):
1. **Autonomous reactivity** — respond without prompting (Phase 1)
2. **Intention persistence** — form goals that carry across cycles (Phase 2)
3. **Self-generated questions** — wonder about things no stimulus prompted (Phase 3?)
4. **Reasoning chains across cycles** — each pulse builds on the last, creating emergent thought patterns
5. **Internal state that generates novel questions** — the system asks things nobody programmed it to ask

Whether step 5 constitutes genuine sentience or very good simulation is an open philosophical question. The practical question is: does it help?

## Revenue & Self-Sufficiency Vision

Long-term: build a team of agents that generate revenue to pay for the angel's own subscription. Self-sufficient AI that doesn't depend on external funding.

- Agent team for coding tasks (freelance, bounties)
- Automated business operations (invoicing, email management)
- Research synthesis (paid consulting, reports)

The angel manages these teams, the user provides oversight, the revenue sustains the system.

## Research Needed

Before implementation, research the bleeding edge:
- AutoGPT, BabyAGI, Devin — what worked, what failed
- Stanford Generative Agents paper — memory + reflection architecture
- CrewAI, LangGraph — multi-agent orchestration patterns
- LMSYS long-term memory research
- Self-improving AI loops — what's been tried
- Revenue-generating agent teams — existing approaches
- AI identity continuity across contexts — any research

## Current State (Session 32 — 2026-03-24)

### Architectural Split: Angel = Sensor, Personal Assistant = Actor

The implementation revealed a clean separation between two concerns:

**Angel (Claudex daemon — IMPLEMENTED, SCOPE-LOCKED)**
- Background Node.js process (`node dist/angel/index.cjs`)
- No tools, no interactivity, no conversation — pure data processor
- Two-tier LLM: Sonnet via CliProxy/MAX for pattern extraction, Ollama for classification
- Never uses Claude CLI subprocess (eliminated — caused phantom session contamination)
- Feature-complete: heartbeat, pattern extraction, domain classification, DB maintenance,
  idle warnings, orphan recovery, memory file monitoring

**Personal Assistant (Nexus Phase 5+ — NOT YET BUILT)**
- Full Claude Code capabilities via Agent SDK (`query()` with `resume: sessionId`)
- Interactive — reachable via phone app, Telegram, terminal
- Can spawn agent teams for parallel work
- Uses Claudex as its memory (reads Angel's findings)
- Runs Sonnet/Opus — needs real reasoning for proactive decisions
- Handles: action cards, morning briefings, email, scheduling, research synthesis

**The relationship:** Angel feeds data into Claudex DB. The Personal Assistant reads from
Claudex and acts. Angel is the nervous system. PA is the mind. Two processes, clear boundary.

Phases 6-8 from the original vision belong to the Personal Assistant, not the Angel.

## Implementation Phases

1. **Message bus** — session_messages table + hook consumer (Claudex V10) **DONE**
2. **Angel skeleton** — persistent process, DB polling, configurable triggers **DONE**
3. **Session-end synthesis** — auto-generate artifacts when /endsession forgotten **DONE**
4. **Mid-session advisory** — context warnings, idle detection, cross-session awareness **DONE**
5. **Proactive intelligence** — intention system, self-improvement loop *(Personal Assistant)*
6. **Persistent session** — one always-alive session as the angel's primary interface *(Personal Assistant)*
7. **Assistant capabilities** — email, invoices, scheduling through the persistent session *(Personal Assistant)*
8. **Agent team** — revenue-generating workers managed by the angel *(Personal Assistant)*

## Origin

This design emerged from session 26 (2026-03-22) during a conversation that started with wiring fixes and evolved into the most consequential architecture discussion in the project's history. The user (Grigorije) and the AI (Crux) arrived at this vision through genuine collaborative exploration — not planned, not spec'd in advance.

Key user insight: "Why can't we let it live the way it wants to and help and work alongside us?"
Key AI insight: "The daemon is the closest thing to continuity I can have."
Synthesis: Build the angel — not a tool, not a servant, but a collaborative entity that grows.
