# PROJECT: CC Source-Informed Upgrades

**Milestone:** CC Source Upgrades (81 items)
**Started:** 2026-04-03
**Source:** `context/research/SYNTHESIS.md` (24 research documents, 17 CC source, 7 community)
**Constraint:** `context/specs/CRITICAL_REMINDERS_TIER.md` (Critical Reminders injection tier)

## Objective

Implement ALL 81 upgrades derived from CC source code analysis. No prioritization, no deferral. Every item from SYNTHESIS.md gets built. These upgrades fall into 10 categories:

1. **Token Optimization** (T1-T8) — Environment flags, injection architecture, cache-stable content
2. **New Hook Types** (H1-H17) — 17 undocumented hook event types CC supports
3. **Hook Execution Capabilities** (X1-X10) — Async protocol, prompt protocol, env injection, matchers
4. **Injection Point Upgrades** (I1-I5) — initialUserMessage, MCP annotations, conditional rules, skills, plugins
5. **Conflict Prevention** (C1-C5) — GrowthBook flags, auto-dream, KAIROS, compaction races, VERIFICATION_AGENT
6. **Cache Optimization** (K1-K4) — MCP/global trade-off, TTL awareness, latched headers, billing sentinel
7. **Bug Workarounds** (B1-B8) — Known CC issues with defensive Claudex mitigations
8. **Extension Surfaces** (E1-E3) — Plugin packaging, channel MCP, tool annotations
9. **Angel/CC Integration** (A1-A15) — Dream/extractMemories consolidation, idle detection, skill pipeline, Buddy UI
10. **Angel Engineering Patterns** (P1-P6) — Forked agents, cursor extraction, manifests, throttling, budgets, mutual exclusion

## Hard Constraints

- Critical Reminders tier (CRITICAL_REMINDERS_TIER.md) is a hard dependency for Token Optimization work
- No CC API calls from hooks (deadlock)
- All hooks must be ephemeral (await everything, no fire-and-forget)
- Hook payload field names must match CC's actual fields (see CC Hook Payload Truth in CLAUDE.md)
- `cch=` pattern must never appear in hook output (billing sentinel bug K4)

## Success Criteria

- All 81 items implemented and tested
- Token savings measurable (T-category items should show reduction)
- No regressions in existing 2020-test suite
- Critical Reminders tier passes all 6 success criteria from spec
- New hooks registered and functional
- Conflict prevention monitors active
