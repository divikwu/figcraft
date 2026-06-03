/**
 * Dynamic toolset manager — registers all tools but only enables core tools by default.
 * Agent can load additional toolsets on demand via `load_toolset` / `unload_toolset`.
 *
 * This keeps the initial tool count low (~30) to reduce agent context overhead,
 * while still making all 100+ tools available when needed.
 *
 * Usage in index.ts:
 *   1. Call registerAllTools(server, bridge) — registers everything
 *   2. Call registerToolsetMetaTools(server) — adds load/unload/list meta tools
 *   3. Call disableNonCoreTools(server) — disables non-core tools, notifies client
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { createHarnessPipeline } from '../harness/index.js';
import { registerGeneratedTools } from './_generated.js';
// ─── Generated registry (single source of truth from schema/tools.yaml) ───
import {
  GENERATED_BRIDGE_TOOLS,
  GENERATED_CORE_TOOLS,
  GENERATED_DEPRECATED_TOOLS,
  GENERATED_EDIT_TOOLS,
  GENERATED_ENDPOINT_METHOD_ACCESS,
  GENERATED_ENDPOINT_REPLACES,
  GENERATED_ENDPOINT_TOOLS,
  GENERATED_REMOVED_TOOLS,
  GENERATED_TOOLSET_QUICKSTART,
  GENERATED_TOOLSETS,
  GENERATED_WRITE_TOOLS,
} from './_registry.js';
import { registerAuditTools } from './audit.js';
import { registerAuthTools } from './auth.js';
import { registerChannelTools } from './channel.js';
import { registerCreateFrame } from './create-frame.js';
import { registerCreationGuide } from './creation-guide.js';
import { registerEndpointTools } from './endpoints.js';
import { registerExecuteJsTools } from './execute-js.js';
import { registerExportTools } from './export.js';
import { registerHelpTool } from './help.js';
import { registerIconTools } from './iconify.js';
import { registerLibraryStyleTools } from './library-styles.js';
import { registerLintTools } from './lint.js';
import { registerLocalImageTools } from './local-images.js';
import { registerModeTools } from './mode.js';
import { registerNodeTools } from './nodes.js';
import { registerPexelsTools } from './pexels.js';
// Import all register functions
import { registerPing } from './ping.js';
import { registerPrototypeTools } from './prototype.js';
import { registerSearchDesignSystemTool } from './search-design-system.js';
import { registerStagingTools } from './staging.js';
import { registerStorageTools } from './storage.js';
import { registerTokenTools } from './tokens.js';
import { registerWriteStyleTools } from './write-styles.js';

const CORE_TOOLS = GENERATED_CORE_TOOLS;
const TOOLSETS = GENERATED_TOOLSETS;

// ─── State ───

const loadedToolsets = new Set<string>();
const toolHandles = new Map<string, RegisteredTool>();

// ─── Access control (3-tier) ───
// FIGCRAFT_ACCESS controls which tools are available:
//   read   — only read tools (all write tools disabled)
//   create — read + tools that add new content (edit tools disabled)
//   edit   — full access (default)
//
// Legacy: FIGCRAFT_READ_ONLY=true is equivalent to FIGCRAFT_ACCESS=read.

export type AccessLevel = 'read' | 'create' | 'edit';

function resolveAccessLevel(): AccessLevel {
  // Legacy env var takes precedence if set
  const readOnly = process.env.FIGCRAFT_READ_ONLY;
  if (readOnly === 'true' || readOnly === '1') return 'read';

  const access = (process.env.FIGCRAFT_ACCESS ?? 'edit').toLowerCase();
  if (access === 'read' || access === 'create' || access === 'edit') return access as AccessLevel;
  console.error(`[FigCraft toolset] WARNING: unknown FIGCRAFT_ACCESS="${access}", defaulting to "edit"`);
  return 'edit';
}

const ACCESS_LEVEL: AccessLevel = resolveAccessLevel();

// ─── API mode ───
// FigCraft uses endpoint mode exclusively. Legacy flat tools are registered as
// ghost tools that return migration guidance (see GENERATED_REMOVED_TOOLS).

/** All tools that modify the Figma document. */
const WRITE_TOOLS = GENERATED_WRITE_TOOLS;
/** Tools that modify/delete existing content (access: edit). Allowed only at edit level. */
const EDIT_TOOLS = GENERATED_EDIT_TOOLS;

/**
 * Check if a tool is blocked by the current access level.
 * Returns the reason string if blocked, or null if allowed.
 */
