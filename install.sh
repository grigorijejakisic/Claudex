#!/usr/bin/env bash
# Claudex first-touch installer (POSIX). Pre-flights Bun, then delegates
# to `bun run setup` which is the complete bootstrap (Bun version, Ollama
# detect, model pull, BGE reranker venv, projects-dir, DB, hooks).
set -e

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found on PATH. Install: https://bun.sh"
  exit 1
fi

bun install --frozen-lockfile
bun run build
bun run setup
