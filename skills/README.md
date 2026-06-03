# FigCraft Skills

Skills are first-class project assets. All skills are managed flat under `skills/`.

## Shared Design Rules

| Skill | Description |
|-------|-------------|
| **ui-ux-fundamentals** | Universal design quality rules (typography, spacing, content, accessibility). Always applies. |
| **design-creator** | No-library mode rules (intentional design thinking, color, iconography). Extends ui-ux-fundamentals. |
| **design-guardian** | Library mode rules (token priority, dark mode, conflict resolution). Extends ui-ux-fundamentals. |

Source of truth for MCP runtime `get_design_guidelines()`. Build copies content (stripped of frontmatter) to `dist/mcp-server/`.

## Quality Assurance

| Skill | Description |
|-------|-------------|
| **design-review** | Review existing designs against quality rules. Outputs structured violation report with fixes. |
| **design-lint** | Lint designs for compliance and auto-fix violations. 40 rules, 22 auto-fixable. |
| **component-docs** | Generate component documentation — properties, variants, usage, structural health audit. |
| **prototype-analysis** | Analyze prototype interactions — flow graph, dead ends, loops, Mermaid diagrams. |
| **text-replace** | Bulk replace text content — localization, data filling, content updates. |
| **spec-compare** | Compare DTCG token spec against Figma variables — audit token drift. |
| **token-sync** | Sync DTCG design tokens to Figma variables and styles. |

Forms the "create → review → fix" quality loop: `figma-create-ui` → `design-review` → `design-lint`.

## Design Patterns

| Skill | Description |
|-------|-------------|
| **responsive-design** | Responsive web design — breakpoints, auto-layout strategy, sizing patterns. |
| **figcraft-html-import** | Import static HTML/web pages into editable Figma layers through the native `import_html` converter. |
| **content-states** | Empty, loading, and error state design patterns for data-driven views. |
| **iconography** | Icon ordering in auto-layout, tool chain, sizing, spacing, style consistency. |
| **multi-screen-flow** | Multi-screen flow architecture — wrapper hierarchy, stage containers, step pills, build order. |
| **design-handoff** | Annotate designs with specs for developer handoff. |
| **platform-ios** | iOS platform rules — screen dimensions, safe areas, SF Pro, HIG navigation. |
| **platform-android** | Android platform rules — screen dimensions, Material Design 3, Roboto, navigation. |
| **ux-writing** | UX writing rules — universal best practices + language-specific rules (Chinese, English). Buttons, forms, errors, empty states. |

## Advanced Orchestration

| Skill | Description |
|-------|-------------|
| **design-system-audit** | Audit design system health — token coverage, component quality, naming compliance. |
| **migration-assistant** | Design system version migration — token mapping, component swapping, verification. |
| **multi-brand** | Multi-brand token management — brand themes, mode switching, cross-brand verification. |

## Declarative Path (create_frame)

| Skill | Description |
|-------|-------------|
| **figma-create-ui** | Create UI using FigCraft declarative tools with Opinion Engine. No-library or single component creation. |
| **figcraft-generate-design** | Create screens by reusing existing design system components, variables, and styles. Extends figma-create-ui with mandatory discovery phase. |
| **figcraft-generate-library** | Build professional design systems (20-100+ calls). Multi-phase: discovery → tokens → structure → components → QA. |

## Plugin API Path (execute_js / use_figma)

| Skill | Description |
|-------|-------------|
| **figcraft-use** | Mandatory prerequisite for all `use_figma`/`execute_js` calls. Plugin API rules. |

## Auxiliary

| Skill | Description |
|-------|-------------|
| **figcraft-implement-design** | Translate Figma designs into production code. |
| **figcraft-code-connect** | Map Figma components to code via Code Connect. |
| **figcraft-create-design-system-rules** | Generate project-specific IDE design rules. |
| **figcraft-create-new-file** | Create blank Figma design/FigJam files. |

## Strategy

See [docs/skills-strategy.md](../docs/skills-strategy.md) for long-term roadmap, expansion phases, and maintenance guidelines.
