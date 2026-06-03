/**
 * Pexels integration — search stock photos for use in Figma designs.
 * Requires PEXELS_API_KEY environment variable.
 * Photos are placed via create_frame with imageUrl:"pexel:<id>" (handled by image-vector handler).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResponse } from './response-helpers.js';

const PEXELS_API = 'https://api.pexels.com/v1';

function getApiKey(): string | null {
  return process.env.PEXELS_API_KEY ?? null;
}

interface PexelsPhoto {
  id: number;
  alt: string;
  avg_color: string;
  width: number;
  height: number;
  photographer: string;
  src: { small: string; medium: string; large: string; original: string };
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
  total_results: number;
  page: number;
  per_page: number;
}

interface PexelsErrorResponse {
  error: string;
}

interface PexelsPreviewResponse {
  [x: string]: unknown;
  content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }>;
}

async function searchPhotos(params: {
  query: string;
  orientation?: string;
  size?: string;
  color?: string;
  page?: number;
  per_page?: number;
}): Promise<unknown> {
  const key = getApiKey();
  if (!key) {
    return { error: 'PEXELS_API_KEY not set. Get a free key at https://www.pexels.com/api/new/' };
  }

  const searchParams = new URLSearchParams({ query: params.query });
  if (params.orientation) searchParams.set('orientation', params.orientation);
  if (params.size) searchParams.set('size', params.size);
  if (params.color) searchParams.set('color', params.color);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.per_page) searchParams.set('per_page', String(params.per_page));

  const res = await fetch(`${PEXELS_API}/search?${searchParams}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) return { error: `Pexels API error (HTTP ${res.status})` };

  const data = (await res.json()) as PexelsSearchResponse;
  return {
    photos: data.photos.map((p) => ({
      id: p.id,
      alt: p.alt,
      avg_color: p.avg_color,
      width: p.width,
      height: p.height,
      photographer: p.photographer,
      imageUrl: p.src.large,
    })),
    total_results: data.total_results,
    page: data.page,
    per_page: data.per_page,
    _hint: "To place a photo: use create_frame with imageUrl set to the photo's imageUrl field.",
  };
}

async function previewPhoto(id: number, size?: string): Promise<PexelsPreviewResponse | PexelsErrorResponse> {
  const key = getApiKey();
  if (!key) {
    return { error: 'PEXELS_API_KEY not set.' };
  }

  const res = await fetch(`${PEXELS_API}/photos/${id}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) return { error: `Photo ${id} not found (HTTP ${res.status})` };

  const photo = (await res.json()) as PexelsPhoto;
  const sizeKey = (size ?? 'medium') as keyof typeof photo.src;
  const imageUrl = photo.src[sizeKey] ?? photo.src.medium;

  // Fetch the image and return as base64
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) return { error: `Failed to fetch image (HTTP ${imgRes.status})` };

  const buffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = 'image/jpeg';

  return {
    content: [
      { type: 'image' as const, data: base64, mimeType },
      {
        type: 'text' as const,
        text: JSON.stringify({
          id: photo.id,
          alt: photo.alt,
          photographer: photo.photographer,
          width: photo.width,
          height: photo.height,
          _hint: `To place: create_frame with imageUrl:"${photo.src.large}"`,
        }),
      },
    ],
  };
}

export function registerPexelsTools(server: McpServer): void {
  server.tool(
    'image_search',
    'Search stock photos by keyword via Pexels. Returns photo metadata (id, alt, dimensions). ' +
      'To place a photo in Figma: use create_frame with imageUrl:"pexel:<id>".',
    {
      query: z.string().describe('Search keyword (e.g. "sunset", "office", "nature")'),
      orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
      size: z.enum(['large', 'medium', 'small']).optional(),
      color: z.string().optional().describe('Filter by color — hex or named: red, blue, green, etc.'),
      page: z.number().optional().describe('Page number (default: 1)'),
      per_page: z.number().optional().describe('Results per page (default: 15, max: 80)'),
    },
    async (params) => {
      const result = await searchPhotos(params);
      return jsonResponse(result);
    },
  );

  server.tool(
    'image_preview',
    'Preview a Pexels photo by ID — returns the actual image so you can see it before placing.',
    {
      id: z.number().describe('Photo ID from image_search results'),
      size: z.enum(['small', 'medium', 'large']).optional().describe('Preview size (default: medium)'),
    },
    async ({ id, size }) => {
      const result = await previewPhoto(id, size);
      // If result has content array (image + text), return directly
      if ('content' in result) return result;
      // Otherwise it's an error
      return jsonResponse(result);
    },
  );
}
