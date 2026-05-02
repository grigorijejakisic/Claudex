# Claudex

Persistent memory for LLM coding agents — they reach for it the way they reach for Grep.

> **Status:** v4.1 Quick Start shipped (Phase 16 structural). Fresh-VM verification on macOS / Ubuntu 24.04 / Windows 11 is HITL-pending — see [docs/onboarding/](./docs/onboarding/) for per-platform runbooks. Track [CHANGELOG.md](./CHANGELOG.md) for the v4.1 release.

## What is Claudex?

Claudex is a persistent memory system that runs locally alongside Claude Code. It captures what happens during a session — observations, decisions, files edited, problems hit — and surfaces the relevant pieces on the next session, automatically. One SQLite database, one local vector index, no cloud service.

It is for people running long coding sessions across days or weeks who want the agent to actually remember context between resets, without manually re-priming each session. The agent reads from the same store you read from; the surfaces are the MCP tools `claudex_search`, `claudex_recall`, and `claudex_events`.

There is no hosted variant. The DB lives at `~/.claudex/db/claudex.db`; embeddings are computed by a local Ollama instance; reranking is a local Python service. Everything runs on the same machine as the editor.

## Why Claudex?

Existing memory systems make the agent FOLLOW INSTRUCTIONS to query memory ("remember to check past decisions before answering"). That fails because instructions decay — the agent stops querying when the prompt window stops nagging. v4's bet is the opposite: memory tools should be treated like file-reading tools, reached for as natural extensions of reasoning when the work shape calls for them.

**v4 makes the agent USE Claudex organically as part of how it works in Claude Code.** Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) get reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

**Canonical example:** if last session we discovered *"60 HTTP polls to backend X = 15-min IP shadowban"*, and this session the user says *"investigate another backend for intel gathering,"* the agent should automatically (1) recognize this is rate-limit-research-shaped work, (2) recall the shadowban finding, (3) apply it to scoping — all without being told to query memory.

This is the difference v4 measures. Behavioral probes verify the recall-and-apply pattern landed; the audit history behind that bet is in [CHANGELOG.md](./CHANGELOG.md).

## Quick Start

Claudex runs entirely on your machine. Bring `bun >=1.3`, `ollama`, and Python `3.11+` (the BGE reranker uses a Python venv). Then:

### 1. Prereqs

| Tool | Minimum | Install |
|------|---------|---------|
| Bun | 1.3 | `curl -fsSL https://bun.sh/install \| bash` (macOS / Linux) · `powershell -c "irm bun.sh/install.ps1 \| iex"` (Windows) |
| Ollama | latest | https://ollama.com/download |
| Python | 3.11 | `brew install python@3.11` (macOS) · `apt install python3.11 python3.11-venv` (Ubuntu 24.04) · https://www.python.org/downloads/ (Windows) |

`bun run doctor` (after install) verifies each of these — no need to memorize floors.

### 2. Clone

```bash
git clone https://github.com/grigorijejakisic/Claudex.git
cd Claudex
```

(Note the capital `C` in the URL — the repo is `grigorijejakisic/Claudex`.)

### 3. Install

```bash
./install.sh        # macOS / Linux
install.bat         # Windows (cmd.exe or PowerShell)
```

Either entry point pre-flights Bun, then runs `bun install --frozen-lockfile && bun run build && bun run setup`. The `bun run setup` step is the substantive bootstrap — it detects Bun, detects Ollama, pulls `snowflake-arctic-embed2` if missing, creates the BGE reranker Python venv at `services/.venv`, installs Python deps, spawns the reranker on port 7439, creates `~/.claudex/db/claudex.db`, and registers Claude Code hooks at `~/.claude/settings.json`. Idempotent — re-running it on a working install is a no-op.

### 4. Verify

```bash
bun run doctor
```

Six parallel checks: Bun version, DB schema, Ollama daemon + `snowflake-arctic-embed2`, BGE reranker on `:7439`, Claude Code hooks, Angel guardian process. Exit 0 means healthy; the reranker check warns rather than fails (bi-encoder fallback covers it). If anything fails, the doctor names the broken check and prints a one-line fix.

### 5. First session

By default Claudex tracks projects under `~/Projects/` (override via `CLAUDEX_PROJECTS_DIR=/some/other/path`). Open Claude Code in any subdirectory of that root — the SessionStart hook injects assembled context within the first user turn. No manual priming needed.

If your projects already live elsewhere, set the env var before launching Claude Code; setup writes the value into `~/.claudex/projects.json` on first run.

## Diagnostics

