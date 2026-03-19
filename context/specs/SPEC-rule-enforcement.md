# Claudex Rule Enforcement Spec — System-Enforced Compliance

## Problem

CLAUDE.md has rules. Memory files have feedback. The model ignores both when focused on implementation. Session 18 proved this: "test live" rule existed since day one, model skipped it, missing import crashed every real hook invocation while 1585 unit tests passed.

Rules in text files depend on model compliance. The system should enforce them.

## Three Mechanisms

### 1. Rules as Trigger-Fired Artifacts

Store CLAUDE.md rules and feedback memories as high-importance artifacts with `trigger_glob` patterns. When PostToolUse fires on a matching file, the rule materializes in the next assembly — the model sees it because the system injected it.

**Implementation:**
- New function `ingestRulesAsArtifacts()` in `file-ingester.ts`
- Reads CLAUDE.md, parses sections (Rules, Quality Standard, Engineering Method)
- Each section → artifact with `artifact_type = 'memory_file'`, `importance = 5`
- Also reads `feedback_*.md` from auto-memory → same treatment
- Each rule artifact gets `trigger_glob` patterns derived from its content:
  - "Test live" → `src/adapters/cc-hooks/**`
  - "Never call CC API from hooks" → `src/adapters/cc-hooks/**`
  - "Fix regressions — write tests BEFORE" → `src/core/migrations*`
- Stored in `context_triggers` with `knowledge_domain` matching the rule's topic

**Trigger flow:**
```
PostToolUse: Edit src/adapters/cc-hooks/stop.ts
  → trigger match: 'src/adapters/cc-hooks/**' → domain 'cc-hooks'
  → experience flags: pending_trigger_domains = ['cc-hooks']

UserPromptSubmit:
  → consume pending domains → FTS5 search 'cc-hooks'
  → materializes: "Test live, not theoretically" artifact
  → injected into assembly context
  → model sees the rule because the system surfaced it
```

### 2. Behavioral Gates in Stop Hook

Session events track what happened (file_edit, build, test_run). The Stop hook can verify workflow compliance by checking event sequences.

**Gates:**
| Condition | Required Events | Warning if Missing |
|-----------|----------------|-------------------|
| Hook files edited | `build` event after last hook edit | "Hook files modified but not rebuilt" |
| Hook files rebuilt | `bun run setup` detected | "Hooks rebuilt but not registered" |
| Any code committed | `test_run` event with `passed` action | "Code committed without test verification" |

**Implementation:**
- In Stop hook, after session summary synthesis
- Query `session_events` for this session
- Check for gate violations
- If violated: emit telemetry warning AND inject a `## Workflow Warning` section into the Stop output
- Stop hook CAN inject context via `hookSpecificOutput.additionalContext`

**Gate check logic:**
```typescript
function checkWorkflowGates(events: SessionEvent[]): string[] {
  const warnings: string[] = [];
  const hookEdits = events.filter(e => e.event_type === 'file_edit' && e.entity.includes('cc-hooks'));
  const builds = events.filter(e => e.event_type === 'build');
  const lastHookEdit = hookEdits.at(-1);
  const lastBuild = builds.at(-1);

  if (lastHookEdit && (!lastBuild || lastBuild.timestamp_epoch < lastHookEdit.timestamp_epoch)) {
    warnings.push('Hook files modified but not rebuilt. Run: bun run build && bun run setup');
  }
  return warnings;
}
```

### 3. Post-Build Smoke Tests

After `bun run build`, automatically invoke each hook entry point with minimal test input. Catches missing imports, undefined references, schema mismatches — the exact class of bug live testing found.

**Implementation:**
- Extend `build.ts` with a `smokeTest()` function called after esbuild
- For each hook entry point, spawn: `echo '{"session_id":"__smoke__","cwd":"..."}' | node dist/adapters/cc-hooks/<hook>.cjs`
- Check: exit code 0, stdout is valid JSON, stderr has no "Error" or "Cannot find module"
- If any hook fails: print error, exit 1 (build fails)
- Timeout: 5 seconds per hook (should be <1s each)

**Smoke test payloads:**
```json
// SessionStart
{"session_id":"__smoke__","cwd":"<project_dir>"}

// UserPromptSubmit
{"session_id":"__smoke__","prompt":"smoke test","cwd":"<project_dir>"}

// PostToolUse
{"session_id":"__smoke__","tool_name":"Read","tool_input":{"file_path":"README.md"},"cwd":"<project_dir>"}

// Stop
{"session_id":"__smoke__","last_assistant_message":"smoke","stop_assistant_turn":"smoke","cwd":"<project_dir>"}

// PreCompact, SessionEnd — minimal payloads
```

**Key constraint:** Smoke tests run against a TEMPORARY in-memory DB or the real DB with a `__smoke__` session ID that gets cleaned up. Must not pollute production data.

## Implementation Order

1. **Smoke tests** (30 min) — catches the exact bug class, zero architectural changes
2. **Behavioral gates** (1 hour) — builds on existing session events, extends Stop hook
3. **Rules as artifacts** (1 hour) — extends existing file ingester + trigger engine

## Success Criteria

- Missing imports in hook files → build fails (smoke test catches it)
- Editing hook files without rebuilding → warning injected at Stop
- CLAUDE.md rules relevant to the current task → automatically surfaced in assembly
- No rule depends on model memory or voluntary compliance
