# Claude Code — Complete Feature Flag & Environment Variable Inventory

**Source:** `claude-code-buildable/src/`
**Date:** 2026-04-01
**Coverage:** Every `process.env.*` reference across all `.ts` and `.tsx` files.

---

## How to Read This Document

- **Default:** The value when the variable is absent (i.e. `undefined`).
- **Truthy/Falsy semantics:** `isEnvTruthy` accepts `1`, `true`, `yes`, `on`. `isEnvDefinedFalsy` accepts `0`, `false`, `no`, `off`. Many flags are tri-state (unset / truthy / falsy).
- **Relevant to Claudex:** Column marks which flags touch memory, caching, context, hooks, tokens, or multi-agent behavior.

---

## 1. Authentication & API Access

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `ANTHROPIC_API_KEY` | Direct API key for first-party requests | — | `src/utils/auth.ts:237` | When set, bypasses OAuth flow entirely | none |
| `ANTHROPIC_AUTH_TOKEN` | Alternative auth token (no `sk-ant-` prefix check) | — | `src/utils/auth.ts:125` | Used for internal/proxy authentication | none |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth bearer token (inline, for non-interactive use) | — | `src/services/api/client.ts` | Overrides full OAuth flow | none |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Refresh token for OAuth | — | `src/cli/handlers/auth.ts:140` | Allows automatic token refresh | none |
| `CLAUDE_CODE_OAUTH_SCOPES` | Comma-separated OAuth scopes | — | `src/cli/handlers/auth.ts:142` | Limits OAuth permissions | none |
| `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` | FD number containing OAuth token | — | `src/utils/auth.ts` | Reads token from open file descriptor | none |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | FD number containing API key | — | `src/utils/auth.ts:127` | Reads key from open file descriptor | none |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | TTL for apiKeyHelper cache (ms) | 300000 (5 min) | `src/utils/auth.ts:436` | Controls how often helper script is re-executed | none |
| `CLAUDE_CODE_OAUTH_CLIENT_ID` | Override OAuth client ID | — | `src/services/oauth/client.ts` | Custom OAuth app integration | none |
| `CLAUDE_CODE_ACCOUNT_UUID` | Override account UUID for OAuth | — | `src/services/oauth/client.ts:457` | Forces a specific account UUID | none |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | Custom OAuth redirect URL | — | `src/constants/oauth.ts` | Redirects OAuth callback to custom endpoint | none |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | CCR session authentication token | — | `src/utils/sessionIngressAuth.ts:103` | Priority 1 for session ingress auth | hooks |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | FD number for WebSocket auth token | — | `src/utils/sessionIngressAuth.ts:25` | Legacy CCR session auth via FD | none |
| `CLAUDE_SESSION_INGRESS_TOKEN_FILE` | Path to file containing session ingress token | CCR_SESSION_INGRESS_TOKEN_PATH | `src/utils/sessionIngressAuth.ts:30` | Fallback token file for CCR subprocesses | none |
| `CLAUDE_CODE_ORGANIZATION_UUID` | Organization UUID for X-Organization-Uuid header | — | `src/utils/sessionIngressAuth.ts:124` | Required for sk-ant-sid session keys | none |
| `CLAUDE_TRUSTED_DEVICE_TOKEN` | Trusted device token | — | `src/bridge/trustedDevice.ts:47` | Enables trusted device authentication | none |

---

## 2. API Provider Selection

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_USE_BEDROCK` | Route all API calls to AWS Bedrock | false | `src/utils/model/providers.ts:7` | Switches provider to `bedrock` | none |
| `CLAUDE_CODE_USE_VERTEX` | Route all API calls to Google Vertex AI | false | `src/utils/model/providers.ts:9` | Switches provider to `vertex` | none |
| `CLAUDE_CODE_USE_FOUNDRY` | Route all API calls to Anthropic Foundry | false | `src/utils/model/providers.ts:11` | Switches provider to `foundry` | none |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | Host controls provider config; ignore settings.json routing | false | `src/utils/managedEnvConstants.ts:16` | Strips user's provider env vars at spawn time | none |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Skip AWS credential validation | false | `src/utils/model/bedrock.ts:126` | Bypasses STS auth check | none |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | Skip GCP credential validation | false | `src/utils/status.tsx:298` | Bypasses ADC auth check | none |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | Skip Foundry auth validation | false | `src/utils/status.tsx:318` | Bypasses Foundry auth check | none |

---

## 3. API Endpoints & Base URLs

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `ANTHROPIC_BASE_URL` | Override Anthropic API base URL | `https://api.anthropic.com` | `src/main.tsx:1336` | Redirects all 1P calls; disables tool search by default | none |
| `ANTHROPIC_BEDROCK_BASE_URL` | Override AWS Bedrock endpoint | AWS default | `src/utils/model/bedrock.ts:62` | Custom Bedrock endpoint | none |
| `BEDROCK_BASE_URL` | Alternative Bedrock base URL (display/status only) | — | `src/utils/status.tsx:263` | Shown in /doctor output | none |
| `VERTEX_BASE_URL` | Vertex AI base URL (display/status only) | — | `src/utils/status.tsx:280` | Shown in /doctor output | none |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Override Foundry base URL | — | `src/utils/status.tsx:304` | Custom Foundry endpoint | none |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry resource/workspace identifier | — | `src/utils/status.tsx:311` | Targets specific Foundry resource | none |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API key | — | `src/services/api/client.ts:196` | Auth for Foundry requests | none |
| `CLAUDE_CODE_API_BASE_URL` | Override files API base URL | — | `src/services/api/filesApi.ts:35` | Separate from main ANTHROPIC_BASE_URL | none |
| `ANTHROPIC_UNIX_SOCKET` | Unix domain socket path for API | — | `src/utils/proxy.ts:301` | Routes API calls through local socket | none |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project ID for Vertex | — | `src/services/api/client.ts:286` | Targets specific GCP project | none |
| `CLOUD_ML_REGION` | Default Vertex AI region | `us-east5` | `src/utils/envUtils.ts:104` | Region for Vertex model requests | none |
| `VERTEX_REGION_CLAUDE_*` | Per-model Vertex region overrides | CLOUD_ML_REGION | `src/utils/envUtils.ts:155–183` | Route specific models to specific regions. Format: `VERTEX_REGION_CLAUDE_4_6_SONNET`, etc. | none |
| `AWS_DEFAULT_REGION` | AWS region fallback | `us-east-1` | `src/utils/envUtils.ts:97` | Used if `AWS_REGION` absent | none |
| `CLAUDE_CODE_GB_BASE_URL` | Override GrowthBook (analytics) base URL | Anthropic API base | `src/services/analytics/growthbook.ts:505` | Custom feature flag server | none |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | Custom OAuth redirect URL | — | `src/constants/oauth.ts` | Alternative OAuth endpoint | none |
| `SESSION_INGRESS_URL` | Remote session ingress URL | — | `src/commands/ultraplan.tsx:213` | UltraPlan session URL construction | none |
| `CLAUDE_BRIDGE_BASE_URL` | Bridge API base URL (ant-only) | — | `src/bridge/bridgeConfig.ts:29` | Internal bridge infrastructure | none |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | Bridge session ingress URL (ant-only) | — | `src/bridge/bridgeMain.ts:2202` | Internal bridge infrastructure | none |

---

## 4. Model Selection

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `ANTHROPIC_MODEL` | Override main/primary model | `claude-sonnet-4-6-...` | `src/main.tsx:2025` | Replaces default Sonnet selection | tokens |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override default Sonnet model ID | release-defined | `src/utils/model/model.ts:120` | What "Sonnet" means at runtime | tokens |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` | Display name for custom Sonnet | — | `src/utils/model/modelOptions.ts:85` | UI label only | none |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION` | Description for custom Sonnet | — | `src/utils/model/modelOptions.ts:87` | Model picker description | none |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override default Opus model ID | release-defined | `src/utils/model/model.ts:106` | What "Opus" means at runtime | tokens |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME` | Display name for custom Opus | — | `src/utils/model/modelOptions.ts:115` | UI label only | none |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION` | Description for custom Opus | — | `src/utils/model/modelOptions.ts:117` | Model picker description | none |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override default Haiku model ID | release-defined | `src/utils/model/model.ts:132` | What "Haiku" means at runtime | tokens |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME` | Display name for custom Haiku | — | `src/utils/model/modelOptions.ts:172` | UI label only | none |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION` | Description for custom Haiku | — | `src/utils/model/modelOptions.ts:174` | Model picker description | none |
| `ANTHROPIC_SMALL_FAST_MODEL` | Override small/fast model (background tasks, compaction summarizer) | Haiku | `src/utils/model/model.ts:37` | Changes which model does cheap tasks | tokens |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | AWS region for small/fast model on Bedrock | AWS default | `src/services/api/client.ts:158` | Separate region for Haiku on Bedrock | none |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | Additional model ID to show in picker | — | `src/utils/model/modelOptions.ts:465` | Shows a 4th custom model option | tokens |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` | Display name for custom model | — | `src/utils/model/modelOptions.ts:472` | Custom model label | none |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | Description for custom model | — | `src/utils/model/modelOptions.ts:474` | Custom model description | none |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Model for spawned subagents | main model | `src/utils/managedEnvConstants.ts:55` | Different model for agent children | multi-agent |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | Model for auto-mode (YOLO classifier) | — | `src/utils/permissions/yoloClassifier.ts:1336` | Override classifier model | none |
| `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | Disable old model name → new model remapping | false | `src/utils/model/model.ts:553` | Opt out of automatic model upgrades | tokens |
| `FALLBACK_FOR_ALL_PRIMARY_MODELS` | Allow fallback to Sonnet when any primary fails | false (Opus-only) | `src/services/api/withRetry.ts:331` | Expands fallback scope beyond Opus | tokens |