export function isToolBlocked(toolName: string): string | null {
  if (ACCESS_LEVEL === 'edit') return null; // full access
  if (ACCESS_LEVEL === 'create') {
    if (EDIT_TOOLS.has(toolName)) return `blocked by FIGCRAFT_ACCESS=create (edit-level tool)`;
    return null;
  }
  // read level
  if (WRITE_TOOLS.has(toolName)) return `blocked by FIGCRAFT_ACCESS=read (write tool)`;
  return null;
}

/** Get the current access level. */
export function getAccessLevel(): AccessLevel {
  return ACCESS_LEVEL;
}

/** Whether toolset management is operational (false = graceful degradation). */
let toolsetManagementActive = false;

/**
 * Snapshot all registered tool handles from the server's internal registry.
 * Called once after all tools are registered — no monkey-patching needed.
 *
 * Defensive: if the SDK changes its internal structure, we gracefully degrade
 * (all tools stay enabled, toolset management becomes a no-op).
 *
 * Probes multiple possible property names to survive SDK refactors.
 */
function captureToolHandles(server: McpServer): boolean {
  // Probe candidates — SDK may rename the internal property across versions
  const candidates = ['_registeredTools', '_tools', 'registeredTools'];
  let registry: Record<string, unknown> | null = null;
  const serverAny = server as unknown as Record<string, unknown>;

  for (const prop of candidates) {
    const val = serverAny[prop];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      registry = val as Record<string, unknown>;
      break;
    }
  }

  if (!registry) {
    console.error(
      '[FigCraft toolset] WARNING: cannot access tool registry — SDK may have changed. All tools will remain enabled.',
    );
    return false;
  }

  for (const [name, handle] of Object.entries(registry)) {
    if (
      handle &&
      typeof handle === 'object' &&
      typeof (handle as RegisteredTool).enable === 'function' &&
      typeof (handle as RegisteredTool).disable === 'function'
    ) {
      toolHandles.set(name, handle as RegisteredTool);
    }
  }

  toolsetManagementActive = toolHandles.size > 0;
  return toolsetManagementActive;
}

/**
 * Safely enable a tool handle. Returns true if successful.
 */
