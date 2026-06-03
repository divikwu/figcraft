# Project: FigCraft

AI-powered Figma plugin that lets AI follow design specs to create designs. Bridges IDEs to Figma via MCP protocol, supporting two spec sources (Figma Shared Library / DTCG design spec documents). Provides Token sync, spec Lint, auto-fix, and element generation.

Standalone product — not tied to any specific design system. Works with any team's DTCG Token files or Figma Libraries.

## ⛔ Figma UI Creation — Tool-Driven Mandatory Flow

Creation flow is enforced by MCP tools at runtime. All IDEs share the same rules.
Call `get_mode` to get `_workflow`, follow `_workflow` steps.

Rules single source of truth (update MCP tool code → all IDEs auto-update):
- Creation flow + design checklist → `get_mode._workflow`
- Opinion Engine → `get_creation_guide(topic:"opinion-engine")`
- UI type templates → `get_creation_guide(topic:"ui-patterns", uiType:"xxx")`
- Design rules → `get_design_guidelines(category)`
- Multi-screen flow → `get_creation_guide(topic:"multi-screen")`
- Responsive Web → `get_creation_guide(topic:"responsive")`
- Content states → `get_creation_guide(topic:"content-states")`

> Do NOT duplicate these rules in CLAUDE.md or IDE config files. Rules are implemented in `packages/core-mcp/src/tools/logic/mode-logic.ts`.

## ⛔ Skill Priority — Project Skills Override External

When a skill name exists in BOTH the project `skills/` directory AND an external source (Figma MCP, Anthropic registry), **ALWAYS load the project version**. External versions contain generic guidance that bypasses figcraft's declarative pipeline (Opinion Engine, harness, variable binding).

| Project Skill | Why project version must win |
|--------------|------------------------------|
| `figcraft-use` | Project version enforces declarative tools first; external goes straight to `use_figma` |
| `figcraft-implement-design` | Project version uses figcraft `get_design_context` (zero REST limits, in-session freshness) |
| `figcraft-generate-design` | Project version has mandatory library discovery phase |
| `figcraft-generate-library` | Project version uses declarative tools; external may use raw Plugin API |
| `figcraft-code-connect` | Project version supports 3 workflows (CLI / MCP / figcraft metadata) |
| `figcraft-create-design-system-rules` | Project version targets figcraft ecosystem |

**Do NOT load** these external skills — use project equivalents instead:
- `baseline-ui` → does not exist in project, ignore entirely
- `ui-ux-pro-max` → use project's `ui-ux-fundamentals` + `design-guardian`/`design-creator`
- `web-design-guidelines` → use project's design rules via `get_design_guidelines(category)`

Creation skill selection and external skill blocking are enforced at runtime via:
- `get_mode._workflow.skillRouting` — skill routing guidance
- Harness `_nextSteps` on `get_mode` — skill priority reminder (content/harness/next-steps.yaml)

Do NOT duplicate these rules here — they are delivered by MCP tools to all IDEs automatically.

## Stack

- TypeScript (strict, ESM)
- MCP Server: @modelcontextprotocol/sdk + stdio transport
- WebSocket Relay: ws (port 3055-3060, auto-switch)
- Figma Plugin: Plugin API (code.js sandbox + ui.html iframe)
- Build: tsup (Plugin IIFE + Server ESM)
- Schema: Zod (MCP tool parameter validation)
- Package manager: npm

IMPORTANT: Do NOT install additional CSS/UI frameworks. Plugin UI is pure HTML/CSS inline in ui.html.

## Commands

```bash
npm run dev:relay      # Start WebSocket relay server (port 3055)
npm run dev:mcp        # Start MCP Server (stdio transport)
npm run build          # Build all (tsup)
npm run build:plugin   # Build Figma Plugin (IIFE bundle)
npm run build:server   # Build MCP Server + Relay (ESM)
npm run typecheck      # TypeScript type checking
npm run test           # Run unit tests (vitest)
npm run test:watch     # Test watch mode
```

## Architecture

### Three-Component Relay Architecture

