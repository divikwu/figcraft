/**
 * Code Mode sandbox — runs model-written JavaScript that calls FigCraft tools.
 *
 * Isolation layers:
 *   1. A dedicated worker thread (killable on timeout, own heap limit, empty env,
 *      stdout/stderr captured so nothing can corrupt the MCP stdio transport).
 *   2. Inside the worker, a fresh `vm` context with string/wasm code generation
 *      disabled (no eval / new Function) and NO host objects reachable from user
 *      code: the only host functions live in a bootstrap closure, and every value
 *      crossing the boundary is a JSON string.
 *   3. The only side effects available to user code are calls to `figcraft.<tool>()`,
 *      which the main thread dispatches to the same tool handlers (and the same
 *      FIGCRAFT_ACCESS checks) as regular MCP calls, with bounded parallelism. When a
 *      run ends, in-flight calls get an abort signal and are awaited (bounded) so
 *      their outcome can be reported instead of silently landing later.
 *
 * This is defense in depth, not a hardened multi-tenant boundary: it is designed
 * for code written by the user's own agent, at the same trust level as the
 * existing `execute_js` tool.
 */

import { Worker } from 'node:worker_threads';

export interface SandboxOptions {
  /** Wall-clock limit for the whole run, including tool calls. */
  timeoutMs: number;
  /** Maximum number of figcraft.<tool>() calls accepted per run. */
  maxToolCalls: number;
  /** Maximum number of tool calls running at the same time (extra calls are queued). Default 4. */
  maxParallelCalls?: number;
  /**
   * After the run ends (timeout, cancellation, crash, or code that returned without awaiting),
   * how long to wait for tool calls already dispatched so their outcome can be reported. Default 35s,
   * slightly above the bridge's 30s request timeout.
   */
  settleTimeoutMs?: number;
  /** Heap limit for the worker (MB). */
  memoryMb?: number;
  /** Tool names exposed on the `figcraft` namespace. */
  toolNames: string[];
  /**
   * Dispatch a tool call. Receives the JSON-encoded arguments and a signal that aborts when the
   * run ends; resolves to the JSON-encoded result (or undefined). Reject to make the call reject
   * in the sandbox.
   */
  callTool: (name: string, argsJson: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Abort the run (e.g. MCP request cancelled). */
  signal?: AbortSignal;
}

/** A tool call that was still running when the run ended, and what happened to it afterwards. */
export interface LateCall {
  name: string;
  status: 'completed' | 'failed' | 'still running';
}

type SandboxOutcome = { ok: true; resultJson: string | undefined } | { ok: false; error: string };

export type SandboxResult = SandboxOutcome & {
  logs: string[];
  /** Tool calls actually dispatched to tool handlers. */
  toolCalls: number;
  /** Calls in flight when the run ended (they may have changed the document after the run ended). */
  lateCalls: LateCall[];
  /** Calls that were queued but never dispatched because the run ended. */
  droppedCalls: number;
  durationMs: number;
};

const MAX_LOG_LINES = 50;
const MAX_LOG_CHARS = 4_000;

/**
 * Bootstrap evaluated inside the vm context. It receives host functions as
 * arguments and keeps them in its closure; user code only ever sees objects
 * created by this context.
 */
const CONTEXT_BOOTSTRAP = String.raw`
(function (hostCall, hostLog, hostDone, toolNamesJson) {
  'use strict';
  var toolNames = JSON.parse(toolNamesJson);
  var known = Object.create(null);
  var api = Object.create(null);
  toolNames.forEach(function (name) {
    known[name] = true;
    api[name] = function (args) {
      var json;
      try {
        json = JSON.stringify(args === undefined ? {} : args);
      } catch (e) {
        return Promise.reject(new TypeError('Arguments for figcraft.' + name + ' must be JSON-serializable'));
      }
      return new Promise(function (resolve, reject) {
        hostCall(name, json === undefined ? '{}' : json, function (err, out) {
          if (err !== null) {
            var error = new Error(err);
            error.tool = name;
            reject(error);
          } else {
            resolve(out === undefined ? undefined : JSON.parse(out));
          }
        });
      });
    };
  });
  var figcraft = new Proxy(Object.freeze(api), {
    get: function (target, prop) {
      if (typeof prop === 'string' && !known[prop] && prop !== 'then') {
        return function () {
          return Promise.reject(
            new Error('Unknown tool "figcraft.' + prop + '". Use the search tool to find available tools.'),
          );
        };
      }
      return target[prop];
    },
  });
  function fmt(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function log() {
    hostLog(Array.prototype.map.call(arguments, fmt).join(' '));
  }
  Object.defineProperty(globalThis, 'figcraft', { value: figcraft, enumerable: true });
  Object.defineProperty(globalThis, 'console', {
    value: Object.freeze({ log: log, info: log, warn: log, error: log, debug: log }),
    enumerable: true,
  });
  function describeError(e) {
    if (e && typeof e === 'object' && typeof e.message === 'string') {
      var head = (e.name || 'Error') + ': ' + e.message;
      // Keep only frames that point into the user's code (line:column is useful for fixing it).
      var frames = typeof e.stack === 'string'
        ? e.stack.split('\n').filter(function (l) { return l.indexOf('figcraft-code.js') !== -1; }).slice(0, 3)
        : [];
      return frames.length ? head + '\n' + frames.join('\n') : head;
    }
    return String(e);
  }
  return function run(fn) {
    if (typeof fn !== 'function') {
      hostDone('code must evaluate to a function, e.g. async () => { ... }', undefined);
      return;
    }
    Promise.resolve()
      .then(function () { return fn(); })
      .then(
        function (value) {
          var out;
          try {
            out = value === undefined ? undefined : JSON.stringify(value);
          } catch (e) {
            hostDone('Return value is not JSON-serializable: ' + describeError(e), undefined);
            return;
          }
          hostDone(null, out);
        },
        function (e) { hostDone(describeError(e), undefined); },
      );
  };
})
`;

/** Worker entry (CommonJS, evaluated with `eval: true`). */
const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

const callbacks = new Map();
let seq = 0;
let finished = false;

function post(msg) { parentPort.postMessage(msg); }

function hostCall(name, argsJson, cb) {
  const id = ++seq;
  callbacks.set(id, cb);
  post({ type: 'call', id: id, name: String(name), args: String(argsJson) });
}
function hostLog(line) { post({ type: 'log', line: String(line) }); }
function hostDone(error, resultJson) {
  if (finished) return;
  finished = true;
  post({ type: 'done', error: error === null ? null : String(error), result: resultJson === undefined ? undefined : String(resultJson) });
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'result') return;
  const cb = callbacks.get(msg.id);
  if (!cb) return;
  callbacks.delete(msg.id);
  cb(typeof msg.error === 'string' ? msg.error : null, typeof msg.result === 'string' ? msg.result : undefined);
});

