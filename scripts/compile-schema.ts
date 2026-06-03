#!/usr/bin/env tsx
/**
 * FigCraft Schema Compiler
 *
 * Reads schema/tools.yaml and generates:
 *   1. packages/core-mcp/src/tools/_generated.ts  — bridge tool registrations (Zod + handler)
 *   2. packages/core-mcp/src/tools/_registry.ts   — CORE_TOOLS, TOOLSETS, WRITE_TOOLS, CREATE_TOOLS, EDIT_TOOLS, TOOLSET_DESCRIPTIONS
 *
 * Simple bridge tools (handler: bridge) get fully generated TypeScript.
 * Custom tools (handler: custom) only contribute to the registry.
 *
 * Usage: npx tsx scripts/compile-schema.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ─── Types ───

interface ParamDef {
  type: string;
  required?: boolean;
  description?: string;
  ref?: string;
  values?: string[]; // for enum
  items?: string | ParamDef; // for array
  fields?: Record<string, ParamDef>; // for object
  valueType?: string; // for record
  additionalProperties?: boolean; // for object: generate .passthrough()
}

interface ToolDef {
  description: string;
  toolset: string;
  write: boolean;
  access?: 'create' | 'edit';
  handler: 'bridge' | 'custom';
  bridgeMethod?: string; // override bridge method name
  params: Record<string, ParamDef>;
  response?: ParamDef;
  examples?: unknown[];
  response_guard?: boolean;
  guard_hints?: string[];
  deprecated?: boolean;
  replaced_by?: string;
  timeoutMs?: number;
}

interface EndpointMethodDef {
  description: string;
  maps_to: string;
  write: boolean;
  access?: 'create' | 'edit';
  params: Record<string, ParamDef>;
  response?: ParamDef;
  examples?: unknown[];
}

interface EndpointToolDef {
  description: string;
  toolset: string;
  handler: 'endpoint';
  methods: Record<string, EndpointMethodDef>;
  deprecated?: boolean;
  replaced_by?: string;
}

type AnyToolDef = ToolDef | EndpointToolDef;

interface Schema {
  [key: string]: AnyToolDef | Record<string, string> | Record<string, ParamDef>;
}

// ─── YAML Loading ───

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SCHEMA_PATH = resolve(ROOT, 'schema/tools.yaml');
const GENERATED_TARGETS = [
  {
    name: 'core-mcp',
    genPath: resolve(ROOT, 'packages/core-mcp/src/tools/_generated.ts'),
    regPath: resolve(ROOT, 'packages/core-mcp/src/tools/_registry.ts'),
    contractPath: resolve(ROOT, 'packages/core-mcp/src/tools/_contracts.ts'),
  },
] as const;

const raw = readFileSync(SCHEMA_PATH, 'utf-8');
const schema = parseYaml(raw, { merge: true }) as Schema;

// ─── Multi-file schema loading ───
// Load additional tool definitions from schema/tools/*.yaml (if directory exists).
// Each file defines one or more tools that get merged into the main schema.
// This enables modular schema organization without splitting the main file.
const TOOLS_DIR = resolve(ROOT, 'schema/tools');
if (existsSync(TOOLS_DIR)) {
  const yamlFiles = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  for (const file of yamlFiles) {
    const filePath = resolve(TOOLS_DIR, file);
    const fileRaw = readFileSync(filePath, 'utf-8');
    const fileSchema = parseYaml(fileRaw, { merge: true });
    if (fileSchema && typeof fileSchema === 'object') {
      for (const [key, value] of Object.entries(fileSchema)) {
        if (key in schema) {
          console.warn(`WARNING: schema/tools/${file} redefines "${key}" (overriding main schema)`);
        }
        (schema as Record<string, unknown>)[key] = value;
      }
    }
    console.error(`[schema] loaded schema/tools/${file}`);
  }
}

// Separate tool definitions from metadata
const toolDefs: Record<string, ToolDef> = {};
const endpointDefs: Record<string, EndpointToolDef> = {};
const toolsetDescriptions: Record<string, string> = {};
const toolsetQuickstart: Record<string, string> = {};
const paramDefinitions: Record<string, ParamDef> = {};

for (const [key, value] of Object.entries(schema)) {
  if (key === '_mixins') {
  } else if (key === '_toolset_descriptions') {
    Object.assign(toolsetDescriptions, value);
  } else if (key === '_toolset_quickstart') {
    Object.assign(toolsetQuickstart, value);
  } else if (key === '_param_definitions') {
    Object.assign(paramDefinitions, value);
  } else if (value && typeof value === 'object' && 'handler' in value) {
    const v = value as AnyToolDef;
    if (v.handler === 'endpoint') {
      // Validate required fields for endpoint definitions
      const ep = v as EndpointToolDef;
      if (!ep.description) {
        console.error(`ERROR: endpoint "${key}" missing required field "description"`);
        process.exit(1);
      }
      if (!ep.methods || Object.keys(ep.methods).length === 0) {
        console.error(`ERROR: endpoint "${key}" missing required field "methods"`);
        process.exit(1);
      }
      for (const [mName, mDef] of Object.entries(ep.methods)) {
        if (!mDef.maps_to) {
          console.warn(`WARNING: endpoint "${key}" method "${mName}" missing "maps_to"`);
        }
      }
      endpointDefs[key] = ep;
    } else {
      toolDefs[key] = value as ToolDef;
    }
  }
}

// Note: Registration file consistency check (toolset name → file convention)
// is validated at test time in tests/registration-consistency.test.ts.
// No compile-time check here — would require reading TS source files.

// ─── Deep param validation ───

const VALID_PARAM_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'enum',
  'array',
  'object',
  'record',
  'unknown',
  'tuple',
  'ref',
]);

function validateParamDef(toolName: string, paramName: string, def: ParamDef, path: string): void {
  if (!VALID_PARAM_TYPES.has(def.type)) {
    console.error(
      `ERROR: ${path} in tool "${toolName}" has invalid type "${def.type}". Valid types: ${[...VALID_PARAM_TYPES].join(', ')}`,
    );
    process.exit(1);
  }
  if (def.type === 'ref') {
    if (!def.ref) {
      console.error(`ERROR: ${path} in tool "${toolName}" is ref but has no "ref" target`);
      process.exit(1);
    }
    if (!paramDefinitions[def.ref]) {
      console.error(`ERROR: ${path} in tool "${toolName}" references unknown shared param definition "${def.ref}"`);
      process.exit(1);
    }
    return;
  }
  if (def.type === 'enum' && (!def.values || def.values.length === 0)) {
    console.error(`ERROR: ${path} in tool "${toolName}" is enum but has no values`);
    process.exit(1);
  }
  if (def.type === 'array' && def.items && typeof def.items === 'object') {
    validateParamDef(toolName, paramName, def.items as ParamDef, `${path}.items`);
  }
  if (def.type === 'object' && def.fields) {
    for (const [fn, fd] of Object.entries(def.fields)) {
      validateParamDef(toolName, fn, fd, `${path}.fields.${fn}`);
    }
  }
}

for (const [defName, def] of Object.entries(paramDefinitions)) {
  validateParamDef('_param_definitions', defName, def, `_param_definitions.${defName}`);
}

// Validate all tool params at compile time
for (const [toolName, def] of Object.entries(toolDefs)) {
  if (def.params) {
    for (const [pName, pDef] of Object.entries(def.params as Record<string, ParamDef>)) {
      validateParamDef(toolName, pName, pDef, `${toolName}.params.${pName}`);
    }
  }
  if (def.response) {
    validateParamDef(toolName, 'response', def.response, `${toolName}.response`);
  }
}
for (const [epName, ep] of Object.entries(endpointDefs)) {
  for (const [mName, mDef] of Object.entries(ep.methods)) {
    if (mDef.params) {
      for (const [pName, pDef] of Object.entries(mDef.params)) {
        validateParamDef(epName, pName, pDef, `${epName}.methods.${mName}.params.${pName}`);
      }
    }
    if (mDef.response) {
      validateParamDef(epName, 'response', mDef.response, `${epName}.methods.${mName}.response`);
    }
  }
}

// ─── Zod Code Generation ───

function sharedSchemaConstName(name: string): string {
  const safe = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
  return `${safe}SharedSchema`;
}

function buildZodExpr(name: string, def: ParamDef, indent: string, applyOptional = true): string {
  let zodExpr: string;

  switch (def.type) {
    case 'string':
      zodExpr = 'z.string()';
      break;
    case 'number':
      zodExpr = 'z.number()';
      break;
    case 'boolean':
      zodExpr = 'z.boolean()';
      break;
    case 'unknown':
      zodExpr = 'z.unknown()';
      break;
    case 'enum':
      if (!def.values?.length) throw new Error(`Enum param "${name}" has no values`);
      zodExpr = `z.enum([${def.values.map((v) => `'${v}'`).join(', ')}])`;
      break;
    case 'ref':
      if (!def.ref) throw new Error(`Ref param "${name}" has no target`);
      zodExpr = sharedSchemaConstName(def.ref);
      break;
    case 'array': {
      const itemsZod = resolveArrayItems(name, def);
      zodExpr = `z.array(${itemsZod})`;
      break;
    }
    case 'object': {
      if (def.fields) {
        const fieldLines = Object.entries(def.fields).map(([fn, fd]) => {
          return `${indent}    ${fn}: ${paramToZod(fn, fd, `${indent}  `)}`;
        });
        const suffix = def.additionalProperties ? '.passthrough()' : '';
        zodExpr = `z.object({\n${fieldLines.join(',\n')},\n${indent}  })${suffix}`;
      } else {
        zodExpr = 'z.record(z.unknown())';
      }
      break;
    }
    case 'record': {
      const vt = def.valueType === 'string' ? 'z.string()' : 'z.unknown()';
      zodExpr = `z.record(${vt})`;
      break;
    }
    case 'tuple': {
      zodExpr = 'z.tuple([z.number(), z.number()])';
      break;
    }
    default:
      zodExpr = 'z.unknown()';
  }

  if (applyOptional && !def.required) zodExpr += '.optional()';
  if (def.description) zodExpr += `.describe(${JSON.stringify(def.description)})`;

  return zodExpr;
}

function paramToZod(name: string, def: ParamDef, indent: string): string {
  return buildZodExpr(name, def, indent, true);
}

function resolveArrayItems(name: string, def: ParamDef): string {
  if (!def.items) return 'z.unknown()';
  if (typeof def.items === 'string') {
    switch (def.items) {
      case 'string':
        return 'z.string()';
      case 'number':
        return 'z.number()';
      case 'boolean':
        return 'z.boolean()';
      case 'object':
        return 'z.record(z.unknown())';
      default:
        return 'z.unknown()';
    }
  }
  // Nested object definition — force required: true (array items are never optional)
  const itemDef = { ...def.items, required: true };
  return paramToZod(`${name}_item`, itemDef, '      ');
}

function generateSharedSchemaDecls(): string {
  if (Object.keys(paramDefinitions).length === 0) return '';
  const sharedSchemas = Object.entries(paramDefinitions).map(([name, def]) => {
    const requiredDef = { ...def, required: true };
    return `const ${sharedSchemaConstName(name)}: z.ZodTypeAny = z.lazy(() => ${buildZodExpr(name, requiredDef, '  ', false)});`;
  });
  return `${sharedSchemas.join('\n')}\n\n`;
}

function indentBlock(text: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function generateResponseSchemaExpr(name: string, def: ParamDef): string {
  const requiredDef = { ...def, required: true };
  return buildZodExpr(name, requiredDef, '  ', false);
}

// ─── Generate _generated.ts ───

const bridgeTools = Object.entries(toolDefs).filter(([, d]) => d.handler === 'bridge');
const bridgeToolNames = bridgeTools.map(([name]) => name);
const customToolNames = Object.entries(toolDefs)
  .filter(([, def]) => def.handler === 'custom')
  .map(([name]) => name);

let genCode = `/**
 * AUTO-GENERATED by scripts/compile-schema.ts — DO NOT EDIT
 *
 * Simple bridge tools compiled from schema/tools.yaml.
 * These tools forward params to the Figma plugin via bridge.request().
 *
 * Re-generate: npm run schema
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge.js';
import { jsonResponse } from './response-helpers.js';

`;

genCode += generateSharedSchemaDecls();

genCode += `
export interface GeneratedToolRegistrationOptions {
  include?: ReadonlySet<string>;
}

function shouldRegisterGeneratedTool(include: ReadonlySet<string> | undefined, toolName: string): boolean {
  return !include || include.has(toolName);
}

export function registerGeneratedTools(
  server: McpServer,
  bridge: Bridge,
  options: GeneratedToolRegistrationOptions = {},
): void {
  const include = options.include;
`;

for (const [toolName, def] of bridgeTools) {
  const params = def.params as Record<string, ParamDef>;
  const paramEntries = Object.entries(params);
  const bridgeMethod = def.bridgeMethod ?? toolName;

  // Prepend [DEPRECATED] prefix if tool is deprecated
  let description = def.description;
  if (def.deprecated && def.replaced_by) {
    description = `[DEPRECATED] Use ${def.replaced_by} instead. ${description}`;
  }

  // Build Zod schema object
  let schemaStr: string;
  if (paramEntries.length === 0) {
    schemaStr = '{}';
  } else {
    const lines = paramEntries.map(([pName, pDef]) => {
      return `      ${pName}: ${paramToZod(pName, pDef, '      ')}`;
    });
    schemaStr = `{\n${lines.join(',\n')},\n    }`;
  }

  // Build handler
  const _paramNames = paramEntries.filter(([, p]) => p.required).map(([n]) => n);
  const allParamNames = paramEntries.map(([n]) => n);

  // Deprecation warning injection
  const escapedReplacedBy = def.replaced_by ? def.replaced_by.replace(/"/g, '\\"') : '';
  const deprecationSuffix =
    def.deprecated && def.replaced_by
      ? `\n      // Inject deprecation warning\n      if (typeof result === 'object' && result !== null) { (result as Record<string, unknown>)._deprecation = { warning: "This tool is deprecated. Use ${escapedReplacedBy} instead.", replacement: "${escapedReplacedBy}" }; }`
      : '';

  // Harness pipeline params: toolName + isWrite (passed to bridge.request for pipeline context)
  const timeoutArg = def.timeoutMs ? `, ${def.timeoutMs}` : ', undefined';
  const harnessArgs = `${timeoutArg}, '${toolName}', ${def.write ? 'true' : 'false'}`;

  let handlerBody: string;
  if (paramEntries.length === 0) {
    handlerBody = `const result = await bridge.request('${bridgeMethod}', {}${harnessArgs});${deprecationSuffix}
      return jsonResponse(result);`;
  } else if (allParamNames.length <= 4 && !paramEntries.some(([, p]) => p.type === 'array' || p.type === 'object')) {
    // Destructured params for simple tools
    const destructure = `{ ${allParamNames.join(', ')} }`;
    handlerBody = `const result = await bridge.request('${bridgeMethod}', { ${allParamNames.join(', ')} }${harnessArgs});${deprecationSuffix}
      return jsonResponse(result);`;
    genCode += `  if (shouldRegisterGeneratedTool(include, '${toolName}')) {
    server.tool(
    '${toolName}',
    ${JSON.stringify(description)},
    ${schemaStr},
    async (${destructure}) => {
      ${handlerBody}
    },
  );
  }

`;
    continue;
  } else {
    handlerBody = `const result = await bridge.request('${bridgeMethod}', params${harnessArgs});${deprecationSuffix}
      return jsonResponse(result);`;
  }

  genCode += `  if (shouldRegisterGeneratedTool(include, '${toolName}')) {
    server.tool(
    '${toolName}',
    ${JSON.stringify(description)},
    ${schemaStr},
    async (params) => {
      ${handlerBody}
    },
  );
  }

`;
}

genCode += `}
`;

// ─── Generate endpoint Zod schemas and registration (Task 4.2) ───

/**
 * For each endpoint, generate a merged Zod schema:
 * - `method` is a required enum of all method names
 * - All other params are the union of all method params, all optional
 * - Same-name params with different types get z.union()
 */