```
IDE (Kiro / Cursor / Claude Code / Antigravity / Codex)
    │ MCP (stdio)
    ▼
MCP Server (Node.js)           ← packages/core-mcp/src/
    │ WebSocket
    ▼
WS Relay (port 3055)           ← packages/relay/src/
    │ WebSocket
    ▼
Figma Plugin
    ├─ UI iframe                ← packages/adapter-figma/src/ui.html
    │     │ postMessage              (WebSocket connection + message bridge)
    │     ▼
    └─ code.js sandbox          ← packages/adapter-figma/src/code.ts
         (Figma Plugin API)          (command dispatch + handler registration)
```

Key constraints:
- **code.js sandbox** can call Figma Plugin API but has no network access
- **ui.html iframe** has browser APIs (WebSocket) but cannot call Figma API
- They communicate via `postMessage`

### Channel Routing

Each Figma document session generates a random channel ID. MCP Server joins the same channel for multi-session isolation. Plugin UI displays the channel ID for MCP Server configuration.

### Request Tracking

Each MCP command gets a UUID. Plugin responses carry the UUID back for correlation. 30-second timeout + 30-second heartbeat.

## Directory Structure

```
figcraft/
├── CLAUDE.md
├── package.json                    # private workspace root
├── manifest.json                   # generated root-compatible plugin manifest
├── schema/tools.yaml               # tool definitions single source of truth
├── scripts/
│   ├── compile-schema.ts           # tools.yaml → generates tool registry
│   └── compile-content.ts          # content/ → generates _guides/_prompts/_templates
├── skills/                         # Skills (IDE discovery, flat structure)
│   ├── ui-ux-fundamentals/         # design rules (MCP Server source of truth)
│   ├── design-creator/
│   ├── design-guardian/
│   ├── figma-create-ui/            # declarative creation flow
│   └── figcraft-use/ ...              # (see skills/ for full list)
├── content/                        # editable content assets (YAML/Markdown)
│   ├── ide-shared/                 # shared snippets injected into IDE config files
│   ├── templates/*.yaml            # UI templates → _templates.ts
│   ├── guides/*.md                 # creation guides → _guides.ts
│   ├── prompts/*.yaml              # MCP Prompts → _prompts.ts
│   └── harness/*.yaml              # harness data rules (recovery + next-steps) → _harness.ts
├── packages/
│   ├── figcraft-design/src/        # published CLI shell
│   ├── core-mcp/src/               # MCP Server runtime, bridge, tools, prompts
│   │   └── harness/                # Harness Pipeline (auto-verify, debt tracking, error recovery)
│   ├── relay/src/                  # WebSocket Relay
│   ├── shared/src/                 # shared protocol, types, version
│   ├── quality-engine/src/         # lint rules and quality engine
│   └── adapter-figma/
│       ├── manifest.base.json      # plugin manifest source of truth
│       ├── build.plugin.mjs        # generates root manifest + dist/plugin/*
│       └── src/                    # Plugin code, handlers, adapters, utils
├── tests/
│   ├── contracts/                  # monorepo/public surface guards
│   └── ...
└── dist/                           # build output (.gitignore)
```

## Dual Mode Operation

Manual switch via `set_mode` / `get_mode` tools:

| Mode | Token Source | Lint Method | Typical Use |
|------|-------------|-------------|-------------|
| **library** | Figma Shared Library Variables/Styles | Checks if nodes are bound to Library Variable/Style | Daily design with team shared library |
| **spec** | DTCG JSON files | Checks if node values match DTCG Token values | Sync from design spec documents, verify compliance |

## MCP Tool System

MCP tools are split into core (always loaded) and optional toolsets (on-demand via `load_toolset`), with resource endpoints.

- Tool definitions single source of truth: `schema/tools.yaml`
- Run `npm run schema` to regenerate registry
- AI calls `list_toolsets` to see full tool list and loading status
- Quality engine: lint rules + auto-fix (`packages/quality-engine/src/rules/`)
- Content assets: `content/` YAML/Markdown → `npm run content` generates TypeScript (see `docs/asset-maintenance.md`)