---

## 5. Token Budgets & Output Limits

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Max tokens in a single response | Model default | `src/services/api/claude.ts:3413` | Hard caps output size | tokens |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Override context window size | Model default | `src/utils/context.ts:63` | Shrinks effective context window | tokens/context |
| `MAX_THINKING_TOKENS` | Max extended thinking tokens | 10000 | `src/utils/thinking.ts:147` | 0 = disable thinking; >0 = enable with budget | tokens |
| `BASH_MAX_OUTPUT_LENGTH` | Max chars in Bash tool output | 30000 | `src/utils/shell/outputLimits.ts:9` | Truncates bash output | tokens |
| `BASH_DEFAULT_TIMEOUT_MS` | Default Bash command timeout | 120000 (2 min) | `src/utils/timeouts.ts:13` | Per-command timeout | none |
| `BASH_MAX_TIMEOUT_MS` | Max Bash command timeout (user can set up to this) | 600000 (10 min) | `src/utils/timeouts.ts:29` | Upper bound for user-specified timeouts | none |
| `MAX_THINKING_TOKENS` | Extended thinking token budget | 10000 | `src/utils/thinking.ts:147` | Duplicated for clarity: `> 0` enables thinking | tokens |
| `MAX_MCP_OUTPUT_TOKENS` | Max tokens in MCP tool output | 25000 | `src/utils/mcpValidation.ts:27` | Truncates large MCP responses | tokens |
| `TASK_MAX_OUTPUT_LENGTH` | Max chars in Task tool output | 30000 | `src/utils/task/outputFormatting.ts:10` | Truncates agent task output | tokens/multi-agent |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | Max tokens for file read tool | model-based | `src/tools/FileReadTool/limits.ts:25` | Limits single file read size | tokens |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | Char budget for skill (slash command) tool | built-in value | `src/tools/SkillTool/prompt.ts:32` | Limits skill context injected per invocation | tokens |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | Retries for structured output (JSON mode) | 5 | `src/QueryEngine.ts:1012` | Controls structured output retry count | none |
| `CLAUDE_CODE_MAX_RETRIES` | Max API retry attempts on error | built-in | `src/services/api/withRetry.ts:791` | Override default retry count | none |
| `API_TIMEOUT_MS` | API request timeout (ms) | 600000 (10 min) | `src/services/api/client.ts:144` | Per-request timeout | none |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Max parallel tool invocations | 10 | `src/services/tools/toolOrchestration.ts:10` | Controls tool parallelism | multi-agent |
| `API_MAX_INPUT_TOKENS` | Input token threshold for microcompact trigger | model-based | `src/services/compact/apiMicrocompact.ts:106` | When to trigger API-side compaction | context |
| `API_TARGET_INPUT_TOKENS` | Target input tokens after microcompact | model-based | `src/services/compact/apiMicrocompact.ts:109` | How much to compact down to | context |

---

## 6. Caching & Prompt Caching

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `DISABLE_PROMPT_CACHING` | Disable prompt caching globally | false | `src/services/api/claude.ts:335` | Turns off all cache_control markers | caching |
| `DISABLE_PROMPT_CACHING_HAIKU` | Disable caching for Haiku model only | false | `src/services/api/claude.ts:338` | Selective cache disable for small model | caching |
| `DISABLE_PROMPT_CACHING_SONNET` | Disable caching for Sonnet model only | false | `src/services/api/claude.ts:344` | Selective cache disable for Sonnet | caching |
| `DISABLE_PROMPT_CACHING_OPUS` | Disable caching for Opus model only | false | `src/services/api/claude.ts:350` | Selective cache disable for Opus | caching |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | Enable 1-hour cache TTL on Bedrock | false | `src/services/api/claude.ts:398` | Opts in to 1h TTL for Bedrock users | caching |

---

## 7. Context Management & Compaction

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `DISABLE_COMPACT` | Disable the /compact command | false | `src/commands/compact/index.ts:9` | Removes manual compaction entirely | context |
| `DISABLE_AUTO_COMPACT` | Disable automatic compaction | false | `src/services/compact/autoCompact.ts:152` | No auto-compact when context fills | context |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | Disable session-memory compaction | false | `src/entrypoints/cli.tsx:22` | Prevents session memory compact variant | context |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | Enable session-memory compaction | false | `src/entrypoints/cli.tsx:22` | Explicitly enables SM compact variant | context |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Override auto-compact trigger percentage | derived from model | `src/services/compact/autoCompact.ts:79` | E.g. `80` = compact at 80% context | context |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Override effective context window for auto-compact | model default | `src/services/compact/autoCompact.ts:40` | Shrinks window for earlier compaction | context |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | Override blocking limit token count | model-derived | `src/services/compact/autoCompact.ts:127` | Token count at which new turns block | context |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Disable 1M context window beta | false | `src/utils/context.ts:32` | Prevents sending `context-1m` beta header | context |
| `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | Disable optimization that skips pre-compact messages | false | `src/utils/sessionStorage.ts:3536` | Forces loading all transcript history | context/memory |
| `USE_API_CONTEXT_MANAGEMENT` | Enable API-side context management beta | false | `src/utils/betas.ts:302` | Sends `context-management` beta header | context |
| `USE_API_CLEAR_TOOL_RESULTS` | Clear tool result content in microcompact | false | `src/services/compact/apiMicrocompact.ts:95` | API-side tool result pruning | context |
| `USE_API_CLEAR_TOOL_USES` | Clear tool use content in microcompact | false | `src/services/compact/apiMicrocompact.ts:97` | API-side tool use pruning | context |
| `CLAUDE_AFTER_LAST_COMPACT` | Signal that session is post-compact | false | `src/services/api/sessionIngress.ts:430` | Used in remote session handoff | context |

---

## 8. Thinking / Extended Reasoning

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_DISABLE_THINKING` | Disable extended thinking entirely | false | `src/services/api/claude.ts:1598` | No thinking blocks in responses | tokens |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Disable adaptive thinking specifically | false | `src/services/api/claude.ts:1606` | Falls back to fixed-budget thinking | tokens |
| `DISABLE_INTERLEAVED_THINKING` | Disable interleaved thinking beta header | false | `src/utils/betas.ts:258` | Prevents `interleaved-thinking` beta | tokens |
| `MAX_THINKING_TOKENS` | Extended thinking token budget | 10000 | `src/utils/thinking.ts:147` | 0 = off, >0 = enabled with this budget | tokens |

---

## 9. Memory & CLAUDE.md

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto-memory (MemDir) | false | `src/memdir/memdir.ts:494` | No automatic memory tracking | memory |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | Override memory storage directory | local cwd-based | `src/memdir/paths.ts:86` | Points memory to mounted storage in CCR | memory |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | Disable CLAUDE.md file loading | false | `src/context.ts:166` | No CLAUDE.md context injection | context/memory |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | Load CLAUDE.md from additional directories | false | `src/utils/claudemd.ts:940` | Reads CLAUDE.md from --add-dir paths | context/memory |
| `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT` | Persist hook_additional_context in transcript | false | `src/utils/sessionStorage.ts:4360` | Saves hook context across sessions (external users) | memory/hooks |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | Full path override for Cowork memory | — | `src/memdir/paths.ts:163` | Forces memory to specific path (Cowork env) | memory |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Extra guidelines text for Cowork memory | — | `src/memdir/memdir.ts:442` | Appended to Cowork memory system prompt | memory |

