/**
 * Code Mode — expose every FigCraft tool through a few MCP tools:
 *
 *   search        — find tools and get compact TypeScript signatures on demand
 *   execute       — run JavaScript that calls READ-ONLY `figcraft.<tool>(args)` in a sandbox
 *   execute_write — same, but may also call tools/methods that modify the document
 *
 * Inspired by Cloudflare's Code Mode (https://blog.cloudflare.com/code-mode-mcp/):
 * tool definitions no longer sit in the context window, and intermediate tool
 * results (node trees, lint reports…) stay inside the sandbox instead of being
 * copied through the model.
 *
 * Reads and writes are split into two MCP tools so IDE approval prompts and
 * readOnlyHint/destructiveHint annotations keep meaning something: approving
 * `execute` never authorizes changes to the document.
 *
 * Enabled with FIGCRAFT_CODE_MODE:
 *   off  (default) — classic tools only
 *   on             — classic tools + Code Mode tools
 *   only           — Code Mode tools + export_image (smallest context footprint)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { designPreflightRule } from '../../harness/rules/design-preflight.js';
import {
  GENERATED_CORE_TOOLS,
  GENERATED_DEPRECATED_TOOLS,
  GENERATED_ENDPOINT_METHOD_ACCESS,
  GENERATED_ENDPOINT_REPLACES,
  GENERATED_ENDPOINT_TOOLS,
  GENERATED_REMOVED_TOOLS,
  GENERATED_TOOLSETS,
  GENERATED_WRITE_TOOLS,
} from '../_registry.js';
import { truncateStructurally } from '../response-helpers.js';
import { type CapturedTool, renderToolSignature, type ToolCatalog, validateToolArgs } from './catalog.js';
import { type LateCall, runInSandbox } from './sandbox.js';

export type CodeMode = 'off' | 'on' | 'only';

/** Classic tools kept visible in "only" mode: their image output is meant for the model's eyes. */
export const CODE_MODE_ONLY_KEEP = new Set(['export_image']);

