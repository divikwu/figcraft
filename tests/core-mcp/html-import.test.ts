import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../../packages/core-mcp/src/bridge.js';
import {
  htmlToCreateFramePayload,
  loadHtmlImportSource,
  parseHtml,
  registerHtmlImportTools,
} from '../../packages/core-mcp/src/tools/html-import.js';

class FakeServer {
  tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  tool(
    name: string,
    _description: string,
    _params: Record<string, unknown>,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, handler);
  }
}

function parseTextResponse(response: unknown): Record<string, unknown> {
  const mcpResponse = response as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  return JSON.parse(mcpResponse.content[0].text) as Record<string, unknown>;
}

describe('HTML import parsing and conversion', () => {
  it('parses simple nested HTML into an element tree', () => {
    const root = parseHtml('<main><h1>Hello</h1><p>World</p></main>');

    expect(root.children).toHaveLength(1);
    const main = root.children[0];
    expect(main).toMatchObject({ kind: 'element', tagName: 'main' });
    if (main.kind === 'element') {
      expect(main.children).toHaveLength(2);
    }
  });

  it('converts semantic HTML into a create_frame payload', () => {
    const source = {
      html: `
        <main style="background:#f8fafc; padding:24px">
          <h1 style="color:#111827">Launch faster</h1>
          <p style="font-size:18px;color:rgb(75,85,99)">Design and ship with one system.</p>
          <button style="background:#2563eb;color:white;border-radius:10px">Start</button>
          <input placeholder="Email address" />
          <img src="/hero.png" width="640" height="360" alt="Product" />
        </main>
      `,
      title: 'Landing',
      url: 'https://example.com/page',
    };

    const { payload, warnings, stats } = htmlToCreateFramePayload(source, { width: 1200 });

    expect(payload.name).toBe('Landing');
    expect(payload.width).toBe(1200);
    expect(payload.children).toHaveLength(1);
    expect(stats.nodeCount).toBeGreaterThan(4);
    expect(warnings).toEqual([]);

    const main = payload.children[0] as Record<string, unknown>;
    expect(main).toMatchObject({
      type: 'frame',
      fill: '#F8FAFC',
      padding: 24,
      layoutMode: 'VERTICAL',
    });

    const children = main.children as Array<Record<string, unknown>>;
    expect(children[0]).toMatchObject({
      type: 'text',
      content: 'Launch faster',
      fontSize: 48,
      fontStyle: 'Bold',
      fill: '#111827',
    });
    expect(children[2]).toMatchObject({ type: 'frame', role: 'button', interactiveKind: 'button-solid' });
    expect(children[3]).toMatchObject({ type: 'frame', role: 'input' });
    expect(children[4]).toMatchObject({
      type: 'frame',
      imageUrl: 'https://example.com/hero.png',
      width: 640,
      height: 360,
    });
  });

  it('does not turn transparent CSS colors into opaque fills', () => {
    const { payload } = htmlToCreateFramePayload({
      html: '<main style="background:rgba(0,0,0,0)"><p style="color:#00000000">Ghost</p></main>',
    });

    const main = payload.children[0] as Record<string, unknown>;
    expect(main).not.toHaveProperty('fill');
    const children = main.children as Array<Record<string, unknown>>;
    expect(children[0]).not.toHaveProperty('fill');
  });
});

describe('HTML import source loading', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figcraft-html-import-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads an absolute local HTML file', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<title>Example</title><main>Hi</main>');

    const source = await loadHtmlImportSource({ filePath, rootsEnv: dir });

    expect(source.kind).toBe('file');
    expect(source.filePath?.endsWith('/page.html')).toBe(true);
    expect(source.title).toBe('Example');
  });

  it('rejects local files outside configured HTML roots', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<main>Hi</main>');

    await expect(loadHtmlImportSource({ filePath, rootsEnv: join(dir, 'allowed') })).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
  });

  it('rejects local files that are not HTML files', async () => {
    const filePath = join(dir, 'secret.txt');
    await writeFile(filePath, '<main>Hi</main>');

    await expect(loadHtmlImportSource({ filePath, rootsEnv: dir })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('rejects .html files whose contents do not look like HTML', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, 'plain secret text');

    await expect(loadHtmlImportSource({ filePath, rootsEnv: dir })).rejects.toMatchObject({
      code: 'INVALID_HTML',
    });
  });

  it('blocks private and loopback URL imports by default', async () => {
    await expect(loadHtmlImportSource({ url: 'http://127.0.0.1:3000/page.html' })).rejects.toMatchObject({
      code: 'PRIVATE_URL_BLOCKED',
    });
  });

  it('fetches public static HTML URLs through the guarded fetch path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<main>Remote</main>', {
        headers: { 'content-type': 'text/html' },
        status: 200,
      }),
    );

    const source = await loadHtmlImportSource({ url: 'https://93.184.216.34/page.html' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(source.kind).toBe('url');
    expect(source.html).toContain('Remote');
  });

  it('rejects non-HTML URL content types', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    await expect(loadHtmlImportSource({ url: 'https://93.184.216.34/data' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('rejects ambiguous sources', async () => {
    await expect(loadHtmlImportSource({ html: '<main />', url: 'https://example.com' })).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });
});

describe('HTML import MCP tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dryRun returns payload without writing to Figma', async () => {
    const server = new FakeServer();
    const bridge = { request: vi.fn() } as unknown as Bridge;
    registerHtmlImportTools(server as unknown as McpServer, bridge);

    const response = await server.tools.get('import_html')!({
      html: '<main><h1>Hello</h1></main>',
      dryRun: true,
      name: 'Dry Run',
    });

    expect(bridge.request).not.toHaveBeenCalled();
    const parsed = parseTextResponse(response);
    expect(parsed).toMatchObject({ ok: true, dryRun: true });
    expect(parsed.payload).toMatchObject({ name: 'Dry Run', role: 'screen' });
  });

  it('writes converted HTML through create_frame', async () => {
    const server = new FakeServer();
    const bridge = {
      request: vi.fn().mockResolvedValue({ id: '1:2', name: 'Imported HTML' }),
    } as unknown as Bridge;
    registerHtmlImportTools(server as unknown as McpServer, bridge);

    const response = await server.tools.get('import_html')!({
      html: '<main><button>Buy now</button></main>',
      name: 'Checkout',
      width: 1024,
    });

    expect(bridge.request).toHaveBeenCalledWith(
      'create_frame',
      expect.objectContaining({
        name: 'Checkout',
        width: 1024,
        role: 'screen',
      }),
      60_000,
      'create_frame',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.id).toBe('1:2');
    expect(parsed.payload).toMatchObject({ name: 'Checkout' });
  });
});
