/**
 * Bug condition exploration tests for Bridge connection resilience.
 *
 * These tests are EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
 *
 * Bug 1: request() only calls waitForConnection() when disconnected, never connect().
 * Bug 2: Eviction (code 4001) leaves bridge permanently dead — no scheduleReconnect().
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockEventHandler = (...args: unknown[]) => void;

// Store event handlers registered by each WebSocket instance
let wsInstances: Array<{
  handlers: Record<string, MockEventHandler>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}>;

// Mock the 'ws' module so Bridge constructor doesn't open real sockets
vi.mock('ws', () => {
  class MockWebSocket {
    handlers: Record<string, MockEventHandler> = {};
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    removeAllListeners = vi.fn();
    readyState = 1;

    on = vi.fn((event: string, handler: MockEventHandler) => {
      this.handlers[event] = handler;
    });

    constructor() {
      wsInstances.push(this as any);
    }
  }
  return { default: MockWebSocket };
});

// Mock figma-api and auth to avoid real network/file calls
vi.mock('../../packages/core-mcp/src/figma-api.js', () => ({
  fetchFileName: vi.fn(),
}));
vi.mock('../../packages/core-mcp/src/auth.js', () => ({
  saveBridgeToken: vi.fn(),
}));

import { Bridge } from '../../packages/core-mcp/src/bridge.js';

describe('Bug Condition Exploration: Bridge reconnection', () => {
  beforeEach(() => {
    wsInstances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * **Validates: Requirements 1.1, 1.3, 2.1**
   *
   * Property 1: Disconnected request() fails without active reconnection.
   *
   * For any non-empty method name, when bridge is disconnected (isConnected == false)
   * and intentionalDisconnect is false, calling request(method) should trigger
   * connect() + discoverPluginChannel() — i.e., active reconnection.
   *
   * On UNFIXED code: request() only calls waitForConnection() which passively waits.
   * connect() is never called, so this test will FAIL.
   */
  it('request() should call connect() when disconnected (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (method) => {
          const bridge = new Bridge('ws://localhost:3055', 'test-channel');

          // Set bridge to disconnected state (simulating a dropped connection)
          (bridge as any).connected = false;
          (bridge as any).intentionalDisconnect = false;
          (bridge as any).ws = null;

          // Spy on connect() — mock it to "succeed" by setting connected = true
          const connectSpy = vi.spyOn(bridge, 'connect').mockImplementation(async () => {
            (bridge as any).connected = true;
            (bridge as any).ws = {
              send: vi.fn(),
              on: vi.fn(),
              close: vi.fn(),
              terminate: vi.fn(),
              removeAllListeners: vi.fn(),
            };
          });

          const discoverSpy = vi.spyOn(bridge, 'discoverPluginChannel').mockResolvedValue();

          // Call request() — on unfixed code this will passively wait via
          // waitForConnection(10_000) and never call connect()
          const requestPromise = bridge.request(method, {}).catch(() => {
            // Swallow "Bridge not connected" — expected on unfixed code
          });

          // Advance timers past the waitForConnection timeout
          await vi.advanceTimersByTimeAsync(11_000);

          await requestPromise;

          // The key assertion: connect() SHOULD have been called.
          // On unfixed code, it won't be — proving the bug.
          expect(connectSpy).toHaveBeenCalled();

          connectSpy.mockRestore();
          discoverSpy.mockRestore();
        },
      ),
      { numRuns: 10 },
    );
  });

  /**
   * **Validates: Requirements 1.2, 2.2**
   *
   * Property 2: Eviction (code 4001) intentionally does NOT reconnect.
   *
   * When a WebSocket close event fires with code 4001 (same_role_eviction),
   * the bridge MUST NOT call scheduleReconnect(). Reconnecting would evict
   * the other instance, creating an infinite eviction loop. Instead the bridge
   * marks itself as evicted and rejects all pending requests.
   */
  it('eviction (code 4001) should NOT schedule a reconnect (avoids eviction loop)', async () => {
    const bridge = new Bridge('ws://localhost:3055', 'test-channel');

    // Call connect() to register event handlers on the mock WebSocket
    const connectPromise = bridge.connect();

    // Get the mock ws instance created during connect()
    const wsInstance = wsInstances[wsInstances.length - 1];
    expect(wsInstance).toBeDefined();

    // Trigger the 'open' handler to complete the connection
    wsInstance.handlers.open();
    await connectPromise;

    expect(bridge.isConnected).toBe(true);

    // Spy on the private scheduleReconnect method
    const scheduleReconnectSpy = vi.spyOn(bridge as any, 'scheduleReconnect');

    // Simulate eviction: fire close with code 4001
    wsInstance.handlers.close(4001, Buffer.from('same_role_eviction'));

    // scheduleReconnect() should NOT be called — eviction is intentionally terminal
    expect(scheduleReconnectSpy).not.toHaveBeenCalled();
    expect(bridge.isConnected).toBe(false);
    expect((bridge as any).evicted).toBe(true);

    scheduleReconnectSpy.mockRestore();
  });
});

