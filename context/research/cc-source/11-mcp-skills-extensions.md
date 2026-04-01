# CC MCP Integration, Skills System, and Extension Points

Research date: 2026-04-01
Source: `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`

---

## 1. MCP Integration Architecture

### Transport Types

CC supports six transport mechanisms for MCP servers, defined in `src/services/mcp/types.ts`:

```typescript
// TransportSchema (line 23-26)
z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk'])
```

Config types per transport:
- **stdio** (`McpStdioServerConfigSchema`, line 28): `{ command, args, env }` — spawns subprocess
- **sse** (`McpSSEServerConfigSchema`, line 58): `{ type, url, headers, headersHelper, oauth }` — SSE remote
- **sse-ide** (`McpSSEIDEServerConfigSchema`, line 69): IDE extension SSE (internal)
- **http** (`McpHTTPServerConfigSchema`, line 89): Streamable HTTP (MCP 2025-03-26 spec)
- **ws** / **ws-ide**: WebSocket transports
- **sdk** (`McpSdkServerConfigSchema`, line 108): In-process, SDK-managed — no subprocess spawned
- **claudeai-proxy** (`McpClaudeAIProxyServerConfigSchema`, line 115): claude.ai connector routing

### Config Scopes

`src/services/mcp/types.ts` line 10-21:
```typescript
z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed'])
```

Config comes from (in priority order, `src/services/mcp/config.ts`):
1. **enterprise** — `getManagedFilePath()/.managed-mcp.json` (exclusive control, blocks all others when present)
2. **managed** — `getManagedFilePath()/.claude/` (policy settings)
3. **user** — `~/.claude/config.json` `mcpServers` key
4. **project** — `.mcp.json` in cwd and parents
5. **local** — `~/.claude/projects/<hash>/config.json` `mcpServers` key
6. **dynamic** — runtime-added (plugins, SDK, `--mcp-config` flag)
7. **claudeai** — fetched from claude.ai connectors (OAuth required)

### Connection Flow

`src/services/mcp/client.ts` `connectToServer()` (line 595, memoized with `getServerCacheKey`):

1. Reads `ScopedMcpServerConfig.type` to select transport
2. For **stdio**: spawns subprocess via `StdioClientTransport`, captures stderr, respects `CLAUDE_CODE_SHELL_PREFIX` env var (line 946)
3. For **sse**: creates `SSEClientTransport` with `ClaudeAuthProvider` + OAuth retry
4. For **http**: creates `StreamableHTTPClientTransport` with 60s per-request timeout wrapper (`wrapFetchWithTimeout`, line 492)
5. For **ws**: creates `WebSocketTransport` with mTLS support
6. For **sdk**: throws — handled separately via `SdkControlClientTransport` in SDK bridge
7. For **claudeai-proxy**: routes through `${MCP_PROXY_URL}${MCP_PROXY_PATH}` with OAuth bearer token
8. Special **in-process** servers (claude-in-chrome, computer-use): uses `InProcessTransport` linked pair — no subprocess, no network

After transport creation:
- Creates `Client` with `{name:'claude-code', capabilities:{roots:{}, elicitation:{}}}`
- Registers `ListRootsRequestSchema` handler returning `file://${cwd}` (line 1009)
- Registers default `ElicitRequestSchema` handler returning `cancel` (line 1191)
- Connection timeout: env `MCP_TIMEOUT` or 30000ms
- On success: calls `fetchToolsForClient`, `fetchResourcesForClient`, `fetchCommandsForClient`

### Tool Registration from MCP

`fetchToolsForClient` (line 1743, LRU-memoized by server name):
```
client.request({method:'tools/list'}, ListToolsResultSchema)
```
Each MCP tool becomes a `Tool` object cloning `MCPTool` with overrides:
- `name`: `mcp__{serverName}__{toolName}` (or bare name in skip-prefix mode)
- `mcpInfo`: `{serverName, toolName}` — used for permission checking
- `isMcp: true`
- `searchHint`: from `tool._meta['anthropic/searchHint']`
- `alwaysLoad`: from `tool._meta['anthropic/alwaysLoad']`
- Annotations respected: `readOnlyHint`, `destructiveHint`, `openWorldHint`
- `call()`: invokes `callMCPToolWithUrlElicitationRetry`, handles session expiry retry (line 1860)