---

## 10. Hooks

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_ENV_FILE` | Path to shell script sourced before bash commands | — | `src/utils/sessionEnvironment.ts:74` | Injects conda/venv activation | hooks |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | Timeout for Stop hooks | — | `src/main.tsx` | How long to wait for Stop hooks | hooks |
| `CLAUDE_CODE_SHELL_PREFIX` | Command prefix for all shell execution | — | `src/utils/shell/bashProvider.ts:190` | Wraps every shell command (e.g. `docker exec`) | hooks |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disable background task execution | false | `src/entrypoints/cli.tsx:22` | No background agent tasks | hooks/multi-agent |

---

## 11. Session Identity & State

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_SESSION_ID` | Override session UUID | random UUID | `src/commands/clear/conversation.ts:205` | Forces a specific session ID | hooks |
| `CLAUDE_CODE_SESSION_NAME` | Human-readable session name | — | `src/utils/concurrentSessions.ts` | Used in UI and telemetry | none |
| `CLAUDE_CODE_SESSION_KIND` | Session type tag | — | `src/utils/concurrentSessions.ts:33` | Categorizes session (e.g. `remote`, `agent`) | multi-agent |
| `CLAUDE_CODE_SESSION_LOG` | Path to per-session log file | — | `src/utils/concurrentSessions.ts:92` | Appends session events to file | none |
| `CLAUDE_CODE_ENTRYPOINT` | Session entrypoint identifier | `unknown` | `src/constants/system.ts:79` | Included in attribution header; gates local-agent behaviors | hooks |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Remote CCR session ID | — | `src/bridge` | Identifies the remote session | none |
| `ENABLE_SESSION_PERSISTENCE` | Enable remote session transcript persistence (v1 CCR) | false | `src/utils/sessionStorage.ts:1327` | Sends transcript to session ingress | memory |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | Skip writing session history to disk | false | `src/utils/sessionStorage.ts:968` | No transcript files written | memory |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | Resume from interrupted assistant turn | — | `src/cli/print.ts:1172` | Injects previous partial response | context |
| `CLAUDE_CODE_WORKER_EPOCH` | CCR worker epoch for round-trip correlation | — | `src/cli/transports/ccrClient.ts:465` | Remote session state tracking | none |

---

## 12. Remote / CCR Infrastructure

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_REMOTE` | Flag that this is a remote/CCR session | false | `src/cli/print.ts:1711` | Adjusts UI, disables local-only features | none |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | Environment type (`bridge`, etc.) | — | `src/cli/remoteIO.ts:96` | Switches remote IO mode | none |
| `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION` | CCR runner version string | — | `src/cli/remoteIO.ts:66` | Used in version negotiation | none |
| `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` | Remote environment classification | — | `src/services/analytics/metadata.ts:599` | Telemetry tagging | none |
| `CLAUDE_CODE_CONTAINER_ID` | Container ID for CCR environment | — | `src/services/api/client.ts:101` | Included in API headers; gates containerized behaviors | none |
| `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` | Send keepalive pings in remote session | false | `src/utils/sessionActivity.ts:36` | Prevents session timeout | none |
| `CLAUDE_CODE_USE_CCR_V2` | Use CCR v2 transport protocol | false | `src/cli/print.ts:5049` | Switches to new remote transport | none |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | Use v2 session ingress endpoint | false | `src/cli/transports/transportUtils.ts:38` | New session ingress protocol | none |
| `CLAUDE_CODE_CCR_MIRROR` | Enable CCR mirror mode | false | `src/bridge/bridgeEnabled.ts:199` | Mirrors session to bridge | none |
| `CLAUDE_BRIDGE_USE_CCR_V2` | Bridge uses CCR v2 (ant-only) | false | `src/bridge/bridgeMain.ts:916` | Internal bridge CCR v2 flag | none |
| `CCR_ENABLE_BUNDLE` | Enable CCR bundle seeding | false | `src/utils/teleport.tsx:944` | Allows bundled context seeds | context |
| `CCR_FORCE_BUNDLE` | Force CCR bundle on every remote session | false | `src/utils/teleport.tsx:943` | Overrides gate; always bundles | context |
| `CCR_UPSTREAM_PROXY_ENABLED` | Enable upstream proxy in CCR | false | `src/upstreamproxy/upstreamproxy.ts:92` | Routes subprocess traffic through relay | none |
| `CLAUDE_CODE_WORKSPACE_HOST_PATHS` | Host-side workspace paths (for telemetry) | — | `src/utils/telemetry/events.ts:58` | Path mapping for CCR workspaces | none |

---

## 13. Multi-Agent / Swarm / Teams

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Enable agent teams (swarm) feature | false | `src/utils/agentSwarmsEnabled.ts:32` | Unlocks multi-agent orchestration | multi-agent |
| `CLAUDE_CODE_COORDINATOR_MODE` | Mark this instance as a team coordinator | false | `src/coordinator/coordinatorMode.ts:38` | Alters system prompt; enables coordinator tools | multi-agent |
| `CLAUDE_CODE_IS_COWORK` | Mark session as Cowork-type (streaming flush) | false | `src/QueryEngine.ts:458` | Forces eager flush for Cowork frontend | multi-agent |
| `CLAUDE_CODE_COWORKER_TYPE` | Cowork role type (telemetry) | — | `src/services/analytics/metadata.ts:604` | Tags session in analytics | multi-agent |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | Use Cowork's plugin directory | false | `src/utils/plugins/pluginDirectories.ts:40` | Loads plugins from Cowork-managed dir | multi-agent |
| `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` | Number of plan-mode v2 agents | built-in default | `src/utils/planModeV2.ts:7` | Configures UltraPlan agent count | multi-agent |
| `CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT` | Number of explore agents in plan-mode v2 | built-in default | `src/utils/planModeV2.ts:34` | Configures UltraPlan exploration breadth | multi-agent |
| `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` | Trigger interview phase in plan-mode | — | `src/utils/planModeV2.ts:54` | Forces clarifying-questions phase | multi-agent |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | Require plan-mode in all sessions | false | `src/utils/teammate.ts:155` | Forces plan approval before execution | multi-agent |
| `CLAUDE_CODE_VERIFY_PLAN` | Enable plan verification step | — | `src/main.tsx` | Adds verification before plan execution | multi-agent |
| `CLAUDE_CODE_ENABLE_TASKS` | Enable task list management tool | false | `src/utils/tasks.ts:135` | Unlocks task-tracking functionality | multi-agent |
| `CLAUDE_CODE_TASK_LIST_ID` | Override task list ID | — | `src/utils/tasks.ts:200` | Forces specific task list | multi-agent |
| `CLAUDE_CODE_DISABLE_CRON` | Disable cron scheduling tool | false | `src/tools/ScheduleCronTool/prompt.ts:38` | Removes cron tool from available tools | none |
| `CLAUDE_AUTO_BACKGROUND_TASKS` | Enable automatic background task creation | — | `src/tools/AgentTool/AgentTool.tsx:73` | Background agent task automation | multi-agent |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disable background task execution | false | `src/entrypoints/cli.tsx:22` | No async background agent calls | multi-agent |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | Disable built-in agent definitions | false | `src/tools/AgentTool/builtInAgents.ts:26` | Removes default agent capabilities | multi-agent |
| `CLAUDE_CODE_AGENT` | Agent identifier string | — | `src/main.tsx:1130` | Tags agent type in metadata | multi-agent |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` | Include agent list in messages | auto | `src/tools/AgentTool/prompt.ts:60` | Shows/hides agent names in tool calls | multi-agent |

---

## 14. Tool Search (Deferred Tools)

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `ENABLE_TOOL_SEARCH` | Enable/configure tool search | auto (10% threshold) | `src/utils/toolSearch.ts:84` | `true`/`1` = always on; `false`/`0` = always off; `auto` = auto-enable when MCP tools exceed threshold; `auto:N` = use N% threshold | none |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Disable all experimental beta headers | false | `src/utils/toolSearch.ts:181` | Blocks tool search and other experimental betas | none |
| `EMBEDDED_SEARCH_TOOLS` | Enable embedded (built-in) search tools | false | `src/utils/embeddedTools.ts:16` | Exposes native file search as a tool | none |

---

