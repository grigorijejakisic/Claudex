@echo off
REM Claudex first-touch installer (Windows). Pre-flights Bun, then delegates
REM to `bun run setup` which is the complete bootstrap (Bun version, Ollama
REM detect, model pull, BGE reranker venv, projects-dir, DB, hooks).

where bun >nul 2>&1
if errorlevel 1 (
  echo Bun not found on PATH. Install: https://bun.sh
  exit /b 1
)

REM `call` is required because bun ships as bun.cmd on Windows; without
REM `call`, control transfers to bun.cmd and never returns to install.bat.
call bun install --frozen-lockfile
if errorlevel 1 exit /b 1

call bun run build
if errorlevel 1 exit /b 1

call bun run setup
if errorlevel 1 exit /b 1