Tool call result returned as `{ data: mcpResult.content, mcpMeta: { _meta, structuredContent } }`.

### Commands (MCP Prompts) Registration

`fetchCommandsForClient` (line 2033):
```
client.request({method:'prompts/list'}, ListPromptsResultSchema)
```
Each MCP prompt becomes a `Command` with:
- `name`: `mcp__{serverName}__{promptName}`
- `source: 'mcp'`
- `getPromptForCommand()`: calls `client.getPrompt()` with user-provided args

### Resources

`fetchResourcesForClient` (line 2000) fetches `resources/list`. When any server has resources, `ListMcpResourcesTool` and `ReadMcpResourceTool` are added globally (one set per session).

### MCP Skills (feature-flagged)

`src/services/mcp/client.ts` line 117-121:
```typescript
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? require('../../skills/mcpSkills.js').fetchMcpSkillsForClient
  : null
```
When `MCP_SKILLS` feature flag is enabled AND server has `capabilities.resources`, MCP servers can expose skills (SKILL.md files) as resources. These are loaded alongside commands via `fetchMcpSkillsForClient`. Security note: MCP skills never execute inline shell commands (`!` \`...\`) since they're remote/untrusted (see `loadSkillsDir.ts` line 374).

### Connection Management

- `connectToServer` is memoized by `getServerCacheKey` (name + JSON config)
- Cache cleared on `client.onclose` — triggers automatic reconnect on next tool call
- `clearServerCache()` exported for manual reconnection
- Reconnection: `reconnectMcpServerImpl()` (line 2137) — full reconnect cycle
- Batch connection size: env `MCP_SERVER_CONNECTION_BATCH_SIZE` (default 3), remote servers: `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` (default 20)
- Tool call timeout: env `MCP_TOOL_TIMEOUT` or ~27.8 hours (100_000_000ms)

### Enterprise Policy Enforcement

`src/services/mcp/config.ts`:
- **Allowlist**: `settings.allowedMcpServers` — array of `{serverName}`, `{serverCommand}`, or `{serverUrl}` entries
- **Denylist**: `settings.deniedMcpServers` — same format, takes absolute precedence
- URL matching supports wildcards (`*`)
- Enterprise MCP config (`managed-mcp.json`) blocks all other config when present
- `filterMcpServersByPolicy()` exported for `--mcp-config` and SDK `setMcpServers`
- SDK-type servers are exempt from policy (no command/URL to check)

### Duplicate Suppression

`dedupPluginMcpServers()` and `dedupClaudeAiMcpServers()` in `config.ts`:
- Signature-based: `stdio:${JSON.stringify(command)}` or `url:${url}`
- CCR proxy URLs unwrapped to original vendor URL for matching
- Manual config beats plugin; first-loaded plugin beats later ones

---

## 2. Skills System

### Skill Types

There are four kinds of skills, tracked by `loadedFrom` field:

| `loadedFrom` | Source | Format |
|---|---|---|
| `'skills'` | `/skills/` directory | `skill-name/SKILL.md` only |
| `'commands_DEPRECATED'` | `/commands/` directory | `SKILL.md` dirs OR single `.md` files |
| `'bundled'` | Compiled into binary | TypeScript `BundledSkillDefinition` |
| `'mcp'` | MCP server resources | SKILL.md files served as resources |
| `'plugin'` | Plugin directories | Same as `'skills'` format |
| `'managed'` | Managed policy path | Same as `'skills'` format |

### Skill File Format

Skills live in `~/.claude/skills/`, `.claude/skills/` (project), or managed path. Structure:
```
skill-name/
  SKILL.md    ← required
```

`SKILL.md` frontmatter fields (parsed by `parseSkillFrontmatterFields`, `src/skills/loadSkillsDir.ts` line 185):

```yaml
---
description: "What this skill does"           # shown in /skill-name help
name: "Display Name"                          # optional override
argument-hint: "[args]"                       # shown in autocomplete
when_to_use: "Detailed usage scenarios"       # model guidance
allowed-tools: [Bash, Read, Write]            # restrict tool access
model: claude-opus-4                          # override model
disable-model-invocation: false               # skip LLM call
user-invocable: true                          # can user type /skill?
context: fork                                 # 'fork' or 'inline' (default)
agent: "Bash"                                 # agent type when forked
effort: high                                  # effort level
paths: ["src/**/*.ts"]                        # conditional activation
version: "1.2.3"
hooks:                                        # lifecycle hooks
  PreToolUse: [...]
shell:                                        # inline shell config
---
```

Special template variables in skill content:
- `${CLAUDE_SKILL_DIR}` — skill's directory (Windows: backslashes normalized to forward slashes)
- `${CLAUDE_SESSION_ID}` — current session UUID
- Argument substitution via `substituteArguments()`
- Inline shell execution via `!`\`command\`` — NOT executed for MCP skills

### Skill Loading Flow

`getSkillDirCommands(cwd)` (`src/skills/loadSkillsDir.ts` line 638, memoized by cwd):

1. Loads from managed dir (`getManagedFilePath()/.claude/skills/`)
2. Loads from user dir (`~/.claude/skills/`)
3. Loads from project dirs (walks up from cwd to home, collecting `.claude/skills/` at each level)
4. Loads from `--add-dir` paths
5. Loads legacy commands from `/commands/` dirs (deprecated)
6. Deduplicates by `realpath()` (symlink-safe, handles NFS/ExFAT inode=0)
7. Splits into conditional (has `paths:` frontmatter) vs unconditional

Controlled by:
- `isSettingSourceEnabled()` — policy gate per source
- `isRestrictedToPluginOnly('skills')` — blocks all non-plugin skills
- `CLAUDE_CODE_DISABLE_POLICY_SKILLS` env — skips managed skills
- `--bare` mode — skips auto-discovery entirely

### Dynamic Skill Discovery

Skills can be discovered at runtime as files are touched (`src/skills/loadSkillsDir.ts` line 861):

- `discoverSkillDirsForPaths(filePaths, cwd)` — walks up from each file path looking for `.claude/skills/`
- Stops at cwd (cwd-level already loaded at startup)
- Skips gitignored directories
- Results sorted deepest-first (more specific overrides shallower)
- `addSkillDirectories(dirs)` — loads and merges into `dynamicSkills` Map
- `onDynamicSkillsLoaded(callback)` — subscribe to skill additions

### Conditional Skills (path-filtered)

Skills with `paths:` frontmatter are stored in `conditionalSkills` Map at load time (not made available to model yet).

`activateConditionalSkillsForPaths(filePaths, cwd)` — called when model touches files:
- Uses `ignore` library (gitignore-style matching)
- Moves matching skills from `conditionalSkills` to `dynamicSkills`
- Fires `tengu_dynamic_skills_changed` analytics event
- Once activated, stays active for the session (tracked in `activatedConditionalSkillNames`)

### Bundled Skills

`registerBundledSkill(definition: BundledSkillDefinition)` (`src/skills/bundledSkills.ts` line 53):

```typescript
type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean        // GrowthBook/platform gate
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>   // reference files extracted to disk lazily
  getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>
}
```

Bundled skills in `src/skills/bundled/index.ts` (`initBundledSkills()`):
- `update-config`, `keybindings`, `verify`, `debug`, `lorem-ipsum`, `skillify`, `remember`, `simplify`, `batch`, `stuck`
- Feature-flagged: `dream` (KAIROS), `hunter` (REVIEW_ARTIFACT), `loop` (AGENT_TRIGGERS), `schedule-remote-agents` (AGENT_TRIGGERS_REMOTE), `claude-api` (BUILDING_CLAUDE_APPS), `run-skill-generator` (RUN_SKILL_GENERATOR)
- Auto-enabled: `claude-in-chrome` (when `shouldAutoEnableClaudeInChrome()`)

Files declared in `files: Record<string, string>` are extracted to disk lazily on first invocation via `extractBundledSkillFiles()` — safe write with `O_EXCL|O_NOFOLLOW`, mode 0o600, in per-process nonce directory.

### runSkillGenerator

`src/skills/bundled/runSkillGenerator.ts` — currently stub: `export default {}`. The registration function `registerRunSkillGeneratorSkill` is feature-gated behind `RUN_SKILL_GENERATOR` flag. The skill generator likely helps create new skills programmatically.

### Skill Execution Flow

When user or model invokes `/skill-name args`:

1. `getPromptForCommand(args, context)` called on the `Command` object
2. For file-based skills: prepends `Base directory for this skill: <dir>` if `baseDir` set
3. Substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`, argument placeholders
4. Executes inline shell commands (`!`\`cmd\``) unless `loadedFrom === 'mcp'`
5. Returns `ContentBlockParam[]` — injected into conversation as user message
6. If `context: 'fork'`: runs as sub-agent with separate context/token budget

