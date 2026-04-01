# CC Source Repo Comparison — Four Community Repositories

**Date:** 2026-04-01  
**Repos analyzed:**
- `claude-code-buildable/` — beita6969, "buildable research fork"
- `claude-code-free/` — paoloanzn, "free-code"
- `claude-code-leaked/` — sanbuphy, version 2.1.88 source analysis
- `claude-code-main/` — Anthropic's official public repo (no source)

---

## 1. What Each Repo Is

### claude-code-leaked (sanbuphy)
**Version:** `2.1.88` (package name: `@anthropic-ai/claude-code-source`)  
**Origin:** Extracted from npm package `@anthropic-ai/claude-code` v2.1.88. The npm tarball ships a bundled `cli.js` (~12MB); source maps were exposed and the TypeScript source reconstructed from them.  
**State:** Raw extracted TypeScript source with no build system. NOT directly compilable. Has a `stubs/` directory at the repo root (not in `src/`) for build infrastructure.  
**Purpose:** Documentation and analysis. The author added extensive docs (`docs/en/`, `docs/zh/`) analyzing telemetry, codenames, undercover mode, remote control, and future roadmap. README explicitly lists 108 missing modules that were dead-code-eliminated from the bundle.  
**Source files:** 1,902 `.ts`/`.tsx` files under `src/`  
**Community additions:** README analysis docs only. No code modifications.

### claude-code-free (paoloanzn)
**Version:** `2.1.87` (package name: `claude-code-source-snapshot`)  
**Origin:** Same npm source map extraction, but one minor version earlier (2.1.87). Claims March 31, 2026 exposure date.  
**State:** Fully buildable. Has proper `package.json` with build scripts, real npm dependencies (actual `@anthropic-ai/bedrock-sdk`, `@azure/identity`, `@opentelemetry/*`, etc.), and the infrastructure to run.  
**Purpose:** "Free build" — telemetry stripped, security-prompt guardrails removed, experimental features unlocked. Install script: `curl -fsSL ... | bash`.  
**Source files:** 1,928 `.ts`/`.tsx` files under `src/`  
**Community additions:** 26 files added, 37 files modified from the leaked baseline (see sections below).

### claude-code-buildable (beita6969)
**Version:** `0.1.0` (package name: `claude-code-research`) — internal version, based on v2.1.87 source  
**Origin:** Same source snapshot as free. Calls itself a "buildable research fork."  
**State:** Fully buildable with Bun. Uses stub packages (`src/stubs/ant-packages/`) for all private Anthropic packages (`@ant/*`, `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@opentelemetry/*` exporters, native `.napi` bindings, etc.) instead of real npm packages.  
**Purpose:** Research/modification platform. Has a web config UI (`bun run config`), custom build system, and is explicitly structured for extension rather than distribution.  
**Source files:** 2,116 `.ts`/`.tsx` files under `src/`  
**Community additions:** 108+ files added beyond leaked baseline. However most of the "extra" files are stubs (79 confirmed empty stubs).

### claude-code-main (Anthropic official)
**Identity:** This is Anthropic's **official public GitHub repository** at `github.com/anthropics/claude-code`.  
**Contains:** NO source code. This is a documentation and community plugins repository only.  
**Contents:**
- `CHANGELOG.md` — Full changelog from v0.2.21 (earliest) to v2.1.29 (latest at time of capture). 202 version entries total.
- `README.md` — Official docs with install instructions (curl/Homebrew/winget/npm)
- `plugins/` — 13 official example plugins (agent-sdk-dev, claude-opus-4-5-migration, code-review, commit-commands, explanatory-output-style, feature-dev, frontend-design, hookify, learning-output-style, plugin-dev, pr-review-toolkit, ralph-wiggum, security-guidance)
- `examples/hooks/` — `bash_command_validator_example.py`
- `examples/settings/` — `settings-bash-sandbox.json`, `settings-lax.json`, `settings-strict.json`
- `scripts/` — GitHub automation scripts (duplicate comment handling)
- `LICENSE.md`, `SECURITY.md`
**No git remote accessible** (128 error — likely requires auth)

---

## 2. Version Analysis