If something feels off — embeddings missing, hooks not firing, retrieval degraded — run:

```bash
bun run doctor
```

This checks the things Claudex needs to be healthy:

- Bun runtime version (>=1.3)
- SQLite DB schema matches the build
- Ollama daemon reachable + `snowflake-arctic-embed2` embedding model pulled
- BGE reranker reachable on port 7439
- Claude Code hooks registered in `~/.claude/settings.json`
- Angel guardian process alive with a fresh heartbeat

Each check prints a one-line remediation if it fails. Pass `--json` for machine-readable output. Exit codes: `0` healthy (warnings allowed), `1` something's broken, `2` doctor itself crashed.

## Troubleshooting

When something feels off, **always run `bun run doctor` first** — it pinpoints which subsystem is broken in under a second and prints a one-line remediation. The entries below cover the four canonical install failures and what each one looks like through the doctor lens.

### Ollama not running

**Symptom:** SessionStart assembly empty or stale; `claudex_search` calls return nothing; `bun run setup` hangs at "model-pull".

**Diagnostic:** `bun run doctor` reports `✗ Ollama` with one of:
- `daemon not reachable on 127.0.0.1:11434`
- `binary missing from PATH`
- `snowflake-arctic-embed2 not pulled`

**Fix:**
- macOS / Linux: start the daemon with `ollama serve &`. If the binary is missing, install per https://ollama.com/download.
- Windows: launch the Ollama app from Start Menu (it runs as a tray service).
- Once the daemon is up, run `bun run setup` again — the model-pull step is idempotent and will pull `snowflake-arctic-embed2` if it isn't already present.

### Port 7439 dead (BGE reranker)

**Symptom:** retrieval feels noticeably worse; SessionStart shows a "Reranker Health" line counting `reranker_fallback` events.

**Diagnostic:** `bun run doctor` reports `⚠ Reranker` (warn, not fail — the bi-encoder fallback keeps retrieval working). Common causes:
- `:7439/health` not reachable
- Python venv at `services/.venv` missing or broken
- The reranker process crashed and Angel hasn't restarted it yet

**Fix:**
- Re-run `bun run setup`. The reranker-bootstrap step recreates the venv if missing and respawns the reranker on `:7439`.
- If the venv exists but the service won't start, delete `services/.venv/` and re-run `bun run setup` — the Python step is idempotent.
- If `bun run doctor` still warns after re-setup, check the reranker process logs (location depends on how `bun run setup` started it — typically captured by Angel's `RerankerSupervisor`) for the underlying error. A common cause is a Python version mismatch — Phase 14 requires Python 3.11+.

### Bun version mismatch

**Symptom:** `bun run setup` exits 1 immediately with a version-floor message; or hooks fail at session-start with `bun: command not found`.

**Diagnostic:** `bun run doctor` reports `✗ Bun version` with either:
- `Bun not found` (binary missing)
- `Bun X.Y.Z (<1.3 required)`

**Fix:**
- macOS / Linux: `curl -fsSL https://bun.sh/install | bash` (re-run installs the latest).
- Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`.
- Verify with `bun --version`. The floor is `1.3.0` — anything below fails the doctor check.

### Hook registration failure

**Symptom:** SessionStart hook doesn't fire; first user turn shows no assembled context; PostToolUse events not recorded.

**Diagnostic:** `bun run doctor` reports `✗ CC hooks` with `N of 25 registered (M missing)`. The doctor names the missing hook(s).

**Fix:**
- Re-run `bun run setup`. The hooks step patches `~/.claude/settings.json` to register every Claudex hook. Idempotent — safe to run on a working install.
- If a hook still won't register after re-setup, your `~/.claude/settings.json` may have a syntax error from a manual edit. Validate with any JSON parser; the doctor will refuse to register hooks into invalid JSON.
- After re-running setup, restart Claude Code. Hooks are loaded at session-start and don't hot-reload.

---

If `bun run doctor` exits 0 but something still feels broken, see [docs/onboarding/](./docs/onboarding/) for per-platform runbooks recording known friction points encountered on fresh VMs.

## Documentation

- [CHANGELOG.md](./CHANGELOG.md) — release history starting at v4.0.0
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup, test commands, commit convention, hook safety
- [`.claude/rules/`](./.claude/rules/) — architectural rules loaded conditionally during work
- [`.planning/PROJECT.md`](./.planning/PROJECT.md) — project intent and current milestone

## License

Claudex is MIT-licensed. See [LICENSE](./LICENSE).

Copyright (c) 2026 Grigorije Jakisic.