## 15. Feature Betas & Beta Headers

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `ANTHROPIC_BETAS` | Comma-separated extra beta headers | — | `src/utils/betas.ts:361` | Forces additional beta headers on all requests | none |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Disable all experimental betas | false | `src/utils/toolSearch.ts:181` | Prevents sending experimental beta headers | none |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | Disable fast-mode beta | false | `src/query/config.ts:43` | Prevents `fast-mode` beta header | tokens |
| `CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS` | Skip fast-mode on network errors | false | `src/utils/fastMode.ts` | Bypasses fast-mode on connectivity issues | none |
| `USE_CONNECTOR_TEXT_SUMMARIZATION` | Use connector text summarization beta | off | `src/utils/betas.ts:293` | `1` = force on; `0` = force off; absent = GrowthBook gate | context |
| `ENABLE_BETA_TRACING_DETAILED` | Enable detailed beta session tracing | false | `src/utils/telemetry/betaSessionTracing.ts:80` | Requires `BETA_TRACING_ENDPOINT` | none |
| `BETA_TRACING_ENDPOINT` | Endpoint for beta tracing export | — | `src/utils/telemetry/betaSessionTracing.ts:81` | Where to send beta traces | none |

---

## 16. Telemetry & Observability (OTEL)

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Enable third-party OTEL telemetry | false | `src/utils/telemetry/instrumentation.ts:325` | Required to activate OTEL pipeline | none |
| `DISABLE_TELEMETRY` | Disable all telemetry | false | `src/utils/privacyLevel.ts:24` | Suppresses analytics and error reporting | none |
| `DISABLE_ERROR_REPORTING` | Disable Sentry-style error reporting | false | `src/utils/log.ts:173` | No error events sent | none |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | Enable enhanced telemetry (primary override) | false | `src/utils/telemetry/sessionTracing.ts:129` | Enables OTEL tracing spans | none |
| `ENABLE_ENHANCED_TELEMETRY_BETA` | Enable enhanced telemetry (legacy name) | false | `src/utils/telemetry/sessionTracing.ts:130` | Same as above, checked second | none |
| `OTEL_METRICS_EXPORTER` | OTEL metrics exporter type | `none` | `src/utils/telemetry/instrumentation.ts:131` | `otlp`, `console`, `none` | none |
| `OTEL_LOGS_EXPORTER` | OTEL logs exporter type | `none` | `src/utils/telemetry/instrumentation.ts:218` | `otlp`, `console`, `none` | none |
| `OTEL_TRACES_EXPORTER` | OTEL traces exporter type | `none` | `src/utils/telemetry/instrumentation.ts:274` | `otlp`, `console`, `none` | none |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTEL collector endpoint | — | `src/utils/telemetry/instrumentation.ts:223` | Target for all OTEL signals | none |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers for OTEL collector | — | `src/utils/telemetry/instrumentation.ts:751` | Bearer token etc. for OTEL endpoint | none |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Default OTEL export protocol | — | `src/utils/telemetry/instrumentation.ts:100` | `grpc`, `http/protobuf`, `http/json` | none |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | Metrics-specific OTEL protocol | OTEL_EXPORTER_OTLP_PROTOCOL | `src/utils/telemetry/instrumentation.ts:160` | Override for metrics only | none |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Logs-specific OTEL protocol | OTEL_EXPORTER_OTLP_PROTOCOL | `src/utils/telemetry/instrumentation.ts:221` | Override for logs only | none |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Traces-specific OTEL protocol | OTEL_EXPORTER_OTLP_PROTOCOL | `src/utils/telemetry/instrumentation.ts:282` | Override for traces only | none |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics export interval (ms) | 60000 | `src/utils/telemetry/instrumentation.ts:133` | How often metrics flush | none |
| `OTEL_LOGS_EXPORT_INTERVAL` | Logs export interval (ms) | 30000 | `src/utils/telemetry/instrumentation.ts:590` | How often logs flush | none |
| `OTEL_TRACES_EXPORT_INTERVAL` | Traces export interval (ms) | 30000 | `src/utils/telemetry/instrumentation.ts:636` | How often traces flush | none |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | Metrics temporality | `delta` | `src/utils/telemetry/instrumentation.ts:114` | `delta` or `cumulative` | none |
| `OTEL_LOG_USER_PROMPTS` | Log user prompt content in traces | false | `src/utils/telemetry/events.ts:14` | Includes raw prompt text in OTEL logs | none |
| `OTEL_LOG_TOOL_CONTENT` | Log full tool call content in traces | false | `src/utils/telemetry/sessionTracing.ts:739` | Includes tool params/results in spans | none |
| `OTEL_LOG_TOOL_DETAILS` | Log tool details in analytics | false | `src/services/analytics/metadata.ts:87` | Tool parameters included in events | none |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Enable OTEL pipeline (checked again) | false | `src/utils/telemetry/instrumentation.ts:325` | Master switch for 3P OTEL | none |
| `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` | OTEL shutdown timeout | 2000 | `src/utils/telemetry/instrumentation.ts:529` | Time to flush at process exit | none |
| `CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS` | OTEL flush timeout | 5000 | `src/utils/telemetry/instrumentation.ts:714` | Per-flush timeout | none |
| `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` | Debounce for OTEL headers helper | — | `src/utils/telemetry` | Throttles headers helper invocation | none |
| `CLAUDE_CODE_PERFETTO_TRACE` | Enable Perfetto trace output | false | `src/utils/telemetry/perfettoTracing.ts:254` | Writes `.pftrace` performance trace file | none |
| `CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S` | Perfetto write interval (seconds) | — | `src/utils/telemetry/perfettoTracing.ts:286` | How often Perfetto trace flushes | none |
| `ANT_CLAUDE_CODE_METRICS_ENDPOINT` | Ant-internal BigQuery metrics endpoint | — | `src/utils/telemetry/bigqueryExporter.ts:51` | Internal metrics destination | none |
| `ANT_OTEL_METRICS_EXPORTER` | Ant-internal OTEL metrics exporter | — | `src/utils/telemetry/instrumentation.ts:90` | Overrides OTEL_METRICS_EXPORTER for ants | none |
| `ANT_OTEL_LOGS_EXPORTER` | Ant-internal OTEL logs exporter | — | `src/utils/telemetry/instrumentation.ts:93` | Overrides OTEL_LOGS_EXPORTER for ants | none |
| `ANT_OTEL_TRACES_EXPORTER` | Ant-internal OTEL traces exporter | — | `src/utils/telemetry/instrumentation.ts:96` | Overrides OTEL_TRACES_EXPORTER for ants | none |
| `ANT_OTEL_EXPORTER_OTLP_PROTOCOL` | Ant-internal OTEL protocol | — | `src/utils/telemetry/instrumentation.ts:99` | Overrides OTEL_EXPORTER_OTLP_PROTOCOL for ants | none |
| `ANT_OTEL_EXPORTER_OTLP_ENDPOINT` | Ant-internal OTEL endpoint | — | `src/utils/telemetry/instrumentation.ts:103` | Overrides OTEL_EXPORTER_OTLP_ENDPOINT for ants | none |
| `ANT_OTEL_EXPORTER_OTLP_HEADERS` | Ant-internal OTEL headers | — | `src/utils/telemetry/instrumentation.ts:107` | Overrides OTEL_EXPORTER_OTLP_HEADERS for ants | none |
| `CLAUDE_CODE_ACCOUNT_TAGGED_ID` | Account-level tagged ID for telemetry | — | `src/utils/telemetryAttributes.ts:60` | Custom account identifier in telemetry | none |
| `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` | DataDog flush interval | — | `src/utils/telemetry` | DataDog-specific metric flush rate | none |

---

## 17. Proxy & Network

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `HTTPS_PROXY` / `https_proxy` | HTTPS proxy URL | — | `src/utils/proxy.ts` | Routes HTTPS through proxy | none |
| `HTTP_PROXY` / `http_proxy` | HTTP proxy URL | — | `src/utils/proxy.ts` | Routes HTTP through proxy | none |
| `NO_PROXY` / `no_proxy` | Proxy exclusion list | — | `src/utils/proxy.ts:217` | Bypasses proxy for listed hosts | none |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` | Let proxy resolve hostnames | false | `src/utils/proxy.ts:151` | Skips local DNS resolution; needed in sandboxes | none |
| `NODE_EXTRA_CA_CERTS` | Path to extra CA certificates | — | `src/utils/status.tsx:332` | Trusts additional CAs | none |
| `SSL_CERT_FILE` | Path to SSL cert bundle | — | `src/utils/proxy.ts` | Alternative CA cert source | none |
| `CLAUDE_CODE_CLIENT_CERT` | Path to mTLS client certificate | — | `src/utils/status.tsx:342` | Mutual TLS for API requests | none |
| `CLAUDE_CODE_CLIENT_KEY` | Path to mTLS client key | — | `src/utils/status.tsx:348` | Mutual TLS client key | none |
| `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | Passphrase for mTLS client key | — | `src/utils/proxy.ts` | Decrypts mTLS private key | none |

