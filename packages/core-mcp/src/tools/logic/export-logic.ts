/**
 * Export logic functions — extracted from export.ts server.tool() callbacks.
 * Used by endpoint tools for image export operations.
 */

import type { Bridge } from '../../bridge.js';
import { requestWithFallback, restExportImage } from '../../rest-fallback.js';
import type { McpResponse } from './node-logic.js';

/** MIME types safe for MCP image content blocks (Claude API whitelist). */
const RASTER_MIME: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
};

export async function exportImageLogic(
  bridge: Bridge,
  params: { nodeId: string; format?: string; scale?: number },
): Promise<McpResponse> {
  const { result, source } = await requestWithFallback(
    bridge,
    'export_image',
    { nodeId: params.nodeId, format: params.format, scale: params.scale },
    () => restExportImage(params.nodeId, params.format, params.scale),
  );
  const r = result as { format?: string; size?: number; base64?: string };

  // Plugin path with base64 data — return inline image or text depending on format
  if (source !== 'rest-api' && r.base64) {
    const fmt = (r.format ?? 'PNG').toUpperCase();
    const mimeType = RASTER_MIME[fmt];

    if (mimeType) {
      // PNG/JPG — safe to return as image content block
      return {
        content: [
          { type: 'image' as const, data: r.base64, mimeType },
          { type: 'text' as const, text: `{"format":"${r.format}","size":${r.size ?? 0}}` },
        ],
      };
    }

    // SVG/PDF — cannot use image content block (Claude API rejects non-raster MIME types
    // with a 400 error that breaks the session). Omit base64 from text to avoid
    // flooding the context window — the data is not actionable by the Agent.
    return {
      content: [
        {
          type: 'text' as const,
          text: `{"format":"${r.format}","size":${r.size ?? 0},"_note":"${fmt} exported successfully (${r.size ?? 0} bytes). This format cannot be previewed inline — use PNG or JPG for visual preview. To deliver the file to the user, re-export with format PNG."}`,
        },
      ],
    };
  }

  // REST fallback or missing base64: text only
  const text =
    source === 'rest-api'
      ? `${JSON.stringify(result, null, 2)}\n\n⚠️ Exported via REST API (plugin offline).`
      : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}
