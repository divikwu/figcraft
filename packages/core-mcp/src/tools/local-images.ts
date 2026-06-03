/**
 * Local image tools — read local PNG/JPEG/GIF files in the MCP Server and send
 * base64 bytes to the Figma Plugin, which applies them as image fills.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, normalize, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { jsonResponse } from './response-helpers.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const FIGMA_MAX_IMAGE_DIMENSION = 4096;
const AUTO_PLACE_GAP = 200;

const SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE'] as const;
type ScaleMode = (typeof SCALE_MODES)[number];

export type SupportedLocalImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif';

export interface LocalImageMetadata {
  filePath: string;
  originalPath: string;
  name: string;
  mimeType: SupportedLocalImageMimeType;
  byteLength: number;
  originalWidth: number;
  originalHeight: number;
  base64: string;
}

export class LocalImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalImageError';
  }
}

interface LoadLocalImageOptions {
  maxBytes?: number;
  rootsEnv?: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImagePlacement {
  x?: number;
  y?: number;
  strategy: 'explicit' | 'auto-right' | 'plugin-auto' | 'fallback';
  adjusted: boolean;
  reason?: string;
}

function localImageError(code: string, message: string): LocalImageError {
  return new LocalImageError(code, message);
}

function getMaxBytes(): number {
  const raw = process.env.FIGCRAFT_LOCAL_IMAGE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function parseAllowedRoots(rootsEnv = process.env.FIGCRAFT_LOCAL_IMAGE_ROOTS): string[] {
  if (!rootsEnv?.trim()) return [];
  return rootsEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalize(entry));
}

function isWithinRoot(filePath: string, root: string): boolean {
  const normalizedRoot = normalize(root);
  if (filePath === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return filePath.startsWith(rootWithSep);
}

function assertPathAllowed(filePath: string, rootsEnv?: string): void {
  const roots = parseAllowedRoots(rootsEnv);
  if (roots.length === 0) return;
  if (!roots.some((root) => isWithinRoot(filePath, root))) {
    throw localImageError('PATH_NOT_ALLOWED', `Local image path is outside FIGCRAFT_LOCAL_IMAGE_ROOTS: ${filePath}`);
  }
}

function detectImageMimeType(buffer: Buffer): SupportedLocalImageMimeType {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  throw localImageError('UNSUPPORTED_IMAGE_FORMAT', 'Unsupported image format. Use PNG, JPEG, or GIF.');
}

function readPngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) {
    throw localImageError('IMAGE_DIMENSIONS_UNREADABLE', 'PNG is too small to contain IHDR dimensions.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 10) {
    throw localImageError('IMAGE_DIMENSIONS_UNREADABLE', 'GIF is too small to contain dimensions.');
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readJpegSize(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    let marker = buffer[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < buffer.length) {
      marker = buffer[offset];
      offset++;
    }

    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) {
        throw localImageError('IMAGE_DIMENSIONS_UNREADABLE', 'JPEG SOF segment is too short.');
      }
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  throw localImageError('IMAGE_DIMENSIONS_UNREADABLE', 'Could not read JPEG dimensions.');
}

function readImageSize(buffer: Buffer, mimeType: SupportedLocalImageMimeType): { width: number; height: number } {
  if (mimeType === 'image/png') return readPngSize(buffer);
  if (mimeType === 'image/gif') return readGifSize(buffer);
  return readJpegSize(buffer);
}

function assertFigmaDimensions(width: number, height: number): void {
  if (width < 1 || height < 1) {
    throw localImageError('IMAGE_DIMENSIONS_UNREADABLE', `Invalid image dimensions: ${width}x${height}.`);
  }
  if (width > FIGMA_MAX_IMAGE_DIMENSION || height > FIGMA_MAX_IMAGE_DIMENSION) {
    throw localImageError(
      'IMAGE_DIMENSIONS_TOO_LARGE',
      `Image dimensions ${width}x${height} exceed Figma's ${FIGMA_MAX_IMAGE_DIMENSION}px limit.`,
    );
  }
}

export async function loadLocalImage(
  filePath: string,
  options: LoadLocalImageOptions = {},
): Promise<LocalImageMetadata> {
  if (!isAbsolute(filePath)) {
    throw localImageError('INVALID_PATH', `Local image path must be absolute: ${filePath}`);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    throw localImageError('INVALID_PATH', `Local image path does not exist: ${filePath}`);
  }

  assertPathAllowed(resolvedPath, options.rootsEnv);

  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw localImageError('INVALID_PATH', `Local image path is not a file: ${resolvedPath}`);
  }

  const maxBytes = options.maxBytes ?? getMaxBytes();
  if (fileStat.size > maxBytes) {
    throw localImageError(
      'FILE_TOO_LARGE',
      `Local image is ${fileStat.size} bytes, exceeding the ${maxBytes} byte limit.`,
    );
  }

  const buffer = await readFile(resolvedPath);
  if (buffer.byteLength > maxBytes) {
    throw localImageError(
      'FILE_TOO_LARGE',
      `Local image is ${buffer.byteLength} bytes, exceeding the ${maxBytes} byte limit.`,
    );
  }
  const mimeType = detectImageMimeType(buffer);
  const dimensions = readImageSize(buffer, mimeType);
  assertFigmaDimensions(dimensions.width, dimensions.height);

  const ext = extname(resolvedPath);
  return {
    filePath: resolvedPath,
    originalPath: filePath,
    name: basename(resolvedPath, ext),
    mimeType,
    byteLength: buffer.byteLength,
    originalWidth: dimensions.width,
    originalHeight: dimensions.height,
    base64: buffer.toString('base64'),
  };
}

function scaledDimension(value: number, explicit: number | undefined, scale: number | undefined): number {
  if (explicit != null) return explicit;
  const factor = scale ?? 1;
  return Math.max(1, Math.round(value * factor));
}

function sourceMetadata(image: LocalImageMetadata): Record<string, unknown> {
  return {
    filePath: image.filePath,
    mimeType: image.mimeType,
    byteLength: image.byteLength,
    originalWidth: image.originalWidth,
    originalHeight: image.originalHeight,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rectFromNode(node: Record<string, unknown>): Rect | null {
  if (node.visible === false) return null;
  const x = finiteNumber(node.x);
  const y = finiteNumber(node.y);
  const width = finiteNumber(node.width);
  const height = finiteNumber(node.height);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function autoRightPlacement(rects: Rect[]): { x: number; y: number } {
  if (rects.length === 0) return { x: 0, y: 0 };
  const maxRight = Math.max(...rects.map((rect) => rect.x + rect.width));
  return { x: Math.round(maxRight + AUTO_PLACE_GAP), y: 0 };
}

async function resolveImagePlacement(
  bridge: Bridge,
  params: {
    parentId?: string;
    x?: number;
    y?: number;
    width: number;
    height: number;
    avoidOverlap?: boolean;
  },
): Promise<ImagePlacement> {
  const explicitX = params.x != null;
  const explicitY = params.y != null;
  const explicitPlacement = explicitX || explicitY;
  if (params.avoidOverlap === false) {
    return { x: params.x, y: params.y, strategy: explicitPlacement ? 'explicit' : 'plugin-auto', adjusted: false };
  }

  try {
    const page = (await bridge.request(
      'get_current_page',
      { maxDepth: 1, maxNodes: 1000, detail: 'summary' },
      15_000,
      'get_current_page',
      false,
    )) as Record<string, unknown>;
    const pageId = typeof page.id === 'string' ? page.id : undefined;
    const isTopLevelPlacement = !params.parentId || params.parentId === pageId;
    if (!isTopLevelPlacement) {
      return {
        x: params.x,
        y: params.y,
        strategy: explicitPlacement ? 'explicit' : 'plugin-auto',
        adjusted: false,
        reason: explicitPlacement ? undefined : 'parented placement is delegated to create_frame',
      };
    }

    const nodes = Array.isArray(page.nodes) ? (page.nodes as Record<string, unknown>[]) : [];
    const rects = nodes.map(rectFromNode).filter((rect): rect is Rect => rect != null);
    const proposed: Rect = { x: params.x ?? 0, y: params.y ?? 0, width: params.width, height: params.height };
    const overlaps = rects.some((rect) => rectsOverlap(proposed, rect));

    if (!explicitPlacement || overlaps) {
      const next = autoRightPlacement(rects);
      return {
        ...next,
        strategy: 'auto-right',
        adjusted: explicitPlacement,
        reason:
          explicitPlacement && overlaps
            ? 'requested position overlaps existing top-level content'
            : 'default non-overlapping placement',
      };
    }

    return { x: params.x, y: params.y, strategy: 'explicit', adjusted: false };
  } catch (err) {
    return {
      x: params.x,
      y: params.y,
      strategy: explicitPlacement ? 'explicit' : 'fallback',
      adjusted: false,
      reason: err instanceof Error ? `page inspection failed: ${err.message}` : 'page inspection failed',
    };
  }
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof LocalImageError) {
    return { ok: false, code: err.code, error: err.message };
  }
  if (err instanceof Error) {
    return { ok: false, code: 'LOCAL_IMAGE_ERROR', error: err.message };
  }
  return { ok: false, code: 'LOCAL_IMAGE_ERROR', error: String(err) };
}

export function registerLocalImageTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'create_image_frame_from_local',
    'Create a new Figma frame filled with a local PNG/JPEG/GIF image read by the MCP Server. ' +
      'The filePath must be absolute. P0 rejects WebP and images above 4096px in width or height. ' +
      'By default, auto-places to the right of current top-level page content to avoid overlap.',
    {
      filePath: z.string().describe('Absolute path to a local PNG/JPEG/GIF image'),
      parentId: z.string().optional().describe('Optional parent node ID. Defaults to current page.'),
      name: z.string().optional().describe('Frame name. Defaults to the image filename without extension.'),
      x: z
        .number()
        .optional()
        .describe('X position for the created frame. Overlapping positions auto-move unless avoidOverlap=false.'),
      y: z
        .number()
        .optional()
        .describe('Y position for the created frame. Overlapping positions auto-move unless avoidOverlap=false.'),
      width: z.number().positive().optional().describe('Frame width. Defaults to originalWidth * scale.'),
      height: z.number().positive().optional().describe('Frame height. Defaults to originalHeight * scale.'),
      scale: z
        .number()
        .positive()
        .optional()
        .describe('Frame size scale only; does not resize image bytes. Default 1.'),
      scaleMode: z.enum(SCALE_MODES).optional().describe('Image paint scale mode (default FILL)'),
      avoidOverlap: z
        .boolean()
        .optional()
        .describe('Default true. Auto-move to the right of top-level page content when omitted or overlapping.'),
    },
    async ({ filePath, parentId, name, x, y, width, height, scale, scaleMode, avoidOverlap }) => {
      try {
        const image = await loadLocalImage(filePath);
        const frameWidth = scaledDimension(image.originalWidth, width, scale);
        const frameHeight = scaledDimension(image.originalHeight, height, scale);
        const placement = await resolveImagePlacement(bridge, {
          parentId,
          x,
          y,
          width: frameWidth,
          height: frameHeight,
          avoidOverlap,
        });
        const result = (await bridge.request(
          'create_frame',
          {
            imageData: image.base64,
            imageMimeType: image.mimeType,
            name: name ?? image.name,
            parentId,
            x: placement.x,
            y: placement.y,
            width: frameWidth,
            height: frameHeight,
            imageScaleMode: scaleMode ?? 'FILL',
          },
          60_000,
          'create_frame',
          true,
        )) as Record<string, unknown>;
        return jsonResponse({ ...result, source: sourceMetadata(image), placement });
      } catch (err) {
        return { ...jsonResponse(errorPayload(err)), isError: true };
      }
    },
  );

  server.tool(
    'fill_existing_image_from_local',
    'Replace an existing Figma node fill with a local PNG/JPEG/GIF image read by the MCP Server. ' +
      'Requires edit access because it modifies an existing node.',
    {
      filePath: z.string().describe('Absolute path to a local PNG/JPEG/GIF image'),
      nodeId: z.string().describe('Target node ID. Node must support fills.'),
      scaleMode: z.enum(SCALE_MODES).optional().describe('Image paint scale mode (default FILL)'),
    },
    async ({ filePath, nodeId, scaleMode }) => {
      try {
        const image = await loadLocalImage(filePath);
        const result = (await bridge.request(
          'set_image_fill',
          {
            nodeId,
            imageData: image.base64,
            mimeType: image.mimeType,
            scaleMode: (scaleMode ?? 'FILL') as ScaleMode,
          },
          60_000,
          'fill_existing_image_from_local',
          true,
        )) as Record<string, unknown>;
        return jsonResponse({ ...result, source: sourceMetadata(image) });
      } catch (err) {
        return { ...jsonResponse(errorPayload(err)), isError: true };
      }
    },
  );
}