---

## 3. Plugin System

### Plugin Architecture

Plugins are git repos or marketplace entries containing:
```
my-plugin/
├── plugin.json          # manifest (optional)
├── commands/            # legacy slash commands
├── agents/              # agent definitions
├── skills/              # skill directories
├── hooks/               # hooks.json or hooks/ dir
├── output-styles/       # output style overrides
├── .mcp.json            # MCP servers (lowest priority)
└── *.mcpb / *.dxt       # MCP bundles
```

Plugin ID format: `{pluginName}@{marketplaceName}` (e.g., `slack@anthropic`).

### Plugin Components

`LoadedPlugin` type (`src/types/plugin.ts` line 48):

```typescript
type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string           // pluginId "name@marketplace"
  repository: string
  enabled?: boolean
  isBuiltin?: boolean      // built-in plugins that ship with CLI
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  commandsPath?: string
  commandsPaths?: string[]
  commandsMetadata?: Record<string, CommandMetadata>
  agentsPath?: string
  skillsPath?: string
  skillsPaths?: string[]
  outputStylesPath?: string
  settings?: Record<string, unknown>
}
```

### Plugin Manifest Schema (`src/utils/plugins/schemas.ts`)

Full `PluginManifestSchema` merges these sub-schemas:
- `PluginManifestMetadataSchema` — name, version, description, author, keywords, dependencies
- `PluginManifestCommandsSchema` — commands (path, array, or object-map with metadata)
- `PluginManifestAgentsSchema` — agents (path or array)
- `PluginManifestSkillsSchema` — skills directories
- `PluginManifestHooksSchema` — hooks (inline or path to JSON)
- `PluginManifestMcpServerSchema` — mcpServers (inline, path, MCPB/DXT file, or array)
- `PluginManifestOutputStylesSchema` — output styles
- `PluginManifestUserConfigSchema` — user-configurable options (prompted at install)
- `PluginManifestChannelsSchema` — MCP servers that emit channel notifications
- `PluginManifestLspServerSchema` — LSP server configs