---

## 18. Security & Sandboxing

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_BUBBLEWRAP` | Use bubblewrap sandbox for bash | false | `src/setup.ts:407` | Enables Linux bubblewrap isolation | none |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | Disable command injection detection | false | `src/tools/BashTool/bashPermissions.ts:1219` | Turns off injection detection in permission checks | none |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | Extra protection header value | — | `src/services/api/client.ts:125` | Adds protection header to API requests | none |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Scrub secrets from subprocess env | false | `src/utils/subprocessEnv.ts:86` | Strips credentials from child process environment | none |
| `ALLOW_ANT_COMPUTER_USE_MCP` | Allow computer-use MCP (ant-only) | false | `src/utils/computerUse/gates.ts:53` | Bypasses monorepo access check for computer-use | none |
| `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` | Show sandbox indicator in Bash tool | false | `src/tools/BashTool/BashTool.tsx:502` | UI indicator that bash is sandboxed | none |
| `IS_SANDBOX` | Mark instance as sandbox environment | — | `src/utils/env.ts` | Metadata tag; affects feature gating | none |

---

## 19. Configuration & Settings Paths

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CONFIG_DIR` | Override Claude config directory | `~/.claude` | `src/utils/envUtils.ts:10` | All settings, sessions, memory stored here | memory |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH` | Path to MDM/managed settings file (ant-only) | — | `src/utils/settings/managedPath.ts:14` | Org-controlled settings override | none |
| `CLAUDE_CODE_TMPDIR` | Override temp directory for Claude | OS default | `src/utils/tmuxSocket.ts` | Where temp files are written | none |
| `CLAUDE_CODE_DEBUG_LOGS_DIR` | Directory for debug log files | Claude config dir | `src/utils/debug.ts:233` | Separate debug log location | none |
| `CLAUDE_CODE_DIAGNOSTICS_FILE` | Path to diagnostics output file | — | `src/utils/diagLogs.ts:60` | Writes diagnostics here | none |
| `CLAUDE_CODE_EXTRA_BODY` | JSON object merged into API request body | — | `src/services/api/claude.ts:274` | Injects arbitrary API parameters | none |
| `CLAUDE_CODE_EXTRA_METADATA` | JSON object merged into API request metadata | — | `src/services/api/claude.ts:506` | Injects arbitrary metadata | none |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | Control attribution header | enabled | `src/constants/system.ts:53` | `0`/`false` = disable; enables billing attribution | none |
| `ANTHROPIC_CUSTOM_HEADERS` | Custom headers to add to all API requests | — | `src/services/api/client.ts:332` | Inject arbitrary headers | none |
| `CLAUDE_CODE_ENABLE_XAA` | Enable XAA (SEP-990) IdP feature | false | `src/utils/settings/types.ts:284` | Unlocks xaaIdp settings schema | none |
| `CLAUDE_CODE_TAGS` | Tags for telemetry | — | `src/utils/telemetry` | Label sessions with custom tags | none |
| `CLAUDE_CODE_OVERRIDE_DATE` | Override the current date | system date | `src/constants/common.ts:6` | Returns fixed date for prompt caching stability (ant-only) | caching |

---

## 20. Plugin System

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | Override plugin cache directory | `~/.claude/plugins` | `src/utils/plugins/pluginDirectories.ts:58` | Redirects all plugin storage | none |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | Pre-seeded plugin registry dir | — | `src/utils/plugins/pluginDirectories.ts:87` | Docker-style pre-bundled plugins | none |
| `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` | Git timeout for plugin install/update | 120000 (2 min) | `src/utils/plugins/marketplaceManager.ts:518` | Controls git clone/pull timeout | none |
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | Use zip cache for plugins | false | `src/utils/plugins/zipCache.ts:56` | Stores plugins as zips for fast deploy | none |
| `CLAUDE_CODE_DISABLE_POLICY_SKILLS` | Disable policy-managed skills | false | `src/skills/loadSkillsDir.ts:686` | Removes MDM-pushed skills from loader | none |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | Skip official marketplace auto-install | false | `src/utils/plugins/officialMarketplaceStartupCheck.ts:49` | No automatic plugin install at startup | none |
| `FORCE_AUTOUPDATE_PLUGINS` | Force plugin updates even if auto-update disabled | false | `src/utils/config.ts:1713` | Overrides DISABLE_AUTOUPDATER for plugins | none |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | Synchronous plugin install on startup | false | `src/cli/print.ts:1739` | Blocks startup until plugins installed | none |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | Timeout for sync plugin install | — | `src/cli/print.ts:1888` | How long to wait for sync install | none |

---

## 21. IDE Integration

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_SSE_PORT` | SSE server port for IDE integration | — | `src/utils/ide.ts:671` | When set, enables SSE-based IDE connection | none |
| `CLAUDE_CODE_AUTO_CONNECT_IDE` | Auto-connect to IDE extension | conditional | `src/hooks/useIDEIntegration.tsx:33` | `0`/`false` = disable even in supported terminal | none |
| `CLAUDE_CODE_IDE_HOST_OVERRIDE` | Override IDE hostname | — | `src/utils/ide.ts:1356` | Forces specific IDE host | none |
| `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` | Skip automatic IDE extension install | false | `src/utils/ide.ts:1301` | Don't prompt/install IDE extensions | none |
| `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` | Skip IDE connection validation | false | `src/utils/ide.ts:697` | Bypasses IDE protocol handshake | none |
| `CLAUDE_CODE_MESSAGING_SOCKET` | Unix socket path for IDE messaging | — | `src/utils/concurrentSessions.ts:87` | IPC channel for IDE-Claude communication | none |
| `FORCE_CODE_TERMINAL` | Force VS Code terminal mode | false | `src/utils/ide.ts:283` | Treats terminal as VS Code | none |

---

## 22. MCP (Model Context Protocol)

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `MCP_TIMEOUT` | MCP server connection timeout (ms) | 30000 | `src/services/mcp/client.ts:457` | How long to wait for MCP server | none |
| `MCP_TOOL_TIMEOUT` | MCP tool call timeout (ms) | ~27.8 hours | `src/services/mcp/client.ts:226` | Per-tool call timeout | none |
| `MAX_MCP_OUTPUT_TOKENS` | Max token output from MCP tools | 25000 | `src/utils/mcpValidation.ts:27` | Truncates large MCP responses | tokens |
| `MCP_SERVER_CONNECTION_BATCH_SIZE` | Batch size for MCP server connections | — | `src/services/mcp/client.ts` | Parallel connection limit | none |
| `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` | Remote MCP server batch size | — | `src/services/mcp/client.ts` | Remote connection parallelism | none |
| `ENABLE_MCP_LARGE_OUTPUT_FILES` | Enable large file outputs from MCP | true | `src/services/mcp/client.ts:2741` | `0`/`false` = disable large outputs | tokens |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Enable claude.ai built-in MCP servers | true | `src/services/mcp/claudeai.ts:42` | `0`/`false` = disable claude.ai MCP | none |
| `CLAUDE_CODE_MCP_INSTR_DELTA` | Use delta mode for MCP instructions | GrowthBook gate | `src/utils/mcpInstructionsDelta.ts:38` | `1` = always use delta; `0` = always use full | context |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | Disable MCP tool name prefixing in Agent SDK | false | `src/services/mcp/client.ts:1763` | Tool names not prefixed with server name | none |
| `MCP_XAA_IDP_CLIENT_SECRET` | Client secret for XAA MCP IdP | — | `src/commands/mcp/xaaIdpCommand.ts:87` | Auth for XAA identity provider | none |
| `MCP_CLIENT_SECRET` | MCP OAuth client secret | — | `src/services/mcp/client.ts` | OAuth for MCP remote servers | none |
| `MCP_OAUTH_CALLBACK_PORT` | OAuth callback port for MCP | — | `src/services/mcp/client.ts` | MCP OAuth redirect port | none |
| `MCP_OAUTH_CLIENT_METADATA_URL` | OAuth metadata URL for MCP | — | `src/services/mcp/client.ts` | MCP OAuth discovery endpoint | none |

---