export function resolveCodeMode(env: NodeJS.ProcessEnv = process.env): CodeMode {
  const raw = (env.FIGCRAFT_CODE_MODE ?? 'off').trim().toLowerCase();
  if (raw === '' || raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'only') return 'only';
  console.error(`[FigCraft code-mode] WARNING: unknown FIGCRAFT_CODE_MODE="${raw}", defaulting to "off"`);
  return 'off';
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export interface CodeModeOptions {
  catalog: ToolCatalog;
  /** Returns a reason string when the tool is blocked by FIGCRAFT_ACCESS, else null. */
  isToolBlocked: (toolName: string) => string | null;
  /** Default wall-clock limit per execution. */
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxToolCalls?: number;
  maxParallelCalls?: number;
  /** How long to wait for in-flight calls after a run ends, to report their outcome. */
  settleTimeoutMs?: number;
  /** Character budget for the execute result (≈ chars / 4 tokens). */
  maxOutputChars?: number;
}

export function codeModeOptionsFromEnv(
  base: Pick<CodeModeOptions, 'catalog' | 'isToolBlocked'>,
  env: NodeJS.ProcessEnv = process.env,
): CodeModeOptions {
  return {
    ...base,
    defaultTimeoutMs: envInt(env, 'FIGCRAFT_CODE_MODE_TIMEOUT_MS', 60_000, 1_000, 600_000),
    maxTimeoutMs: 600_000,
    maxToolCalls: envInt(env, 'FIGCRAFT_CODE_MODE_MAX_CALLS', 200, 1, 5_000),
    maxParallelCalls: envInt(env, 'FIGCRAFT_CODE_MODE_MAX_PARALLEL', 4, 1, 32),
    maxOutputChars: envInt(env, 'FIGCRAFT_CODE_MODE_MAX_OUTPUT', 24_000, 1_000, 500_000),
  };
}

/**
 * Never callable from code: toolset plumbing, Code Mode itself, and `execute_js`
 * (raw Plugin API; it stays behind its explicit `load_toolset('debug')` opt-in).
 */
const NON_CALLABLE = new Set([
  'load_toolset',
  'unload_toolset',
  'list_toolsets',
  'search',
  'execute',
  'execute_write',
  'execute_js',
]);

/** Tools gated by design-preflight (get_mode → proposal → user confirmation → create). */
const PREFLIGHT_TOOLS = new Set(designPreflightRule.tools ?? []);

/** Harness fields meant for the agent; collected from every call so code can't silently drop them. */
const HARNESS_FIELDS = ['_nextSteps', '_warnings', '_verificationDebt', '_tokenBindingFailures'] as const;
const MAX_HARNESS_NOTES_CHARS = 3_000;
const MAX_RETURNED_IMAGES = 4;

function toolsetOf(name: string): string {
  if (GENERATED_CORE_TOOLS.has(name) || GENERATED_ENDPOINT_TOOLS.has(name)) return 'core';
  for (const [toolset, def] of Object.entries(GENERATED_TOOLSETS)) {
    if (def.tools.includes(name)) return toolset;
  }
  return 'other';
}

const REPLACED_FLAT_TOOLS = new Set(Object.values(GENERATED_ENDPOINT_REPLACES).flat());

/**
 * Not document writes in schema/tools.yaml, but with side effects outside the read-only contract
 * of `execute`: local files, credentials, version history, the bridge connection.
 */
export const SIDE_EFFECT_TOOLS = new Set([
  'reverse_sync_tokens', // writes a JSON file to an arbitrary local path
  'figma_login',
  'figma_logout',
  'save_version_history',
  'join_channel',
]);

function isWriteTool(name: string): boolean {
  return GENERATED_WRITE_TOOLS.has(name) || SIDE_EFFECT_TOOLS.has(name);
}

/** True when the tool (or the endpoint method in `args`) modifies the document. */
export function isWriteCall(name: string, args: unknown): boolean {
  if (isWriteTool(name)) return true;
  const methods = GENERATED_ENDPOINT_METHOD_ACCESS[name];
  if (!methods) return false;
  const method = (args as { method?: unknown } | null)?.method;
  // Unknown/missing method: let the endpoint's own validation reject it, but treat it as a write to be safe.
  return typeof method !== 'string' || !methods[method] || methods[method].write;
}

/** True when a tool exposes at least one operation that modifies the document. */
function hasWriteOperation(name: string): boolean {
  if (isWriteTool(name)) return true;
  const methods = GENERATED_ENDPOINT_METHOD_ACCESS[name];
  return !!methods && Object.values(methods).some((m) => m.write);
}

/** True when a tool exposes at least one read-only operation. */
function hasReadOperation(name: string): boolean {
  if (isWriteTool(name)) return false;
  const methods = GENERATED_ENDPOINT_METHOD_ACCESS[name];
  return !methods || Object.values(methods).some((m) => !m.write);
}

/** Tools callable from Code Mode, in stable order (core first, then by toolset). */
export function listCallableTools(options: Pick<CodeModeOptions, 'catalog' | 'isToolBlocked'>): CapturedTool[] {
  const order = ['core', ...Object.keys(GENERATED_TOOLSETS), 'other'];
  return options.catalog
    .list()
    .filter(
      (t) =>
        !NON_CALLABLE.has(t.name) &&
        !(t.name in GENERATED_REMOVED_TOOLS) &&
        !(t.name in GENERATED_DEPRECATED_TOOLS) &&
        !REPLACED_FLAT_TOOLS.has(t.name) &&
        !options.isToolBlocked(t.name),
    )
    .sort((a, b) => order.indexOf(toolsetOf(a.name)) - order.indexOf(toolsetOf(b.name)));
}

/** Compact "toolset: a, b, c" index used in the execute tool descriptions. */
export function renderToolIndex(tools: CapturedTool[]): string {
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const ts = toolsetOf(t.name);
    groups.set(ts, [...(groups.get(ts) ?? []), t.name]);
  }
  return [...groups.entries()].map(([ts, names]) => `${ts}: ${names.join(', ')}`).join('\n');
}

// ─── search ───

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .flatMap((t) => [t, ...t.split('_')])
    .filter((t) => t.length > 1);
}

