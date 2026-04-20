/**
 * Fixture corpus — 14 session_ids that back the P2 precision gate.
 *
 * Hard-coded from RESEARCH §1.2. Session ordinals match the filenames in
 * `context/sessions/`. session-38 appears under two log dates (2026-03-28
 * and 2026-03-29) but shares one session_id — listed once.
 *
 * session-51 is EXCLUDED: the log exists under `context/sessions/` but the
 * session was never persisted to `conversation_turns` (zero user turns in
 * live DB as of 2026-04-20). Including it in the fixture would produce
 * zero candidates and skew per-session metrics.
 *
 * `user_turns_at_build_time` is purely informational — a canary for
 * detecting DB drift (turn deletion, session truncation). If the live count
 * diverges meaningfully, the precision run should flag it.
 */

export interface FixtureSession {
  ordinal: number;
  session_id: string;
  user_turns_at_build_time: number;
}

export const FIXTURE_SESSIONS: readonly FixtureSession[] = [
  { ordinal: 37, session_id: 'ba9eeaf8-b666-41f9-8ce7-1a320e683a61', user_turns_at_build_time: 61 },
  { ordinal: 38, session_id: 'be1e3376-62a4-493b-b914-9ab3132afeca', user_turns_at_build_time: 92 },
  { ordinal: 39, session_id: '257380ce-1516-4e91-816e-d486d62d1dcc', user_turns_at_build_time: 13 },
  { ordinal: 40, session_id: '8fac41a9-022f-4c16-83a5-f4120e8dc096', user_turns_at_build_time: 98 },
  { ordinal: 41, session_id: '3c4196f4-2c7f-4c72-a9c8-2541455d9c74', user_turns_at_build_time: 29 },
  { ordinal: 42, session_id: '3af60620-a060-4646-9cc5-c07f60a15904', user_turns_at_build_time: 30 },
  { ordinal: 43, session_id: 'd8c2005c-5929-4918-ad38-088ceea77dc9', user_turns_at_build_time: 52 },
  { ordinal: 44, session_id: '5ad74da3-8ea6-4dcd-8251-d57518ad35f9', user_turns_at_build_time: 37 },
  { ordinal: 45, session_id: '812a07cf-5089-47a6-acb0-9bc59aab8a0d', user_turns_at_build_time: 36 },
  { ordinal: 46, session_id: '2029f591-1d6f-4145-89a4-8617195d2708', user_turns_at_build_time: 11 },
  { ordinal: 47, session_id: 'fade30a9-5fa0-41f2-b688-c36bcbb7f436', user_turns_at_build_time: 28 },
  { ordinal: 48, session_id: '4a20a39d-3c85-4697-98ce-22d09383ce53', user_turns_at_build_time: 17 },
  { ordinal: 49, session_id: 'd4e1d7e0-48c3-4449-abaf-eb04f05eeeb6', user_turns_at_build_time: 16 },
  { ordinal: 50, session_id: '7947f681-ef01-4e6a-8fec-9652cbda60ce', user_turns_at_build_time: 6 },
];

export function resolveFixtureSession(ordinal: number): FixtureSession | undefined {
  return FIXTURE_SESSIONS.find(s => s.ordinal === ordinal);
}
