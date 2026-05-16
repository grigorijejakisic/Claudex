#!/usr/bin/env node
/**
 * Auto-commit hook for Claudex v3.
 *
 * Fires at SessionStart, PostToolUse (on Write|Edit|MultiEdit|NotebookEdit),
 * and Stop. Captures git state at each boundary so a future agent can
 * diff session-start vs session-end and see exactly what changed.
 *
 * Silent-fail: any git error swallowed. Never blocks the session.
 *
 * Usage:
 *   node auto-commit-hook.cjs <event_name> [tag_prefix]
 *
 * Examples:
 *   node auto-commit-hook.cjs session-start session-start
 *   node auto-commit-hook.cjs edit
 *   node auto-commit-hook.cjs session-end session-end
 *
 * When tag_prefix is supplied, a tag `claudex/<tag_prefix>-<epoch_seconds>`
 * is created after the commit. SessionStart and Stop use this; PostToolUse
 * does not (would create too many tags).
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const eventName = process.argv[2] || 'unknown';
const tagPrefix = process.argv[3] || null;

function quietGit(cmd) {
  try {
    execSync(`git ${cmd}`, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Verify this is a git repo before attempting anything.
try {
  execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'ignore' });
} catch {
  // Not a git repo — exit silently. Future enhancement: auto-init if missing.
  process.exit(0);
}

// Stage everything respecting .gitignore.
quietGit('add -A');

// Commit. --allow-empty so session boundary commits land even when no files changed.
// --no-verify skips pre-commit hooks (we don't want to chain hook-on-hook).
const msg = `claudex/auto: ${eventName}`;
const escaped = msg.replace(/"/g, '\\"');
quietGit(`commit -m "${escaped}" --allow-empty --no-verify`);

// Tag at session boundaries (not at every PostToolUse — would be noisy).
if (tagPrefix) {
  const ts = Math.floor(Date.now() / 1000);
  // Sanitize tag prefix to alphanumeric + hyphen.
  const safePrefix = tagPrefix.replace(/[^a-zA-Z0-9-]/g, '-');
  quietGit(`tag claudex/${safePrefix}-${ts}`);
}

// Always exit 0 — silent-fail design.
process.exit(0);
