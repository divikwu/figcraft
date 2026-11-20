import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  installToolRecorder,
  parseToolArgs,
  renderToolSignature,
  ToolCatalog,
  validateToolArgs,
} from '../../packages/core-mcp/src/tools/code-mode/catalog.js';
import {
  decodeToolResult,
  formatExecuteOutput,
  registerCodeModeTools,
  resolveCodeMode,
  searchTools,
} from '../../packages/core-mcp/src/tools/code-mode/index.js';
import { runInSandbox } from '../../packages/core-mcp/src/tools/code-mode/sandbox.js';

// biome-ignore lint/suspicious/noExplicitAny: test doubles
type AnyFn = (...args: any[]) => any;

interface FakeTool {
  description: string;
  inputSchema?: unknown;
  callback: AnyFn;
}

/** Minimal stand-in for McpServer: records tool registrations. */
class FakeMcpServer {
  tools: Record<string, FakeTool> = {};

  tool(name: string, ...rest: unknown[]): void {
    const callback = rest.pop() as AnyFn;
    const description = (rest.find((r) => typeof r === 'string') as string) ?? '';
    this.tools[name] = { description, inputSchema: rest.find((r) => typeof r === 'object'), callback };
  }

  registerTool(name: string, config: { description?: string; inputSchema?: unknown }, callback: AnyFn): void {
    this.tools[name] = { description: config.description ?? '', inputSchema: config.inputSchema, callback };
  }