## 23. Shell & Ripgrep

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_SHELL` | Override shell executable | auto-detected | `src/utils/Shell.ts:75` | Forces specific bash/zsh path | none |
| `CLAUDE_CODE_SHELL_PREFIX` | Prefix command for all shell invocations | — | `src/utils/shell/bashProvider.ts:190` | Wraps every command (e.g. container exec, nix-shell) | hooks |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | Enable PowerShell tool | ant: on by default | `src/utils/shell/shellToolUtils.ts:20` | Shows PowerShell tool option | none |
| `CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS` | PowerShell parse timeout | 5000 | `src/utils/powershell/parser.ts:209` | Timeout for PS command parsing | none |
| `CLAUDE_CODE_GIT_BASH_PATH` | Path to Git Bash on Windows | auto-detected | `src/utils/windowsPaths.ts:99` | Override Git Bash location | none |
| `USE_BUILTIN_RIPGREP` | Use built-in ripgrep vs system | true | `src/utils/ripgrep.ts:33` | `0`/`false` = use system `rg` | none |
| `CLAUDE_CODE_GLOB_NO_IGNORE` | Don't respect .gitignore in glob | true | `src/utils/glob.ts:98` | `0`/`false` = respect .gitignore | none |
| `CLAUDE_CODE_GLOB_HIDDEN` | Include hidden files in glob | true | `src/utils/glob.ts:99` | `0`/`false` = exclude hidden files | none |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | Timeout for glob operations | 0 (no timeout) | `src/utils/ripgrep.ts:132` | Kills long glob searches | none |
| `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` | Use native Node.js file search | false | `src/utils/markdownConfigLoader.ts:558` | Bypasses ripgrep for CLAUDE.md lookup | none |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | Reset cwd to project root after each command | false | `src/utils/envUtils.ts:112` | Re-cd's to project dir after bash | none |

---

## 24. Effort / Budget Control

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_EFFORT_LEVEL` | Default effort level | — | `src/commands/effort/effort.tsx:37` | Pre-sets effort slider (`low`, `medium`, `high`, or numeric) | tokens |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | Always show effort control | false | `src/utils/effort.ts:25` | Forces effort control visible regardless of model | tokens |

---

## 25. Session Transcript & Persistence

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_JSONL_TRANSCRIPT` | Path for JSONL transcript output | — | `src/utils/permissions/yoloClassifier.ts:1381` | Writes auto-mode decisions to file | none |
| `CLAUDE_CODE_SESSION_LOG` | Path for per-session event log | — | `src/utils/concurrentSessions.ts:92` | Structured session event log | none |
| `ENABLE_SESSION_PERSISTENCE` | Enable remote session transcript persistence | false | `src/utils/sessionStorage.ts:1327` | v1 CCR transcript forwarding | memory |
| `TEST_ENABLE_SESSION_PERSISTENCE` | Enable persistence in test environment | false | `src/utils/sessionStorage.ts:962` | Testing override for persistence | memory |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | Don't write session history | false | `src/utils/sessionStorage.ts:968` | No `.jsonl` transcript files | memory |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | Disable file edit checkpointing | false | `src/utils/fileHistory.ts:69` | No undo history for file edits | none |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | Enable file checkpointing in SDK mode | false | `src/utils/fileHistory.ts:75` | File checkpoint history in SDK sessions | none |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` | Emit session state events via stdout | false | `src/utils/sessionState.ts:127` | JSON session state events on stdout | none |
| `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` | Emit tool-use summary events | — | `src/query/config.ts:37` | Include tool summaries in events | none |
| `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES` | Include partial streaming messages | false | `src/main.tsx:1239` | Non-interactive: stream in-progress tokens | none |

---

## 26. UI & Display

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_NO_FLICKER` | Enable flicker-free (fullscreen) rendering | ant: true; external: false | `src/utils/fullscreen.ts:114` | Uses alternate screen buffer | none |
| `CLAUDE_CODE_STREAMLINED_OUTPUT` | Streamlined output mode (non-interactive) | false | `src/cli/print.ts:858` | Transforms messages for JSON stream | none |
| `CLAUDE_CODE_BRIEF` | Brief output mode (hides spinners, truncates) | false | `src/components/Spinner.tsx:72` | Minimal UI output | none |
| `CLAUDE_CODE_BRIEF_UPLOAD` | Brief upload progress display | false | `src/tools/BriefTool/attachments.ts:95` | Simplified upload feedback | none |
| `CLAUDE_CODE_FORCE_FULL_LOGO` | Force full logo display | false | `src/components/LogoV2/LogoV2.tsx:118` | Shows full logo even in narrow terminal | none |
| `CLAUDE_CODE_SCROLL_SPEED` | Scroll speed multiplier | 1 | `src/components/ScrollKeybindingHandler.tsx:306` | Range (0, 20]; e.g. `3` for smooth scroll | none |
| `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` | Disable virtual scrolling | false | `src/screens/REPL.tsx` | Forces all messages to render | none |
| `CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS` | Disable message action buttons | false | `src/screens/REPL.tsx:608` | No copy/feedback buttons on messages | none |
| `CLAUDE_CODE_ACCESSIBILITY` | Enable accessibility mode | false | `src/ink/components/App.tsx:183` | Disables mouse, enables screen-reader text | none |
| `CLAUDE_CODE_DISABLE_MOUSE` | Disable all mouse events | false | `src/ink/components/App.tsx` | No mouse tracking | none |
| `CLAUDE_CODE_DISABLE_MOUSE_CLICKS` | Disable mouse click events | false | `src/ink/components/App.tsx` | Clicks not captured | none |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | Don't update terminal tab title | false | `src/utils/managedEnvConstants.ts:139` | Leaves terminal title unchanged | none |
| `CLAUDE_CODE_DEBUG_REPAINTS` | Show repaint indicators | false | `src/ink` | Visual debugging for renderer | none |
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | Override syntax highlight theme | `BAT_THEME` value | `src/native-ts/color-diff/index.ts:974` | Sets code highlighting theme | none |
| `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` | Format for question preview | — | `src/main.tsx:848` | Controls how question previews appear | none |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | Disable non-streaming API fallback | false | `src/services/api/claude.ts:2470` | Won't retry with non-streaming on error | none |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | Enable prompt suggestion feature | true | `src/cli/print.ts:2277` | `0`/`false` = disable prompt suggestions | none |
| `CLAUDE_CODE_SIMPLE` | Bare/simple mode (no hooks, LSP, etc.) | false | `src/utils/envUtils.ts:62` | Equivalent to `--bare` CLI flag | hooks |
| `IS_DEMO` | Demo mode (hides org/email, disables some features) | false | `src/components/LogoV2/LogoV2.tsx:213` | Sanitized display for demos | none |
| `DEMO_VERSION` | Demo version string | — | `src/components/LogoV2/LogoV2.tsx:225` | Used in demo builds | none |

---

## 27. Tmux Integration

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_TMUX_SESSION` | Name of tmux session (set by CC) | — | `src/components/LogoV2/LogoV2.tsx:194` | Displayed in logo; set by CC itself | none |
| `CLAUDE_CODE_TMUX_PREFIX` | Tmux prefix key (set by CC) | — | `src/components/LogoV2/LogoV2.tsx:194` | Shown in detach instructions | none |
| `CLAUDE_CODE_TMUX_PREFIX_CONFLICTS` | Whether tmux prefix conflicts (set by CC) | — | `src/components/LogoV2/LogoV2.tsx:194` | Adjusts detach instructions display | none |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | Force truecolor in tmux | — | `src/utils/tmuxSocket.ts` | Enables 24-bit color in tmux | none |
| `TMUX` | Tmux socket path (OS-provided) | — | `src/utils/swarm/backends/detection.ts:10` | Detected at startup; cannot be set | none |
| `TMUX_PANE` | Tmux pane ID (OS-provided) | — | `src/utils/swarm/backends/detection.ts:19` | Current pane identifier | none |

---

## 28. Auto-Update & Installation

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `DISABLE_AUTOUPDATER` | Disable automatic Claude Code updates | false | `src/utils/config.ts:1739` | No automatic version upgrades | none |
| `DISABLE_UPGRADE_COMMAND` | Disable /upgrade command | false | `src/commands/upgrade/index.ts:11` | Removes upgrade option | none |
| `ENABLE_LOCKLESS_UPDATES` | Skip file lock during updates | false | `src/utils/nativeInstaller/installer.ts:568` | Lockless update install | none |
| `ENABLE_PID_BASED_VERSION_LOCKING` | Use PID-based version lock | auto | `src/utils/nativeInstaller/pidLock.ts:36` | Forces on/off PID locking | none |
| `DISABLE_INSTALLATION_CHECKS` | Skip installation validation | false | `src/utils/nativeInstaller/installer.ts:804` | No version/integrity checks | none |

---