### Plugin MCP Integration

`src/utils/plugins/mcpPluginIntegration.ts`:

1. `loadPluginMcpServers(plugin)` — loads from `.mcp.json`, then manifest `mcpServers` (path/inline/MCPB)
2. `resolvePluginMcpEnvironment(config, plugin, userConfig)` — substitutes:
   - `${CLAUDE_PLUGIN_ROOT}` → plugin.path
   - `${CLAUDE_PLUGIN_DATA}` → plugin data directory
   - `${user_config.KEY}` → saved user configuration
   - `${ENV_VAR}` → environment variables
3. `addPluginScopeToServers()` — prefixes server names: `plugin:{pluginName}:{serverName}`
4. `getPluginMcpServers(plugin)` — top-level accessor called from config.ts

MCPB/DXT files (`.mcpb`, `.dxt`) — MCP bundle format from `@anthropic-ai/mcpb`. Loaded by `loadMcpbFile()`, extracts to plugin data dir, may require user config before loading.

### Plugin Hooks Integration

`src/utils/plugins/loadPluginHooks.ts`:

- `loadPluginHooks()` — memoized, loads hooks from all enabled plugins
- Converts plugin hook config to `PluginHookMatcher[]` with `pluginRoot`, `pluginName`, `pluginId`
- Registers via `registerHookCallbacks()`
- Hot-reload on `policySettings` change via `setupPluginHookHotReload()`
- `pruneRemovedPluginHooks()` — removes hooks from disabled plugins immediately

