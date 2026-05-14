#!/usr/bin/env bash
# Mid-flight commit visibility — CC statusline script.
# Add to CC settings: { "statusline": { "command": "bash path/to/statusline.sh", "refreshInterval": 10 } }

set -euo pipefail

# Get last 4 commits, one line each
COMMITS=$(git log -4 --oneline 2>/dev/null || echo "no git history")

# Output as a single compact line for statusline display
echo "commits: $(echo "$COMMITS" | tr '\n' ' | ' | sed 's/ | $//')"