function safeEnable(handle: RegisteredTool): boolean {
  try {
    handle.enable();
    return true;
  } catch (err) {
    console.error('[FigCraft toolset] enable() failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Safely disable a tool handle. Returns true if successful.
 */
function safeDisable(handle: RegisteredTool): boolean {
  try {
    handle.disable();
    return true;
  } catch (err) {
    console.error('[FigCraft toolset] disable() failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

// ─── Public API ───

/**
 * Register ALL tools (core + all toolsets). Captures handles for later enable/disable.
 */
/**
 * Register ghost tools for removed flat tools.
 * Each ghost returns a migration guidance error pointing to the replacement endpoint.
 */
function registerRemovedToolGhosts(server: McpServer): void {
  for (const [toolName, info] of Object.entries(GENERATED_REMOVED_TOOLS)) {
    server.tool(
      toolName,
      `[REMOVED] This tool has been removed. Use ${info.endpoint}(method: "${info.method}") instead.`,
      {},
      async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: false,
                error: `Tool "${toolName}" has been removed. Use ${info.endpoint}(method: "${info.method}") instead.`,
                migration: { endpoint: info.endpoint, method: info.method },
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      }),
    );
  }
}

export function registerAllTools(server: McpServer, bridge: Bridge): void {
  // Initialize Harness Pipeline — middleware for pre/post processing of bridge requests.
  // Must be set before tool registration so that all bridge.request() calls go through it.
  const pipeline = createHarnessPipeline(bridge);
  bridge.setPipeline(pipeline);

  // Register every tool group (same as original index.ts)
  registerPing(server, bridge);
  registerAuthTools(server);
  registerNodeTools(server, bridge);
  registerGeneratedTools(server, bridge, { include: GENERATED_BRIDGE_TOOLS });
  registerLibraryStyleTools(server, bridge);
  registerExportTools(server, bridge);
  registerTokenTools(server, bridge);
  registerStorageTools(server, bridge);
  registerWriteStyleTools(server, bridge);
  registerLintTools(server, bridge);
  registerModeTools(server, bridge);
  registerCreationGuide(server, bridge);
  registerChannelTools(server, bridge);
  registerPrototypeTools(server, bridge);
  registerAuditTools(server, bridge);
  registerStagingTools(server, bridge);
  registerExecuteJsTools(server, bridge);

  // Register icon tools (Iconify integration)
  registerIconTools(server, bridge);

  // Register custom create_frame handler (resolves icon children before forwarding to Plugin)
  registerCreateFrame(server, bridge);

  // Register image tools (Pexels integration)
  registerPexelsTools(server);
  registerLocalImageTools(server, bridge);

  // Register design system search
  registerSearchDesignSystemTool(server, bridge);

  // Register endpoint tools (resource-oriented API)
  registerEndpointTools(server, bridge);

  // Register help tool (AI can query tool usage at runtime)
  registerHelpTool(server);

  // Register ghost tools for removed flat tools (Phase 3 migration guidance)
  registerRemovedToolGhosts(server);

  // Snapshot all handles from the server's internal registry
  const captured = captureToolHandles(server);
  if (!captured) {
    console.error('[FigCraft toolset] tool capture failed — toolset management disabled, all tools remain active');
  }

  // Set readOnlyHint annotations: write tools = false, all others = true.
  // Allows MCP clients (Claude Code, Cursor) to safely parallelize read-only calls.
  let annotated = 0;
  for (const [name, handle] of toolHandles) {
    const isWrite = WRITE_TOOLS.has(name);
    handle.annotations = { ...handle.annotations, readOnlyHint: !isWrite };
    annotated++;
  }

  console.error(
    `[FigCraft toolset] registered ${toolHandles.size} tools total, ${annotated} annotated with readOnlyHint`,
  );
}

/**
 * Register the 3 meta tools: load_toolset, unload_toolset, list_toolsets.
 */
export function registerToolsetMetaTools(server: McpServer): void {
  const toolsetNames = Object.keys(TOOLSETS);

  server.registerTool(
    'load_toolset',
    {
      description:
        'Load an additional toolset to enable more tools. ' +
        `Only ~${CORE_TOOLS.size + 3} core tools are enabled by default. ` +
        'Call list_toolsets to see available toolsets and their descriptions. ' +
        'You can load multiple toolsets at once by passing a comma-separated string.',
      inputSchema: {
        names: z.string().describe(`Comma-separated toolset names to load. Available: ${toolsetNames.join(', ')}`),
      },
    },
    async ({ names }) => {
      const results: string[] = [];
      for (const name of names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        results.push(enableToolset(server, name));
      }
      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    },
  );

  server.registerTool(
    'unload_toolset',
    {
      description: 'Unload a previously loaded toolset to reduce context. Core tools cannot be unloaded.',
      inputSchema: {
        names: z.string().describe('Comma-separated toolset names to unload.'),
      },
    },
    async ({ names }) => {
      const results: string[] = [];
      for (const name of names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        results.push(disableToolset(server, name));
      }
      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    },
  );

  server.registerTool(
    'list_toolsets',
    {
      description: 'List all available toolsets with descriptions, tool counts, and loaded status.',
      inputSchema: {},
    },
    async () => {
      const lines: string[] = [];
      if (ACCESS_LEVEL !== 'edit') {
        const icon = ACCESS_LEVEL === 'read' ? '🔒' : '🔏';
        lines.push(
          `${icon} Access level: ${ACCESS_LEVEL.toUpperCase()} (FIGCRAFT_ACCESS=${ACCESS_LEVEL}). ${ACCESS_LEVEL === 'read' ? 'All write tools disabled.' : 'Edit tools disabled, create tools allowed.'}`,
          '',
        );
      }
      const blockedCoreCount =
        ACCESS_LEVEL === 'read'
          ? [...CORE_TOOLS].filter((t) => WRITE_TOOLS.has(t)).length
          : ACCESS_LEVEL === 'create'
            ? [...CORE_TOOLS].filter((t) => EDIT_TOOLS.has(t)).length
            : 0;
      lines.push(
        `Core tools (always enabled): ${CORE_TOOLS.size}${blockedCoreCount > 0 ? ` (${blockedCoreCount} tools disabled by access level)` : ''}`,
        '',
      );
      // Endpoint info
      {
        const epLines: string[] = [];
        for (const ep of GENERATED_ENDPOINT_TOOLS) {
          const methods = GENERATED_ENDPOINT_METHOD_ACCESS[ep];
          if (methods) {
            const methodCount = Object.keys(methods).length;
            epLines.push(`${ep} (${methodCount} methods)`);
          }
        }
        if (epLines.length > 0) {
          lines.push(`Endpoints: ${epLines.join(', ')}`, '');
        }
      }
      lines.push('Available toolsets:');
      for (const [name, def] of Object.entries(TOOLSETS)) {
        const status = loadedToolsets.has(name) ? '✅ loaded' : '⬚ not loaded';
        const blockedCount =
          ACCESS_LEVEL === 'read'
            ? def.tools.filter((t) => WRITE_TOOLS.has(t)).length
            : ACCESS_LEVEL === 'create'
              ? def.tools.filter((t) => EDIT_TOOLS.has(t)).length
              : 0;
        const blockedSuffix = blockedCount > 0 ? ` (${blockedCount} tools blocked)` : '';
        lines.push(`  ${name} (${def.tools.length} tools) [${status}]${blockedSuffix}`);
        lines.push(`    ${def.description}`);
      }
      const totalNonCore = Object.values(TOOLSETS).reduce((sum, d) => sum + d.tools.length, 0);
      lines.push(
        '',
        `Total: ${CORE_TOOLS.size} core + ${totalNonCore} in toolsets = ${CORE_TOOLS.size + totalNonCore} tools`,
      );
      const activeCoreCount = CORE_TOOLS.size - blockedCoreCount;
      const activeLoadedCount = [...loadedToolsets].reduce((sum, n) => {
        const ts = TOOLSETS[n];
        if (!ts) return sum;
        return sum + ts.tools.filter((t) => !isToolBlocked(t)).length;
      }, 0);
      lines.push(`Currently active: ${activeCoreCount + activeLoadedCount}`);
      // Show deprecated tools if any
      const deprecatedCount = Object.keys(GENERATED_DEPRECATED_TOOLS).length;
      if (deprecatedCount > 0) {
        lines.push('', `⚠️ Deprecated tools (${deprecatedCount}):`);
        for (const [tool, info] of Object.entries(GENERATED_DEPRECATED_TOOLS)) {
          lines.push(`  ${tool} → use ${info.replacedBy} instead`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

/**
 * Disable all non-core tools. Call AFTER registerAllTools + registerToolsetMetaTools.
 * Also validates that every registered tool belongs to CORE_TOOLS or a toolset.
 */
export function disableNonCoreTools(server: McpServer): void {
  if (!toolsetManagementActive || toolHandles.size === 0) {
    console.error('[FigCraft toolset] no tool handles captured — skipping disable (all tools remain active)');
    return;
  }

  // Build set of all known tool names (core + all toolsets + meta tools + endpoint tools)
  const allKnown = new Set(CORE_TOOLS);
  const META_TOOLS = ['load_toolset', 'unload_toolset', 'list_toolsets'];
  for (const name of META_TOOLS) allKnown.add(name);
  for (const def of Object.values(TOOLSETS)) {
    for (const tool of def.tools) allKnown.add(tool);
  }
  for (const ep of GENERATED_ENDPOINT_TOOLS) allKnown.add(ep);

  // Warn about orphaned tools (registered but not in any group)
  const orphaned: string[] = [];
  let disabled = 0;
  for (const [name, handle] of toolHandles) {
    if (!allKnown.has(name)) {
      orphaned.push(name);
    }
    if (!CORE_TOOLS.has(name) && !META_TOOLS.includes(name) && handle.enabled) {
      if (safeDisable(handle)) disabled++;
    }
  }

  // Disable flat tools that are replaced by endpoints (only core ones — toolset ones are already disabled)
  let apiModeDisabled = 0;
  for (const replaces of Object.values(GENERATED_ENDPOINT_REPLACES)) {
    for (const flatTool of replaces) {
      if (CORE_TOOLS.has(flatTool)) {
        const h = toolHandles.get(flatTool);
        if (h?.enabled && safeDisable(h)) apiModeDisabled++;
      }
    }
  }
  // Re-enable core endpoint tools that were disabled in the generic non-core loop above.
  // Defensive: core endpoint tools (e.g. 'nodes', 'text', 'shapes', 'components') are in
  // CORE_TOOLS, so the generic loop won't disable them. This block is a safety net in case
  // the CORE_TOOLS set is misconfigured or a future refactor changes the disable order.
  for (const ep of GENERATED_ENDPOINT_TOOLS) {
    if (CORE_TOOLS.has(ep)) {
      const h = toolHandles.get(ep);
      if (h && !h.enabled && safeEnable(h)) apiModeDisabled--; // net count
    }
  }

  // Access control: disable tools blocked by the current access level
  let accessDisabled = 0;
  if (ACCESS_LEVEL !== 'edit') {
    const blockedSet = ACCESS_LEVEL === 'read' ? WRITE_TOOLS : EDIT_TOOLS;
    for (const toolName of blockedSet) {
      const h = toolHandles.get(toolName);
      if (h?.enabled && safeDisable(h)) accessDisabled++;
    }
  }

  if (orphaned.length > 0) {
    console.error(
      `[FigCraft toolset] WARNING: orphaned tools (not in CORE_TOOLS or any toolset): ${orphaned.join(', ')}`,
    );
    console.error(
      '[FigCraft toolset] These tools are disabled with no way to enable them. Add them to CORE_TOOLS or a TOOLSETS entry.',
    );
  }

  console.error(
    `[FigCraft toolset] disabled ${disabled} non-core tools, ${CORE_TOOLS.size} core + ${META_TOOLS.length} meta tools active`,
  );
  if (ACCESS_LEVEL !== 'edit') {
    console.error(`[FigCraft toolset] access level "${ACCESS_LEVEL}": additionally disabled ${accessDisabled} tools`);
  }
  if (apiModeDisabled > 0) {
    console.error(`[FigCraft toolset] endpoint mode: ${apiModeDisabled} replaced flat tools disabled`);
  }

  // Validate WRITE_TOOLS: warn about entries that don't match any registered tool.
  // This catches stale entries or typos when new tools are added.
  const staleWriteTools: string[] = [];
  for (const wt of WRITE_TOOLS) {
    if (!toolHandles.has(wt)) {
      staleWriteTools.push(wt);
    }
  }
  if (staleWriteTools.length > 0) {
    console.error(
      `[FigCraft toolset] WARNING: WRITE_TOOLS contains ${staleWriteTools.length} unregistered tool(s): ${staleWriteTools.join(', ')}`,
    );
    console.error(
      '[FigCraft toolset] These may be stale entries — verify they still exist or remove them from WRITE_TOOLS.',
    );
  }

  server.sendToolListChanged();
}

// ─── Internal helpers ───

function enableToolset(server: McpServer, name: string): string {
  const def = TOOLSETS[name];
  if (!def) return `Unknown toolset "${name}". Use list_toolsets to see available toolsets.`;
  if (loadedToolsets.has(name)) return `Toolset "${name}" is already loaded.`;

  if (!toolsetManagementActive) {
    loadedToolsets.add(name);
    return `Loaded "${name}" (toolset management degraded — all tools already active).`;
  }

  let count = 0;
  const skippedAccess: string[] = [];
  const skippedReplaced: string[] = [];
  for (const tool of def.tools) {
    const blocked = isToolBlocked(tool);
    if (blocked) {
      skippedAccess.push(tool);
      continue;
    }
    // Skip flat tools that are replaced by endpoints
    if (!GENERATED_ENDPOINT_TOOLS.has(tool)) {
      const isReplaced = Object.values(GENERATED_ENDPOINT_REPLACES).some((r) => r.includes(tool));
      if (isReplaced) {
        skippedReplaced.push(tool);
        continue;
      }
    }
    const h = toolHandles.get(tool);
    if (h && !h.enabled && safeEnable(h)) count++;
  }
  loadedToolsets.add(name);
  server.sendToolListChanged();

  const enabledTools = def.tools.filter((t) => !isToolBlocked(t) && !skippedReplaced.includes(t));
  let msg = `Loaded "${name}" — ${count} tools enabled: ${enabledTools.join(', ')}`;
  if (skippedAccess.length > 0) {
    msg += `\n⚠️ Access level "${ACCESS_LEVEL}": ${skippedAccess.length} tools skipped: ${skippedAccess.join(', ')}`;
  }
  if (skippedReplaced.length > 0) {
    msg += `\n⚠️ Endpoint mode: ${skippedReplaced.length} replaced flat tools skipped: ${skippedReplaced.join(', ')}`;
  }
  const quickStart = GENERATED_TOOLSET_QUICKSTART[name];
  if (quickStart) {
    msg += `\n⚡ Quick start: ${quickStart}`;
  }
  return msg;
}

function disableToolset(server: McpServer, name: string): string {
  const def = TOOLSETS[name];
  if (!def) return `Unknown toolset "${name}".`;
  if (!loadedToolsets.has(name)) return `Toolset "${name}" is not loaded.`;

  if (!toolsetManagementActive) {
    loadedToolsets.delete(name);
    return `Unloaded "${name}" (toolset management degraded — tools remain active).`;
  }

  let count = 0;
  for (const tool of def.tools) {
    if (CORE_TOOLS.has(tool)) continue;
    const h = toolHandles.get(tool);
    if (h?.enabled && safeDisable(h)) count++;
  }
  loadedToolsets.delete(name);
  server.sendToolListChanged();
  return `Unloaded "${name}" — ${count} tools disabled.`;
}
