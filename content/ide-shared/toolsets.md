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