function generateEndpointZodSchema(_epName: string, ep: EndpointToolDef): string {
  const methodNames = Object.keys(ep.methods);

  // Collect all params across methods, tracking types for conflict detection
  const paramMap = new Map<string, { defs: ParamDef[]; sources: string[] }>();

  for (const [mName, mDef] of Object.entries(ep.methods)) {
    if (!mDef.params) continue;
    for (const [pName, pDef] of Object.entries(mDef.params)) {
      if (!paramMap.has(pName)) {
        paramMap.set(pName, { defs: [], sources: [] });
      }
      const entry = paramMap.get(pName)!;
      entry.defs.push(pDef);
      entry.sources.push(mName);
    }
  }

  // Build schema lines
  const lines: string[] = [];
  lines.push(
    `      method: z.enum([${methodNames.map((m) => `'${m}'`).join(', ')}]).describe('Method to invoke on this endpoint')`,
  );

  for (const [pName, { defs }] of paramMap) {
    // Deduplicate by type signature
    const uniqueTypes = new Map<string, ParamDef>();
    for (const d of defs) {
      const key = JSON.stringify({
        type: d.type,
        values: d.values,
        items: d.items,
        fields: d.fields,
        valueType: d.valueType,
      });
      if (!uniqueTypes.has(key)) uniqueTypes.set(key, d);
    }

    let zodExpr: string;
    if (uniqueTypes.size === 1) {
      // All methods agree on the type — use it directly, but force optional
      const def = [...uniqueTypes.values()][0];
      // Strip description — we add it once at the end to avoid double .describe()
      const forcedOptional = { ...def, required: true, description: undefined };
      zodExpr = paramToZod(pName, forcedOptional, '      ');
    } else {
      // Type conflict — use z.union()
      const variants = [...uniqueTypes.values()].map((def) => {
        const forced = { ...def, required: true, description: undefined };
        return paramToZod(pName, forced, '        ');
      });
      zodExpr = `z.union([${variants.join(', ')}])`;
    }

    // All endpoint params (except method) are optional in the merged schema
    zodExpr += '.optional()';

    // Merge descriptions
    const descriptions = defs.filter((d) => d.description).map((d) => d.description!);
    const uniqueDescs = [...new Set(descriptions)];
    if (uniqueDescs.length > 0) {
      zodExpr += `.describe(${JSON.stringify(uniqueDescs[0])})`;
    }

    lines.push(`      ${pName}: ${zodExpr}`);
  }

  return `{\n${lines.join(',\n')},\n    }`;
}

