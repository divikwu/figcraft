/**
 * Code Mode tool catalog.
 *
 * Records every tool as it is registered on the McpServer (name, description,
 * Zod input shape, callback) so Code Mode can:
 *   1. render compact TypeScript-style signatures for the `search` tool, and
 *   2. invoke tool callbacks in-process from sandboxed code via `execute`.
 *
 * Recording wraps `server.tool` / `server.registerTool` only for the duration of
 * `registerAllTools()` and then restores the originals. It reads nothing from
 * the SDK's private registry, so it survives SDK refactors.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, type ZodTypeAny, z } from 'zod';

// biome-ignore lint/suspicious/noExplicitAny: tool callbacks have heterogeneous signatures
type AnyToolCallback = (...args: any[]) => unknown;

export interface CapturedTool {
  name: string;
  description: string;
  /** Raw Zod shape, or undefined for tools registered without parameters. */
  shape?: ZodRawShape;
  callback: AnyToolCallback;
}

export class ToolCatalog {
  private readonly tools = new Map<string, CapturedTool>();

  record(tool: CapturedTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): CapturedTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): CapturedTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }
}

function isZodType(value: unknown): value is ZodTypeAny {
  return !!value && typeof value === 'object' && '_def' in (value as object);
}

function isZodRawShape(value: unknown): value is ZodRawShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const values = Object.values(value as Record<string, unknown>);
  // `{}` is a valid (empty) params shape in the SDK's `server.tool()` overloads.
  return values.every(isZodType);
}

/** Normalize an inputSchema that may be a raw shape or a ZodObject. */
function toShape(schema: unknown): ZodRawShape | undefined {
  if (!schema) return undefined;
  if (isZodType(schema) && (schema as ZodTypeAny)._def?.typeName === 'ZodObject') {
    return (schema as z.AnyZodObject).shape as ZodRawShape;
  }
  if (isZodRawShape(schema)) return schema;
  return undefined;
}

/**
 * Parse the arguments of `server.tool(...)`, whose overloads are:
 *   (name, cb) | (name, description, cb) | (name, shape, cb) | (name, description, shape, cb)
 *   | (name, shape, annotations, cb) | (name, description, shape, annotations, cb)
 */
export function parseToolArgs(args: unknown[]): CapturedTool | null {
  const [name, ...rest] = args;
  const callback = rest[rest.length - 1];
  if (typeof name !== 'string' || typeof callback !== 'function') return null;
  let description = '';
  let shape: ZodRawShape | undefined;
  for (const arg of rest.slice(0, -1)) {
    if (typeof arg === 'string') description = arg;
    else if (shape === undefined && isZodRawShape(arg)) shape = arg;
    // anything else is an annotations object — ignored
  }
  return { name, description, shape, callback: callback as AnyToolCallback };
}

/** Parse the arguments of `server.registerTool(name, config, cb)`. */
export function parseRegisterToolArgs(args: unknown[]): CapturedTool | null {
  const [name, config, callback] = args as [unknown, { description?: string; inputSchema?: unknown }, unknown];
  if (typeof name !== 'string' || typeof callback !== 'function') return null;
  return {
    name,
    description: config?.description ?? '',
    shape: toShape(config?.inputSchema),
    callback: callback as AnyToolCallback,
  };
}

/**
 * Temporarily wrap `server.tool` and `server.registerTool` so every registration
 * is also recorded in `catalog`. Returns a function that restores the originals.
 */
export function installToolRecorder(server: McpServer, catalog: ToolCatalog): () => void {
  const target = server as unknown as Record<string, unknown>;
  const originalTool = target.tool as ((...a: unknown[]) => unknown) | undefined;
  const originalRegisterTool = target.registerTool as ((...a: unknown[]) => unknown) | undefined;

  if (typeof originalTool === 'function') {
    target.tool = function recordedTool(this: unknown, ...args: unknown[]) {
      const handle = originalTool.apply(this, args);
      const captured = parseToolArgs(args);
      if (captured) catalog.record(captured);
      return handle;
    };
  }
  if (typeof originalRegisterTool === 'function') {
    target.registerTool = function recordedRegisterTool(this: unknown, ...args: unknown[]) {
      const handle = originalRegisterTool.apply(this, args);
      const captured = parseRegisterToolArgs(args);
      if (captured) catalog.record(captured);
      return handle;
    };
  }

  return () => {
    if (typeof originalTool === 'function') target.tool = originalTool;
    if (typeof originalRegisterTool === 'function') target.registerTool = originalRegisterTool;
  };
}

// ─── Argument validation ───

/** Validate tool arguments the same way the SDK does (non-strict object, unknown keys stripped). */
export async function validateToolArgs(
  tool: CapturedTool,
  args: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (!tool.shape) return { ok: true, value: args ?? {} };
  const parsed = await z.object(tool.shape).safeParseAsync(args ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `Invalid arguments for ${tool.name}: ${issues}` };
}

// ─── Signature rendering ───

const MAX_TYPE_DEPTH = 4;

function wrapUnion(type: string): string {
  return type.includes(' | ') ? `(${type})` : type;
}

function propKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

interface RenderOptions {
  /** Include `/** description *\/` comments for object properties. */
  docs: boolean;
  /** Indentation used for property comments (only with docs). */
  indent: string;
}

