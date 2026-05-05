/**
 * Phase 6 PID liveness probe — cross-platform via process.kill(pid, 0).
 *
 * Per CONTEXT.md (Claude's Discretion #1): uses the cross-platform builtin,
 * not tasklist / ps shell-out. EPERM-means-alive idiom — POSIX returns EPERM
 * when the process exists but we lack signal permission; that still means
 * it's alive.
 *
 * NEVER alone closes a session — composition rule in boundary-detector.ts
 * always corroborates with heartbeat AND JSONL signals (CONTEXT decision:
 * stale heartbeat alone NEVER closes a session).
 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}