export function searchTools(tools: CapturedTool[], query: string, limit: number): CapturedTool[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scored = tools.map((tool) => {
    const name = tool.name.toLowerCase();
    const nameParts = new Set(tokenize(name));
    const toolset = toolsetOf(tool.name);
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 20;
      else if (nameParts.has(term)) score += 8;
      else if (name.includes(term)) score += 5;
      if (toolset.includes(term)) score += 3;
      if (description.includes(term)) score += 1;
    }
    return { tool, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tool);
}

function signatureLabel(name: string): string {
  if (isWriteTool(name)) return `${toolsetOf(name)}, writes: execute_write only`;
  const methods = GENERATED_ENDPOINT_METHOD_ACCESS[name];
  if (methods) {
    const writes = Object.entries(methods)
      .filter(([, m]) => m.write)
      .map(([k]) => k);
    if (writes.length) return `${toolsetOf(name)}, write methods (execute_write only): ${writes.join(', ')}`;
  }
  return toolsetOf(name);
}

// ─── Per-execution state ───

export class ExecutionState {
  getModeCalled = false;
  readonly harnessNotes: string[] = [];
  private harnessChars = 0;
  readonly images = new Map<string, { data: string; mimeType: string }>();

  addHarnessNote(note: string): void {
    if (this.harnessNotes.includes(note) || this.harnessChars >= MAX_HARNESS_NOTES_CHARS) return;
    const room = MAX_HARNESS_NOTES_CHARS - this.harnessChars;
    const kept = note.length > room ? `${note.slice(0, room)}…` : note;
    this.harnessNotes.push(kept);
    this.harnessChars += kept.length;
  }

  addImage(data: string, mimeType: string): string {
    const id = `img_${this.images.size + 1}`;
    this.images.set(id, { data, mimeType });
    return id;
  }
}

// ─── execute: result decoding ───

interface ToolCallResult {
  content?: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

function errorMessageOf(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) return String((value as { error: unknown }).error);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Turn an MCP tool result into the value seen by sandbox code.
 * Throws when the tool failed — via `isError`, or in-band as `{ ok: false, error }`.
 * Images become `{ _image: "img_N" }` handles (returnable from the code, see execute).
 */
export function decodeToolResult(toolName: string, result: unknown, state?: ExecutionState): unknown {
  const r = (result ?? {}) as ToolCallResult;
  const parts = (r.content ?? []).map((item) => {
    if (item.type === 'text') {
      const text = item.text ?? '';
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    if (item.type === 'image') {
      const mimeType = item.mimeType ?? 'image/png';
      const handle = state && item.data ? state.addImage(item.data, mimeType) : undefined;
      return { _image: handle ?? true, mimeType, base64Length: item.data?.length ?? 0 };
    }
    return { _content: item.type };
  });
  const value = r.structuredContent ?? (parts.length <= 1 ? parts[0] : parts);
  if (r.isError) throw new Error(`${toolName} failed: ${errorMessageOf(value)}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.ok === false && 'error' in obj) throw new Error(`${toolName} failed: ${errorMessageOf(obj)}`);
    if (state) {
      for (const field of HARNESS_FIELDS) {
        if (obj[field] !== undefined) state.addHarnessNote(`${toolName}.${field}: ${JSON.stringify(obj[field])}`);
      }
    }
  }
  return value;
}

/** Fit the final payload in the output budget, keeping valid JSON where possible. */
export function formatExecuteOutput(
  resultJson: string | undefined,
  logs: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  let truncated = false;
  let resultText = resultJson ?? 'undefined';
  const logBlock = logs.length ? `\n\n--- console ---\n${logs.join('\n')}` : '';
  const budget = Math.max(maxChars - logBlock.length, Math.floor(maxChars / 2));
  if (resultText.length > budget) {
    truncated = true;
    let shrunk = resultText;
    try {
      shrunk = JSON.stringify(truncateStructurally(JSON.parse(resultText), budget));
    } catch {
      // not JSON — fall through to slicing
    }
    resultText =
      shrunk.length <= budget
        ? shrunk
        : `${shrunk.slice(0, budget)}\n--- TRUNCATED --- (${resultText.length} chars; return less data, e.g. filter or summarize inside the code)`;
  }
  return { text: resultText + logBlock, truncated };
}

function describeLateCalls(lateCalls: LateCall[], droppedCalls: number): string {
  const lines: string[] = [];
  if (lateCalls.length) {
    lines.push(
      '--- calls still in flight when the run ended (they may have changed the document; check before retrying) ---',
      ...lateCalls.map((c) => `${c.name}: ${c.status}`),
    );
  }
  if (droppedCalls) lines.push(`${droppedCalls} queued call(s) were never sent.`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

// ─── Registration ───

const EXECUTE_GUIDE =
  '`code` is an async arrow function, e.g. ' +
  '`async () => { const s = await figcraft.get_selection(); return s.nodes.map((n) => n.id); }`. ' +
  'Every tool is `figcraft.<name>(args)`: same arguments as the MCP tool, resolves to its parsed JSON result, ' +
  'rejects with an Error if the tool fails. Get exact signatures with `search` first. ' +
  'Loop, branch, filter and aggregate inside the code — intermediate results never reach the conversation. ' +
  'Return a small JSON-serializable value; console.log output and harness notes (_nextSteps, _warnings) are included. ' +
  'Image results are `{ _image: "img_N" }` handles: return a handle to see the image (max 4). ' +
  'No network, filesystem, timers or imports in the code itself.';

export function registerCodeModeTools(server: McpServer, options: CodeModeOptions): void {
  const callable = listCallableTools(options);
  const readable = callable.filter((t) => hasReadOperation(t.name));
  const writable = callable.filter((t) => hasWriteOperation(t.name));
  const callableSet = new Set(callable.map((t) => t.name));
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  const maxToolCalls = options.maxToolCalls ?? 200;
  const maxOutputChars = options.maxOutputChars ?? 24_000;
  const hasWrites = writable.length > 0;

  server.registerTool(
    'search',
    {
      description:
        'Look up FigCraft tools for use inside `execute` / `execute_write`. Returns TypeScript-style signatures of ' +
        '`figcraft.<tool>(args)` methods. Pass `query` (keywords, e.g. "lint fix") or exact `tools` names. ' +
        'Use detail:"full" for complete descriptions and per-parameter docs before calling an unfamiliar tool.',
      inputSchema: {
        query: z.string().optional().describe('Keywords to match against tool names, toolsets and descriptions'),
        tools: z.array(z.string()).optional().describe('Exact tool names to describe'),
        detail: z.enum(['brief', 'full']).optional().describe('Default "brief" for query, "full" for tools'),
        limit: z.number().optional().describe('Max results for query (default 8, max 30)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tools, detail, limit }) => {
      const sections: string[] = [];
      if (tools?.length) {
        const missing: string[] = [];
        for (const name of tools) {
          const tool = callableSet.has(name) ? options.catalog.get(name) : undefined;
          if (!tool) {
            missing.push(name);
            continue;
          }
          sections.push(renderToolSignature(tool, { detail: detail ?? 'full', label: signatureLabel(name) }));
        }
        if (missing.length) sections.push(`// not available: ${missing.join(', ')}`);
      }
      if (query?.trim()) {
        const max = Math.min(Math.max(Math.round(limit ?? 8), 1), 30);
        const hits = searchTools(callable, query, max);
        if (hits.length === 0) sections.push(`// no tools match "${query}"`);
        for (const tool of hits) {
          sections.push(renderToolSignature(tool, { detail: detail ?? 'brief', label: signatureLabel(tool.name) }));
        }
      }
      if (sections.length === 0) {
        const header = `// ${callable.length} tools by toolset — pass query or tools for signatures`;
        sections.push(`${header}\n${renderToolIndex(callable)}`);
      }
      return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
    },
  );

  const run = async (
    code: string,
    timeoutMs: number | undefined,
    // biome-ignore lint/suspicious/noExplicitAny: RequestHandlerExtra from the SDK, forwarded to tool callbacks
    extra: any,
    allowWrites: boolean,
  ) => {
    const timeout = Math.min(Math.max(Math.round(timeoutMs ?? defaultTimeoutMs), 1_000), maxTimeoutMs);
    const state = new ExecutionState();
    const names = (allowWrites ? callable : readable).map((t) => t.name);
    const allowed = new Set(names);
    const result = await runInSandbox(code, {
      timeoutMs: timeout,
      maxToolCalls,
      maxParallelCalls: options.maxParallelCalls,
      settleTimeoutMs: options.settleTimeoutMs,
      toolNames: names,
      signal: extra?.signal,
      callTool: async (name, argsJson, signal) => {
        const tool = allowed.has(name) ? options.catalog.get(name) : undefined;
        if (!tool) throw new Error(`Unknown tool "${name}"`);
        const blocked = options.isToolBlocked(name);
        if (blocked) throw new Error(`${name} is ${blocked}`);
        const validated = await validateToolArgs(tool, JSON.parse(argsJson));
        if (!validated.ok) throw new Error(validated.error);
        if (!allowWrites && isWriteCall(name, validated.value)) {
          throw new Error(`${name} modifies the document: run this code with execute_write instead of execute`);
        }
        if (PREFLIGHT_TOOLS.has(name) && state.getModeCalled) {
          throw new Error(
            `${name} blocked: get_mode was called in this same execution. Return its _workflow, present the design ` +
              'proposal to the user and wait for confirmation, then create in a separate execute_write call.',
          );
        }
        if (name === 'get_mode') state.getModeCalled = true;
        let raw: unknown;
        try {
          const toolExtra = { ...(extra ?? {}), signal };
          // Same calling convention as the MCP SDK: (args, extra) with a schema, (extra) without.
          raw = tool.shape ? await tool.callback(validated.value, toolExtra) : await tool.callback(toolExtra);
        } catch (err) {
          throw new Error(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const value = decodeToolResult(name, raw, state);
        return value === undefined ? undefined : JSON.stringify(value);
      },
    });

    const meta = `[${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}, ${result.durationMs}ms]`;
    const harness = state.harnessNotes.length ? `\n\n--- harness notes ---\n${state.harnessNotes.join('\n')}` : '';
    const late = describeLateCalls(result.lateCalls, result.droppedCalls);
    if (!result.ok) {
      const logs = result.logs.length ? `\n\n--- console ---\n${result.logs.join('\n')}` : '';
      return {
        content: [{ type: 'text' as const, text: `${result.error}${logs}${harness}${late}\n${meta}` }],
        isError: true,
      };
    }
    const { text } = formatExecuteOutput(result.resultJson, result.logs, maxOutputChars);
    const images = [...state.images.entries()]
      .filter(([id]) => result.resultJson?.includes(`"${id}"`))
      .slice(0, MAX_RETURNED_IMAGES)
      .map(([, img]) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }));
    return { content: [{ type: 'text' as const, text: `${text}${harness}${late}\n${meta}` }, ...images] };
  };

  const timeoutSchema = z
    .number()
    .optional()
    .describe(`Wall-clock limit for the whole run (default ${defaultTimeoutMs}, max ${maxTimeoutMs})`);

  server.registerTool(
    'execute',
    {
      description:
        'Run JavaScript that calls READ-ONLY FigCraft tools and return only the result you need. ' +
        `${EXECUTE_GUIDE} Tools or endpoint methods that modify the document reject here: use execute_write.\n` +
        `Tools:\n${renderToolIndex(readable)}`,
      inputSchema: {
        code: z.string().describe('Async arrow function source: async () => { ... return value; }'),
        timeoutMs: timeoutSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ code, timeoutMs }, extra) => run(code, timeoutMs, extra, false),
  );

  if (hasWrites) {
    server.registerTool(
      'execute_write',
      {
        description:
          'Same as `execute`, but the code may also call tools and endpoint methods that MODIFY the Figma document. ' +
          'Use only for changes the user asked for. Calls are not transactional: earlier writes stay applied ' +
          'if a later call fails. UI creation (create_frame/create_text/create_svg) requires get_mode in an ' +
          'earlier call and the user’s confirmation of the design proposal.\n' +
          `Write-capable tools (plus everything in execute):\n${renderToolIndex(writable)}`,
        inputSchema: {
          code: z.string().describe('Async arrow function source: async () => { ... return value; }'),
          timeoutMs: timeoutSchema,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ code, timeoutMs }, extra) => run(code, timeoutMs, extra, true),
    );
  }

  console.error(
    `[FigCraft code-mode] registered search/execute${hasWrites ? '/execute_write' : ''} — ` +
      `${readable.length} read-capable, ${callable.length} total tools callable from code`,
  );
}