Plugin hook matchers get `pluginRoot` which becomes `CLAUDE_PLUGIN_ROOT` env var in hook scripts.

### Built-in Plugins

`src/plugins/builtinPlugins.ts`:
- `registerBuiltinPlugin(BuiltinPluginDefinition)` — registers a plugin that shows in `/plugin` UI
- Built-in plugins use `{name}@builtin` ID
- `BuiltinPluginDefinition` can provide: `skills`, `hooks`, `mcpServers`, `isAvailable()`
- Default enabled/disabled tracked in `settings.enabledPlugins`

Currently: `src/plugins/bundled/index.ts` `initBuiltinPlugins()` is empty scaffolding — no built-in plugins registered yet.

### Plugin LSP Integration

Plugins can also provide LSP servers (`lspServers` in manifest). This creates another extension surface distinct from MCP.

### Marketplace System

Plugin sources: `{marketplace}` name → git repository on GitHub (official org: `anthropics`).

Reserved marketplace names (ALLOWED_OFFICIAL_MARKETPLACE_NAMES):
- `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`
- `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`
- `life-sciences`, `knowledge-work-plugins`

Blocked names: anything matching `BLOCKED_OFFICIAL_NAME_PATTERN` (impersonation attempt).

---

## 4. Hook System — Full Extension Point

Hooks are the deepest extension mechanism. They intercept every major event in CC's lifecycle.

### Hook Events (28 total)

`src/entrypoints/sdk/coreTypes.ts` line 25-53:

```
PreToolUse, PostToolUse, PostToolUseFailure,
Notification, UserPromptSubmit,
SessionStart, SessionEnd,
Stop, StopFailure,
SubagentStart, SubagentStop,
PreCompact, PostCompact,
PermissionRequest, PermissionDenied,
Setup, TeammateIdle,
TaskCreated, TaskCompleted,
Elicitation, ElicitationResult,
ConfigChange,
WorktreeCreate, WorktreeRemove,
InstructionsLoaded,
CwdChanged, FileChanged
```

### Hook Response Schema (`src/types/hooks.ts`)

Sync response (`syncHookResponseSchema`, line 50):
```typescript
{
  continue?: boolean          // stop CC if false
  suppressOutput?: boolean    // hide stdout from transcript
  stopReason?: string         // message when continue=false
  decision?: 'approve'|'block'
  reason?: string
  systemMessage?: string      // warning shown to user
  hookSpecificOutput?: {      // per-event extensions
    hookEventName: 'PreToolUse',
    permissionDecision?: 'ask'|'deny'|'allow'|'passthrough',
    permissionDecisionReason?: string,
    updatedInput?: Record<string, unknown>,  // MODIFY tool input
    additionalContext?: string
  } | {
    hookEventName: 'PostToolUse',
    additionalContext?: string,
    updatedMCPToolOutput?: unknown           // REPLACE MCP tool output
  } | {
    hookEventName: 'SessionStart',
    additionalContext?: string,
    initialUserMessage?: string,            // inject initial message
    watchPaths?: string[]                   // register FileChanged paths
  } | {
    hookEventName: 'UserPromptSubmit',
    additionalContext?: string              // inject context into prompt
  } | {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'allow',
      updatedInput?: Record<string, unknown>,
      updatedPermissions?: PermissionUpdate[]
    } | {
      behavior: 'deny',
      message?: string,
      interrupt?: boolean
    }
  } | {
    hookEventName: 'Elicitation',
    action: 'accept'|'decline'|'cancel',
    content?: Record<string, unknown>
  } | ...
  }
}
```

Async response: `{ async: true, asyncTimeout?: number }` — hook signals it will respond asynchronously via file.

### Key Hook Capabilities