try {
  const context = vm.createContext(Object.create(null), {
    name: 'figcraft-code-mode',
    codeGeneration: { strings: false, wasm: false },
  });
  const bootstrap = vm.runInContext(${JSON.stringify(CONTEXT_BOOTSTRAP)}, context, { filename: 'figcraft-bootstrap.js' });
  const run = bootstrap(hostCall, hostLog, hostDone, JSON.stringify(workerData.toolNames));
  const fn = vm.runInContext('(' + workerData.code + '\n)', context, {
    filename: 'figcraft-code.js',
    timeout: workerData.syncTimeoutMs,
  });
  run(fn);
} catch (e) {
  hostDone((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)), undefined);
}
`;

/** Run `code` (an async arrow function expression) in the sandbox. */
export function runInSandbox(code: string, options: SandboxOptions): Promise<SandboxResult> {
  const started = Date.now();
  const logs: string[] = [];
  const maxParallel = Math.max(1, options.maxParallelCalls ?? 4);
  const settleTimeoutMs = options.settleTimeoutMs ?? 35_000;
  const runAbort = new AbortController();
  let logChars = 0;
  let accepted = 0;
  let dispatched = 0;

  interface QueuedCall {
    id: number;
    name: string;
    args: string;
  }
  const queue: QueuedCall[] = [];
  const running = new Map<number, { name: string; done: Promise<'completed' | 'failed'> }>();

  return new Promise<SandboxResult>((resolve) => {
    let ended = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        code,
        toolNames: options.toolNames,
        syncTimeoutMs: Math.min(options.timeoutMs, 5_000),
      },
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: options.memoryMb ?? 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    // Drain captured stdio so the worker never blocks on a full pipe.
    worker.stdout?.resume();
    worker.stderr?.resume();

    const pump = () => {
      while (!ended && running.size < maxParallel && queue.length > 0) {
        const call = queue.shift()!;
        dispatched++;
        const done = options.callTool(call.name, call.args, runAbort.signal).then(
          (result) => {
            if (!ended) worker.postMessage({ type: 'result', id: call.id, result });
            return 'completed' as const;
          },
          (err: unknown) => {
            if (!ended) {
              const error = err instanceof Error ? err.message : String(err);
              worker.postMessage({ type: 'result', id: call.id, error });
            }
            return 'failed' as const;
          },
        );
        running.set(call.id, { name: call.name, done });
        void done.finally(() => {
          running.delete(call.id);
          pump();
        });
      }
    };

    const end = (outcome: SandboxOutcome) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      runAbort.abort();
      const droppedCalls = queue.length;
      queue.length = 0;
      const inFlight = [...running.values()];
      const report = (lateCalls: LateCall[]) =>
        resolve({ ...outcome, logs, toolCalls: dispatched, lateCalls, droppedCalls, durationMs: Date.now() - started });
      if (inFlight.length === 0) {
        report([]);
        return;
      }
      // Calls already sent to the plugin may still apply changes: wait (bounded) and report them,
      // so the agent doesn't retry a write that actually happened.
      const statuses: LateCall[] = inFlight.map((c) => ({ name: c.name, status: 'still running' }));
      const settled = Promise.all(
        inFlight.map((c, i) =>
          c.done.then((status) => {
            statuses[i] = { name: c.name, status };
          }),
        ),
      );
      let settleTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((r) => {
        settleTimer = setTimeout(r, settleTimeoutMs);
      });
      void Promise.race([settled, grace]).then(() => {
        clearTimeout(settleTimer);
        report(statuses);
      });
    };

    const timer = setTimeout(() => {
      end({ ok: false, error: `Execution timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);

    const onAbort = () => end({ ok: false, error: 'Execution cancelled' });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg: { type: string; [k: string]: unknown }) => {
      if (ended) return;
      if (msg.type === 'log') {
        const line = String(msg.line);
        if (logs.length < MAX_LOG_LINES && logChars < MAX_LOG_CHARS) {
          const room = MAX_LOG_CHARS - logChars;
          const kept = line.length > room ? `${line.slice(0, room)}…` : line;
          logs.push(kept);
          logChars += kept.length;
        }
        return;
      }
      if (msg.type === 'call') {
        const id = msg.id as number;
        if (accepted >= options.maxToolCalls) {
          worker.postMessage({
            type: 'result',
            id,
            error: `Tool-call limit reached (${options.maxToolCalls} per execution). Split the work into several executions.`,
          });
          return;
        }
        accepted++;
        queue.push({ id, name: String(msg.name), args: String(msg.args) });
        pump();
        return;
      }
      if (msg.type === 'done') {
        if (typeof msg.error === 'string') end({ ok: false, error: msg.error });
        else end({ ok: true, resultJson: msg.result as string | undefined });
      }
    });

    worker.on('error', (err: Error) => {
      const code = (err as { code?: string }).code;
      end({
        ok: false,
        error: code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Execution exceeded the sandbox memory limit' : err.message,
      });
    });
    worker.on('exit', () => end({ ok: false, error: 'Sandbox exited before the code finished' }));
  });
}
