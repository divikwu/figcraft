# FigCraft Public Contract Baseline

This document captures the externally visible behavior that must remain stable across releases.

## CLI

- Command name: `figcraft-design`
- Published package manifest: `packages/figcraft-design/package.json`
- Published bin target: `./dist/index.js`
- Current local development command: `npm run dev:mcp`
- The root dev/build shell now delegates to:
  - `packages/figcraft-design/src/index.ts`
  - `packages/relay/src/index.ts`
  - `packages/adapter-figma/build.plugin.mjs`

## Figma Plugin Import

- Users import the repository-root `manifest.json`
- The package-owned manifest source of truth lives at:
  - `packages/adapter-figma/manifest.base.json`
- The generated root manifest currently points at:
  - `dist/plugin/code.js`
  - `dist/plugin/ui.html`
- The plugin build also emits `dist/plugin/manifest.json` for convenience

## Schema and Tooling

- Tool definitions live at `schema/tools.yaml`
- The schema compiler writes package-owned generated files to:
  - `packages/core-mcp/src/tools/_generated.ts`
  - `packages/core-mcp/src/tools/_registry.ts`
  - `packages/core-mcp/src/tools/_contracts.ts`
- Generated API contract documentation lives at:
  - `docs/generated/api-contracts.md`
- The generated registry exposes endpoint-to-flat-tool replacement metadata via:
  - `GENERATED_ENDPOINT_REPLACES`
  - `GENERATED_REMOVED_TOOLS`

## Stable Runtime Surface

- Endpoint names and method names remain stable
- Legacy flat tool names have been removed; calling them returns migration guidance (see `docs/flat-to-endpoint-migration.md`)
- Core declarative tools: `create_frame`, `create_text`, `create_svg` (with Opinion Engine)
- MCP guidance tools: `get_mode`, `get_design_guidelines`, `get_creation_guide`
- Existing environment variables remain stable:
  - `FIGCRAFT_RELAY_PORT`
  - `FIGCRAFT_RELAY_URL`
  - `FIGCRAFT_CHANNEL`
  - `FIGCRAFT_ACCESS`
  - `FIGMA_API_TOKEN`

## Skills Directory

- Skills live at `skills/` (project root), shared across IDEs via symlinks
- Structure: flat — all 30 skills as direct children of `skills/` (design rules, declarative creation, plugin API, platform, auxiliary)
- IDE symlinks: `.claude/skills` → `../skills`, `.kiro/skills` → `../skills`
- Design rules source of truth: `skills/ui-ux-fundamentals/SKILL.md`, `skills/design-guardian/SKILL.md`, `skills/design-creator/SKILL.md`

## Quality Gate

The migration must continue to pass:

- `npm run typecheck`
- `npm run test`
- `npm run build`

## Compatibility Note

The repository root is now the private workspace orchestrator.
The published CLI surface lives in `packages/figcraft-design`, while the repository root preserves the local manifest/build compatibility surface.
Package-owned source lives under `packages/*`, and legacy `src/*` shim trees have been removed.