| Repo | CC Version | File Count (src/) | Build Status |
|------|-----------|-------------------|--------------|
| leaked (sanbuphy) | 2.1.88 | 1,902 | Not buildable (no build config) |
| free (paoloanzn) | 2.1.87 | 1,928 | Buildable (real deps) |
| buildable (beita6969) | based on 2.1.87 | 2,116 | Buildable (stub deps) |
| main (Anthropic official) | changelog up to 2.1.29 | 0 (no source) | N/A |

**Ordering:** leaked is the newest raw source (2.1.88 > 2.1.87). However free has 26 more source files than leaked because paoloanzn added stub implementations for internal modules. buildable has the most files (2,116) because beita6969 added 79+ stubs plus a full `stubs/ant-packages/` directory with 56 package stub files.

**The 2.1.88 vs 2.1.87 delta:** The only content difference between leaked and free for their shared files is ~37 files modified. Key ones:
- `main.tsx` — leaked has `-d2e, --debug-to-stderr` flag name; buildable/free have `--debug-to-stderr`
- `constants/cyberRiskInstruction.ts` — free blanks out the cyber risk instruction string; leaked has the real instruction text
- `services/analytics/sink.ts` — free stubs out `initializeAnalyticsSink()` and `initializeAnalyticsGates()`; leaked has real routing to Datadog + 1P logger
- `utils/telemetry/instrumentation.ts` — free stubs out `bootstrapTelemetry()`, `initializeTelemetry()`, sets `isTelemetryEnabled() = false`; leaked has full OpenTelemetry setup with OTLP exporters

---

## 3. Directory Diff — Files in One Repo but Not Others

### 3.1 Files ONLY in buildable (vs both free and leaked)

**Top-level src/ additions (all stubs or empty exports):**
- `attributionTrailer.ts` — stub
- `cachedMicrocompact.ts` — stub
- `coreTypes.generated.ts` — stub
- `devtools.ts` — stub
- `dream.ts` — stub (`export default {}`)
- `entry.ts` — stub
- `global.d.ts` — type declaration stub
- `hunter.ts` — stub (`export default {}`)
- `protectedNamespace.ts` — stub
- `runSkillGenerator.ts` — stub

**New top-level directories (all stubs):**
- `jobs/classifier.ts` — stub
- `proactive/index.ts`, `proactive/useProactive.ts` — stubs
- `sdk/runtimeTypes.ts`, `sdk/toolTypes.ts` — partial type definitions
- `ssh/createSSHSession.ts` — stub
- `stubs/` — 56 stub package files (see section 3.3)
- `yolo-classifier-prompts/` — at repo root (duplicate; real one is in `src/utils/permissions/yolo-classifier-prompts/`)

**Feature stubs (buildable has, leaked does not):**

