# Contributing to Claudex

Thanks for considering a contribution. Claudex is a small, opinionated codebase
— the contribution surface is intentionally narrow. This guide covers the
mechanics; deeper architectural context lives in [`.claude/rules/`](./.claude/rules/)
which Claude Code loads conditionally when editing relevant paths.

## Development setup

```bash
git clone https://github.com/grigorijejakisic/Claudex.git
cd Claudex
bun install
bun run build
```

Requirements:
- **Bun** ≥ 1.3 (the runtime — `bun --version` to confirm)
- An Ollama instance running locally with the `snowflake-arctic-embed2` model
  pulled (used for the bi-encoder fallback path)
- A Claude Code installation if you intend to test hook integration end-to-end

The build is esbuild-based (~70ms) and writes to `dist/`. Hooks register via
`bun run setup` once the build is in place.

## Running tests

**Always use `bun run test`. Never use `bun test`.**

```bash
bun run test           # vitest, 3000+ tests
```

`bun test` (without `run`) invokes Bun's native test runner, which is a
different runner with different conventions. It will discover the wrong files,
report confusing failures, and is not the test gate. The `run` keyword
forwards the command to the npm-style script (`"test": "vitest run"`),
which is what runs in CI.

Other useful commands:

```bash
bun run vesna         # SC#1 — Vesna behavioral probe suite (the merge gate)
bun run sc3           # SC#3 — MEMORY.md content-quality scorer
bun run health        # local health check
```

## Commit convention

Atomic commits using [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — new capability
- `fix: ...` — bug fix
- `docs: ...` — documentation only
- `chore: ...` — tooling, dependencies, repo plumbing
- `test: ...` — test-only changes
- `refactor: ...` — internal restructuring without behavior change
- `phase(NN-MM): ...` — work tied to a specific GSD phase plan (e.g.
  `phase(12-03): DOC-05 ...`)

One commit per task; commit messages explain the *why*, not the *what* (the
diff already shows what). When a commit is co-authored, end with a
`Co-Authored-By:` trailer.

## Pull request workflow

Before opening a PR:
1. `bun run build` — must succeed
2. `bun run test` — full vitest suite must pass
3. `bun run vesna` — SC#1 behavioral probe suite must PASS (this is the
   merge gate; do not ship a PR that regresses Vesna)
4. `bun run sc3` — SC#3 MEMORY.md content quality must remain ≥80% per
   project (this catches regressions in the curation pipeline)

CI runs the Vesna probe suite via `.github/workflows/vesna.yml` on every PR.
The PR cannot merge until Vesna is green.

PRs should reference the requirement ID(s) they close (e.g. `Closes LIC-02`)
and link to the GSD phase directory under `.planning/phases/` if the work is
phase-scoped.

## Hook safety

Two non-obvious rules when editing hook code in `src/adapters/cc-hooks/`:

1. **Never call Claude Code's CLIProxyAPI from inside a hook.** Hooks run
   inside the Claude Code process; calling back into its API from a hook
   deadlocks the host. Use Ollama directly when a hook needs an LLM call.
2. **Always `await` in hooks.** Hooks are ephemeral processes — a
   fire-and-forget Promise can be killed mid-flight when the hook process
   exits. Only the long-running components (Angel, OpenClaw bridge) can
   fire-and-forget.

## Architectural context

`.claude/rules/` contains the deeper rule files Claude Code loads
conditionally when editing relevant paths. Read these before making
non-trivial changes to:

- The schema or migrations (`src/storage/schema/`, `src/storage/migrations/`)
- Hook payloads (`src/adapters/cc-hooks/`)
- Angel responsibilities (`src/angel/`)
- The retrieval pipeline (`src/retrieval/`)

The project-level `CLAUDE.md` at the repo root summarizes the runtime
components, schema version, and critical safety rules.

## Issues

Bugs, design questions, and feature requests:
[github.com/grigorijejakisic/Claudex/issues](https://github.com/grigorijejakisic/Claudex/issues)