// Generate endpoint registration code in _generated.ts
if (Object.keys(endpointDefs).length > 0) {
  genCode += `
// ─── Endpoint Zod Schemas ───

`;
  for (const [epName, ep] of Object.entries(endpointDefs)) {
    const schemaStr = generateEndpointZodSchema(epName, ep);
    genCode += `export const ${epName}EndpointSchema = ${schemaStr};\n\n`;
  }
}

// ─── Generate _contracts.ts ───

const toolResponseDefs = Object.entries(toolDefs).filter(([, def]) => def.response);
const endpointResponseDefs = Object.entries(endpointDefs)
  .map(([epName, ep]) => {
    const methods = Object.entries(ep.methods).filter(([, mDef]) => mDef.response);
    return [epName, methods] as const;
  })
  .filter(([, methods]) => methods.length > 0);

let contractCode = `/**
 * AUTO-GENERATED by scripts/compile-schema.ts — DO NOT EDIT
 *
 * Tool response contracts and example payloads derived from schema/tools.yaml.
 * These are intended for docs, tests, and future prompt/runtime validation work.
 *
 * Re-generate: npm run schema
 */

import { z } from 'zod';

`;

contractCode += generateSharedSchemaDecls();

contractCode += `export const GENERATED_TOOL_RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny> = {
`;

