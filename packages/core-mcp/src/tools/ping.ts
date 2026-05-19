/**
 * Ping tool — verifies MCP Server ↔ Relay ↔ Plugin connectivity.
 * Includes version mismatch detection and step-by-step diagnostics.
 */

import { VERSION as SERVER_VERSION } from '@figcraft/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { setFileContext } from '../rest-fallback.js';
import { diagnosticError } from './connection-diagnostics.js';

export function registerPing(server: McpServer, bridge: Bridge): void {
  server.tool(
    'ping',
    'Test connectivity to the Figma plugin through the WebSocket relay. ' +
      'Returns connection status, round-trip latency, and version check.',
    {
      channel: z.string().optional().describe('Channel ID (defaults to current channel)'),
    },
    async () => {
      // ── Stage 1: Try connecting if not connected (including after eviction) ──
      // Unlike request(), ping is a user-initiated diagnostic tool, so we
      // attempt reconnection even after eviction — the user may have already
      // removed the duplicate MCP config that caused the eviction.
      if (!bridge.isConnected) {
        try {
          await bridge.connect();
          await bridge.discoverPluginChannel();
        } catch {
          // Default relay URL failed — try multi-port discovery before giving up.
          // This handles the case where relay is running on a non-default port
          // (e.g. 3060 instead of 3055 because 3055 was occupied at relay startup).
          try {
            const switched = await bridge.discoverPluginRelay();
            if (switched) {
              await bridge.discoverPluginChannel();
            }
          } catch {
            // Fall through to Stage 2 diagnosis
          }
        }
      }

      // ── Stage 2: If still not connected, diagnose WHY ──
      // At this point, both direct connect and multi-port discovery have been
      // attempted in Stage 1. We only need to classify the failure for the user.
      if (!bridge.isConnected) {
        if (bridge.isEvicted) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(diagnosticError('evicted')) }],
          };
        }
        const probe = await bridge.probeRelay();
        if (!probe.reachable) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(diagnosticError('relay_unreachable')) }],
          };
        }
        if (!probe.pluginConnected) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(diagnosticError('plugin_not_connected')) }],
          };
        }
        // Relay is up and plugin is connected somewhere, but bridge couldn't connect
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(diagnosticError('plugin_not_responding')) }],
        };
      }

      // ── Stage 3: Connected — send ping to plugin ──
      const start = Date.now();
      try {
        const result = (await bridge.request('ping', {})) as Record<string, unknown>;
        return buildSuccessResponse(result, Date.now() - start);
      } catch (err) {
        // Ping failed — try auto-discovering the correct channel and retry
        try {
          await bridge.discoverPluginChannel();
          const retryStart = Date.now();
          const retryResult = (await bridge.request('ping', {})) as Record<string, unknown>;
          return buildSuccessResponse(retryResult, Date.now() - retryStart, bridge.currentChannel);
        } catch {
          // Auto-discovery also failed — diagnose
        }

        // Connected to relay but plugin not responding
        const probe = await bridge.probeRelay();
        if (probe.pluginConnected) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  diagnosticError('plugin_not_responding', err instanceof Error ? err.message : String(err)),
                ),
              },
            ],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(diagnosticError('plugin_not_connected')) }],
        };
      }
    },
  );
}

function buildSuccessResponse(result: Record<string, unknown>, latencyMs: number, autoSwitchedChannel?: string) {
  const pluginVersion = result.pluginVersion as string | undefined;
  let versionWarning: string | undefined;
  if (pluginVersion && pluginVersion !== SERVER_VERSION) {
    versionWarning = `Version mismatch: MCP Server ${SERVER_VERSION}, Plugin ${pluginVersion}. Please rebuild the plugin.`;
  }

  // Cache file context for REST API fallback
  const fileKey = result.fileKey as string | undefined;
  const documentName = result.documentName as string | undefined;
  if (fileKey && documentName) {
    setFileContext(fileKey, documentName);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          connected: true,
          latency: `${latencyMs}ms`,
          serverVersion: SERVER_VERSION,
          pluginVersion: pluginVersion ?? 'unknown',
          ...(versionWarning ? { versionWarning } : {}),
          ...(autoSwitchedChannel ? { _channelAutoSwitched: autoSwitchedChannel } : {}),
          _hint: autoSwitchedChannel
            ? 'Connection OK (auto-switched channel). Proceed with your task.'
            : 'Connection OK. Proceed with your task — do NOT stop here.',
          result,
        }),
      },
    ],
  };
}
