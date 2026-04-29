# Handoff Frontmatter Canonical Spec (Phase 5)

**Status:** Authoritative for Phase 5 INJ-06 contract. Phase 7.5 will revisit format.

## Required keys

| Key | Type | Values | Purpose |
|-----|------|--------|---------|
| status | string | active \| consumed \| deferred | Active means session-start may auto-prime |
| phase | string | "N" or "N.M" (decimal) | Must EXACTLY match STATE.md `Current Phase: N` (or `N.M`) for prime to fire |

## Optional keys

| Key | Type | Purpose |
|-----|------|---------|
| summary | string (one-line) | First-person resume blurb. If absent, prime falls back to first non-blank H1-stripped body line. |

## Example (Phase 5-compatible)

```yaml
---
status: active
phase: "5"
summary: "Resume Phase 5 wave 3 — Tier B deletion of project_overview pending."
---

# Handoff body...
```

## INJ-06 prime contract

The session-start hook fires `initialUserMessage` if and only if:

1. `context/handoffs/ACTIVE.md` exists and is readable.
2. Frontmatter `status` matches `/^active\b/i`.
3. Frontmatter `phase` exactly equals (string equality) the value extracted from STATE.md `Current Phase: N` (or `N.M`).
4. Either `summary` is present in frontmatter, OR a non-blank, non-H1 line exists in the body.
5. sessionType is `'startup'` or empty (NOT `'resume'`, NOT `'compact'`).

The prime emitted is:

```
Resume handoff: ${summary}. Full state at .planning/handoffs/ACTIVE.md.
```

## EXACT-match rationale

Per team-lead Q3 verdict 2026-04-29: handoff `phase: "4.1"` paired with STATE.md `Current Phase: 4` MUST NOT prime — that would resume stale handoffs from a previous decimal subphase. Phase comparison is string-equal, not numeric-equal. Plan 07 implements + tests this contract.

## What this replaces

The pre-Phase 5 prime path used a generic `auto_prime` config flag plus a fallback `"A handoff is active"` message. The frontmatter contract above is the only gate; the config flag is removed in Plan 07.