1. **Block tool use** (PreToolUse): `continue: false` stops the tool
2. **Modify tool input** (PreToolUse): `updatedInput` replaces args before call
3. **Replace MCP tool output** (PostToolUse): `updatedMCPToolOutput` — only for MCP tools. CC propagates this at `src/services/tools/toolHooks.ts` line 146 and `src/services/tools/toolExecution.ts` line 1494
4. **Inject context** (SessionStart, UserPromptSubmit, PostToolUse): `additionalContext` added to system message
5. **Set initial message** (SessionStart): `initialUserMessage` injected as first user turn
6. **Grant permissions** (PermissionRequest): hook can approve/deny + update permissions list
7. **Watch files** (SessionStart, CwdChanged, FileChanged): `watchPaths` registers additional paths for FileChanged hooks
8. **Elicitation handling**: hooks can auto-respond to MCP server elicitation requests
9. **Retry permission denied**: `retry: boolean` in PermissionDenied hook

Hooks can be:
- **Shell commands** (most common): executed as subprocess
- **Callback functions** (internal): `HookCallback` type with direct async function

### Hook Configuration Sources

Hooks can be configured in:
1. `settings.json` (user/project/policy) — `hooks:` key
2. Skill frontmatter — `hooks:` field, scoped to skill invocation duration
3. Plugin manifest or `hooks/hooks.json` — loaded by `loadPluginHooks()`
4. Built-in callback hooks — registered via `registerHookCallbacks()`

---

## 5. SDK Extension Transport

### SDK MCP Transport

`src/services/mcp/SdkControlTransport.ts` — allows in-process MCP servers:

```
CLI Process                    SDK Process
────────────                   ──────────────
MCP Client                     MCP Server
  ↕                              ↕
SdkControlClientTransport  ←→  SdkControlServerTransport
  ↕ (wraps in control msg)
stdout/stdin JSON-RPC bridge
```

SDK consumers define tools via `createSdkMcpServer()` + `tool()` factory (`src/entrypoints/agentSdkTypes.ts` line 73-106), then pass `McpSdkServerConfigWithInstance` to CC. CC creates a `{type:'sdk', name}` config and routes tool calls back via control messages.

### In-Process Transport

`src/services/mcp/InProcessTransport.ts` — `createLinkedTransportPair()`:
```typescript
export function createLinkedTransportPair(): [Transport, Transport]
```
Used for chrome-in-chrome and computer-use MCP servers. `send()` on one side delivers via `queueMicrotask` to `onmessage` on the other.

---

## 6. Extension Points Summary

| Extension Point | Mechanism | What It Can Do |
|---|---|---|
| **MCP Tools** | Any transport type | Full tool execution; annotations control permissions |
| **MCP Prompts** | `prompts/list` capability | Become slash commands `mcp__{server}__{prompt}` |
| **MCP Resources** | `resources/list` capability | Browsable via ListMcpResourcesTool/ReadMcpResourceTool |
| **MCP Skills** | Resources (feature-flagged `MCP_SKILLS`) | SKILL.md served as resources → become slash commands |
| **Skills (file)** | `~/.claude/skills/`, `.claude/skills/` | Slash commands with full prompt injection |
| **Skills (bundled)** | `registerBundledSkill()` | Compiled-in slash commands with full context |
| **Hooks** | settings.json, skill frontmatter, plugins | Intercept 28 events; modify inputs/outputs/permissions |
| **Plugins (git)** | marketplace entry | Skills + commands + agents + hooks + MCP servers + LSP servers |
| **Built-in Plugins** | `registerBuiltinPlugin()` | User-toggleable feature bundles with all components |
| **SDK MCP** | `createSdkMcpServer()` | In-process tools without subprocess |
| **In-Process MCP** | `createLinkedTransportPair()` | No-subprocess MCP (internal use: chrome, computer-use) |

---

## 7. Key Undocumented Mechanisms

### MCP Tool Annotations (extension metadata)

MCP tools can pass `_meta` fields that CC reads:
- `tool._meta['anthropic/searchHint']` → `searchHint` (used for deferred tool list)
- `tool._meta['anthropic/alwaysLoad']` → `alwaysLoad: true` (always shown to model, never deferred)

Source: `src/services/mcp/client.ts` line 1779-1785.

### IDE Tool Filtering

`src/services/mcp/client.ts` line 568-573:
```typescript
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
function isIncludedMcpTool(tool: Tool): boolean {
  return !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
}
```
All `mcp__ide__*` tools are filtered EXCEPT `executeCode` and `getDiagnostics`. IDE extensions cannot add arbitrary tools — only these two pass through.

