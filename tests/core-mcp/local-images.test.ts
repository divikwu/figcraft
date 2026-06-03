import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../../packages/core-mcp/src/bridge.js';
import { loadLocalImage, registerLocalImageTools } from '../../packages/core-mcp/src/tools/local-images.js';

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function validPng1x1(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );
}

function validGif1x1(): Buffer {
  return Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
}

function gifBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function jpegBuffer(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

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

describe('local image loading', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figcraft-local-images-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads PNG dimensions and base64 data', async () => {
    const filePath = join(dir, 'sample.png');
    await writeFile(filePath, pngBuffer(20, 10));

    const image = await loadLocalImage(filePath);

    expect(image.mimeType).toBe('image/png');
    expect(image.originalWidth).toBe(20);
    expect(image.originalHeight).toBe(10);
    expect(image.base64).toBe(pngBuffer(20, 10).toString('base64'));
  });

  it('loads a valid PNG fixture, not just a header-shaped buffer', async () => {
    const filePath = join(dir, 'valid.png');
    await writeFile(filePath, validPng1x1());

    const image = await loadLocalImage(filePath);

    expect(image.mimeType).toBe('image/png');
    expect(image.originalWidth).toBe(1);
    expect(image.originalHeight).toBe(1);
    expect(image.base64).toBe(validPng1x1().toString('base64'));
  });

  it('uses magic bytes instead of extension for JPEG detection', async () => {
    const filePath = join(dir, 'sample.txt');
    await writeFile(filePath, jpegBuffer(320, 240));

    const image = await loadLocalImage(filePath);

    expect(image.mimeType).toBe('image/jpeg');
    expect(image.originalWidth).toBe(320);
    expect(image.originalHeight).toBe(240);
  });

  it('loads GIF dimensions', async () => {
    const filePath = join(dir, 'sample.gif');
    await writeFile(filePath, validGif1x1());

    const image = await loadLocalImage(filePath);

    expect(image.mimeType).toBe('image/gif');
    expect(image.originalWidth).toBe(1);
    expect(image.originalHeight).toBe(1);
  });

  it('rejects relative paths', async () => {
    await expect(loadLocalImage('sample.png')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('checks root allowlist after resolving symlinks', async () => {
    const allowedRoot = join(dir, 'allowed');
    const outsideRoot = join(dir, 'outside');
    await mkdir(allowedRoot);
    await mkdir(outsideRoot);
    const outsideFile = join(outsideRoot, 'image.png');
    const linkedFile = join(allowedRoot, 'linked.png');
    await writeFile(outsideFile, pngBuffer(8, 8));
    await symlink(outsideFile, linkedFile);

    await expect(loadLocalImage(linkedFile, { rootsEnv: allowedRoot })).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
  });

  it('rejects files above the byte limit', async () => {
    const filePath = join(dir, 'large.png');
    await writeFile(filePath, Buffer.concat([pngBuffer(8, 8), Buffer.alloc(100)]));

    await expect(loadLocalImage(filePath, { maxBytes: 24 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects images above Figma dimensions', async () => {
    const filePath = join(dir, 'too-wide.png');
    await writeFile(filePath, pngBuffer(4097, 10));

    await expect(loadLocalImage(filePath)).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_TOO_LARGE' });
  });
});

describe('local image MCP tools', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figcraft-local-image-tools-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('create_image_frame_from_local sends base64 bytes to the create plugin handler', async () => {
    const filePath = join(dir, 'hero.png');
    await writeFile(filePath, pngBuffer(20, 10));
    const server = new FakeServer();
    const bridge = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ nodes: [] })
        .mockResolvedValueOnce({ id: '1:2', name: 'Hero', width: 10, height: 5, imageHash: 'hash' }),
    } as unknown as Bridge;

    registerLocalImageTools(server as unknown as McpServer, bridge);
    const response = await server.tools.get('create_image_frame_from_local')!({
      filePath,
      name: 'Hero',
      scale: 0.5,
      scaleMode: 'FIT',
    });

    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      'get_current_page',
      { maxDepth: 1, maxNodes: 1000, detail: 'summary' },
      15_000,
      'get_current_page',
      false,
    );
    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      'create_frame',
      expect.objectContaining({
        imageData: pngBuffer(20, 10).toString('base64'),
        imageMimeType: 'image/png',
        name: 'Hero',
        x: 0,
        y: 0,
        width: 10,
        height: 5,
        imageScaleMode: 'FIT',
      }),
      60_000,
      'create_frame',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.id).toBe('1:2');
    expect(parsed.source).toMatchObject({ originalWidth: 20, originalHeight: 10, mimeType: 'image/png' });
    expect(parsed.placement).toMatchObject({ x: 0, y: 0, strategy: 'auto-right', adjusted: false });
  });

  it('auto-places new local image frames to the right of existing top-level content', async () => {
    const filePath = join(dir, 'hero.png');
    await writeFile(filePath, pngBuffer(20, 10));
    const server = new FakeServer();
    const bridge = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [
            { id: '1:1', name: 'Existing', type: 'FRAME', visible: true, x: 0, y: 0, width: 100, height: 100 },
            { id: '1:2', name: 'Hidden', type: 'FRAME', visible: false, x: 1000, y: 0, width: 100, height: 100 },
          ],
        })
        .mockResolvedValueOnce({ id: '1:3', name: 'Hero', width: 20, height: 10, imageHash: 'hash' }),
    } as unknown as Bridge;

    registerLocalImageTools(server as unknown as McpServer, bridge);
    const response = await server.tools.get('create_image_frame_from_local')!({ filePath, name: 'Hero' });

    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      'create_frame',
      expect.objectContaining({ x: 300, y: 0, width: 20, height: 10 }),
      60_000,
      'create_frame',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.placement).toMatchObject({
      x: 300,
      y: 0,
      strategy: 'auto-right',
      adjusted: false,
      reason: 'default non-overlapping placement',
    });
  });

  it('moves overlapping explicit coordinates by default', async () => {
    const filePath = join(dir, 'overlap.png');
    await writeFile(filePath, pngBuffer(20, 10));
    const server = new FakeServer();
    const bridge = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [{ id: '1:1', name: 'Existing', type: 'FRAME', visible: true, x: 0, y: 0, width: 100, height: 100 }],
        })
        .mockResolvedValueOnce({ id: '1:2', name: 'Overlap', width: 20, height: 10, imageHash: 'hash' }),
    } as unknown as Bridge;

    registerLocalImageTools(server as unknown as McpServer, bridge);
    const response = await server.tools.get('create_image_frame_from_local')!({
      filePath,
      name: 'Overlap',
      x: 0,
      y: 0,
    });

    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      'create_frame',
      expect.objectContaining({ x: 300, y: 0 }),
      60_000,
      'create_frame',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.placement).toMatchObject({
      x: 300,
      y: 0,
      strategy: 'auto-right',
      adjusted: true,
      reason: 'requested position overlaps existing top-level content',
    });
  });

  it('still avoids overlap when parentId is the current page', async () => {
    const filePath = join(dir, 'page-parent.png');
    await writeFile(filePath, pngBuffer(20, 10));
    const server = new FakeServer();
    const bridge = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          id: '0:1',
          nodes: [{ id: '1:1', name: 'Existing', type: 'FRAME', visible: true, x: 20, y: 0, width: 100, height: 100 }],
        })
        .mockResolvedValueOnce({ id: '1:2', name: 'Page Parent', width: 20, height: 10, imageHash: 'hash' }),
    } as unknown as Bridge;

    registerLocalImageTools(server as unknown as McpServer, bridge);
    const response = await server.tools.get('create_image_frame_from_local')!({
      filePath,
      name: 'Page Parent',
      parentId: '0:1',
    });

    expect(bridge.request).toHaveBeenNthCalledWith(
      2,
      'create_frame',
      expect.objectContaining({ parentId: '0:1', x: 320, y: 0 }),
      60_000,
      'create_frame',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.placement).toMatchObject({
      x: 320,
      y: 0,
      strategy: 'auto-right',
      adjusted: false,
    });
  });

  it('fill_existing_image_from_local sends base64 bytes to the edit plugin handler', async () => {
    const filePath = join(dir, 'replace.gif');
    await writeFile(filePath, gifBuffer(12, 8));
    const server = new FakeServer();
    const bridge = {
      request: vi
        .fn()
        .mockResolvedValue({ ok: true, id: '1:2', name: 'Target', width: 12, height: 8, imageHash: 'hash' }),
    } as unknown as Bridge;

    registerLocalImageTools(server as unknown as McpServer, bridge);
    const response = await server.tools.get('fill_existing_image_from_local')!({
      filePath,
      nodeId: '1:2',
      scaleMode: 'CROP',
    });

    expect(bridge.request).toHaveBeenCalledWith(
      'set_image_fill',
      expect.objectContaining({
        nodeId: '1:2',
        imageData: gifBuffer(12, 8).toString('base64'),
        mimeType: 'image/gif',
        scaleMode: 'CROP',
      }),
      60_000,
      'fill_existing_image_from_local',
      true,
    );
    const parsed = parseTextResponse(response);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toMatchObject({ originalWidth: 12, originalHeight: 8, mimeType: 'image/gif' });
  });
});