for (const [toolName, def] of toolResponseDefs) {
  contractCode += `  '${toolName}': ${generateResponseSchemaExpr(`${toolName}Response`, def.response!)},\n`;
}

contractCode += `};

export const GENERATED_TOOL_RESPONSE_EXAMPLES: Record<string, unknown[]> = {
`;

for (const [toolName, def] of toolResponseDefs) {
  const examples = def.examples ?? [];
  contractCode += `  '${toolName}': ${indentBlock(JSON.stringify(examples, null, 2), 2).trimStart()},\n`;
}

contractCode += `};

export const GENERATED_ENDPOINT_METHOD_RESPONSE_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
`;

for (const [epName, methods] of endpointResponseDefs) {
  contractCode += `  '${epName}': {\n`;
  for (const [methodName, methodDef] of methods) {
    contractCode += `    '${methodName}': ${generateResponseSchemaExpr(`${epName}_${methodName}Response`, methodDef.response!)},\n`;
  }
  contractCode += `  },\n`;
}

contractCode += `};

export const GENERATED_ENDPOINT_METHOD_RESPONSE_EXAMPLES: Record<string, Record<string, unknown[]>> = {
`;

for (const [epName, methods] of endpointResponseDefs) {
  contractCode += `  '${epName}': {\n`;
  for (const [methodName, methodDef] of methods) {
    const examples = methodDef.examples ?? [];
    contractCode += `    '${methodName}': ${indentBlock(JSON.stringify(examples, null, 2), 4).trimStart()},\n`;
  }
  contractCode += `  },\n`;
}