<!-- @inject-start: ide-shared/toolsets.md -->
Core tools (44) are always enabled — including `create_component`, `create_component_set`, `update_component`, `create_component_from_node`, `layout_component_set`, `create_section`, `get_design_context`, `import_html`, `variables_ep`, and `styles_ep`. Load additional toolsets as needed via `load_toolset`:

| Toolset | When to load |
|---------|-------------|
| `variables` | Write operations on variables (rename, alias, modes). Note: `variables_ep` read/write methods are always available as core — no toolset needed for list, get, export, batch_update |
| `tokens` | Syncing DTCG design tokens |
| `styles` | Write operations on styles (create, update, sync). Note: `styles_ep` read methods are always available as core — no toolset needed for list, get |
| `components-advanced` | Building component libraries, managing variants |
| `library-import` | Importing library variables, styles, and components into local file (design system authoring, NOT for UI creation in library mode) |
| `shapes-vectors` | Stars, polygons, sections, boolean ops, flatten |
| `annotations` | Adding, reading, and clearing annotations on nodes |
| `prototype` | Prototype interactions, flow analysis, batch-connect screens |
| `lint` | Fine-grained lint (beyond lint_fix_all) |
| `auth` | Figma OAuth setup |
| `pages` | Creating/renaming pages |
| `staging` | Staged workflow — preview changes before finalizing |
| `debug` | execute_js (raw Plugin API) |

Use `list_toolsets` to see current status. Load multiple: `load_toolset({ names: "tokens,variables" })`.
<!-- @inject-end -->

<!-- @inject-start: ide-shared/endpoints.md -->
Resource-oriented endpoints with method dispatch:

| Endpoint | Methods |
|----------|---------|
| `nodes` | `get`, `get_batch`, `list`, `update`, `delete`, `clone`, `reparent` |
| `text` | `set_content`, `set_range` |
| `components` | `list`, `list_library`, `get`, `list_properties` |
| `variables_ep` | `list`, `get`, `list_collections`, `get_bindings`, `export` (always available); `set_binding`, `create`, `update`, `batch_update`, `delete`, `create_collection`, `delete_collection`, `batch_create`, `set_code_syntax`, `batch_bind`, `set_values_multi_mode`, `extend_collection`, `get_overrides`, `remove_override` (write methods — `load_toolset("variables")` to enable write tools) |
| `styles_ep` | `list`, `get` (always available); `create_paint`, `update_paint`, `update_text`, `update_effect`, `delete`, `sync` (write methods — `load_toolset("styles")` to enable write tools) |

Call syntax: `nodes({ method: "get", nodeId: "1:23" })`, `variables_ep({ method: "list_collections" })`, `styles_ep({ method: "list" })`
<!-- @inject-end -->

## DTCG → Figma Type Mapping

| DTCG $type | Figma Target | Scope Inference |
|------------|-------------|-----------------|
| `color` | Variable (COLOR) | ALL_FILLS + STROKE_COLOR + EFFECT_COLOR |
| `dimension` / `number` | Variable (FLOAT) | Inferred by name: radius→CORNER_RADIUS, spacing→GAP, font-size→FONT_SIZE |
| `fontFamily` | Variable (STRING) | FONT_FAMILY |
| `fontWeight` | Variable (FLOAT) | FONT_WEIGHT |
| `boolean` | Variable (BOOLEAN) | ALL_SCOPES |
| `typography` | **Text Style** | N/A (compound type — decomposed into individual Variables + Style created) |
| `shadow` | **Effect Style** | N/A (compound type) |

## Plugin Handler Registration Pattern

All handlers are registered to a global Map via `registerHandler(method, handler)`. Handler files auto-register via import side effects.

> **Note**: Plugin-side handler method names (e.g. `get_node_info`, `patch_nodes`) are internal bridge protocol names, unrelated to MCP tool names. The MCP layer uses endpoint mode (e.g. `nodes(method: "get")`), and endpoints internally call Plugin handlers via `bridge.request('get_node_info', ...)`.

```typescript
// packages/adapter-figma/src/handlers/nodes.ts
import { registerHandler } from '../code.js';

// Internal bridge protocol name — NOT an MCP tool name
registerHandler('get_node_info', async (params) => {
  // ... Figma API calls
});
```

