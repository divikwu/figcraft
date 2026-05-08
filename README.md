# FigCraft

English | [中文](README.zh-CN.md)

AI-powered Figma plugin for design quality. Two-way bridge between AI IDEs and Figma — create UI, review designs, sync tokens, lint for compliance, audit, and auto-fix, all via natural language. Works great on its own, and even better alongside the [official Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/).

> **New here?** Start with [docs/introduction.md](docs/introduction.md) for a 5-minute product tour (positioning, three core capabilities, FAQ). This README focuses on installation and reference.

## What can you do with it?

Describe what you want in natural language, and FigCraft + Figma MCP make it happen in Figma:

> "Create a login screen, then lint the whole page and auto-fix issues"

> "Sync tokens from my DTCG JSON to Figma variables, diff and update"

> "Check WCAG contrast and target sizes on this page, auto-fix what you can"

## Features

- 🎨 **From creation to delivery, fully covered** — Create UI directly in Figma with 116 MCP tools. Build frames, components, variants, icons — check quality right after, fix issues on the spot
- 🧠 **Opinion Engine** — auto-infers layout direction, sizing, token bindings, and catches parameter conflicts before they hit Figma. You describe *what*, it figures out *how*
- 🔍 **Automated design audit** — token bindings, color contrast, spacing, component health — all checked in one pass · [Full guide →](docs/design-review.md)
- 🔧 **Lint + fix in one step** — 40 rules covering token compliance, WCAG, layout structure — one command to batch-fix everything flagged
- 🔄 **Two-way token sync** — DTCG JSON ↔ Figma variables, Light/Dark multi-mode in one step. Changed tokens in code? Just sync
- 🔀 **Dual mode for any team** — Library mode for Figma shared libraries, Spec mode for DTCG JSON — pick what fits your workflow
- 📐 **Prototype → dev docs** — parse prototype interactions into Mermaid flow diagrams + interaction specs, no more manual handoff docs
- 🛡️ **Harness Pipeline** — auto-verifies every creation, recovers from errors with actionable suggestions, and tracks quality debt across turns

## Quick Start

> Requires Node.js >= 20.

### 1. Install the Figma Plugin

FigCraft is not yet on the Figma Community. Build from source:

```bash
git clone https://github.com/DivikWu/figcraft.git
cd figcraft
npm install
npm run build
```

Then in Figma Desktop:
1. **Plugins → Development → Import plugin from manifest**
2. Select the `manifest.json` file from the cloned repo

### 2. Add MCP Servers to your IDE

FigCraft handles both UI creation and design quality on its own. For even more creation capabilities, you can add the [official Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) alongside it — both servers run in parallel and complement each other.

> **If you cloned this repo (step 1 above)**: MCP configs are already tracked at `.cursor/mcp.json`, `.mcp.json` (Claude Code), and `.kiro/settings/mcp.json`. Open the repo in your IDE and the FigCraft MCP server is wired up automatically — **skip to step 3**.
>
> Note: the tracked Claude Code and Kiro configs auto-approve all FigCraft tools by default — including destructive ones like `delete_node` and `execute_js`. Edit the local file to tighten if your trust model differs.
>
> Why the three configs aren't symmetric: Cursor and Kiro pass MCP server cwd as the filesystem root unless told otherwise, so they use `cwd: "${workspaceFolder}"` (variable substitution supported by VS Code-derived IDEs). Claude Code already defaults `cwd` to the project root for project-level `.mcp.json` and does not perform variable substitution — adding `${workspaceFolder}` there would be passed as a literal path and break the launch. Don't "normalize" the configs by force.

The configs below are for using FigCraft **from a separate project** (e.g. your own app or design system repo).

> **Note**: `figcraft-design` is not yet published to npm. You need to clone the repo first (step 1 above). Replace `cwd` below with the absolute path to your local clone.

