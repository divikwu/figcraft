# Flat → Endpoint Migration Guide

> **Status**: Migration complete (Phase 3). Flat mode has been removed. This document is retained as a reference for the mapping between legacy flat tool names and their endpoint equivalents.

## Overview

FigCraft migrated from flat tool names to resource-oriented endpoint mode. Legacy flat tool names are registered as "ghost tools" that return migration guidance pointing to the correct endpoint method. FigCraft provides its own declarative creation tools (`create_frame`, `create_text`, `create_svg`) with an Opinion Engine that auto-handles sizing, FILL ordering, token binding, and failure cleanup.

## Complete Mapping Table

### Core Tools (always available)

| Flat Tool | Endpoint Call |
|-----------|--------------|
| `get_node_info(nodeId)` | `nodes(method: "get", nodeId)` |
| `search_nodes(query)` | `nodes(method: "list", query)` |
| `patch_nodes(patches)` | `nodes(method: "update", patches)` |
| `delete_nodes(nodeIds)` | `nodes(method: "delete", nodeIds)` |
| `set_text_content(nodeId, content)` | `text(method: "set_content", nodeId, content)` |
| `list_components()` | `components(method: "list")` |
| `list_library_components()` | `components(method: "list_library")` |
| `get_component(nodeId)` | `components(method: "get", nodeId)` |
| `list_component_properties(nodeId)` | `components(method: "list_properties", nodeId)` |

### Removed Legacy Tools (replaced by declarative tools or endpoints)

The following legacy flat tool names have been removed. Use the declarative tools or endpoints instead:

| Legacy Tool | Replacement |
|-------------|-------------|
| `create_document` | `create_page` (pages toolset) |
| `create_screen` | `create_frame` (core, with Opinion Engine) |
| `create_frame` (legacy) | `create_frame` (core, rebuilt with Opinion Engine + token binding) |
| `create_rectangle` | `create_frame` children `type:"rectangle"` or `create_rectangle` (shapes-vectors toolset) |
| `create_ellipse` | `create_frame` children `type:"ellipse"` or `create_ellipse` (shapes-vectors toolset) |
| `create_vector` | `create_svg` (core) |
| `create_text` (legacy) | `create_text` (core, rebuilt with font fallback + token binding) |
| `create_instance` | `create_instance` (components-advanced toolset) |
| `clone_node` | `nodes(method: "clone")` |
| `insert_child` | `create_frame` children with `parentId` |
| `set_image_fill` | Remote images: `create_frame` with `imageUrl`; local new frames: `create_image_frame_from_local`; local replacement: `fill_existing_image_from_local` |

### Variables Endpoint (core — always available, no toolset needed)

| Flat Tool | Endpoint Call |
|-----------|--------------|
| `list_variables(...)` | `variables_ep(method: "list", ...)` |
| `get_variable(variableId)` | `variables_ep(method: "get", variableId)` |
| `list_collections()` | `variables_ep(method: "list_collections")` |
| `get_node_variables(nodeId)` | `variables_ep(method: "get_bindings", nodeId)` |
| `set_variable_binding(...)` | `variables_ep(method: "set_binding", ...)` |
| `create_variable(...)` | `variables_ep(method: "create", ...)` |
| `update_variable(...)` | `variables_ep(method: "update", ...)` |
| `delete_variable(variableId)` | `variables_ep(method: "delete", variableId)` |
| `create_collection(...)` | `variables_ep(method: "create_collection", ...)` |
| `delete_collection(collectionId)` | `variables_ep(method: "delete_collection", collectionId)` |
| `batch_create_variables(...)` | `variables_ep(method: "batch_create", ...)` |
| `export_variables(...)` | `variables_ep(method: "export", ...)` |

### Styles Endpoint (core — always available, no toolset needed)

| Flat Tool | Endpoint Call |
|-----------|--------------|
| `list_styles(...)` | `styles_ep(method: "list", ...)` |
| `get_style(styleId)` | `styles_ep(method: "get", styleId)` |
| `create_paint_style(...)` | `styles_ep(method: "create_paint", ...)` |
| `update_paint_style(...)` | `styles_ep(method: "update_paint", ...)` |
| `update_text_style(...)` | `styles_ep(method: "update_text", ...)` |
| `update_effect_style(...)` | `styles_ep(method: "update_effect", ...)` |
| `delete_style(styleId)` | `styles_ep(method: "delete", styleId)` |
| `sync_styles(tokens)` | `styles_ep(method: "sync", tokens)` |

## Standalone Tools (unchanged)

These tools are NOT grouped into endpoints and keep their original names:

`ping`, `get_mode`, `set_mode`, `join_channel`, `get_channel`, `export_image`, `lint_fix_all`, `set_current_page`, `save_version_history`, `set_selection`, `get_selection`, `get_current_page`, `get_document_info`, `list_fonts`, `audit_node`, `get_design_guidelines`

## Workflow Examples

### Before (flat mode)

```
ping → get_current_page(maxDepth=2) → get_node_info(nodeId: "1:23")
patch_nodes(patches: [{ nodeId: "1:23", props: { name: "Updated" } }])
delete_nodes(nodeIds: ["1:23"])
```

### After (endpoint mode)

```
ping → get_current_page(maxDepth=2) → nodes(method: "get", nodeId: "1:23")
nodes(method: "update", patches: [{ nodeId: "1:23", props: { name: "Updated" } }])
nodes(method: "delete", nodeIds: ["1:23"])
```

## Bridge Protocol Note

Endpoint methods dispatch to the Figma plugin via `bridge.request()` using internal handler names (e.g. `patch_nodes`, `clone_node`). These are bridge protocol names used for plugin communication, not MCP tool names. The plugin handler registry (`packages/adapter-figma/src/handlers/`) was intentionally not modified during the migration.
