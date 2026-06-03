import { hexToRgbTuple } from './color.js';

type RgbTuple = [number, number, number];

export interface SolidPaintLike {
  type?: string;
  color?: string;
  opacity?: number;
  visible?: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getHexAlpha(hex: string | undefined): number | undefined {
  if (!hex) return undefined;
  const clean = hex.replace('#', '');
  if (clean.length < 8 || !/^[0-9a-fA-F]+$/.test(clean)) return undefined;
  return parseInt(clean.slice(6, 8), 16) / 255;
}

export function getPaintOpacity(paint: SolidPaintLike): number {
  return clamp01(paint.opacity ?? getHexAlpha(paint.color) ?? 1);
}

export function isVisibleSolidPaint(paint: SolidPaintLike | undefined): paint is SolidPaintLike & { color: string } {
  return paint?.type === 'SOLID' && paint.visible !== false && !!paint.color && getPaintOpacity(paint) > 0;
}

export function compositeRgb(fg: RgbTuple, bg: RgbTuple, opacity: number): RgbTuple {
  const a = clamp01(opacity);
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

export function rgbTupleToHex(rgb: RgbTuple): string {
  return `#${rgb
    .map((channel) =>
      Math.round(clamp01(channel) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function resolveSolidPaintRgb(paint: SolidPaintLike, backdropHex?: string): RgbTuple | null {
  if (!paint.color) return null;
  const rgb = hexToRgbTuple(paint.color);
  if (!rgb) return null;
  const opacity = getPaintOpacity(paint);
  if (opacity >= 1) return rgb;
  if (opacity <= 0) return backdropHex ? hexToRgbTuple(backdropHex) : null;
  const backdrop = backdropHex ? hexToRgbTuple(backdropHex) : null;
  return backdrop ? compositeRgb(rgb, backdrop, opacity) : rgb;
}

export function resolveSolidPaintHex(paint: SolidPaintLike, backdropHex?: string): string | undefined {
  const rgb = resolveSolidPaintRgb(paint, backdropHex);
  return rgb ? rgbTupleToHex(rgb) : undefined;
}