Adding a new handler:
1. Create file in `packages/adapter-figma/src/handlers/`
2. Use `registerHandler` to register (internal bridge protocol name)
3. Add `import './handlers/xxx.js'` in `packages/adapter-figma/src/code.ts`
4. Add tool definition in `schema/tools.yaml` (endpoint or standalone)

## Adding New MCP Tools

New tools are defined via `schema/tools.yaml`, supporting three handler types:

1. **`handler: bridge`** — auto-generated, YAML definition only, no hand-written MCP wrapper needed
2. **`handler: endpoint`** — resource endpoint, define `methods` map in YAML, dispatch in `packages/core-mcp/src/tools/endpoints.ts`
3. **`handler: custom`** — hand-written MCP wrapper in `packages/core-mcp/src/tools/`, registered in `toolset-manager.ts`

Run `npm run schema` to regenerate registry.

## Adding New Lint Rules

1. Create file in `packages/quality-engine/src/rules/`, implement `LintRule` interface
2. Register in `ALL_RULES` array in `packages/quality-engine/src/engine.ts`
3. `check()` method receives `AbstractNode` (decoupled from Figma API), returns `LintViolation[]`
4. Set `autoFixable: true` + `fixData` for auto-fix support
5. Add fix logic in `packages/adapter-figma/src/handlers/lint.ts` `lint_fix` handler

## IDE Diagnostic Notes

Plugin files (`packages/adapter-figma/src/**`) will show "Cannot find name" errors for `figma`, `__html__` and other globals in IDEs. This is normal — these globals are injected by the Figma Plugin runtime, `@figma/plugin-typings` provides type definitions, and the Plugin uses a separate `tsconfig.plugin.json`.

Server-side type checking: `npm run typecheck` (uses main `tsconfig.json`, excludes plugin files).

## Environment Variables

```env
FIGCRAFT_RELAY_URL=ws://localhost:3055    # Relay address (default, usually no need to set)
FIGCRAFT_RELAY_PORT=3055                  # Relay preferred port (default 3055, auto-switches to 3056-3060 if occupied)
FIGCRAFT_CHANNEL=figcraft                 # Default channel (both Plugin and MCP Server default to figcraft)
FIGCRAFT_ACCESS=edit                      # Access level: read | create | edit (default: edit). Controls which tools are available.
FIGMA_API_TOKEN=figd_xxx                  # Figma Personal Access Token (optional, can also be configured in plugin panel)
FIGMA_CLIENT_ID=xxx                       # OAuth 2.0 Client ID (optional, for figma_login)
FIGMA_CLIENT_SECRET=xxx                   # OAuth 2.0 Client Secret (optional, for figma_login)
PEXELS_API_KEY=xxx                        # Pexels API key (optional, for image_search/image_preview tools)
```

> **Note**: `FIGMA_API_TOKEN` has three configuration methods (priority high to low):
> 1. Environment variable `FIGMA_API_TOKEN`
> 2. API Token input in FigCraft plugin panel (stored in Figma clientStorage, passed to MCP Server via WebSocket)
> 3. OAuth login (`figma_login` tool, requires `FIGMA_CLIENT_ID` + `FIGMA_CLIENT_SECRET`)

## Running

### Strategic Principle: Self-Built First, Official Tools As Complement

figcraft is the **complete MCP toolkit** for Figma Design — built around the Figma **Plugin API**, with WebSocket relay + Plugin sandbox architecture. It self-builds every capability where the Plugin API gives a structural advantage, and defers to official Figma tools for ecosystem-standard or REST-native features.

**What figcraft actually differentiates on** — and what it does NOT:

figcraft and the official Figma MCP (Desktop or Remote) are **not replacements for each other**. They occupy different architectural positions and have different limitations. Be honest about both.