## 29. Feedback & Surveys

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | Disable all feedback surveys | false | `src/components/FeedbackSurvey/useFeedbackSurvey.tsx:229` | No survey prompts | none |
| `CLAUDE_FORCE_DISPLAY_SURVEY` | Force survey display for testing | false | `src/components/FeedbackSurvey/useFeedbackSurvey.tsx:223` | Shows survey even if recently shown | none |
| `DISABLE_BUG_COMMAND` | Disable /bug command | false | `src/commands/feedback/index.ts:18` | Removes bug report command | none |
| `DISABLE_FEEDBACK_COMMAND` | Disable /feedback command | false | `src/commands/feedback/index.ts:17` | Removes feedback command | none |
| `DISABLE_COST_WARNINGS` | Suppress cost threshold warnings | false | `src/utils/billing.ts:12` | No dollar-amount warnings | none |

---

## 30. Development & Debugging (Internal)

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_PROFILE_STARTUP` | Enable startup performance profiling | false | `src/utils/startupProfiler.ts:26` | Detailed startup timing log | none |
| `CLAUDE_CODE_PROFILE_QUERY` | Enable query pipeline profiling | false | `src/utils/queryProfiler.ts:36` | Times user-input → first-token pipeline | none |
| `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS` | Threshold for slow operation warnings | 100 | `src/utils/slowOperations.ts:30` | Logs operations slower than this | none |
| `CLAUDE_CODE_FRAME_TIMING_LOG` | Path for frame timing log | — | `src/interactiveHelpers.tsx:319` | Records render frame times | none |
| `CLAUDE_CODE_COMMIT_LOG` | Path for ink reconciler commit log | — | `src/ink/reconciler.ts:191` | Logs React reconciler commits | none |
| `CLAUDE_CODE_TERMINAL_RECORDING` | Record terminal as asciicast (ant-only) | false | `src/main.tsx:2235` | Writes `.cast` asciinema file | none |
| `CLAUDE_CODE_DUMP_AUTO_MODE` | Dump auto-mode classifier data | false | `src/utils/permissions/yoloClassifier.ts:160` | Writes classifier decisions to temp files | none |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | Debug log verbosity level | — | `src/utils/debug.ts` | Controls which debug messages appear | none |
| `CLAUDE_DEBUG` | Enable debug mode | false | `src/utils/warningHandler.ts:109` | Verbose warning output | none |
| `CLAUDE_CODE_TWO_STAGE_CLASSIFIER` | Enable two-stage auto-mode classifier | — | `src/utils/permissions/yoloClassifier.ts:1359` | Second-pass classification for permissions | none |
| `CLAUDE_CODE_ABLATION_BASELINE` | Run in ablation baseline mode | false | `src/entrypoints/cli.tsx:21` | Strips features for A/B comparison | none |
| `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` | Exit after first render (ant testing) | false | `src/cli/print.ts:495` | Used for render performance tests | none |
| `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` | Delay before exit after stop signal | 0 | `src/utils/idleTimeout.ts:16` | Grace period after session stop | none |
| `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` | Idle timeout (minutes) | 75 | `src/screens/REPL.tsx:3294` | Minutes before idle warning shown | none |
| `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD` | Token count threshold for idle consideration | 100000 | `src/screens/REPL.tsx:3295` | Min tokens used before idle logic triggers | none |
| `CLAUDE_CODE_UNATTENDED_RETRY` | Enable extended retries for unattended sessions | false | `src/services/api/withRetry.ts:102` | More aggressive retry on 429/529 | none |
| `CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING` | Download stall timeout for tests | — | `src/utils/nativeInstaller/download.ts:277` | Testing override for download stall detection | none |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | Enable fine-grained tool streaming | false | `src/utils/api.ts:203` | Streams tool results as they arrive | none |
| `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT` | Attach token usage to responses | false | `src/utils/attachments.ts:3811` | Includes usage stats in context | tokens |
| `CLAUDE_CODE_DISABLE_ATTACHMENTS` | Disable context attachments | false | `src/utils/attachments.ts:753` | No file/image/context attachments | context |
| `ENABLE_GROWTHBOOK_DEV` | Enable GrowthBook dev mode | false | `src/services/analytics/growthbook.ts` | DevTools mode for feature flags | none |
| `FORCE_VCR` | Force VCR (record/replay) mode (ant-only) | false | `src/services/vcr.ts:28` | Records API calls for replay | none |
| `VCR_RECORD` | VCR record mode | — | `src/services/vcr.ts` | Record vs replay mode for VCR | none |
| `CLAUDE_CODE_BASE_REF` | Git base ref for diff context | — | `src/utils/gitDiff.ts:492` | Used in git diff operations | none |

---

## 31. Proactive Features

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_CODE_PROACTIVE` | Enable proactive mode (auto-actions) | false | `src/cli/print.ts:542` | Triggers proactive task detection | none |
| `CLAUDE_CODE_REPL` | Enable REPL tool | model-dependent | `src/tools/REPLTool/constants.ts:24` | `0`/`false` = disable REPL tool | none |
| `CLAUDE_REPL_MODE` | Legacy REPL mode enable | false | `src/tools/REPLTool/constants.ts:25` | Forces REPL tool on | none |
| `CLAUDE_CODE_ADVISOR_TOOL` | Enable advisor tool | GrowthBook | `src/utils/advisor.ts:61` | `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` disables it | none |
| `ENABLE_LSP_TOOL` | Enable LSP (Language Server Protocol) tool | false | `src/tools.ts:224` | Adds LSP tool to available tools | none |

---

## 32. Agent SDK Integration

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `CLAUDE_AGENT_SDK_VERSION` | Version string of Agent SDK | — | `src/utils/http.ts:19` | Included in User-Agent header | none |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | Client app name from Agent SDK | — | `src/utils/http.ts:24` | Included in User-Agent header | none |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | Disable Agent SDK built-in agents | false | `src/tools/AgentTool/builtInAgents.ts:26` | No default agent types | multi-agent |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | Disable MCP prefix in Agent SDK | false | `src/services/mcp/client.ts:1763` | Tool names are unprefixed | none |
| `DEBUG_SDK` | Enable SDK debug logging | false | `src/utils/debug.ts` | Verbose SDK output | none |

---

## 33. GitHub Actions & CI Environment Detection

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `GITHUB_ACTIONS` | GHA environment marker | — | `src/utils/user.ts:116` | Detected; enables GHA-specific features | none |
| `GITHUB_ACTOR` | GHA actor username | — | `src/utils/user.ts:118` | Telemetry for GHA runs | none |
| `GITHUB_ACTOR_ID` | GHA actor ID | — | `src/utils/user.ts:119` | GHA telemetry | none |
| `GITHUB_REPOSITORY` | GHA repository | — | `src/utils/user.ts:120` | GHA telemetry | none |
| `GITHUB_REPOSITORY_ID` | GHA repository ID | — | `src/utils/user.ts:121` | GHA telemetry | none |
| `GITHUB_REPOSITORY_OWNER` | GHA repository owner | — | `src/utils/user.ts:122` | GHA telemetry | none |
| `GITHUB_REPOSITORY_OWNER_ID` | GHA repository owner ID | — | `src/utils/user.ts:123` | GHA telemetry | none |
| `GITHUB_EVENT_NAME` | GHA event name | — | `src/utils/user.ts` | GHA event context | none |
| `GITHUB_ACTION_PATH` | GHA action path | — | `src/commands/install-github-app` | Action install path | none |
| `GITHUB_ACTION_INPUTS` | GHA action inputs JSON | — | `src/commands/install-github-app` | Input parameters for action | none |
| `CLAUDE_CODE_ACTION` | Mark as claude-code-action session | false | `src/main.tsx:543` | Enables GHA-specific behaviors | none |
| `CI` | Generic CI marker | — | `src/utils/renderOptions.ts:28` | Disables color, adjusts rendering | none |
| `RUNNER_ENVIRONMENT` | GitHub runner environment | — | `src/utils/env.ts` | Environment detection | none |
| `RUNNER_OS` | Runner OS | — | `src/utils/env.ts` | OS detection in runners | none |
| `BUILDKITE` | Buildkite CI marker | — | `src/utils/env.ts:288` | CI environment detection | none |
| `CIRCLECI` | CircleCI marker | — | `src/utils/env.ts:287` | CI environment detection | none |
| `SWE_BENCH_INSTANCE_ID` | SWE-bench instance ID | — | `src/utils/env.ts` | SWE-bench evaluation marker | none |
| `SWE_BENCH_RUN_ID` | SWE-bench run ID | — | `src/utils/env.ts` | SWE-bench run tracking | none |
| `SWE_BENCH_TASK_ID` | SWE-bench task ID | — | `src/utils/env.ts` | SWE-bench task tracking | none |

---