contractCode += `};
`;

// ─── Generate _registry.ts ───

const coreTools: string[] = [];
const writeTools: string[] = [];
const createTools: string[] = [];
const editTools: string[] = [];
const toolsets: Record<string, string[]> = {};

for (const [name, def] of Object.entries(toolDefs)) {
  if (def.toolset === 'core') {
    coreTools.push(name);
  } else {
    if (!toolsets[def.toolset]) toolsets[def.toolset] = [];
    toolsets[def.toolset].push(name);
  }
  if (def.write) {
    writeTools.push(name);
    const level = def.access ?? 'edit'; // default to most restrictive
    if (level === 'create') {
      createTools.push(name);
    } else {
      editTools.push(name);
    }
  }
}

// Endpoint tools: add to core/toolset sets but NOT to write tools
// (access control is at method level via ENDPOINT_METHOD_ACCESS)
const endpointTools: string[] = [];
const endpointReplaces: Record<string, string[]> = {};
const endpointMethodAccess: Record<string, Record<string, { write: boolean; access?: string }>> = {};
const flatToolMigrations: Record<
  string,
  { endpoint: string; method: string; toolset: string; write: boolean; access?: string }
> = {};

for (const [name, ep] of Object.entries(endpointDefs)) {
  endpointTools.push(name);

  if (ep.toolset === 'core') {
    coreTools.push(name);
  } else {
    if (!toolsets[ep.toolset]) toolsets[ep.toolset] = [];
    toolsets[ep.toolset].push(name);
  }

  // Build method access map and replaces list
  const methodAccess: Record<string, { write: boolean; access?: string }> = {};
  const replaces: string[] = [];

  for (const [mName, mDef] of Object.entries(ep.methods)) {
    const entry: { write: boolean; access?: string } = { write: mDef.write };
    if (mDef.access) entry.access = mDef.access;
    methodAccess[mName] = entry;
    if (mDef.maps_to) {
      replaces.push(mDef.maps_to);
      if (flatToolMigrations[mDef.maps_to]) {
        console.error(
          `ERROR: flat tool "${mDef.maps_to}" is mapped more than once: ` +
            `${flatToolMigrations[mDef.maps_to].endpoint}.${flatToolMigrations[mDef.maps_to].method} and ${name}.${mName}`,
        );
        process.exit(1);
      }
      flatToolMigrations[mDef.maps_to] = {
        endpoint: name,
        method: mName,
        toolset: ep.toolset,
        write: mDef.write,
        ...(mDef.access ? { access: mDef.access } : {}),
      };
    }
  }

  endpointMethodAccess[name] = methodAccess;
  endpointReplaces[name] = replaces;
}

