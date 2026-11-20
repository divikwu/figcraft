# Code Mode

Code Mode exposes every FigCraft tool through a few MCP tools instead of one MCP tool per operation:

| Tool | What it does |
|------|--------------|
| `search` | Finds tools by keyword or name and returns compact TypeScript-style signatures of `figcraft.<tool>(args)` |
| `execute` | Runs an async JavaScript function in a sandbox. The code can call **read-only** tools and endpoint methods, and only the returned value goes back to the model |
| `execute_write` | Same as `execute`, but the code may also call tools and methods that **modify** the document |

The idea comes from Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode-mcp/). It reduces token usage in two ways:

1. **Tool definitions.** The client no longer loads dozens of JSON schemas into the context window. The agent looks up only the signatures it needs.
2. **Intermediate results.** Multi-step work (inspect → lint → fix → verify, or loops over many nodes) runs inside one call. Node trees and lint reports stay in the sandbox, and only the filtered result reaches the model.

## Enabling

```env
FIGCRAFT_CODE_MODE=only   # Code Mode tools + export_image only (smallest context)
FIGCRAFT_CODE_MODE=on     # classic tools + Code Mode tools
FIGCRAFT_CODE_MODE=off    # default: classic tools only
```

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "node",
      "args": ["dist/mcp-server/index.js"],
      "cwd": "/path/to/figcraft",
      "env": { "FIGCRAFT_CODE_MODE": "only" }
    }
  }
}
```

Optional limits:

| Variable | Default | Meaning |
|----------|---------|---------|
| `FIGCRAFT_CODE_MODE_TIMEOUT_MS` | `60000` | Default wall-clock limit per execution (the agent can pass `timeoutMs`, max 600000) |
| `FIGCRAFT_CODE_MODE_MAX_CALLS` | `200` | Max `figcraft.*` calls accepted per execution |
| `FIGCRAFT_CODE_MODE_MAX_PARALLEL` | `4` | Max tool calls running at once; extra calls are queued |
| `FIGCRAFT_CODE_MODE_MAX_OUTPUT` | `24000` | Character budget for the returned value (≈ 6k tokens); larger results are truncated structurally |

## Approvals and permissions

Code Mode keeps reads and writes in separate MCP tools, so IDE approval prompts and tool annotations stay meaningful:

- `execute` is annotated `readOnlyHint: true`. Approving it, or auto-approving it, never authorizes changes. A call to a write tool, a write endpoint method (e.g. `nodes({ method: "delete" })`) or a tool with outside side effects rejects inside the code.
- `execute_write` is annotated `destructiveHint: true`. Treat its approval like approving every write tool at once: **don't auto-approve it** unless you would auto-approve all FigCraft write tools.
- A few tools are routed to `execute_write` even though `schema/tools.yaml` doesn't mark them as document writes, because their side effects reach outside the read-only contract: `reverse_sync_tokens` (writes a local file), `figma_login`, `figma_logout`, `save_version_history` and `join_channel`.
- `execute_js` (raw Plugin API) is **never** callable from Code Mode. It stays behind its explicit `load_toolset('debug')` opt-in.
- `FIGCRAFT_ACCESS` still applies: blocked tools are not exposed, and endpoint method checks still run. With `FIGCRAFT_ACCESS=read`, `execute_write` only exists if some side-effect tool is still allowed.

## Design workflow and harness

- **Preflight.** The `design-preflight` guard requires `get_mode` before `create_frame` / `create_text` / `create_svg`, and the `_workflow` it returns asks the agent to present a proposal and wait for the user's confirmation. Code Mode enforces that step: if `get_mode` is called in an execution, UI creation in the **same** execution rejects. The agent must return the workflow, confirm with the user, then create in a separate call.
- **Harness notes.** `_nextSteps`, `_warnings`, `_verificationDebt` and `_tokenBindingFailures` from every call are collected and always appended to the result under `--- harness notes ---`, even if the code doesn't return them.

## Results, errors and images

Each `figcraft.<tool>(args)` call:

- takes the same arguments as the MCP tool and is validated against the same Zod schema;
- runs the same handler as a regular MCP call, so the harness pipeline, Opinion Engine and `FIGCRAFT_ACCESS` checks still apply;
- resolves to the parsed JSON result, or **rejects** with an `Error` when the tool fails: either an `isError` response or an in-band `{ ok: false, error }` result.

Calls are not transactional: earlier writes stay applied if a later call fails.

Image results (e.g. `export_image`, `verify_design`) become `{ _image: "img_N" }` handles. Return a handle (or an object containing it) and the image is attached to the response, up to 4 per execution. In `only` mode, `export_image` also stays available as a classic tool.

If a run ends while calls are still in flight (timeout, cancellation, or code that returned without awaiting), the sandbox is stopped, queued calls are dropped, and the abort signal passed to tool handlers fires. In-flight calls are then awaited for up to 35 seconds and listed with their outcome (`completed` / `failed` / `still running`), so the agent can check the document instead of blindly retrying a write that actually happened.

## Footprint

Measured on the current tool registry by serializing the `tools/list` payload with a Zod → JSON Schema conversion close to the SDK's. Token figures are estimates at ~4 characters per token.

| Configuration | Tools listed | `tools/list` size | ≈ tokens |
|---------------|-------------:|------------------:|---------:|
| Classic, default (core + meta tools) | 47 | ~68.6k chars | ~17.2k |
| Classic, all toolsets loaded | 123 | ~126.5k chars | ~31.6k |
| `FIGCRAFT_CODE_MODE=only` | 4 | ~6.2k chars | ~1.6k |

The `execute` / `execute_write` descriptions contain a name-only index of the callable tools, so the agent knows what exists without loading any schema. Savings on responses depend on the workflow: they grow with the number of chained calls and the size of the intermediate data.

## Sandbox

- The code runs in a dedicated **worker thread** with its own heap limit and an empty `env`. Its stdout and stderr are captured, so nothing can write to the MCP stdio stream. The worker is terminated at the timeout or when the MCP request is cancelled.
- Inside the worker, the code runs in a fresh **`vm` context** with string and WebAssembly code generation disabled (no `eval`, no `new Function`). The context has no `process`, `require`, `fetch`, timers or filesystem. The only host functions live in a bootstrap closure, and every value that crosses the boundary is a JSON string, so user code never holds a host-realm object.
- The only side effects available are `figcraft.*` calls, dispatched on the main thread. Some tools themselves read local files within their own existing path restrictions (e.g. local images, HTML import) or write one (`reverse_sync_tokens`, `execute_write` only), exactly as they do as classic tools.

This is defense in depth for code written by your own agent. It is not a hardened multi-tenant boundary.

## Implementation

| File | Role |
|------|------|
| `packages/core-mcp/src/tools/code-mode/catalog.ts` | Records tool registrations during `registerAllTools()`, validates arguments, renders TypeScript signatures |
| `packages/core-mcp/src/tools/code-mode/sandbox.ts` | Worker + `vm` sandbox, tool-call bridge, parallelism and call limits, in-flight call reporting |
| `packages/core-mcp/src/tools/code-mode/index.ts` | `search` / `execute` / `execute_write`, read/write routing, preflight, harness notes, images, `FIGCRAFT_CODE_MODE` handling |
| `tests/core-mcp/code-mode.test.ts` | Unit tests (catalog, sandbox isolation and limits, read/write split, preflight, harness notes, images) |

Recording wraps `server.tool` / `server.registerTool` only while `registerAllTools()` runs, then restores them. It reads nothing from the SDK's private registry.