## 34. Ant-Internal (USER_TYPE=ant Only)

These variables only have effect when `USER_TYPE=ant`.

| Variable | Controls | Default | File:Line | Effect | Claudex Relevance |
|----------|----------|---------|-----------|--------|-------------------|
| `USER_TYPE` | Identifies internal (`ant`) vs external user | `external` | `src/utils/sessionStorage.ts:420` | Gates ~50+ ant-only code paths | none |
| `COO_RUNNING_ON_HOMESPACE` | Running on Homespace cloud (ant) | false | `src/utils/envUtils.ts:121` | Affects credential lookup | none |
| `COO_CREATOR` | Homespace creator username | — | `src/utils/user.ts:154` | Constructs ant email address | none |
| `CLAUDE_CODE_UNDERCOVER` | Undercover mode (ant) | false | `src/utils/undercover.ts:30` | Hides Anthropic identity in responses | none |
| `SAFEUSER` | Safe username for ant environments | — | `src/commands/commit-push-pr.ts:34` | Used in git commit attribution | none |
| `SPACE_CREATOR_USER_ID` | Homespace creator user ID | — | `src/utils/user.ts` | Homespace user tracking | none |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | Bridge OAuth token (ant) | — | `src/bridge/bridgeConfig.ts:21` | Bridge authentication | none |
| `ULTRAPLAN_PROMPT_FILE` | Path to UltraPlan prompt file (ant) | — | `src/commands/ultraplan.tsx:56` | Overrides UltraPlan instructions | none |
| `BUGHUNTER_DEV_BUNDLE_B64` | Base64 dev bundle for bug hunter (ant) | — | `src/commands/review/reviewRemote.ts:200` | Dev bundle for remote review | none |
| `CLAUDE_CODE_ACCOUNT_TAGGED_ID` | Tagged account ID for telemetry | — | `src/utils/telemetryAttributes.ts:60` | Ant account identification in OTEL | none |
| `MONOREPO_ROOT_DIR` | Monorepo root (ant) | — | `src/utils/env.ts` | Monorepo-specific path resolution | none |
| `ENABLE_GROWTHBOOK_DEV` | GrowthBook dev mode | false | `src/services/analytics/growthbook.ts` | Feature flag dev tools | none |
| `CLAUDE_MOCK_HEADERLESS_429` | Simulate headerless 429 errors (ant testing) | false | `src/services/api/withRetry.ts` | Test retry behavior | none |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | Disable git instructions in prompt | false | `src/utils/systemPrompt.ts` | Removes git guidance from system prompt | context |

---

## 35. Vertex Region Overrides

Each maps a model prefix to a specific Vertex region. All default to `CLOUD_ML_REGION` if unset.

| Variable | Model Prefix | File:Line |
|----------|-------------|-----------|
| `VERTEX_REGION_CLAUDE_HAIKU_4_5` | `claude-haiku-4-5` | `src/utils/envUtils.ts:156` |
| `VERTEX_REGION_CLAUDE_3_5_HAIKU` | `claude-3-5-haiku` | `src/utils/envUtils.ts:157` |
| `VERTEX_REGION_CLAUDE_3_5_SONNET` | `claude-3-5-sonnet` | `src/utils/envUtils.ts:158` |
| `VERTEX_REGION_CLAUDE_3_7_SONNET` | `claude-3-7-sonnet` | `src/utils/envUtils.ts:159` |
| `VERTEX_REGION_CLAUDE_4_1_OPUS` | `claude-opus-4-1` | `src/utils/envUtils.ts:160` |
| `VERTEX_REGION_CLAUDE_4_0_OPUS` | `claude-opus-4` | `src/utils/envUtils.ts:161` |
| `VERTEX_REGION_CLAUDE_4_6_SONNET` | `claude-sonnet-4-6` | `src/utils/envUtils.ts:162` |
| `VERTEX_REGION_CLAUDE_4_5_SONNET` | `claude-sonnet-4-5` | `src/utils/envUtils.ts:163` |
| `VERTEX_REGION_CLAUDE_4_0_SONNET` | `claude-sonnet-4` | `src/utils/envUtils.ts:164` |

---

## 36. Beta Header Constants (Not env vars — for reference)

These are hardcoded beta headers sent in API requests. Controlled by logic + env vars above.

| Constant | Value | Controlled By |
|----------|-------|---------------|
| `CLAUDE_CODE_20250219_BETA_HEADER` | `claude-code-20250219` | Always sent |
| `INTERLEAVED_THINKING_BETA_HEADER` | `interleaved-thinking-2025-05-14` | `DISABLE_INTERLEAVED_THINKING` |
| `CONTEXT_1M_BETA_HEADER` | `context-1m-2025-08-07` | `CLAUDE_CODE_DISABLE_1M_CONTEXT` |
| `CONTEXT_MANAGEMENT_BETA_HEADER` | `context-management-2025-06-27` | `USE_API_CONTEXT_MANAGEMENT` |
| `STRUCTURED_OUTPUTS_BETA_HEADER` | `structured-outputs-2025-12-15` | Automatic |
| `WEB_SEARCH_BETA_HEADER` | `web-search-2025-03-05` | Automatic |
| `TOOL_SEARCH_BETA_HEADER_1P` | `advanced-tool-use-2025-11-20` | `ENABLE_TOOL_SEARCH` |
| `TOOL_SEARCH_BETA_HEADER_3P` | `tool-search-tool-2025-10-19` | `ENABLE_TOOL_SEARCH` (Bedrock/Vertex) |
| `EFFORT_BETA_HEADER` | `effort-2025-11-24` | Effort level controls |
| `TASK_BUDGETS_BETA_HEADER` | `task-budgets-2026-03-13` | Automatic when task budgets active |
| `PROMPT_CACHING_SCOPE_BETA_HEADER` | `prompt-caching-scope-2026-01-05` | 1P only |
| `FAST_MODE_BETA_HEADER` | `fast-mode-2026-02-01` | `CLAUDE_CODE_DISABLE_FAST_MODE` |
| `REDACT_THINKING_BETA_HEADER` | `redact-thinking-2026-02-12` | Automatic |
| `TOKEN_EFFICIENT_TOOLS_BETA_HEADER` | `token-efficient-tools-2026-03-28` | Automatic |
| `ADVISOR_BETA_HEADER` | `advisor-tool-2026-03-01` | `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` |
| `CLI_INTERNAL_BETA_HEADER` | `cli-internal-2026-02-09` | `USER_TYPE=ant` only |

---

## Claudex-Relevant Summary

Flags that directly impact memory, caching, context, hooks, tokens, or multi-agent behavior:

### Memory
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY` — turns off MemDir
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` — CCR memory mount path
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS` — stops CLAUDE.md injection
- `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT` — persists hook output in transcript
- `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` — Cowork memory
- `ENABLE_SESSION_PERSISTENCE`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY` — transcript storage

### Caching
- `DISABLE_PROMPT_CACHING`, `DISABLE_PROMPT_CACHING_HAIKU/SONNET/OPUS` — cache_control markers
- `ENABLE_PROMPT_CACHING_1H_BEDROCK` — 1h TTL on Bedrock
- `CLAUDE_CODE_OVERRIDE_DATE` — date stability for cache

### Context
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` — context window sizing
- `DISABLE_AUTO_COMPACT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `API_MAX_INPUT_TOKENS` — compaction triggers
- `USE_API_CONTEXT_MANAGEMENT` — API-side context management beta
- `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` — full transcript loading

### Hooks
- `CLAUDE_CODE_SIMPLE` — disables hooks entirely
- `CLAUDE_CODE_SHELL_PREFIX` — wraps all shell commands run by hooks
- `CLAUDE_ENV_FILE` — sourced before bash commands
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN` — hook auth token
- `CLAUDE_CODE_ENTRYPOINT` — identifies hook caller context

### Tokens & Cost
- `MAX_THINKING_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_DISABLE_THINKING` — token budgets
- `CLAUDE_CODE_EFFORT_LEVEL` — effort/budget slider
- `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `TASK_MAX_OUTPUT_LENGTH` — output truncation

### Multi-Agent
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_COORDINATOR_MODE` — swarm mode
- `CLAUDE_CODE_IS_COWORK`, `CLAUDE_CODE_USE_COWORK_PLUGINS` — Cowork environment
- `CLAUDE_CODE_PLAN_V2_AGENT_COUNT`, `CLAUDE_CODE_PLAN_MODE_REQUIRED` — plan mode
- `CLAUDE_CODE_ENABLE_TASKS`, `TASK_MAX_OUTPUT_LENGTH` — task management
- `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` — parallel tool execution limit