/** Strip wrappers that don't affect the TypeScript shape; report optionality. */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  for (let i = 0; i < 20; i++) {
    const def = current._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; in?: ZodTypeAny };
    switch (def.typeName) {
      case 'ZodOptional':
      case 'ZodDefault':
        optional = true;
        current = def.innerType as ZodTypeAny;
        continue;
      case 'ZodCatch':
      case 'ZodReadonly':
      case 'ZodBranded':
        current = (def.innerType ?? (current._def as { type?: ZodTypeAny }).type) as ZodTypeAny;
        continue;
      case 'ZodEffects':
        current = def.schema as ZodTypeAny;
        continue;
      case 'ZodPipeline':
        current = def.in as ZodTypeAny;
        continue;
      default:
        return { inner: current, optional };
    }
  }
  return { inner: current, optional };
}

function firstSentence(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^(.+?[.!?])(\s|$)/);
  const sentence = match ? match[1] : clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function renderZodType(schema: ZodTypeAny, opts: RenderOptions, depth = 0): string {
  const { inner } = unwrap(schema);
  // biome-ignore lint/suspicious/noExplicitAny: walking Zod v3 internals
  const def = inner._def as any;
  switch (def.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
    case 'ZodBigInt':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodNull':
      return 'null';
    case 'ZodUndefined':
    case 'ZodVoid':
      return 'undefined';
    case 'ZodDate':
      return 'string';
    case 'ZodLiteral':
      return JSON.stringify(def.value);
    case 'ZodEnum':
      return (def.values as string[]).map((v) => JSON.stringify(v)).join(' | ');
    case 'ZodNativeEnum':
      return Object.values(def.values as Record<string, string | number>)
        .filter((v) => typeof v === 'string')
        .map((v) => JSON.stringify(v))
        .join(' | ');
    case 'ZodArray':
      return `${wrapUnion(renderZodType(def.type, opts, depth + 1))}[]`;
    case 'ZodSet':
      return `${wrapUnion(renderZodType(def.valueType, opts, depth + 1))}[]`;
    case 'ZodTuple':
      return `[${(def.items as ZodTypeAny[]).map((t) => renderZodType(t, opts, depth + 1)).join(', ')}]`;
    case 'ZodRecord':
    case 'ZodMap':
      return `Record<string, ${renderZodType(def.valueType, opts, depth + 1)}>`;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options: ZodTypeAny[] = Array.isArray(def.options) ? def.options : [...def.options.values()];
      return [...new Set(options.map((o) => renderZodType(o, opts, depth + 1)))].join(' | ');
    }
    case 'ZodIntersection':
      return `${renderZodType(def.left, opts, depth + 1)} & ${renderZodType(def.right, opts, depth + 1)}`;
    case 'ZodObject': {
      if (depth >= MAX_TYPE_DEPTH) return 'object';
      const shape = (typeof def.shape === 'function' ? def.shape() : def.shape) as ZodRawShape;
      return renderShape(shape, opts, depth + 1);
    }
    case 'ZodLazy':
      // Recursive schemas (e.g. inline children trees) — don't expand.
      return depth >= 1 ? 'object' : renderZodType(def.getter(), opts, depth + 1);
    case 'ZodPromise':
      return `Promise<${renderZodType(def.type, opts, depth + 1)}>`;
    default:
      return 'unknown';
  }
}

export function renderShape(shape: ZodRawShape, opts: RenderOptions, depth = 0): string {
  const entries = Object.entries(shape);
  if (entries.length === 0) return '{}';
  if (!opts.docs) {
    const props = entries.map(([key, schema]) => {
      const { optional } = unwrap(schema);
      return `${propKey(key)}${optional ? '?' : ''}: ${renderZodType(schema, opts, depth)}`;
    });
    return `{ ${props.join('; ')} }`;
  }
  const pad = opts.indent.repeat(depth + 1);
  const lines = entries.map(([key, schema]) => {
    const { optional } = unwrap(schema);
    const desc = schema.description ?? unwrap(schema).inner.description;
    const doc = desc ? `${pad}/** ${firstSentence(desc, 200)} */\n` : '';
    return `${doc}${pad}${propKey(key)}${optional ? '?' : ''}: ${renderZodType(schema, opts, depth)};`;
  });
  return `{\n${lines.join('\n')}\n${opts.indent.repeat(depth)}}`;
}

export interface SignatureOptions {
  /** 'brief' = one-line signature + first sentence. 'full' = full description + per-param docs. */
  detail: 'brief' | 'full';
  /** Optional label (e.g. toolset name, write/read) shown above the signature. */
  label?: string;
}

/** Render a tool as a TypeScript-style method declaration on the `figcraft` namespace. */
export function renderToolSignature(tool: CapturedTool, options: SignatureOptions): string {
  const full = options.detail === 'full';
  const params = tool.shape ? renderShape(tool.shape, { docs: full, indent: '  ' }) : '{}';
  const allOptional = !tool.shape || Object.values(tool.shape).every((schema) => unwrap(schema).optional);
  const description = full ? tool.description.replace(/\s+/g, ' ').trim() : firstSentence(tool.description);
  const label = options.label ? ` [${options.label}]` : '';
  const doc = description || label ? `/** ${description}${label} */\n` : '';
  return `${doc}figcraft.${tool.name}(args${allOptional ? '?' : ''}: ${params}): Promise<any>`;
}
