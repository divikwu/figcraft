/**
 * Export tool — export Figma node as image (PNG/SVG/PDF/JPG).
 * Supports REST API fallback when plugin is offline.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { exportImageLogic } from './logic/export-logic.js';

export function registerExportTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'export_image',
    'Export a Figma node as an image. Returns base64-encoded image data. ' +
      'Only PNG and JPG can be previewed inline in chat. ' +
      'SVG and PDF are returned as base64 text data — use PNG for visual preview.',
    {
      nodeId: z.string().describe('The node ID to export'),
      format: z.enum(['PNG', 'SVG', 'PDF', 'JPG']).optional().describe('Export format (default: PNG)'),
      scale: z.number().optional().describe('Export scale for raster formats (default: 2)'),
    },
    async ({ nodeId, format, scale }) => {
      return exportImageLogic(bridge, { nodeId, format, scale });
    },
  );
}