// Deprecated tools map
const deprecatedTools: Record<string, string> = {};
for (const [name, def] of Object.entries(toolDefs)) {
  if (def.deprecated && def.replaced_by) {
    deprecatedTools[name] = def.replaced_by;
  }
}

let regCode = `/**
 * AUTO-GENERATED by scripts/compile-schema.ts — DO NOT EDIT
 *
 * Tool registry derived from schema/tools.yaml.
 * Provides CORE_TOOLS, BRIDGE_TOOLS, CUSTOM_TOOLS, TOOLSETS, WRITE_TOOLS, CREATE_TOOLS, EDIT_TOOLS, and TOOLSET_DESCRIPTIONS.
 *
 * Re-generate: npm run schema
 */

/** Core tools: always enabled (~${coreTools.length}) */
export const GENERATED_CORE_TOOLS = new Set([
${coreTools.map((t) => `  '${t}',`).join('\n')}
]);

/** Bridge-backed flat tools compiled into _generated.ts registrations. */
export const GENERATED_BRIDGE_TOOLS = new Set([
${bridgeToolNames.map((t) => `  '${t}',`).join('\n')}
]);

/** Hand-written custom flat tools that keep bespoke MCP logic. */
export const GENERATED_CUSTOM_TOOLS = new Set([
${customToolNames.map((t) => `  '${t}',`).join('\n')}
]);

/** All tools that modify the Figma document (union of create + edit). */
export const GENERATED_WRITE_TOOLS = new Set([
${writeTools.map((t) => `  '${t}',`).join('\n')}
]);

/**
 * Tools that add NEW content (access: create).
 * Allowed when FIGCRAFT_ACCESS=create or edit.
 */
export const GENERATED_CREATE_TOOLS = new Set([
${createTools.map((t) => `  '${t}',`).join('\n')}
]);

/**
 * Tools that modify or delete EXISTING content (access: edit).
 * Allowed only when FIGCRAFT_ACCESS=edit (default).
 */
export const GENERATED_EDIT_TOOLS = new Set([
${editTools.map((t) => `  '${t}',`).join('\n')}
]);

/** Toolset definitions with tool lists */
export const GENERATED_TOOLSETS: Record<string, { description: string; tools: string[] }> = {
`;

for (const [tsName, tools] of Object.entries(toolsets)) {
  const desc = toolsetDescriptions[tsName] ?? `${tsName} tools`;
  regCode += `  '${tsName}': {
    description: ${JSON.stringify(desc)},
    tools: [
${tools.map((t) => `      '${t}',`).join('\n')}
    ],
  },
`;
}

regCode += `};

/** Toolset descriptions for display */
export const GENERATED_TOOLSET_DESCRIPTIONS: Record<string, string> = {
${Object.entries(toolsetDescriptions)
  .map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`)
  .join('\n')}
};

