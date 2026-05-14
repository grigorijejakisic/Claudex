# Mid-Flight Commit Visibility

Three mechanisms compose into complete mid-flight visibility during autonomous Claude Code sessions.

## Mechanism 1 — Last-Commit Sidecar (PostToolUse hook)

When the agent runs `git commit`, the PostToolUse hook writes the commit hash + subject to `~/.claudex/.last-commit.txt`.

Monitor it:
```bash
# One-shot check
cat ~/.claudex/.last-commit.txt

# Live watch (updates on each commit)
watch -n 2 cat ~/.claudex/.last-commit.txt
```

The file contains one line: `<commit-hash> <commit-subject>`.

## Mechanism 2 — Statusline (4 most recent commits)

Add `scripts/statusline.sh` to CC's statusline configuration to see the 4 most recent commits in your Claude Code status bar.

1. Make the script executable:
   ```bash
   chmod +x scripts/statusline.sh
   ```

2. Add to your CC `settings.json` (operator-specific path — see CC docs for `statusline`):
   ```json
   {
     "statusline": {
       "command": "bash /absolute/path/to/claudex/scripts/statusline.sh",
       "refreshInterval": 10
     }
   }
   ```

The statusline refreshes every 10 seconds and shows the 4 most recent commits as a compact one-liner.

## Mechanism 3 — Transcript Tail (full Bash output)

Claude Code writes a JSONL transcript for each session under:
```
~/.claude/projects/<project-path-slug>/<session-id>.jsonl
```

To stream full Bash output in real time:
```bash
# Find the latest session file
LATEST=$(ls -t ~/.claude/projects/<project-slug>/*.jsonl | head -1)

# Tail it for live output
tail -f "$LATEST" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        ev = json.loads(line)
        if ev.get('type') in ('tool_result', 'tool_input'):
            print(json.dumps(ev, indent=2))
    except:
        pass
"
```

For lighter monitoring (bash output only):
```bash
tail -f "$LATEST" | grep -A5 '"tool_name": "Bash"'
```

## Why Three Mechanisms

Each mechanism covers a different granularity:
- **Sidecar**: lightweight, one commit at a time, zero processing overhead
- **Statusline**: ambient awareness in CC bar, auto-refreshing, requires one-time setup
- **Transcript tail**: full visibility into any tool use, useful for debugging but high signal volume

The 2026-05-09 Gemini consultation surfaced all 13+ Phase 10/11 regressions before the operator saw them — Gemini had real-time visibility via `tail -f` while the autonomous pipeline did not. These three mechanisms give the operator the same visibility Gemini had, using only documented CC APIs.