describe('Preservation: Baseline behavior that must be unchanged after fix', () => {
  beforeEach(() => {
    wsInstances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper: create a Bridge, connect it via mock WebSocket, and return both.
   * After this, bridge.isConnected === true and ws.send is available.
   */
  async function createConnectedBridge() {
    const bridge = new Bridge('ws://localhost:3055', 'test-channel');
    const connectPromise = bridge.connect();
    const wsInstance = wsInstances[wsInstances.length - 1];
    // Complete the handshake
    wsInstance.handlers.open();
    await connectPromise;
    // Clear the join messages sent during connect
    wsInstance.send.mockClear();
    return { bridge, wsInstance };
  }

  /**
   * **Validates: Requirements 3.1, 3.5**
   *
   * Property 2a: Connected requests go through immediately.
   *
   * For all non-empty method names, when bridge is connected (isConnected == true),
   * request() sends immediately via WebSocket without calling connect() or
   * discoverPluginChannel(). This preserves the fast path with zero reconnection overhead.
   */
  it('connected request() sends immediately without reconnection overhead (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (method) => {
          const { bridge, wsInstance } = await createConnectedBridge();

          const connectSpy = vi.spyOn(bridge, 'connect');
          const discoverSpy = vi.spyOn(bridge, 'discoverPluginChannel');

          // Start the request — it should send immediately since bridge is connected
          const requestPromise = bridge.request(method, { foo: 'bar' });

          // ws.send should have been called synchronously (the request message)
          expect(wsInstance.send).toHaveBeenCalledTimes(1);

          // Parse the sent message to verify it contains our method
          const sentPayload = JSON.parse(wsInstance.send.mock.calls[0][0]);
          expect(sentPayload.method).toBe(method);
          expect(sentPayload.type).toBe('request');

          // connect() and discoverPluginChannel() should NOT have been called
          expect(connectSpy).not.toHaveBeenCalled();
          expect(discoverSpy).not.toHaveBeenCalled();

          // Simulate a response so the request resolves and doesn't leak timers
          const responseId = sentPayload.id;
          wsInstance.handlers.message(JSON.stringify({ type: 'response', id: responseId, result: { ok: true } }));

          const result = await requestPromise;
          expect(result).toEqual({ ok: true });

          connectSpy.mockRestore();
          discoverSpy.mockRestore();
          bridge.disconnect();
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * **Validates: Requirement 3.4**
   *
   * Property 2b: Intentional disconnect is respected.
   *
   * For all non-empty method names, when intentionalDisconnect is true (after
   * bridge.disconnect()), request() fails with "Bridge not connected" immediately
   * without attempting reconnection via connect().
   */
  it('request() after disconnect() fails without reconnection attempt (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (method) => {
          const { bridge } = await createConnectedBridge();

          // Intentionally disconnect
          bridge.disconnect();
          expect(bridge.isConnected).toBe(false);

          const connectSpy = vi.spyOn(bridge, 'connect');

          // request() should fail — catch the rejection immediately to avoid unhandled warnings.
          // disconnect() already called notifyConnectionWaiters(), so waitForConnection()
          // resolves immediately and request() throws synchronously after the await.
          const requestPromise = bridge.request(method, {}).then(
            () => {
              throw new Error('Expected request to reject');
            },
            (err: Error) => err,
          );

          // Advance timers to ensure any pending waitForConnection timers resolve
          await vi.advanceTimersByTimeAsync(11_000);

          const error = await requestPromise;
          expect(error.message).toBe('Bridge not connected');

          // connect() should NOT have been called — intentional disconnect is respected
          expect(connectSpy).not.toHaveBeenCalled();

          connectSpy.mockRestore();
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * **Validates: Requirement 3.6**
   *
   * Property 2c: Exponential backoff strategy preserved for non-eviction disconnects.
   *
   * When a WebSocket closes with a non-4001 code, scheduleReconnect() IS called
   * and uses exponential backoff. This behavior must be preserved after the fix.
   */
  it('non-eviction close triggers scheduleReconnect with exponential backoff', async () => {
    const { bridge, wsInstance } = await createConnectedBridge();

    const scheduleReconnectSpy = vi.spyOn(bridge as any, 'scheduleReconnect');

    // Simulate a normal (non-eviction) close — e.g. code 1006 (abnormal closure)
    wsInstance.handlers.close(1006, Buffer.from('connection lost'));

    // scheduleReconnect() SHOULD be called for non-eviction disconnects
    expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected).toBe(false);

    // Verify the reconnect timer was set (reconnectTimer is non-null)
    expect((bridge as any).reconnectTimer).not.toBeNull();

    // Verify reconnectAttempts was incremented (backoff tracking)
    expect((bridge as any).reconnectAttempts).toBe(1);

    scheduleReconnectSpy.mockRestore();
    bridge.disconnect();
  });
});
