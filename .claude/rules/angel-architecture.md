---
paths:
  - "src/angel/**"
---

# Angel System Architecture

Angel is Claudex's persistent guardian process. It runs independently of CC hooks and performs reflective, holistic analysis.

## Core Subsystems
- **Heartbeat**: Periodic liveness signal, session monitoring
- **Pattern Extractor**: Extracts experience patterns from full conversations (cursor-based, incremental)
- **CARA Reasoning**: Opinion formation network with confidence dynamics (`angel_opinions` table)
- **Session Monitor**: Tracks active sessions, sends idle warnings (10-min debounce)
- **Message Sender**: Inter-session messaging via `session_messages` table
- **Entity Summarizer**: Generates consolidated knowledge for entities appearing in 3+ sessions
- **Retention Sweep**: Prunes stale observations, preserves high-value artifacts
- **Proactive Curator**: Identifies knowledge gaps and surfaces relevant context

## Engineering Patterns
- **10-min debounce** on monitoring loops — prevents noisy notifications
- **5-turn hard budget** on background LLM processes — caps token spend
- **Cursor-based extraction** — processes only new conversation turns since last cursor
- **Mutual exclusion skip logic** — if another process holds a lock, skip rather than wait

## Reference
See `context/specs/ANGEL_SYSTEM.md` for full design specification.