| Axis | figcraft (Plugin-first) | Figma Desktop MCP | Figma Remote MCP |
|---|---|---|---|
| **Authoring writes** (create_frame, nodes, variables, styles) | ✅ Full, via Plugin API | ⚠️ Limited (REST has write restrictions by plan) | ⚠️ Limited (REST) |
| **Opinion Engine** (sizing inference, FILL ordering, conflict detection, token auto-binding) | ✅ Unique to figcraft | ❌ | ❌ |
| **Reading node / variable / style / component data** | ✅ Via Plugin API, zero REST rate limits | ✅ Via local endpoint | ✅ Via REST |
| **Zero Figma-plan gating** | ✅ Plugin API is available on every Figma plan | ⚠️ Dev Mode requires Organization+ | ⚠️ Remote MCP requires Organization+ |
| **Zero OAuth / API-token setup** | ✅ Plugin installs directly | ⚠️ Needs Dev Mode enabled | ❌ Requires OAuth / API token |
| **In-session context** (data is fresh the instant a figcraft write finishes) | ✅ Same MCP, same session | ❌ Must re-fetch via REST | ❌ Must re-fetch via REST |
| **Code Connect template file generation** | ❌ Not self-built — deferred to `figma connect create` CLI | ⚠️ Some support via `get_code_connect_suggestions` | ⚠️ Some support |
| **Code Connect publish** | ❌ Not self-built — deferred to `figma connect publish` CLI | N/A | N/A |
| **FigJam** | ❌ Not supported | ✅ | ⚠️ |
| **Local connectivity required** | ⚠️ **Yes** — Plugin + relay run against a local Figma client (Desktop or Web). The default relay binds `localhost:3055`. | ⚠️ Yes — requires local Figma Desktop at `127.0.0.1:3845` | ✅ No — HTTPS endpoint, reachable from cloud agents |
| **Remote / cloud-agent friendly without extra config** | ❌ **Same local-binding constraint as Desktop MCP.** Remote agents need a tunnel or a local MCP-server proxy. | ❌ | ✅ |

**What figcraft actually owns** (where it is clearly the right tool):
- Design-to-code context extraction → `get_design_context` (P0-5) — in-session, no REST rate limits, carries figcraft's own semantic metadata (role plugin data, `#id` suffixes, preferredValues)
- Screenshot / export → `export_image` — Plugin-side, no REST round trip
- Variable / style / component CRUD → `variables_ep`, `styles_ep`, `components_advanced` toolset — Plugin API writes that REST cannot do on non-Enterprise plans
- Design system search → `search_design_system` (dual-source: plugin + REST, richer than either alone)
- Library publish preflight → `preflight_library_publish` (P0-1) — composes figcraft's own scan results
- Variant matrix guardrail → built into `create_component_set` (P0-4) — runtime enforcement of the 30-variant cap
- Component property batch binding → `bind_component_property` accepts arrays (P0-3) — cuts agent tool-call count
- Self-correcting error messages → `assertNodeType` helper across handlers (P0-2) — Plugin-side candidate lists

**4 scenarios where official Figma tools are the right choice** (and why):
1. **FigJam** — figcraft only supports Figma Design; FigJam has its own Plugin API surface
2. **Code Connect template generation + publish** — `figma connect create` and `figma connect publish` are the ecosystem standard. They hit the Figma REST API directly (no Desktop required), support every framework Code Connect supports, and are maintained by Figma. figcraft provides `get_code_connect_metadata` for in-session agent data — NOT template file generation
3. **Dev Mode UI association** — Figma's native sidebar UI for component ↔ source linking
4. **Tokens Studio dialect import** — see "spec mode" docs for figcraft's DTCG-only stance
5. **Fully cloud agent with no local Figma client** — if the agent has zero reach to a local machine running Figma, neither figcraft nor figma-desktop MCP works. **Figma Remote MCP server** (`https://...figma.com/mcp` — see [official docs](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)) is the right tool for this case, via OAuth

**Honest local-connectivity note**: figcraft's Plugin + relay architecture, like figma-desktop MCP, assumes a local Figma client (Desktop app or Figma Web open in the user's browser) reachable from wherever the MCP server runs. For remote / cloud-agent / claude.ai-web scenarios, users need either:
- A tunnel exposing the local relay port to the remote agent, OR
- The agent running in a place that can dial the user's local `localhost:3055`, OR
- Fall back to Figma Remote MCP (above) for pure-cloud scenarios

