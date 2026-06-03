import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../packages/adapter-figma/src/utils/node-lookup.js', () => ({
  findNodeByIdAsync: vi.fn(),
}));

vi.mock('../../packages/adapter-figma/src/handlers/write-nodes.js', () => ({
  getCachedModeLibrary: vi.fn().mockResolvedValue(['spec', undefined]),
  resolveFontAsync: vi.fn(),
}));

import { registerImageVectorHandlers } from '../../packages/adapter-figma/src/handlers/image-vector.js';
import { registerCreateHandlers } from '../../packages/adapter-figma/src/handlers/write-nodes-create.js';
import { handlers } from '../../packages/adapter-figma/src/registry.js';
import { findNodeByIdAsync } from '../../packages/adapter-figma/src/utils/node-lookup.js';

const mockFindNodeByIdAsync = vi.mocked(findNodeByIdAsync);

function createFrameNode(id = 'frame:1') {
  return {
    id,
    type: 'FRAME',
    name: 'Frame',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    fills: [],
    strokes: [],
    effects: [],
    layoutMode: 'NONE',
    clipsContent: true,
    children: [],
    resize(width: number, height: number) {
      this.width = width;
      this.height = height;
    },
    appendChild: vi.fn(),
    remove: vi.fn(),
    getPluginData: vi.fn(() => ''),
    setPluginData: vi.fn(),
  };
}

describe('local image plugin handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.stubGlobal('figma', {
      mixed: Symbol('mixed'),
      base64Decode: vi.fn((data: string) => Buffer.from(data, 'base64')),
      createImage: vi.fn(() => ({ hash: 'image-hash' })),
      createFrame: vi.fn(() => createFrameNode('frame:new')),
      currentPage: {
        id: 'page:1',
        type: 'PAGE',
        name: 'Page',
        children: [],
      },
    });
    registerImageVectorHandlers();
    registerCreateHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    handlers.clear();
  });

  it('set_image_fill writes an image paint and returns node metadata', async () => {
    const node = createFrameNode('frame:target');
    mockFindNodeByIdAsync.mockResolvedValue(node as unknown as SceneNode);

    const handler = handlers.get('set_image_fill');
    expect(handler).toBeDefined();
    const result = (await handler!({
      nodeId: 'frame:target',
      imageData: Buffer.from('image-bytes').toString('base64'),
      scaleMode: 'FIT',
    })) as Record<string, unknown>;

    expect(node.fills).toEqual([{ type: 'IMAGE', scaleMode: 'FIT', imageHash: 'image-hash' }]);
    expect(result).toMatchObject({
      ok: true,
      id: 'frame:target',
      name: 'Frame',
      width: 100,
      height: 100,
      imageHash: 'image-hash',
    });
  });

  it('create_frame supports local base64 image fills through the main creation pipeline', async () => {
    mockFindNodeByIdAsync.mockResolvedValue(null);

    const handler = handlers.get('create_frame');
    expect(handler).toBeDefined();
    const result = (await handler!({
      imageData: Buffer.from('image-bytes').toString('base64'),
      name: 'Local Screenshot',
      width: 320,
      height: 640,
      x: 12,
      y: 24,
      imageScaleMode: 'CROP',
    })) as Record<string, unknown>;

    const frame = (figma.createFrame as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as ReturnType<
      typeof createFrameNode
    >;
    expect(frame.name).toBe('Local Screenshot');
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(640);
    expect(frame.x).toBe(12);
    expect(frame.y).toBe(24);
    expect(frame.fills).toEqual([{ type: 'IMAGE', scaleMode: 'CROP', imageHash: 'image-hash' }]);
    expect(result).toMatchObject({
      id: 'frame:new',
      name: 'Local Screenshot',
      width: 320,
      height: 640,
      imageHash: 'image-hash',
    });
  });

  it('create_frame removes the frame when local image bytes fail', async () => {
    mockFindNodeByIdAsync.mockResolvedValue(null);
    (figma.createImage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('bad image');
    });

    const handler = handlers.get('create_frame');
    expect(handler).toBeDefined();
    await expect(
      handler!({
        imageData: Buffer.from('not-an-image').toString('base64'),
        name: 'Broken Local Image',
        width: 120,
        height: 80,
      }),
    ).rejects.toThrow('imageData failed: bad image');

    const frame = (figma.createFrame as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as ReturnType<
      typeof createFrameNode
    >;
    expect(frame.remove).toHaveBeenCalled();
  });
});