FigCraft config (same for all IDEs):

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "npx",
      "args": ["tsx", "packages/figcraft-design/src/index.ts"],
      "cwd": "/your/absolute/path/to/figcraft"
    }
  }
}
```

> FigCraft works standalone for both UI creation and design quality. Adding the Figma MCP server gives you even more creation capabilities.

<details>
<summary><strong>Adding the official Figma MCP server (for extra creation capabilities)</strong></summary>

Figma provides two deployment options:

**Desktop server** (local, runs inside Figma Desktop App):
1. Open Figma Desktop → Dev Mode → Enable MCP server in the inspect panel
2. Add to your IDE config:
```json
{
  "mcpServers": {
    "figma-desktop": {
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

**Remote server** (cloud, broader feature set — recommended by Figma):
See [Figma's remote server setup guide](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/).

For full details, see the [official Figma MCP documentation](https://developers.figma.com/docs/figma-mcp-server/).
</details>

Put it in the right file for your IDE:

<details>
<summary><strong>Cursor</strong> — <code>.cursor/mcp.json</code></summary>

Create `.cursor/mcp.json` in your project root with the config above.
</details>

<details>
<summary><strong>Claude Code</strong> — <code>.mcp.json</code></summary>

Create `.mcp.json` in your project root with the config above.
</details>

<details>
<summary><strong>Kiro</strong> — <code>.kiro/settings/mcp.json</code></summary>

Create `.kiro/settings/mcp.json` in your project root. Kiro supports additional fields like `autoApprove`:

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "npx",
      "args": ["tsx", "packages/figcraft-design/src/index.ts"],
      "cwd": "/your/absolute/path/to/figcraft",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Tools are exposed as `mcp_figcraft_*` (e.g. `mcp_figcraft_ping`, `mcp_figcraft_lint_fix_all`).

> **Tip**: This repo includes `.kiro/steering/figcraft.md` as a workflow guide. Copy it to your project's `.kiro/steering/` folder.
</details>

<details>
<summary><strong>Antigravity (Google)</strong> — MCP Server management panel</summary>

Open Antigravity → Agent dropdown → **Manage MCP Servers** → **View raw config**, then paste the config above.
</details>

<details>
<summary><strong>Codex CLI (OpenAI)</strong> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.figcraft]
command = "npx"
args = ["tsx", "packages/figcraft-design/src/index.ts"]
cwd = "/your/absolute/path/to/figcraft"
```
</details>

### 3. Connect & Verify

Open the FigCraft plugin in Figma — both sides auto-connect via the WebSocket relay. The plugin UI shows the channel ID and connection status.

To verify the connection works, ask your AI IDE to run the `ping` tool. If it returns a response, you're all set.

> **Troubleshooting**: If the connection fails, check that port 3055 is not occupied by another process. The relay will auto-try ports 3056–3060 as fallback.

## Architecture

FigCraft operates on a single Plugin Channel to Figma:

```
AI IDE (Kiro / Cursor / Claude Code / Antigravity / Codex)
    │ MCP (stdio)
    ▼
MCP Server (Node.js)
    └── Plugin Channel ──→ WS Relay (:3055) ──→ Figma Plugin
        (lint, audit, token sync, node ops)
```

- Plugin Channel: WebSocket relay to the FigCraft Figma Plugin. Required for all operations — creation, lint, audit, node inspection, and token sync all run through the Plugin API sandbox.
- `ping` checks Plugin Channel connectivity and reports status.
- FigCraft handles UI creation, design system search, component management, and design-to-code context extraction natively. The [official Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) complements it with FigJam support and Code Connect publishing.

## Dual Mode

| Mode | Token Source | Lint Behavior | Use Case |
|------|-------------|---------------|----------|
| **Library** | Figma shared library | Check variable/style bindings | Daily design with team library |
| **Spec** | DTCG JSON files | Check values against token specs | Spec-driven validation |

Switch modes via `set_mode` tool or the plugin UI.

## UI Creation

FigCraft creates UI directly in Figma — frames, text, SVG, components, variants, icons, and images. The Opinion Engine auto-infers layout, sizing, and token bindings so you describe structure, not implementation details. GRID layout, nested children trees, and batch operations are all supported.

- `create_frame` with inline `children` builds entire screen hierarchies in one call
- `create_component` / `create_component_set` build reusable component libraries with variant guardrails
- After creating UI, the Harness Pipeline auto-verifies quality; or run `lint_fix_all` manually
- Use `get_design_context` to extract node trees with resolved tokens for design-to-code workflows

## Lint Rules (40)

Current lint coverage spans token compliance, WCAG accessibility, layout structure, screen-level quality, naming, and component health.

- Token compliance (5): color, typography, radius, hardcoded token usage, missing text style
- WCAG accessibility (5): contrast, target size, text size, line height, non-text contrast
- Layout & Structure (27): screen shell validation, misclassified interactive root, nested interactive shell, missing auto-layout, empty container, spacer frames, nesting depth, button variants (solid/outline/ghost/text/icon), standalone link, text overflow, form consistency, CTA width consistency, overflow parent, HUG/STRETCH paradox, section spacing collapse, screen bottom overflow, social/nav/stats row crowding, input field structure, mobile dimensions, elevation consistency, elevation hierarchy
- Naming & Content (2): default name detection, placeholder text detection
- Component (1): component property binding checks

See [docs/generated/lint-rules.md](docs/generated/lint-rules.md) for the complete rule reference.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FIGCRAFT_RELAY_PORT` | Relay WebSocket port | `3055` |
| `FIGCRAFT_RELAY_URL` | Full WebSocket relay URL (overrides port) | `ws://localhost:3055` |
| `FIGCRAFT_CHANNEL` | Channel ID | `figcraft` |
| `FIGMA_API_TOKEN` | Figma Personal Access Token (for REST API fallback; can also be set in plugin UI or via OAuth) | — |
| `FIGCRAFT_ACCESS` | Access control level: `read`, `create`, or `edit` | `edit` |

## Development

Requires Node.js >= 20.

```bash
npm install
npm run build          # Build all (MCP server + relay + plugin)
npm run build:plugin   # Build Figma plugin only
npm run dev:relay      # Start WebSocket relay server (for debugging)
npm run dev:mcp        # Start MCP server (stdio transport)
npm run schema         # Regenerate tool registry from schema/tools.yaml
npm run content        # Compile templates, guides, and prompts from content/
npm run typecheck      # TypeScript type check
npm run test           # Run unit tests (vitest)
```

For details on content assets (templates, guides, prompts) and how to add new ones, see [docs/asset-maintenance.md](docs/asset-maintenance.md).

<details>
<summary><strong>Run MCP server from source (for development)</strong></summary>

Instead of `npx figcraft-design`, point your IDE to the local source:

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "npx",
      "args": ["tsx", "packages/figcraft-design/src/index.ts"],
      "cwd": "/path/to/figcraft"
    }
  }
}
```
</details>

## Contributing

Contributions welcome! Fork the repo and open a Pull Request.

Before submitting, make sure:

```bash
npm run typecheck      # Type check passes
npm run test           # Tests pass
```

## License

MIT