  sendToolListChanged(): void {}
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** Build a catalog with a few fake FigCraft tools, the way registerAllTools would. */
function buildCatalog() {
  const server = new FakeMcpServer();
  const catalog = new ToolCatalog();
  const calls: Array<{ name: string; args: unknown }> = [];
  const stop = installToolRecorder(server as unknown as McpServer, catalog);

  server.tool('get_selection', 'Get the currently selected nodes in Figma.', {}, async () => {
    calls.push({ name: 'get_selection', args: {} });
    return json({ nodes: [{ id: '1:1', type: 'FRAME' }, { id: '1:2', type: 'TEXT' }, { id: '1:3', type: 'FRAME' }] });
  });
  server.tool(
    'lint_fix_all',
    'Run lint on the page/selection, then auto-fix all fixable violations in one call. Long details.',
    { nodeIds: z.array(z.string()).optional().describe('Node IDs to lint'), dryRun: z.boolean().optional() },
    async (args: unknown) => {
      calls.push({ name: 'lint_fix_all', args });
      return json({ fixed: 2, remaining: 1 });
    },
  );
  server.registerTool(
    'nodes',
    {
      description: 'Node operations — get, list, update, delete.',
      inputSchema: { method: z.enum(['get', 'delete']), nodeId: z.string().optional() },
    },
    async (args: { method: string; nodeId?: string }) => {
      calls.push({ name: 'nodes', args });
      if (args.method === 'get' && !args.nodeId) {
        return { ...json({ ok: false, error: 'nodeId required' }), isError: true };
      }
      return json({ ok: true, id: args.nodeId });
    },
  );
  server.tool('list_toolsets', 'List toolsets.', {}, async () => json({}));
  server.tool('get_mode', 'Get current mode.', {}, async () => {
    calls.push({ name: 'get_mode', args: {} });
    return json({ mode: 'library', _workflow: ['present proposal', 'wait for confirmation'] });
  });
  server.tool('create_frame', 'Create a frame.', { name: z.string().optional() }, async (args: unknown) => {
    calls.push({ name: 'create_frame', args });
    return json({ id: '9:9', _warnings: ['token binding skipped'], _nextSteps: ['run lint_fix_all'] });
  });
  server.tool('export_image', 'Export a node as an image.', { nodeId: z.string() }, async () => ({
    content: [{ type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  }));
  server.tool('reverse_sync_tokens', 'Export variables to a DTCG file.', { filePath: z.string() }, async () =>
    json({ ok: true }),
  );
  server.tool('execute_js', 'Run raw Plugin API code.', { code: z.string() }, async () => json({ ok: true }));
  server.tool('failing_in_band', 'Reports failure without isError.', {}, async () =>
    json({ ok: false, error: 'ReferenceError: foo' }),
  );
  stop();

  return { catalog, calls, recorderServer: server };
}

describe('Code Mode configuration', () => {
  it('resolves FIGCRAFT_CODE_MODE values', () => {
    expect(resolveCodeMode({})).toBe('off');
    expect(resolveCodeMode({ FIGCRAFT_CODE_MODE: 'on' })).toBe('on');
    expect(resolveCodeMode({ FIGCRAFT_CODE_MODE: 'ONLY' })).toBe('only');
    expect(resolveCodeMode({ FIGCRAFT_CODE_MODE: 'true' })).toBe('on');
    const original = console.error;
    console.error = () => {};
    expect(resolveCodeMode({ FIGCRAFT_CODE_MODE: 'bogus' })).toBe('off');
    console.error = original;
  });
});

describe('Code Mode catalog', () => {
  it('records server.tool and registerTool registrations and restores the originals', () => {
    const { catalog, recorderServer } = buildCatalog();
    expect(catalog.has('get_selection')).toBe(true);
    expect(catalog.has('nodes')).toBe(true);
    expect(catalog.get('lint_fix_all')?.shape).toBeDefined();
    // Recorder removed: later registrations are not captured.
    recorderServer.tool('late_tool', 'x', {}, async () => json({}));
    expect(catalog.has('late_tool')).toBe(false);
  });

  it('parses every server.tool overload', () => {
    const cb = async () => json({});
    expect(parseToolArgs(['a', cb])).toMatchObject({ name: 'a', description: '', shape: undefined });
    expect(parseToolArgs(['a', 'desc', cb])).toMatchObject({ description: 'desc', shape: undefined });
    const shape = { x: z.string() };
    expect(parseToolArgs(['a', 'desc', shape, { readOnlyHint: true }, cb])?.shape).toBe(shape);
    expect(parseToolArgs(['a', 'not a callback'])).toBeNull();
  });

  it('renders compact TypeScript signatures', () => {
    const { catalog } = buildCatalog();
    const brief = renderToolSignature(catalog.get('lint_fix_all')!, { detail: 'brief', label: 'core' });
    expect(brief).toContain('figcraft.lint_fix_all(args?: { nodeIds?: string[]; dryRun?: boolean })');
    expect(brief).toContain('Run lint on the page/selection, then auto-fix all fixable violations in one call.');
    expect(brief).not.toContain('Long details');
    const full = renderToolSignature(catalog.get('lint_fix_all')!, { detail: 'full' });
    expect(full).toContain('/** Node IDs to lint */');
    const nodes = renderToolSignature(catalog.get('nodes')!, { detail: 'brief' });
    expect(nodes).toContain('args: { method: "get" | "delete"; nodeId?: string }');
  });

  it('validates arguments like the SDK', async () => {
    const { catalog } = buildCatalog();
    const bad = await validateToolArgs(catalog.get('nodes')!, { method: 'explode' });
    expect(bad.ok).toBe(false);
    const good = await validateToolArgs(catalog.get('nodes')!, { method: 'get', nodeId: '1:1', extra: 1 });
    expect(good).toEqual({ ok: true, value: { method: 'get', nodeId: '1:1' } });
  });
});

describe('Code Mode sandbox', () => {
  const options = (overrides: Partial<Parameters<typeof runInSandbox>[1]> = {}) => ({
    timeoutMs: 3_000,
    maxToolCalls: 5,
    toolNames: ['echo'],
    callTool: async (_name: string, argsJson: string) => argsJson,
    ...overrides,
  });

  it('runs code, dispatches tool calls and captures console output', async () => {
    const result = await runInSandbox(
      'async () => { const r = await figcraft.echo({ a: 1 }); console.log("got", r); return r.a + 1; }',
      options(),
    );
    expect(result).toMatchObject({ ok: true, resultJson: '2', toolCalls: 1, logs: ['got {"a":1}'] });
  });

  it('exposes no host capabilities', async () => {
    const result = await runInSandbox(
      'async () => [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.figcraft]',
      options(),
    );
    expect(result.ok && JSON.parse(result.resultJson!)).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'object',
    ]);
  });

  it('blocks string code generation, including via host function constructors', async () => {
    const viaEval = await runInSandbox('async () => eval("1 + 1")', options());
    expect(viaEval.ok).toBe(false);
    const viaCtor = await runInSandbox('async () => figcraft.echo.constructor("return process")()', options());
    expect(viaCtor.ok).toBe(false);
    expect(!viaCtor.ok && viaCtor.error).toContain('Code generation from strings disallowed');
  });

  it('kills runaway code at the timeout', async () => {
    const result = await runInSandbox('async () => { while (true) {} }', options({ timeoutMs: 500 }));
    expect(result).toMatchObject({ ok: false, error: 'Execution timed out after 500ms' });
  });

  it('turns tool failures into catchable errors and enforces the call limit', async () => {
    const failing = await runInSandbox(
      'async () => { try { await figcraft.echo({}); } catch (e) { return e.message; } }',
      options({
        callTool: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(failing.ok && JSON.parse(failing.resultJson!)).toBe('boom');

    const loop = 'async () => { for (let i = 0; i < 10; i++) await figcraft.echo({}); }';
    const limited = await runInSandbox(loop, options());
    expect(!limited.ok && limited.error).toContain('Tool-call limit reached (5 per execution)');
  });

  it('reports unknown tools, syntax errors and non-function code', async () => {
    const unknown = await runInSandbox('async () => figcraft.nope()', options());
    expect(!unknown.ok && unknown.error).toContain('Unknown tool "figcraft.nope"');
    const syntax = await runInSandbox('async () => {', options());
    expect(!syntax.ok && syntax.error).toContain('SyntaxError');
    const notFn = await runInSandbox('42', options());
    expect(!notFn.ok && notFn.error).toContain('code must evaluate to a function');
  });

  it('limits parallel calls and counts only dispatched calls', async () => {
    let active = 0;
    let peak = 0;
    const result = await runInSandbox(
      'async () => { await Promise.all(Array.from({ length: 8 }, () => figcraft.echo({}))); for (let i = 0; i < 5; i++) { try { await figcraft.echo({}); } catch {} } }',
      options({
        maxToolCalls: 10,
        maxParallelCalls: 2,
        callTool: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          return '{}';
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(peak).toBe(2);
    expect(result.toolCalls).toBe(10);
  });

  it('reports calls still in flight when the run times out, and aborts their signal', async () => {
    let aborted = false;
    const result = await runInSandbox(
      'async () => { await figcraft.echo({}); }',
      options({
        timeoutMs: 300,
        settleTimeoutMs: 2_000,
        callTool: async (_name, _args, signal) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise((r) => setTimeout(r, 600));
          return '{}';
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: 'Execution timed out after 300ms' });
    expect(result.lateCalls).toEqual([{ name: 'echo', status: 'completed' }]);
    expect(aborted).toBe(true);
  });

  it('stops when the request is aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runInSandbox(
      'async () => { while (true) {} }',
      options({ timeoutMs: 5_000, signal: controller.signal }),
    );
    expect(result).toMatchObject({ ok: false, error: 'Execution cancelled' });
  });
});

describe('Code Mode tools', () => {
  function setup(blocked: (name: string) => string | null = () => null, maxOutputChars = 24_000) {
    const { catalog, calls } = buildCatalog();
    const server = new FakeMcpServer();
    const original = console.error;
    console.error = () => {};
    registerCodeModeTools(server as unknown as McpServer, {
      catalog,
      isToolBlocked: blocked,
      maxOutputChars,
      defaultTimeoutMs: 5_000,
    });
    console.error = original;
    const exec = (tool: 'execute' | 'execute_write', code: string) => server.tools[tool].callback({ code }, {});
    return { server, calls, exec };
  }

  it('registers search, execute and execute_write; keeps plumbing and execute_js out of reach', () => {
    const { server } = setup();
    expect(Object.keys(server.tools).sort()).toEqual(['execute', 'execute_write', 'search']);
    expect(server.tools.execute.description).toContain('get_selection');
    expect(server.tools.execute.description).not.toContain('lint_fix_all');
    expect(server.tools.execute_write.description).toContain('lint_fix_all');
    for (const description of [server.tools.execute.description, server.tools.execute_write.description]) {
      expect(description).not.toContain('list_toolsets');
      expect(description).not.toContain('execute_js');
    }
  });

  it('execute chains read-only tools in one call and returns only the final value', async () => {
    const { exec, calls } = setup();
    const result = await exec(
      'execute',
      `async () => {
        const sel = await figcraft.get_selection();
        const node = await figcraft.nodes({ method: 'get', nodeId: sel.nodes[0].id });
        return { frames: sel.nodes.filter((n) => n.type === 'FRAME').map((n) => n.id), first: node.id };
      }`,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('{"frames":["1:1","1:3"],"first":"1:1"}');
    expect(textOf(result)).toContain('[2 tool calls');
    expect(calls.map((c) => c.name)).toEqual(['get_selection', 'nodes']);
  });

  it('execute rejects writes, write endpoint methods and side-effect tools; execute_write allows them', async () => {
    const { exec, calls } = setup();
    const code = `async () => {
      const out = [];
      for (const call of [
        () => figcraft.lint_fix_all({}),
        () => figcraft.nodes({ method: 'delete', nodeId: '1:1' }),
        () => figcraft.reverse_sync_tokens({ filePath: '/tmp/x.json' }),
      ]) {
        try { await call(); out.push('ok'); } catch (e) { out.push(e.message); }
      }
      return out;
    }`;
    const readOnly = JSON.parse(textOf(await exec('execute', code)).split('\n')[0]);
    expect(readOnly[0]).toContain('Unknown tool "figcraft.lint_fix_all"');
    expect(readOnly[1]).toBe('nodes modifies the document: run this code with execute_write instead of execute');
    expect(readOnly[2]).toContain('Unknown tool "figcraft.reverse_sync_tokens"');
    expect(calls).toHaveLength(0);

    const writes = JSON.parse(textOf(await exec('execute_write', code)).split('\n')[0]);
    expect(writes).toEqual(['ok', 'ok', 'ok']);
  });

  it('never exposes execute_js, even to execute_write', async () => {
    const { exec } = setup();
    const result = await exec('execute_write', `async () => figcraft.execute_js({ code: '1' })`);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool "figcraft.execute_js"');
  });

  it('blocks UI creation after get_mode in the same execution', async () => {
    const { exec, calls } = setup();
    const result = await exec(
      'execute_write',
      `async () => { await figcraft.get_mode(); return figcraft.create_frame({ name: 'Login' }); }`,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('create_frame blocked: get_mode was called in this same execution');
    expect(calls.map((c) => c.name)).toEqual(['get_mode']);

    const later = await exec('execute_write', `async () => (await figcraft.create_frame({ name: 'Login' })).id`);
    expect(textOf(later)).toContain('"9:9"');
  });

  it('always surfaces harness notes, even when the code drops them', async () => {
    const { exec } = setup();
    const result = await exec('execute_write', `async () => { await figcraft.create_frame({}); return 'done'; }`);
    const text = textOf(result);
    expect(text).toContain('--- harness notes ---');
    expect(text).toContain('create_frame._warnings: ["token binding skipped"]');
    expect(text).toContain('create_frame._nextSteps: ["run lint_fix_all"]');
  });

  it('returns images whose handle the code returns', async () => {
    const { exec } = setup();
    const code = `async () => { const img = await figcraft.export_image({ nodeId: '1:1' }); return img; }`;
    const result = await exec('execute', code);
    expect(textOf(result)).toContain('"_image":"img_1"');
    expect(result.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });

    const dropped = await exec('execute', `async () => { await figcraft.export_image({ nodeId: '1:1' }); return 1; }`);
    expect(dropped.content).toHaveLength(1);
  });

  it('surfaces tool errors (isError and in-band ok:false), validation errors and access-level blocks', async () => {
    const { exec, calls } = setup((name) => (name === 'get_selection' ? 'blocked by FIGCRAFT_ACCESS=read' : null));
    const result = await exec(
      'execute',
      `async () => {
        const out = [];
        for (const call of [
          () => figcraft.nodes({ method: 'get' }),
          () => figcraft.nodes({ method: 'explode' }),
          () => figcraft.failing_in_band(),
          () => figcraft.get_selection(),
        ]) {
          try { await call(); out.push('ok'); } catch (e) { out.push(e.message); }
        }
        return out;
      }`,
    );
    const [toolError, validationError, inBand, accessError] = JSON.parse(textOf(result).split('\n')[0]);
    expect(toolError).toBe('nodes failed: nodeId required');
    expect(validationError).toContain('Invalid arguments for nodes');
    expect(inBand).toBe('failing_in_band failed: ReferenceError: foo');
    // Blocked tools are not exposed on the figcraft namespace at all.
    expect(accessError).toContain('Unknown tool "figcraft.get_selection"');
    expect(calls).toHaveLength(1);
  });

  it('search returns signatures by keyword and by name, flagging write-only usage', async () => {
    const { server } = setup();
    const byQuery = textOf(await server.tools.search.callback({ query: 'lint fix' }, {}));
    expect(byQuery).toContain('figcraft.lint_fix_all(');
    expect(byQuery).toContain('execute_write only');
    const byName = textOf(await server.tools.search.callback({ tools: ['nodes', 'missing'] }, {}));
    expect(byName).toContain('figcraft.nodes(');
    expect(byName).toContain('write methods (execute_write only): update, delete, clone, reparent');
    expect(byName).toContain('// not available: missing');
    const index = textOf(await server.tools.search.callback({}, {}));
    expect(index).toContain('get_selection');
  });
});

describe('Code Mode helpers', () => {
  it('decodes MCP tool results', () => {
    expect(decodeToolResult('t', json({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeToolResult('t', json({ ok: false, reason: 'no error field' }))).toEqual({
      ok: false,
      reason: 'no error field',
    });
    expect(decodeToolResult('t', { content: [{ type: 'text', text: 'plain' }] })).toBe('plain');
    expect(decodeToolResult('t', { content: [{ type: 'image', data: 'abcd', mimeType: 'image/png' }] })).toEqual({
      _image: true,
      mimeType: 'image/png',
      base64Length: 4,
    });
    const failed = { ...json({ ok: false, error: 'nope' }), isError: true };
    expect(() => decodeToolResult('t', failed)).toThrow('t failed: nope');
  });

  it('truncates oversized output while keeping valid JSON when possible', () => {
    const big = JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ id: i, name: `node-${i}` })));
    const { text, truncated } = formatExecuteOutput(big, [], 2_000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2_200);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('ranks name matches above description matches', () => {
    const { catalog } = buildCatalog();
    const hits = searchTools(catalog.list(), 'selection', 5).map((t) => t.name);
    expect(hits[0]).toBe('get_selection');
  });
});