### Skip-Prefix Mode (SDK)

When `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1` and server type is `sdk`:
- Tool names are not prefixed with `mcp__{serverName}__`
- Tools can override built-in tools by name

Source: `src/services/mcp/client.ts` line 1761-1763.

### Shell Prefix Injection

`process.env.CLAUDE_CODE_SHELL_PREFIX` — if set, wraps stdio MCP server commands:
```
command = CLAUDE_CODE_SHELL_PREFIX
args = [original_command + ' ' + original_args]
```
Source: `src/services/mcp/client.ts` line 946-950.

### Conditional Skills via Paths

Skills remain hidden until model touches a matching file. This is the intended mechanism for context-sensitive slash commands that appear only when relevant (e.g., a `ts-fix` skill that appears only when editing `.ts` files).

### Plugin User Config in Env

Plugin user config values become `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables in hook scripts (from `schemas.ts` comment). Non-sensitive values also available as `${user_config.KEY}` in skill/agent content.

### Channel MCP Servers

Plugins can declare `channels[]` in manifest — MCP servers that emit `notifications/claude/channel` to inject messages into the conversation (Telegram, Slack, Discord integration pattern).

---

## 8. MCP Tool Result Handling

Full chain from tool call to model:

1. `client.callTool()` → MCP SDK → transport → MCP server → response
2. `callMCPTool()` in client.ts validates result, handles binary content (`persistBinaryContent`), truncates large output (`truncateMcpContentIfNeeded`, max `mcpValidation.ts`)
3. Returns `MCPToolResult` with `content` (ContentBlockParam[]) and optional `_meta`, `structuredContent`
4. `runPostToolUseHooks()` called with result — hook can replace via `updatedMCPToolOutput`
5. Final content returned as `tool_result` message block

Large outputs: CC saves binary blobs to disk and returns a path reference. Text output capped by `maxResultSizeChars: 100_000` on `MCPTool`.

Image handling: `src/services/mcp/client.ts` resizes/downsamples images via `maybeResizeAndDownsampleImageBuffer`.

---

## Files Referenced

- `src/services/mcp/types.ts` — transport + config schemas, server connection types
- `src/services/mcp/client.ts` — connectToServer, fetchToolsForClient, fetchCommandsForClient, fetchResourcesForClient
- `src/services/mcp/config.ts` — getAllMcpConfigs, policy enforcement, scope management
- `src/services/mcp/SdkControlTransport.ts` — SDK in-process bridge
- `src/services/mcp/InProcessTransport.ts` — linked transport pair
- `src/skills/bundledSkills.ts` — registerBundledSkill, BundledSkillDefinition
- `src/skills/loadSkillsDir.ts` — getSkillDirCommands, createSkillCommand, parseSkillFrontmatterFields, dynamic discovery
- `src/skills/mcpSkillBuilders.ts` — write-once registry for MCP skill discovery
- `src/skills/bundled/index.ts` — initBundledSkills()
- `src/plugins/builtinPlugins.ts` — registerBuiltinPlugin, BuiltinPluginDefinition
- `src/plugins/bundled/index.ts` — initBuiltinPlugins() (empty scaffold)
- `src/types/plugin.ts` — LoadedPlugin, BuiltinPluginDefinition, PluginError
- `src/types/command.ts` — Command, PromptCommand, CommandBase, CommandAvailability
- `src/types/hooks.ts` — syncHookResponseSchema, HookResult, HookCallback
- `src/utils/plugins/mcpPluginIntegration.ts` — loadPluginMcpServers, resolvePluginMcpEnvironment
- `src/utils/plugins/loadPluginHooks.ts` — loadPluginHooks, setupPluginHookHotReload
- `src/utils/plugins/schemas.ts` — PluginManifestSchema, CommandMetadataSchema, LspServerConfigSchema
- `src/entrypoints/sdk/coreTypes.ts` — HOOK_EVENTS, EXIT_REASONS
- `src/entrypoints/agentSdkTypes.ts` — tool(), createSdkMcpServer(), query(), unstable_v2_*
- `src/tools/MCPTool/MCPTool.ts` — base MCPTool definition
