/**
 * Tool_Logic_Function behavioral equivalence unit tests.
 *
 * Validates that extracted logic functions return McpResponse format
 * and preserve key behaviors: URL parsing, node-not-found guidance, etc.
 *
 * Validates: Requirements 1.5, 12.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpResponse } from '../../packages/core-mcp/src/tools/logic/node-logic.js';

// ─── Mock setup ───

vi.mock('../../packages/core-mcp/src/rest-fallback.js', () => ({
  requestWithFallback: vi.fn(),
  restGetNodeInfo: vi.fn(),
  restExportImage: vi.fn(),
  setFileKey: vi.fn(),
  setFileContext: vi.fn(),
}));

vi.mock('../../packages/core-mcp/src/tools/toolset-manager.js', () => ({
  getAccessLevel: vi.fn(() => 'edit'),
  isToolBlocked: vi.fn(() => null),
}));

vi.mock('../../packages/core-mcp/src/tools/logic/component-logic.js', () => ({
  listLibraryComponentsLogic: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"componentSetCount":0,"standaloneCount":0,"componentSets":[],"standalone":[]}' }],
  }),
}));

vi.mock('../../packages/core-mcp/src/figma-api.js', () => ({
  extractFileKeyFromUrl: vi.fn((url: string) => {
    const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }),
  extractNodeIdFromUrl: vi.fn((url: string) => {
    const match = url.match(/node-id=([^&]+)/);
    if (!match) return null;
    return decodeURIComponent(match[1]).replaceAll('-', ':');
  }),
}));

import { requestWithFallback } from '../../packages/core-mcp/src/rest-fallback.js';
import { exportImageLogic } from '../../packages/core-mcp/src/tools/logic/export-logic.js';
import {
  getCurrentPageLogic,
  getNodeInfoLogic,
  searchNodesLogic,
} from '../../packages/core-mcp/src/tools/logic/node-logic.js';

const mockRequestWithFallback = vi.mocked(requestWithFallback);

// ─── Bridge mock factory ───

function createMockBridge(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: true,
    request: vi.fn().mockResolvedValue({ ok: true }),
    setLibraryFileKey: vi.fn(),
    getLibraryFileKey: vi.fn(),
    ...overrides,
  } as any;
}

// ─── McpResponse format helper ───

function assertValidMcpResponse(response: McpResponse) {
  expect(response).toHaveProperty('content');
  expect(Array.isArray(response.content)).toBe(true);
  expect(response.content.length).toBeGreaterThan(0);
  for (const item of response.content) {
    expect(['text', 'image']).toContain(item.type);
    if (item.type === 'text') {
      expect(typeof item.text).toBe('string');
    } else {
      expect(typeof item.data).toBe('string');
      expect(typeof item.mimeType).toBe('string');
    }
  }
  if (response.isError !== undefined) {
    expect(typeof response.isError).toBe('boolean');
  }
}

// ─── Tests ───

describe('getNodeInfoLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid McpResponse for a normal node ID', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { id: '1:23', name: 'Frame', type: 'FRAME' },
      source: 'plugin',
    });

    const response = await getNodeInfoLogic(bridge, { nodeId: '1:23' });

    assertValidMcpResponse(response);
    expect(response.isError).toBeUndefined();
    expect(mockRequestWithFallback).toHaveBeenCalledWith(
      bridge,
      'get_node_info',
      { nodeId: '1:23' },
      expect.any(Function),
    );
  });

  it('extracts nodeId from a Figma URL with node-id param', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { id: '705:60', name: 'Button' },
      source: 'plugin',
    });

    const url = 'https://www.figma.com/design/abc123?node-id=705-60';
    const response = await getNodeInfoLogic(bridge, { nodeId: url });

    assertValidMcpResponse(response);
    expect(mockRequestWithFallback).toHaveBeenCalledWith(
      bridge,
      'get_node_info',
      { nodeId: '705:60' },
      expect.any(Function),
    );
  });

  it('returns error when Figma URL has no node-id', async () => {
    const bridge = createMockBridge();

    const url = 'https://www.figma.com/design/abc123';
    const response = await getNodeInfoLogic(bridge, { nodeId: url });

    assertValidMcpResponse(response);
    expect(response.content[0].text).toContain('Could not extract node ID');
    expect(mockRequestWithFallback).not.toHaveBeenCalled();
  });

  it('returns guidance message when node is not found', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { error: 'Node not found' },
      source: 'plugin',
    });

    const response = await getNodeInfoLogic(bridge, { nodeId: '999:999' });

    assertValidMcpResponse(response);
    expect(response.content.length).toBe(2);
    expect(response.content[1].text).toContain('Node not found');
  });
});

describe('searchNodesLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid McpResponse format', async () => {
    const bridge = createMockBridge();
    bridge.request.mockResolvedValue([{ id: '1:1', name: 'Button', type: 'FRAME' }]);

    const response = await searchNodesLogic(bridge, { query: 'Button' });

    assertValidMcpResponse(response);
    expect(bridge.request).toHaveBeenCalledWith('search_nodes', {
      query: 'Button',
      types: undefined,
      limit: undefined,
      detail: 'summary',
    });
  });
});

describe('getCurrentPageLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid McpResponse with workflow hint', async () => {
    const bridge = createMockBridge();
    bridge.request.mockResolvedValue({
      name: 'Page 1',
      children: [],
    });

    const response = await getCurrentPageLogic(bridge, {});

    assertValidMcpResponse(response);
    expect(response.content.length).toBe(2);
    expect(response.content[1].text).toContain('NEXT');
  });
});

describe('exportImageLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid McpResponse format', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { base64: 'abc123', format: 'PNG' },
      source: 'plugin',
    });

    const response = await exportImageLogic(bridge, { nodeId: '1:23' });

    assertValidMcpResponse(response);
    expect(response.isError).toBeUndefined();
    // content[0] is the image block, content[1] is text metadata
    expect(response.content[0].type).toBe('image');
    const imgBlock = response.content[0] as { type: 'image'; data: string; mimeType: string };
    expect(imgBlock.data).toBe('abc123');
    expect(imgBlock.mimeType).toBe('image/png');
    const meta = JSON.parse((response.content[1] as { type: 'text'; text: string }).text);
    expect(meta.format).toBe('PNG');
  });

  it('returns SVG as text content block (not image) to avoid API 400 errors', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { base64: 'PHN2Zz4=', format: 'SVG', size: 1024 },
      source: 'plugin',
    });

    const response = await exportImageLogic(bridge, { nodeId: '1:23', format: 'SVG' });

    assertValidMcpResponse(response);
    // SVG must NOT use image content block — Claude API rejects image/svg+xml
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe('text');
    const parsed = JSON.parse((response.content[0] as { type: 'text'; text: string }).text);
    expect(parsed.format).toBe('SVG');
    expect(parsed.size).toBe(1024);
    expect(parsed.base64).toBeUndefined(); // base64 omitted to save context tokens
    expect(parsed._note).toContain('cannot be previewed inline');
  });

  it('returns PDF as text content block (not image) to avoid API 400 errors', async () => {
    const bridge = createMockBridge();
    mockRequestWithFallback.mockResolvedValue({
      result: { base64: 'JVBERi0=', format: 'PDF', size: 2048 },
      source: 'plugin',
    });

    const response = await exportImageLogic(bridge, { nodeId: '1:23', format: 'PDF' });

    assertValidMcpResponse(response);
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe('text');
    const parsed = JSON.parse((response.content[0] as { type: 'text'; text: string }).text);
    expect(parsed.format).toBe('PDF');
    expect(parsed.size).toBe(2048);
    expect(parsed.base64).toBeUndefined();
    expect(parsed._note).toContain('cannot be previewed inline');
  });
});

// ─── Property-Based Tests ───

import fc from 'fast-check';
import { bridgeRequestLogic, registerEndpointTools } from '../../packages/core-mcp/src/tools/endpoints.js';
import { listLibraryComponentsLogic } from '../../packages/core-mcp/src/tools/logic/component-logic.js';

const mockListLibraryComponentsLogic = vi.mocked(listLibraryComponentsLogic);

function isValidMcpResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return false;
  if (obj.content.length === 0) return false;
  for (const item of obj.content) {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'text') return false;
    if (typeof entry.text !== 'string') return false;
  }
  if (obj.isError !== undefined && typeof obj.isError !== 'boolean') return false;
  return true;
}

describe('Feature: endpoint-mode-refactor, Property 2: Tool_Logic_Function 返回格式一致性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bridgeRequestLogic always returns valid McpResponse for any bridge method name and any JSON-serializable result', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 50 }), fc.jsonValue(), async (methodName, bridgeResult) => {
        const bridge = createMockBridge();
        bridge.request.mockResolvedValue(bridgeResult);

        const response = await bridgeRequestLogic(bridge, methodName, { someParam: 'value' });

        expect(isValidMcpResponse(response)).toBe(true);
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.content[0].type).toBe('text');
        expect(typeof response.content[0].text).toBe('string');
      }),
      { numRuns: 100 },
    );
  });

  it('getNodeInfoLogic always returns valid McpResponse for any nodeId string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 100 }),
          fc.constantFrom(
            '1:23',
            '999:999',
            '',
            'https://www.figma.com/design/abc123?node-id=705-60',
            'https://www.figma.com/design/abc123',
            'not-a-url',
            '0:0',
          ),
        ),
        async (nodeId) => {
          const bridge = createMockBridge();
          mockRequestWithFallback.mockResolvedValue({
            result: { id: nodeId, name: 'TestNode', type: 'FRAME' },
            source: 'plugin',
          });

          const response = await getNodeInfoLogic(bridge, { nodeId });

          expect(isValidMcpResponse(response)).toBe(true);
          expect(response.content.length).toBeGreaterThan(0);
          expect(response.content[0].type).toBe('text');
        },
      ),
      { numRuns: 100 },
    );
  });
});

const ENDPOINT_FLAT_EQUIVALENCE: Array<{
  endpoint: string;
  method: string;
  handler:
    | { type: 'logic'; fn: 'getNodeInfoLogic' | 'searchNodesLogic' | 'listLibraryComponentsLogic' }
    | { type: 'bridge'; bridgeMethod: string };
  paramsArb: fc.Arbitrary<Record<string, unknown>>;
}> = [
  {
    endpoint: 'nodes',
    method: 'get',
    handler: { type: 'logic', fn: 'getNodeInfoLogic' },
    paramsArb: fc.record({ nodeId: fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/) }),
  },
  {
    endpoint: 'nodes',
    method: 'list',
    handler: { type: 'logic', fn: 'searchNodesLogic' },
    paramsArb: fc.record({
      query: fc.string({ minLength: 1, maxLength: 30 }),
      types: fc.option(
        fc.array(fc.constantFrom('FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE'), { minLength: 0, maxLength: 3 }),
        { nil: undefined },
      ),
      limit: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    }),
  },
  {
    endpoint: 'nodes',
    method: 'update',
    handler: { type: 'bridge', bridgeMethod: 'patch_nodes' },
    paramsArb: fc.record({
      patches: fc.array(
        fc.record({
          nodeId: fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/),
          props: fc.constant({ name: 'Updated' }),
        }),
        { minLength: 0, maxLength: 3 },
      ),
    }),
  },
  {
    endpoint: 'nodes',
    method: 'delete',
    handler: { type: 'bridge', bridgeMethod: 'delete_nodes' },
    paramsArb: fc.record({
      nodeIds: fc.array(fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/), { minLength: 0, maxLength: 5 }),
    }),
  },
  {
    endpoint: 'text',
    method: 'set_content',
    handler: { type: 'bridge', bridgeMethod: 'set_text_content' },
    paramsArb: fc.record({
      nodeId: fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/),
      content: fc.string({ minLength: 1, maxLength: 50 }),
    }),
  },
  {
    endpoint: 'components',
    method: 'list',
    handler: { type: 'bridge', bridgeMethod: 'list_components' },
    paramsArb: fc.constant({}),
  },
  {
    endpoint: 'components',
    method: 'get',
    handler: { type: 'bridge', bridgeMethod: 'get_component' },
    paramsArb: fc.record({ nodeId: fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/) }),
  },
  {
    endpoint: 'components',
    method: 'list_properties',
    handler: { type: 'bridge', bridgeMethod: 'list_component_properties' },
    paramsArb: fc.record({ nodeId: fc.stringMatching(/^[0-9]{1,4}:[0-9]{1,4}$/) }),
  },
  {
    endpoint: 'components',
    method: 'list_library',
    handler: { type: 'logic', fn: 'listLibraryComponentsLogic' },
    paramsArb: fc.record({
      fileKey: fc.option(fc.stringMatching(/^[a-zA-Z0-9]{5,15}$/), { nil: undefined }),
    }),
  },
];

function createMockServerForEndpoints() {
  const registeredTools: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};
  const mockServer = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: unknown,
        callback: (params: Record<string, unknown>) => Promise<unknown>,
      ) => {
        registeredTools[name] = callback;
      },
    ),
  };
  return { server: mockServer as any, registeredTools };
}

describe('Feature: endpoint-mode-refactor, Property 1: Endpoint 与 Flat Tool 行为等价', () => {
  let registeredTools: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
  let sharedBridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    const { server, registeredTools: tools } = createMockServerForEndpoints();
    sharedBridge = createMockBridge();
    sharedBridge.request.mockResolvedValue({ ok: true, data: 'mock-result' });
    mockRequestWithFallback.mockResolvedValue({
      result: { id: '1:1', name: 'MockNode', type: 'FRAME' },
      source: 'plugin',
    });
    registerEndpointTools(server, sharedBridge);
    registeredTools = tools;
  });

  it('endpoint call and direct logic function call produce identical results for any valid (endpoint, method, params)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom(...ENDPOINT_FLAT_EQUIVALENCE)
          .chain((entry) => entry.paramsArb.map((params) => ({ ...entry, generatedParams: params }))),
        async ({ endpoint, method, handler, generatedParams }) => {
          sharedBridge.request.mockClear();
          mockRequestWithFallback.mockClear();
          vi.mocked(getNodeInfoLogic).mockClear?.();
          vi.mocked(searchNodesLogic).mockClear?.();
          mockListLibraryComponentsLogic.mockClear();

          const endpointParams = { method, ...generatedParams };
          const endpointResult = (await registeredTools[endpoint](endpointParams)) as McpResponse;

          let flatResult: McpResponse;
          if (handler.type === 'logic') {
            if (handler.fn === 'getNodeInfoLogic') {
              flatResult = await getNodeInfoLogic(sharedBridge, { nodeId: generatedParams.nodeId as string });
            } else if (handler.fn === 'searchNodesLogic') {
              flatResult = await searchNodesLogic(sharedBridge, {
                query: generatedParams.query as string,
                types: generatedParams.types as string[] | undefined,
                limit: generatedParams.limit as number | undefined,
              });
            } else {
              flatResult = await listLibraryComponentsLogic(sharedBridge, {
                fileKey: generatedParams.fileKey as string | undefined,
              });
            }
          } else {
            flatResult = await bridgeRequestLogic(sharedBridge, handler.bridgeMethod, generatedParams);
          }

          expect(endpointResult.content).toEqual(flatResult.content);
          expect(endpointResult.isError).toEqual(flatResult.isError);
        },
      ),
      { numRuns: 100 },
    );
  });
});