/** Quick-start hints appended to load_toolset responses */
export const GENERATED_TOOLSET_QUICKSTART: Record<string, string> = {
${Object.entries(toolsetQuickstart)
  .map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`)
  .join('\n')}
};

/** Endpoint method-level access control mapping */
export const GENERATED_ENDPOINT_METHOD_ACCESS: Record<
  string,
  Record<string, { write: boolean; access?: 'create' | 'edit' }>
> = {
`;

for (const [epName, methods] of Object.entries(endpointMethodAccess)) {
  regCode += `  '${epName}': {\n`;
  for (const [mName, mAccess] of Object.entries(methods)) {
    const accessStr = mAccess.access ? `, access: '${mAccess.access}'` : '';
    regCode += `    '${mName}': { write: ${mAccess.write}${accessStr} },\n`;
  }
  regCode += `  },\n`;
}

regCode += `};

/** Endpoint tool names (for API mode switching) */
export const GENERATED_ENDPOINT_TOOLS = new Set<string>([
${endpointTools.map((t) => `  '${t}',`).join('\n')}
]);

/** Endpoint → flat tools it replaces (for API mode switching) */
export const GENERATED_ENDPOINT_REPLACES: Record<string, string[]> = {
`;

for (const [epName, replaces] of Object.entries(endpointReplaces)) {
  regCode += `  '${epName}': [${replaces.map((t) => `'${t}'`).join(', ')}],\n`;
}

regCode += `};

/** Flat tool → endpoint.method migration map */
export const GENERATED_FLAT_TOOL_MIGRATIONS: Record<
  string,
  { endpoint: string; method: string; toolset: string; write: boolean; access?: 'create' | 'edit' }
> = {
`;

for (const [flatTool, migration] of Object.entries(flatToolMigrations)) {
  const accessStr = migration.access ? `, access: '${migration.access}'` : '';
  regCode += `  '${flatTool}': { endpoint: '${migration.endpoint}', method: '${migration.method}', toolset: '${migration.toolset}', write: ${migration.write}${accessStr} },\n`;
}

regCode += `};

/** Deprecated tools → replacement endpoint.method */
export const GENERATED_DEPRECATED_TOOLS: Record<string, { replacedBy: string }> = {
`;

for (const [name, replacedBy] of Object.entries(deprecatedTools)) {
  regCode += `  '${name}': { replacedBy: ${JSON.stringify(replacedBy)} },\n`;
}

regCode += `};

/** Removed tools → migration guidance (Phase 3) */
export const GENERATED_REMOVED_TOOLS: Record<string, { endpoint: string; method: string }> = {
`;

// Build removed tools map from endpoint replaces (only for tools not in toolDefs anymore)
// In Phase 3, tools would be removed from toolDefs but their maps_to entries remain in endpointDefs
// For now this is empty — populated when flat tools are actually removed from the YAML
const allFlatToolNames = new Set(Object.keys(toolDefs));
for (const [epName, ep] of Object.entries(endpointDefs)) {
  for (const [mName, mDef] of Object.entries(ep.methods)) {
    if (mDef.maps_to && !allFlatToolNames.has(mDef.maps_to)) {
      regCode += `  '${mDef.maps_to}': { endpoint: '${epName}', method: '${mName}' },\n`;
    }
  }
}

regCode += `};
`;

// ─── Write files ───

for (const target of GENERATED_TARGETS) {
  mkdirSync(dirname(target.genPath), { recursive: true });
  mkdirSync(dirname(target.regPath), { recursive: true });
  mkdirSync(dirname(target.contractPath), { recursive: true });
  writeFileSync(target.genPath, genCode, 'utf-8');
  writeFileSync(target.regPath, regCode, 'utf-8');
  writeFileSync(target.contractPath, contractCode, 'utf-8');
}

// ─── Generate help database ───

function generateHelpCode(): string {
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED by schema compiler — do not edit');
  lines.push('');

  // Build directory
  const dirLines: string[] = [];
  dirLines.push('# FigCraft Tools');
  dirLines.push('');

  // Group tools by toolset
  const byToolset = new Map<string, string[]>();
  for (const [name, def] of Object.entries(toolDefs)) {
    const ts = def.toolset || 'core';
    const list = byToolset.get(ts) ?? [];
    list.push(`  ${name.padEnd(28)} ${def.description.split('.')[0]}`);
    byToolset.set(ts, list);
  }
  for (const [name, def] of Object.entries(endpointDefs)) {
    const ts = def.toolset || 'core';
    const list = byToolset.get(ts) ?? [];
    const methods = Object.keys(def.methods).join(', ');
    list.push(`  ${name.padEnd(28)} ${def.description.split('.')[0]} [methods: ${methods}]`);
    byToolset.set(ts, list);
  }

  for (const [toolset, tools] of byToolset) {
    const desc = toolsetDescriptions[toolset] ?? '';
    dirLines.push(`[${toolset}]${desc ? ` — ${desc}` : ''}`);
    dirLines.push(...tools);
    dirLines.push('');
  }

  dirLines.push('Use help(topic: "<tool>") for tool details.');
  dirLines.push('Use help(topic: "<endpoint>.<method>") for method details.');

  // Build per-tool details
  const toolDetails: Record<string, string> = {};
  for (const [name, def] of Object.entries(toolDefs)) {
    const detail: string[] = [];
    detail.push(`# ${name}`);
    detail.push(def.description);
    detail.push(`Toolset: ${def.toolset || 'core'}`);
    detail.push(`Write: ${def.write ? 'yes' : 'no'}${def.access ? ` (access: ${def.access})` : ''}`);
    if (def.params && Object.keys(def.params).length > 0) {
      detail.push('');
      detail.push('Params:');
      for (const [pName, pDef] of Object.entries(def.params)) {
        const req = pDef.required ? 'required' : 'optional';
        const type = pDef.values ? pDef.values.join(' | ') : (pDef.type ?? 'string');
        detail.push(`  ${pName} (${type}, ${req})${pDef.description ? ` — ${pDef.description}` : ''}`);
      }
    }
    toolDetails[name] = detail.join('\n');
  }

  // Build per-endpoint details with methods
  const endpointDetails: Record<string, { summary: string; methods: Record<string, string> }> = {};
  for (const [name, def] of Object.entries(endpointDefs)) {
    const summary: string[] = [];
    summary.push(`# ${name}`);
    summary.push(def.description);
    summary.push(`Toolset: ${def.toolset || 'core'}`);
    summary.push('');
    summary.push('Methods:');
    for (const [mName, mDef] of Object.entries(def.methods)) {
      summary.push(`  ${mName.padEnd(20)} ${mDef.description ?? ''}`);
    }

    const methods: Record<string, string> = {};
    for (const [mName, mDef] of Object.entries(def.methods)) {
      const mDetail: string[] = [];
      mDetail.push(`# ${name}.${mName}`);
      mDetail.push(mDef.description ?? '');
      mDetail.push(`Maps to: ${mDef.maps_to ?? 'N/A'}`);
      mDetail.push(`Write: ${mDef.write ? 'yes' : 'no'}${mDef.access ? ` (access: ${mDef.access})` : ''}`);
      if (mDef.params && Object.keys(mDef.params).length > 0) {
        mDetail.push('');
        mDetail.push('Params:');
        for (const [pName, pDef] of Object.entries(mDef.params)) {
          if (typeof pDef !== 'object') continue;
          const req = pDef.required ? 'required' : 'optional';
          const type = pDef.values ? pDef.values.join(' | ') : (pDef.type ?? 'string');
          mDetail.push(`  ${pName} (${type}, ${req})${pDef.description ? ` — ${pDef.description}` : ''}`);
        }
      }
      methods[mName] = mDetail.join('\n');
    }

    endpointDetails[name] = { summary: summary.join('\n'), methods };
  }

  lines.push(`export const helpDirectory: string = ${JSON.stringify(dirLines.join('\n'))};`);
  lines.push('');
  lines.push(`export const helpTools: Record<string, string> = ${JSON.stringify(toolDetails, null, 2)};`);
  lines.push('');
  lines.push(
    `export const helpEndpoints: Record<string, { summary: string; methods: Record<string, string> }> = ${JSON.stringify(endpointDetails, null, 2)};`,
  );
  lines.push('');
  lines.push(`/** Resolve a help query. Returns help text. */`);
  lines.push(`export function resolveHelp(topic?: string): string {`);
  lines.push(`  if (!topic) return helpDirectory;`);
  lines.push(`  const dot = topic.indexOf('.');`);
  lines.push(`  if (dot === -1) {`);
  lines.push(`    if (helpTools[topic]) return helpTools[topic];`);
  lines.push(`    const ep = helpEndpoints[topic];`);
  lines.push(`    if (ep) return ep.summary;`);
  lines.push(`    const all = [...Object.keys(helpTools), ...Object.keys(helpEndpoints)];`);
  lines.push(`    return 'Unknown topic: ' + topic + '. Available: ' + all.join(', ');`);
  lines.push(`  }`);
  lines.push(`  const epName = topic.slice(0, dot);`);
  lines.push(`  const methodName = topic.slice(dot + 1);`);
  lines.push(`  const ep = helpEndpoints[epName];`);
  lines.push(`  if (!ep) return 'Unknown endpoint: ' + epName;`);
  lines.push(`  const method = ep.methods[methodName];`);
  lines.push(`  if (method) return method;`);
  lines.push(
    `  return 'Unknown method: ' + methodName + ' on ' + epName + '. Available: ' + Object.keys(ep.methods).join(', ');`,
  );
  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

const helpCode = generateHelpCode();
const helpPath = resolve(ROOT, 'packages/core-mcp/src/tools/_help.ts');
writeFileSync(helpPath, helpCode, 'utf-8');
console.log(`   → ${helpPath}`);

// ─── Auto-sync version.ts from package.json ───

const VERSION_PATH = resolve(ROOT, 'packages/shared/src/version.ts');
const pkgJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };
const currentVersionTs = readFileSync(VERSION_PATH, 'utf-8');
const versionRegex = /export const VERSION = '([^']+)'/;
const currentMatch = currentVersionTs.match(versionRegex);
if (currentMatch && currentMatch[1] !== pkgJson.version) {
  const updatedVersionTs = currentVersionTs.replace(versionRegex, `export const VERSION = '${pkgJson.version}'`);
  writeFileSync(VERSION_PATH, updatedVersionTs, 'utf-8');
  console.log(`   ⚠ Updated version.ts: ${currentMatch[1]} → ${pkgJson.version}`);
}

// ─── Summary ───

const bridgeCount = bridgeTools.length;
const customCount = Object.values(toolDefs).filter((d) => d.handler === 'custom').length;
const endpointCount = Object.keys(endpointDefs).length;
const totalTools = Object.keys(toolDefs).length + endpointCount;

console.log(`✅ Schema compiled successfully`);
console.log(
  `   ${totalTools} tools total (${bridgeCount} bridge → generated, ${customCount} custom → registry only, ${endpointCount} endpoint)`,
);
console.log(
  `   ${coreTools.length} core tools, ${Object.keys(toolsets).length} toolsets, ${writeTools.length} write tools (${createTools.length} create + ${editTools.length} edit)`,
);
if (endpointCount > 0) {
  const totalMethods = Object.values(endpointDefs).reduce((sum, ep) => sum + Object.keys(ep.methods).length, 0);
  console.log(`   ${endpointCount} endpoints with ${totalMethods} total methods`);
}
for (const target of GENERATED_TARGETS) {
  console.log(`   [${target.name}] → ${target.genPath}`);
  console.log(`   [${target.name}] → ${target.regPath}`);
  console.log(`   [${target.name}] → ${target.contractPath}`);
}