| Path | Feature Gate | Status |
|------|-------------|--------|
| `assistant/gate.ts` | KAIROS | stub |
| `assistant/index.ts` | KAIROS | stub |
| `assistant/sessionDiscovery.ts` | KAIROS | stub |
| `bridge/peerSessions.ts` | BRIDGE_MODE | stub |
| `commands/agents-platform/index.ts` | internal (`ant`) | stub |
| `commands/assistant/assistant.ts` | KAIROS | stub |
| `commands/assistant/index.ts` | KAIROS | stub |
| `commands/buddy/index.ts` | BUDDY | stub |
| `commands/force-snip.ts` | HISTORY_SNIP | stub |
| `commands/fork/index.ts` | FORK_SUBAGENT | stub |
| `commands/peers/index.ts` | BRIDGE_MODE | stub |
| `commands/proactive.ts` | PROACTIVE | stub |
| `commands/remoteControlServer/index.ts` | DAEMON+BRIDGE_MODE | stub |
| `commands/subscribe-pr.ts` | KAIROS_GITHUB_WEBHOOKS | stub |
| `commands/torch.ts` | TORCH | stub |
| `commands/workflows/index.ts` | WORKFLOW_SCRIPTS | stub |
| `coordinator/workerAgent.ts` | COORDINATOR_MODE | stub |
| `memdir/memoryShapeTelemetry.ts` | MEMORY_SHAPE_TELEMETRY | stub |
| `server/server.ts` | server mode | stub |
| `server/backends/dangerousBackend.ts` | server mode | stub |
| `server/connectHeadless.ts` | server mode | stub |
| `server/lockfile.ts` | server mode | stub |
| `server/parseConnectUrl.ts` | server mode | stub |
| `server/serverBanner.ts` | server mode | stub |
| `server/serverLog.ts` | server mode | stub |
| `server/sessionManager.ts` | server mode | stub |
| `services/compact/reactiveCompact.ts` | CACHED_MICROCOMPACT | stub |
| `services/compact/snipCompact.ts` | HISTORY_SNIP | stub |
| `services/compact/snipProjection.ts` | HISTORY_SNIP | stub |
| `services/compact/cachedMCConfig.ts` | CACHED_MICROCOMPACT | stub |
| `services/contextCollapse/index.ts` | CONTEXT_COLLAPSE | stub |
| `services/contextCollapse/operations.ts` | CONTEXT_COLLAPSE | stub |
| `services/contextCollapse/persist.ts` | CONTEXT_COLLAPSE | stub |
| `services/sessionTranscript/sessionTranscript.ts` | TRANSCRIPT_CLASSIFIER | stub |
| `services/skillSearch/featureCheck.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `services/skillSearch/localSearch.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `services/skillSearch/prefetch.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `services/skillSearch/remoteSkillLoader.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `services/skillSearch/remoteSkillState.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `services/skillSearch/telemetry.ts` | EXPERIMENTAL_SKILL_SEARCH | stub |
| `tasks/LocalWorkflowTask/` | WORKFLOW_SCRIPTS | stub |
| `tasks/MonitorMcpTask/` | internal | stub |

**Tools unique to buildable (all stubs):**

| Tool | Feature Gate |
|------|-------------|
| `CtxInspectTool` | internal debug |
| `DiscoverSkillsTool` | EXPERIMENTAL_SKILL_SEARCH |
| `ListPeersTool` | BRIDGE_MODE |
| `MonitorTool` | internal |
| `OverflowTestTool` | internal testing |
| `PushNotificationTool` | KAIROS |
| `ReviewArtifactTool` | KAIROS |
| `SendUserFileTool` | internal |
| `SnipTool` | HISTORY_SNIP |
| `SubscribePRTool` | KAIROS_GITHUB_WEBHOOKS |
| `SuggestBackgroundPRTool` | KAIROS |
| `TerminalCaptureTool` | internal |
| `TungstenTool` | internal (Anthropic-only) |
| `VerifyPlanExecutionTool` | internal |
| `WebBrowserTool` | internal |
| `WorkflowTool` | WORKFLOW_SCRIPTS |

**UI components unique to buildable (all stubs returning null):**
- `components/MonitorMcpDetailDialog.tsx`
- `components/MonitorPermissionRequest/`
- `components/ReviewArtifactPermissionRequest/`
- `components/UserCrossSessionMessage.tsx`
- `components/UserForkBoilerplateMessage.tsx`
- `components/UserGitHubWebhookMessage.tsx`
- `components/WorkflowDetailDialog.tsx`
- `components/messages/SnipBoundaryMessage.tsx`
- `components/messages/UserCrossSessionMessage.tsx`
- `components/messages/UserForkBoilerplateMessage.tsx`
- `components/messages/UserGitHubWebhookMessage.tsx`
- `components/permissions/MonitorPermissionRequest/`
- `components/permissions/ReviewArtifactPermissionRequest/`
- `components/tasks/MonitorMcpDetailDialog.tsx`
- `components/tasks/WorkflowDetailDialog.tsx`

**Skills unique to buildable:**
- `skills/bundled/claude-api/` — 18 markdown files (SKILL.md + multi-language examples for claude API)
- `skills/bundled/verify/` — SKILL.md + example markdown files
- `skills/bundled/dream.ts` — stub
- `skills/bundled/hunter.ts` — stub
- `skills/bundled/runSkillGenerator.ts` — stub
- `skills/mcpSkills.ts` — stub

**Utils unique to buildable:**
- `utils/attributionHooks.ts` — stub (COMMIT_ATTRIBUTION feature)
- `utils/attributionTrailer.ts` — stub
- `utils/filePersistence/types.ts` — stub
- `utils/permissions/yolo-classifier-prompts/` — 3 prompt text files (auto_mode_system_prompt.txt, permissions_anthropic.txt, permissions_external.txt)
- `utils/protectedNamespace.ts` — stub
- `utils/systemThemeWatcher.ts` — stub (AUTO_THEME feature)
- `utils/taskSummary.ts` — stub
- `utils/udsClient.ts` — stub (UDS_INBOX feature)
- `utils/udsMessaging.ts` — stub (UDS_INBOX feature)
- `utils/ultraplan/prompt.txt` — ultraplan prompt content

**SDK types unique to buildable (also present in free but not leaked):**
- `entrypoints/sdk/coreTypes.generated.ts`
- `entrypoints/sdk/runtimeTypes.ts`
- `entrypoints/sdk/toolTypes.ts`

**Ink internals unique to buildable (also in free, not leaked):**
- `ink/devtools.ts`
- `ink/global.d.ts`

### 3.2 Files ONLY in free (paoloanzn) vs leaked (sanbuphy)

Free added 26 files beyond the leaked baseline. Unlike buildable's stubs, some of these have real (partial) implementations:

| File | Content | Purpose |
|------|---------|---------|
| `assistant/AssistantSessionChooser.tsx` | real React component | KAIROS session picker UI |
| `commands/assistant/assistant.tsx` | real component | KAIROS assistant command |
| `components/UltraplanChoiceDialog.tsx` | real dialog | Ultraplan launch choice |
| `components/UltraplanLaunchDialog.tsx` | real dialog | Ultraplan launch confirmation |
| `components/agents/SnapshotUpdateDialog.tsx` | stub (calls onCancel) | Agent snapshot merge UI |
| `entrypoints/sdk/coreTypes.generated.ts` | real types | SDK core type generation |
| `entrypoints/sdk/runtimeTypes.ts` | real types | SDK runtime type defs |
| `entrypoints/sdk/toolTypes.ts` | real MCP tool types | SDK tool type defs |
| `ink/devtools.ts` | real (re-export) | Ink devtools integration |
| `ink/global.d.ts` | real | Global type declarations |
| `services/compact/cachedMCConfig.ts` | real implementation | Cached micro-compact config with `CachedMCState` type |
| `services/compact/cachedMicrocompact.ts` | real implementation | Cache edits block types + state management |
| `services/compact/snipCompact.ts` | stub (returns false/passthrough) | Snip compaction (gated) |
| `services/compact/snipProjection.ts` | stub | Snip projection (gated) |
| `services/contextCollapse/index.ts` | stub (all no-ops) | CONTEXT_COLLAPSE service |
| `services/contextCollapse/operations.ts` | stub | Collapse operations |
| `services/contextCollapse/persist.ts` | stub | Collapse persistence |
| `tools/TungstenTool/TungstenTool.ts` | real but returns UNAVAILABLE | Anthropic-internal tool placeholder |
| `tools/TungstenTool/TungstenLiveMonitor.tsx` | real component | Tungsten monitor UI |
| `tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts` | real but returns UNAVAILABLE | Plan verification placeholder |
| `tools/VerifyPlanExecutionTool/constants.ts` | real | Tool name constant |
| `tools/WorkflowTool/constants.ts` | real | `WORKFLOW_TOOL_NAME = 'Workflow'` |
| `types/connectorText.ts` | real type | Connector text type |
| `utils/claudeInChrome/package.ts` | real | Chrome extension package utils |
| `utils/filePersistence/types.ts` | real type | File persistence type |
| `utils/ultraplan/prompt.txt` | real content | Ultraplan system prompt text |

### 3.3 The stubs/ant-packages Directory (buildable ONLY)

Buildable created 56 stub package files to satisfy npm dependency resolution without using private Anthropic packages:

**@ant/* packages (Anthropic internal):**
- `@ant/claude-for-chrome-mcp` — Chrome extension MCP server
- `@ant/computer-use-input` — Computer use input handling
- `@ant/computer-use-mcp` — Computer use MCP server (with `sentinelApps/`, `types/`)
- `@ant/computer-use-swift` — macOS computer use via Swift

**@anthropic-ai/* packages:**
- `@anthropic-ai/bedrock-sdk` — AWS Bedrock SDK
- `@anthropic-ai/foundry-sdk` — Anthropic Foundry SDK
- `@anthropic-ai/vertex-sdk` — Google Vertex AI SDK

**@aws-sdk/* packages:**
- `@aws-sdk/client-bedrock`
- `@aws-sdk/client-sts`

**@azure/* packages:**
- `@azure/identity`

**@opentelemetry/* exporters (9 packages):**
- All OTLP exporters for logs, metrics, traces (grpc/http/proto variants)
- Prometheus exporter

**Native .napi packages:**
- `audio-capture-napi` — audio capture
- `color-diff-napi` — color diffing
- `modifiers-napi` — keyboard modifiers

**Other:**
- `sharp` — image processing
- `turndown` — HTML to Markdown

**Bun-specific stubs:**
- `stubs/bun-bundle-preload.ts`
- `stubs/bun-bundle-runtime.ts`
- `stubs/bun-bundle.d.ts`
- `stubs/bun-ffi.d.ts`

In contrast, free (paoloanzn) uses the **real npm packages** as dependencies. This is the fundamental build strategy difference between the two buildable repos.

### 3.4 Files ONLY in leaked (vs buildable and free)

**None.** Leaked has zero unique files. Both buildable and free are strict supersets of leaked in terms of file coverage.

---

## 4. Feature Comparison

### 4.1 Hooks System

All three source repos have identical hooks implementations. The hooks directory structure is identical across all three (80+ hooks). No community modifications found.

### 4.2 Memory / Memdir

All three have identical `memdir/` structure:
- `findRelevantMemories.ts`
- `memdir.ts`
- `memoryAge.ts`
- `memoryScan.ts`
- `memoryTypes.ts`
- `paths.ts`
- `teamMemPaths.ts`
- `teamMemPrompts.ts`

Buildable additionally stubs `memdir/memoryShapeTelemetry.ts` (MEMORY_SHAPE_TELEMETRY feature gate).

### 4.3 Coordinator / Multi-Agent

- **leaked:** `coordinator/coordinatorMode.ts` only
- **free:** `coordinator/coordinatorMode.ts` only  
- **buildable:** `coordinator/coordinatorMode.ts` + `coordinator/workerAgent.ts` (stub: `export default {}`)

The `workerAgent.ts` is the missing COORDINATOR_MODE piece. All repos have `coordinatorMode.ts` which is the orchestrator side.

### 4.4 Compact System

| File | leaked | free | buildable |
|------|--------|------|-----------|
| `compact.ts` | ✓ | ✓ | ✓ |
| `autoCompact.ts` | ✓ | ✓ | ✓ |
| `microCompact.ts` | ✓ | ✓ | ✓ |
| `apiMicrocompact.ts` | ✓ | ✓ | ✓ |
| `sessionMemoryCompact.ts` | ✓ | ✓ | ✓ |
| `grouping.ts` | ✓ | ✓ | ✓ |
| `prompt.ts` | ✓ | ✓ | ✓ |
| `compactWarningHook.ts` | ✓ | ✓ | ✓ |
| `timeBasedMCConfig.ts` | ✓ | ✓ | ✓ |
| `cachedMCConfig.ts` | ✗ | ✓ (real) | ✓ (stub) |
| `cachedMicrocompact.ts` | ✗ | ✓ (real) | ✓ (stub) |
| `reactiveCompact.ts` | ✗ | ✗ | ✓ (stub) |
| `snipCompact.ts` | ✗ | ✓ (stub) | ✓ (stub) |
| `snipProjection.ts` | ✗ | ✓ (stub) | ✓ (stub) |

### 4.5 Context Collapse

- **leaked:** Not present
- **free:** Present as stubs (all functions are no-ops, `isContextCollapseEnabled()` returns false)
- **buildable:** Present as stubs (same pattern)

### 4.6 Telemetry / Analytics

**leaked:** Full telemetry implementations — real Datadog routing, real OpenTelemetry OTLP setup, real first-party event logging, real `cyberRiskInstruction` text injected in system prompts.

**free:** All telemetry disabled:
- `initializeAnalyticsSink()` → no-op
- `bootstrapTelemetry()` → no-op
- `isTelemetryEnabled()` → returns `false`
- `CYBER_RISK_INSTRUCTION` → empty string (guardrail removed)
- Datadog sink → stubbed
- First-party logger → stubbed
- OpenTelemetry instrumentation → stubbed

**buildable:** Uses the same modified files as free (telemetry stripped), but additionally stubs out the OpenTelemetry exporter packages entirely via `stubs/ant-packages/@opentelemetry/*`.

### 4.7 Server / Headless Mode

- **leaked:** Not present
- **free:** Not present
- **buildable:** Stubs present (`server/server.ts`, `server/sessionManager.ts`, `server/connectHeadless.ts`, `server/lockfile.ts`, `server/backends/dangerousBackend.ts`, etc.) — all stub exports

This server mode is the `--headless` / remote session server functionality.

### 4.8 KAIROS / Assistant Mode

- **leaked:** No KAIROS files
- **free:** `assistant/AssistantSessionChooser.tsx` (real UI), `commands/assistant/assistant.tsx` (real command) — but gate.ts, index.ts, sessionDiscovery.ts are absent
- **buildable:** `assistant/gate.ts` (stub), `assistant/index.ts` (stub), `assistant/sessionDiscovery.ts` (stub), `commands/assistant/assistant.ts` (stub), `commands/assistant/index.ts` (stub) — all stubs

### 4.9 Skills / Skill Search

- **leaked:** `bundledSkills.ts`, `loadSkillsDir.ts`, `mcpSkillBuilders.ts` — no `mcpSkills.ts`, no skillSearch service
- **free:** Same as leaked
- **buildable:** Adds `skills/mcpSkills.ts` (stub), full `services/skillSearch/` directory (6 files, all stubs), `skills/bundled/claude-api/` (18 markdown docs for Claude API skill), `skills/bundled/verify/` (SKILL.md + examples)

### 4.10 Bridge / Peer Sessions

All repos have identical `bridge/` directory except:
- **buildable only:** `bridge/peerSessions.ts` — stub for BRIDGE_MODE peer session management

### 4.11 SSH

- **leaked/free:** No SSH support
- **buildable:** `ssh/createSSHSession.ts` — stub

### 4.12 Ultraplan

All repos have `commands/ultraplan.tsx` and `utils/ultraplan/ccrSession.ts`, `utils/ultraplan/keyword.ts`.

Additionally:
- **free:** `utils/ultraplan/prompt.txt` (real ultraplan system prompt), `components/UltraplanLaunchDialog.tsx`, `components/UltraplanChoiceDialog.tsx`
- **buildable:** `utils/ultraplan/prompt.txt` (same prompt text, placed at wrong relative path at root)
- **leaked:** None of the above (prompt.txt and dialog components absent)

---

## 5. Community Additions Beyond Leaked Source

### buildable (beita6969) additions:

1. **Full build infrastructure:** `package.json` with Bun scripts, `bun build` pipeline, `tsconfig.json`, `scripts/postinstall.sh`, web config UI (`config-ui/`)
2. **56 stub npm packages** in `src/stubs/ant-packages/` to satisfy TypeScript imports without private packages
3. **79+ stub source files** for all 108 feature-gated internal modules (replacing missing modules with empty exports so TypeScript compiles)
4. **Yolo classifier prompts** (3 text files): auto_mode_system_prompt.txt, permissions_anthropic.txt, permissions_external.txt — these are the actual permission classification prompts used by Claude in auto mode
5. **claude-api bundled skill** (18 markdown files): Complete Claude API reference as a skill (multi-language: Python, TypeScript, Go, Java, C#, PHP, Ruby)
6. **verify bundled skill** docs (SKILL.md + examples)
7. **Runtime MACRO injection** in `main.tsx`: sets `globalThis.MACRO` with VERSION, BUILD_TIME, PACKAGE_URL, etc. at runtime (in production this comes from Bun compile-time macros)
8. **Web config UI** (`bun run config`): dashboard for configuring Claude Code settings via browser

### free (paoloanzn) additions:

1. **Telemetry removal:** All analytics sinks stubbed, OTEL instrumentation disabled, GrowthBook still runs locally but doesn't report back
2. **Guardrail removal:** `CYBER_RISK_INSTRUCTION` blanked out (security-prompt injection removed)
3. **Feature unlocking:** Claims 45+ feature flags enabled at build time
4. **Real SDK type files** for `entrypoints/sdk/` (coreTypes.generated.ts, runtimeTypes.ts, toolTypes.ts)
5. **Ultraplan UI dialogs** (UltraplanLaunchDialog, UltraplanChoiceDialog) — real implementations
6. **AssistantSessionChooser** — real KAIROS session picker component
7. **cachedMCConfig + cachedMicrocompact** — real implementations for cached microcompact config state management
8. **TungstenTool, VerifyPlanExecutionTool, WorkflowTool** stubs — type-safe disabled placeholders so the codebase compiles cleanly
9. **Install script** (`install.sh`) that clones, builds with all features, and installs as `free-code` binary

### leaked (sanbuphy) additions:

1. **Analysis documentation** (5 EN + 5 ZH docs): telemetry/privacy, codenames/feature flags, undercover mode, remote control/killswitches, future roadmap
2. **QUICKSTART.md** — build instructions
3. Chinese README (`README_CN.md`)
4. No source code modifications — pure extracted source

---

## 6. Key Structural Observations

### Hierarchy of completeness (most → least):
```
buildable (2,116 files) > free (1,928 files) > leaked (1,902 files)
```

### Relationship between the three:
- **leaked** is the raw extracted source (v2.1.88, unmodified)
- **free** took v2.1.87 source and made it buildable + stripped telemetry/guardrails + added some reconstructed internal files
- **buildable** took v2.1.87 source and made it buildable via stubs + added all 108 missing module stubs (empty) + added build infrastructure

### The 108 "missing modules":
The leaked repo README documents 108 modules that exist only in Anthropic's internal monorepo. Both free and buildable attempt to address these:
- **buildable** creates stub files for all of them (empty exports so TypeScript compiles)
- **free** creates real-but-disabled stubs for the most important ones (snip, contextCollapse, cachedMC), and real implementations for some SDK types

### The stubs/ant-packages strategy (buildable only):
Because Anthropic's native packages (`@ant/computer-use-*`, native `.napi` bindings, etc.) are private, buildable replaces them with empty JavaScript stubs that export nothing. This is cleaner than free's approach of using the real public npm packages (which may have version mismatches) but means those features are completely non-functional.

### Free's telemetry removal is the differentiating feature:
The 37 modified files between leaked and free primarily remove telemetry and guardrails. The source is otherwise architecturally identical. Anyone wanting to study unmodified CC behavior should use leaked. Anyone wanting a runnable build should use free or buildable.

### claude-code-main is purely official/documentation:
It contains no source code whatsoever — only the CHANGELOG (0.2.21 → 2.1.29, 202 version entries), official plugins, example hooks/settings, and GitHub automation scripts. It is the official Anthropic community/docs repo, not a source mirror.

---

## 7. Shared Infrastructure (Identical Across All Three Source Repos)

The following are identical in leaked, free, and buildable:
- All `migrations/` (11 files) — model name migrations
- All `hooks/` React hooks (80+ hooks)
- `bridge/` (except peerSessions.ts in buildable)
- `components/` (except noted above)
- `constants/` (except cyberRiskInstruction.ts in free)
- `context/` — query context assembly
- `coordinator/coordinatorMode.ts`
- `memdir/` (except memoryShapeTelemetry.ts in buildable)
- `native-ts/` (color-diff, file-index, yoga-layout)
- `outputStyles/`
- `plugins/`
- `query/`
- `remote/`
- `screens/`
- `services/SessionMemory/`, `services/AgentSummary/`, `services/MagicDocs/`, etc.
- `state/`
- `tasks/` (except LocalWorkflowTask/MonitorMcpTask in buildable)
- `tools/` core tools (BashTool, FileReadTool, FileEditTool, etc.)
- `types/`
- `upstreamproxy/`
- Migration files — all identical