figcraft is **not** a magic cloud solution. It is a better **local-plugin-first toolkit** — stronger at authoring, Opinion Engine, zero-config, and zero-plan-gating than the official Figma MCPs, but subject to the same local-connectivity trade-off as figma-desktop MCP.

### User Usage (after npm package published)

```bash
# Default: figcraft alone is enough.
# {
#   "mcpServers": {
#     "figcraft": {
#       "command": "npx",
#       "args": ["figcraft-design"]
#     }
#   }
# }
#
# Optional: add figma-desktop MCP only if you need FigJam, Code Connect publish,
# or Dev Mode UI features (see "Strategic Principle" above):
# {
#   "mcpServers": {
#     "figcraft": { "command": "npx", "args": ["figcraft-design"] },
#     "figma-desktop": {
#       "url": "http://127.0.0.1:3845/mcp",
#       "type": "http"
#     }
#   }
# }
# figma-desktop requires Figma desktop app → Shift+D (Dev Mode) → Enable MCP Server.
# figcraft requires the FigCraft plugin loaded in Figma.
```

### Development

```bash
# 1. Load plugin in Figma desktop app
# Plugins → Development → Import plugin from manifest → select manifest.json
# (requires npm run build:plugin to build dist/plugin/ first)

# 2. Configure MCP Server in IDE (no need to manually start Relay, MCP Server auto-embeds it):
# {
#   "mcpServers": {
#     "figcraft": {
#       "command": "npx",
#       "args": ["tsx", "packages/figcraft-design/src/index.ts"],
#       "cwd": "/path/to/figcraft"
#     }
#     // Add figma-desktop only if you need FigJam / Code Connect publish / Dev Mode UI.
#   }
# }

# Optionally start Relay separately (for debugging):
npm run dev:relay
```

### End-to-End Verification

1. Open plugin in Figma → UI auto-detects Relay port and connects
2. IDE starts MCP Server → auto-embeds Relay (or connects to existing Relay) → `ping` tool returns document name and page info

> **Note**: Plugin and MCP Server default to `figcraft` channel — zero config for single-document scenarios. For multi-document, use `join_channel` tool or `FIGCRAFT_CHANNEL` env var. Relay port defaults to 3055, auto-switches to 3056-3060 if occupied.

## Relationship with design-guidelines Project

figcraft is a standalone product. The design-guidelines project's DTCG Token files are one optional source for figcraft:

```
design-guidelines/
  ├── tokens/*.json          # Token source files
  └── mcp-server/            # Design spec query MCP Server (independent of figcraft)

figcraft/
  └── sync_tokens(filePath)  # Can point to design-guidelines token files
```

## Constraints

<!-- @inject-start: ide-shared/constraints.md -->
Key architectural constraints:

- Plugin UI is pure HTML/CSS inline in ui.html — no frontend frameworks
- Linter runs in Plugin side (not MCP Server) — avoids transmitting large node data over WebSocket
- DTCG parsing runs in MCP Server only — Plugin receives parsed `DesignToken[]`
- Composite types (typography/shadow) map to Figma Styles, not Variables — Figma Variables don't support compound types
- `figma.teamLibrary` API can enumerate Library Variables but not Library Styles (REST API supplement needed)
- Plugin API bypasses REST API Enterprise restrictions — Variable writes work on all Figma plans
- Batch operations use `items[]` + per-item error handling — single-item failure doesn't block batch
- Token sync is idempotent — second run: created=0
- Figma Plugin API does NOT expose component property descriptions — `editComponentProperty`/`addComponentProperty` accept only `{ name, defaultValue, preferredValues }`. Property descriptions are editable only in Figma's UI (`execute_js` cannot help — same API surface). `update_component_property` throws `UNSUPPORTED_BY_FIGMA_API` with the workaround
- VARIANT property defaults are derived from the top-left variant's spatial position — `editComponentProperty`'s `defaultValue` does NOT apply to VARIANT. Reorder variants to change the default. `update_component_property` throws `UNSUPPORTED_FOR_VARIANT`
<!-- @inject-end -->
