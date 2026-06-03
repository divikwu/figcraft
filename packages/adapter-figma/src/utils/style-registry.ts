/**
 * Style registry — register, persist, and match library styles for auto-application.
 *
 * No scanning. AI registers styles via register_library_styles (data from official Figma MCP).
 * Styles are imported via importStyleByKeyAsync and mapped in memory for O(1) lookup.
 * Keys persisted in clientStorage for lazy recovery after plugin restart.
 */

import { LOCAL_LIBRARY } from '../constants.js';
import { registerCache } from './cache-manager.js';
import { getAvailableLibraryCollectionsCached, resolveVariableLibraryName } from './design-context.js';

// ─── Types ───

export interface RegisteredTextStyle {
  key: string;
  name: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
}

export interface RegisteredPaintStyle {
  key: string;
  name: string;
  hex: string;
}

export interface RegisteredEffectStyle {
  key: string;
  name: string;
  effectType: string;
}

export interface RegisteredStyles {
  textStyles: RegisteredTextStyle[];
  paintStyles: RegisteredPaintStyle[];
  effectStyles: RegisteredEffectStyle[];
}

// ─── In-memory maps (built on register/restore, queried on create) ───

/** Text styles keyed by fontSize. Multiple styles can share the same fontSize (e.g. Body/Regular vs Body/Bold). */
type TextStyleEntry = { id: string; key: string; name: string; fontFamily: string; fontWeight: string };
type PaintStyleEntry = { id: string; key: string; name: string };
type EffectStyleEntry = { id: string; key: string; name: string };

const textStyleMap = new Map<number, TextStyleEntry[]>();
/** Text styles keyed by lowercase name. Parallel index for O(1) name-based lookup (textStyleName binding + font preloading). */
const textStyleByName = new Map<
  string,
  { id: string; key: string; name: string; fontFamily: string; fontWeight: string; fontSize: number }
>();
/** Paint styles keyed by hex. Multiple styles can share the same hex (e.g. Primary/500 vs Info/Default). */
const paintStyleMap = new Map<string, PaintStyleEntry[]>();
const effectStyleMap = new Map<string, EffectStyleEntry>();
let loadedLibrary: string | null = null;

function storageKey(library: string): string {
  return `figcraft_styles_${library}`;
}

/** Import a style by key with a timeout to avoid hanging on deleted keys. */
function importWithTimeout(key: string, timeoutMs = 5000): Promise<{ id: string; key: string }> {
  return Promise.race([
    figma.importStyleByKeyAsync(key) as Promise<BaseStyle>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Import timeout: ${key}`)), timeoutMs)),
  ]);
}

// ─── Register (one-time, AI-driven) ───

export async function registerStyles(
  library: string,
  styles: RegisteredStyles,
): Promise<{ textStyles: number; paintStyles: number; effectStyles: number }> {
  // Clear previous maps
  textStyleMap.clear();
  textStyleByName.clear();
  paintStyleMap.clear();
  effectStyleMap.clear();

  // Import all styles in parallel for speed
  const [textResults, paintResults, effectResults] = await Promise.all([
    Promise.allSettled(
      styles.textStyles.map(async (ts) => {
        const imported = await importWithTimeout(ts.key);
        return {
          fontSize: ts.fontSize,
          id: imported.id,
          key: imported.key,
          name: ts.name,
          fontFamily: ts.fontFamily,
          fontWeight: ts.fontWeight,
        };
      }),
    ),
    Promise.allSettled(
      styles.paintStyles.map(async (ps) => {
        const imported = await importWithTimeout(ps.key);
        return { hex: ps.hex.toLowerCase(), id: imported.id, key: imported.key, name: ps.name };
      }),
    ),
    Promise.allSettled(
      styles.effectStyles.map(async (es) => {
        const imported = await importWithTimeout(es.key);
        return { effectType: es.effectType, id: imported.id, key: imported.key, name: es.name };
      }),
    ),
  ]);

  for (const r of textResults) {
    if (r.status === 'fulfilled') {
      const existing = textStyleMap.get(r.value.fontSize) ?? [];
      const entry = {
        id: r.value.id,
        key: r.value.key,
        name: r.value.name,
        fontFamily: r.value.fontFamily,
        fontWeight: r.value.fontWeight,
      };
      existing.push(entry);
      textStyleMap.set(r.value.fontSize, existing);
      textStyleByName.set(r.value.name.toLowerCase(), { ...entry, fontSize: r.value.fontSize });
    }
  }
  for (const r of paintResults) {
    if (r.status === 'fulfilled') {
      const existing = paintStyleMap.get(r.value.hex) ?? [];
      existing.push({ id: r.value.id, key: r.value.key, name: r.value.name });
      paintStyleMap.set(r.value.hex, existing);
    }
  }
  for (const r of effectResults) {
    if (r.status === 'fulfilled') {
      effectStyleMap.set(r.value.effectType, { id: r.value.id, key: r.value.key, name: r.value.name });
    }
  }

  // Persist to clientStorage
  await figma.clientStorage.setAsync(storageKey(library), JSON.stringify(styles));
  loadedLibrary = library;

  // Count total entries across all array values
  let textCount = 0;
  for (const arr of textStyleMap.values()) textCount += arr.length;
  let paintCount = 0;
  for (const arr of paintStyleMap.values()) paintCount += arr.length;

  return {
    textStyles: textCount,
    paintStyles: paintCount,
    effectStyles: effectStyleMap.size,
  };
}

// ─── Lazy restore (after plugin restart) ───

export async function ensureLoaded(library: string): Promise<void> {
  if (loadedLibrary === library) return;

  // ── Local mode: load local text/paint/effect styles directly into registry ──
  if (library === LOCAL_LIBRARY) {
    try {
      const [textStyles, paintStyles, effectStyles] = await Promise.all([
        figma.getLocalTextStylesAsync(),
        figma.getLocalPaintStylesAsync(),
        figma.getLocalEffectStylesAsync(),
      ]);

      // Clear and populate maps directly (no importStyleByKeyAsync needed — styles are already local)
      textStyleMap.clear();
      textStyleByName.clear();
      paintStyleMap.clear();
      effectStyleMap.clear();

      for (const ts of textStyles) {
        const entry = {
          id: ts.id,
          key: ts.key,
          name: ts.name,
          fontFamily: ts.fontName.family,
          fontWeight: ts.fontName.style,
        };
        const existing = textStyleMap.get(ts.fontSize) ?? [];
        existing.push(entry);
        textStyleMap.set(ts.fontSize, existing);
        textStyleByName.set(ts.name.toLowerCase(), { ...entry, fontSize: ts.fontSize });
      }
      for (const ps of paintStyles) {
        const fills = ps.paints.filter((p): p is SolidPaint => p.type === 'SOLID');
        if (fills.length > 0) {
          const { r, g, b } = fills[0].color;
          const hex = `#${[r, g, b]
            .map((c) =>
              Math.round(c * 255)
                .toString(16)
                .padStart(2, '0'),
            )
            .join('')}`;
          const existing = paintStyleMap.get(hex) ?? [];
          existing.push({ id: ps.id, key: ps.key, name: ps.name });
          paintStyleMap.set(hex, existing);
        }
      }
      for (const es of effectStyles) {
        const effects = es.effects;
        if (effects.length > 0) {
          effectStyleMap.set(effects[0].type, { id: es.id, key: es.key, name: es.name });
        }
      }
    } catch (err) {
      console.warn('[figcraft] ensureLoaded(__local__) failed:', err instanceof Error ? err.message : err);
    }
    loadedLibrary = library;
    return;
  }

  // ── Library mode: restore from clientStorage ──
  const json = (await figma.clientStorage.getAsync(storageKey(library))) as string | undefined;
  if (!json) {
    loadedLibrary = library;
    return;
  }

  try {
    const styles = JSON.parse(json) as RegisteredStyles;
    // Race against a 6s timeout to prevent blocking node creation
    // Clean up timer on resolve to avoid leaks
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      registerStyles(library, styles).finally(() => clearTimeout(timer)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn('[figcraft] ensureLoaded timed out after 6s, proceeding without styles');
          loadedLibrary = library;
          resolve();
        }, 6_000);
      }),
    ]);
  } catch {
    loadedLibrary = library;
  }
}

// ─── Query (pure memory, 0ms) ───

/**
 * Get a text style matching the given fontSize.
 * When multiple styles share the same fontSize, optionally match by fontFamily/fontWeight.
 *
 * Fallback behaviour:
 * - When `hints.fontFamily` is provided, only styles from the SAME font family are
 *   considered. This prevents auto-binding a GT Walsheim style when the caller
 *   explicitly requested Inter — which would change the node's font and cause
 *   "unloaded font" errors on subsequent property writes.
 * - When no hints are provided, falls back to the first registered style at that size.
 */
export function getTextStyleId(
  fontSize: number,
  hints?: { fontFamily?: string; fontWeight?: string },
): { id: string; name: string; fontFamily: string; fontWeight: string } | null {
  const entries = textStyleMap.get(fontSize);
  if (!entries || entries.length === 0) return null;
  if (!hints) return entries[0];

  // Try to match by fontFamily + fontWeight for best precision
  if (hints.fontFamily && hints.fontWeight) {
    const exact = entries.find((e) => e.fontFamily === hints.fontFamily && e.fontWeight === hints.fontWeight);
    if (exact) return exact;
  }
  // Fall back to fontFamily match only (preserve font family intent)
  if (hints.fontFamily) {
    const byFamily = entries.find((e) => e.fontFamily === hints.fontFamily);
    if (byFamily) return byFamily;
    // No style in this font family at this size — do NOT fall back to a different
    // font family. Binding a mismatched style silently changes the node's font,
    // causing "Cannot write to node with unloaded font" on subsequent writes.
    return null;
  }
  // Fall back to fontWeight match only (no family constraint)
  if (hints.fontWeight) {
    const byWeight = entries.find((e) => e.fontWeight === hints.fontWeight);
    if (byWeight) return byWeight;
  }
  return entries[0];
}

/**
 * Get a text style by exact name (case-insensitive).
 * Returns font info for preloading + style id for binding.
 */
export function getTextStyleByName(
  name: string,
): { id: string; name: string; fontFamily: string; fontWeight: string; fontSize: number } | null {
  return textStyleByName.get(name.toLowerCase()) ?? null;
}

/**
 * Get a paint style matching the given hex color.
 * When multiple styles share the same hex, returns the first registered one.
 */
export function getPaintStyleId(hex: string): { id: string; name: string } | null;
export function getPaintStyleId(hex: string | undefined, name: string): { id: string; name: string } | null;
export function getPaintStyleId(hex: string | undefined, name?: string): { id: string; name: string } | null {
  // Name-based lookup: scan all entries for a matching name
  if (name) {
    const lowerName = name.toLowerCase();
    for (const entries of paintStyleMap.values()) {
      for (const entry of entries) {
        if (entry.name.toLowerCase() === lowerName) return entry;
      }
    }
    return null;
  }
  // Hex-based lookup (original behavior)
  if (!hex) return null;
  const entries = paintStyleMap.get(hex.toLowerCase());
  if (!entries || entries.length === 0) return null;
  return entries[0];
}

// ─── Get registered styles summary (for get_mode response) ───

export async function getRegisteredStylesSummary(
  library: string,
): Promise<(RegisteredStyles & { _loaded?: { text: number; paint: number; effect: number } }) | null> {
  // Read from storage (source of truth for full registered list)
  const json = (await figma.clientStorage.getAsync(storageKey(library))) as string | undefined;
  if (!json) return null;
  try {
    const styles = JSON.parse(json) as RegisteredStyles;
    // Include actual in-memory counts so AI can detect import failures
    if (loadedLibrary === library) {
      // Count total entries across all array values
      let textCount = 0;
      for (const arr of textStyleMap.values()) textCount += arr.length;
      let paintCount = 0;
      for (const arr of paintStyleMap.values()) paintCount += arr.length;
      (styles as any)._loaded = {
        text: textCount,
        paint: paintCount,
        effect: effectStyleMap.size,
      };
    }
    return styles;
  } catch {
    return null;
  }
}

// ─── Incremental register (only import changed styles, preserve unchanged) ───

export async function registerStylesIncremental(
  library: string,
  fullStyles: RegisteredStyles,
  changedStyles: RegisteredStyles,
  removedKeys: string[],
): Promise<{ textStyles: number; paintStyles: number; effectStyles: number }> {
  // Ensure current maps are loaded
  await ensureLoaded(library);

  // Remove deleted styles from maps.
  // In-memory maps are keyed by value (fontSize/hex/effectType), not by style key,
  // so we look up stored data to find which value keys to delete.
  if (removedKeys.length > 0) {
    const removedSet = new Set(removedKeys);
    const storedJson = (await figma.clientStorage.getAsync(storageKey(library))) as string | undefined;
    if (storedJson) {
      const stored = JSON.parse(storedJson) as RegisteredStyles;
      for (const ts of stored.textStyles) {
        if (removedSet.has(ts.key)) {
          const arr = textStyleMap.get(ts.fontSize);
          if (arr) {
            const filtered = arr.filter((e) => e.name !== ts.name);
            if (filtered.length === 0) textStyleMap.delete(ts.fontSize);
            else textStyleMap.set(ts.fontSize, filtered);
          }
          textStyleByName.delete(ts.name.toLowerCase());
        }
      }
      for (const ps of stored.paintStyles) {
        if (removedSet.has(ps.key)) {
          const arr = paintStyleMap.get(ps.hex.toLowerCase());
          if (arr) {
            const filtered = arr.filter((e) => e.name !== ps.name);
            if (filtered.length === 0) paintStyleMap.delete(ps.hex.toLowerCase());
            else paintStyleMap.set(ps.hex.toLowerCase(), filtered);
          }
        }
      }
      for (const es of stored.effectStyles) {
        if (removedSet.has(es.key)) effectStyleMap.delete(es.effectType);
      }
    }
  }

  // Import only changed styles (added + modified) in parallel
  let _imported = 0;
  const [textResults, paintResults, effectResults] = await Promise.all([
    Promise.allSettled(
      changedStyles.textStyles.map(async (ts) => {
        const style = await importWithTimeout(ts.key);
        return {
          fontSize: ts.fontSize,
          id: style.id,
          key: style.key,
          name: ts.name,
          fontFamily: ts.fontFamily,
          fontWeight: ts.fontWeight,
        };
      }),
    ),
    Promise.allSettled(
      changedStyles.paintStyles.map(async (ps) => {
        const style = await importWithTimeout(ps.key);
        return { hex: ps.hex.toLowerCase(), id: style.id, key: style.key, name: ps.name };
      }),
    ),
    Promise.allSettled(
      changedStyles.effectStyles.map(async (es) => {
        const style = await importWithTimeout(es.key);
        return { effectType: es.effectType, id: style.id, key: style.key, name: es.name };
      }),
    ),
  ]);

  for (const r of textResults) {
    if (r.status === 'fulfilled') {
      const existing = textStyleMap.get(r.value.fontSize) ?? [];
      // Replace existing entry with same name, or append
      const idx = existing.findIndex((e) => e.name === r.value.name);
      const entry = {
        id: r.value.id,
        key: r.value.key,
        name: r.value.name,
        fontFamily: r.value.fontFamily,
        fontWeight: r.value.fontWeight,
      };
      if (idx >= 0) existing[idx] = entry;
      else existing.push(entry);
      textStyleMap.set(r.value.fontSize, existing);
      textStyleByName.set(entry.name.toLowerCase(), { ...entry, fontSize: r.value.fontSize });
      _imported++;
    }
  }
  for (const r of paintResults) {
    if (r.status === 'fulfilled') {
      const existing = paintStyleMap.get(r.value.hex) ?? [];
      const idx = existing.findIndex((e) => e.name === r.value.name);
      const entry = { id: r.value.id, key: r.value.key, name: r.value.name };
      if (idx >= 0) existing[idx] = entry;
      else existing.push(entry);
      paintStyleMap.set(r.value.hex, existing);
      _imported++;
    }
  }
  for (const r of effectResults) {
    if (r.status === 'fulfilled') {
      effectStyleMap.set(r.value.effectType, { id: r.value.id, key: r.value.key, name: r.value.name });
      _imported++;
    }
  }

  // Persist full styles to clientStorage (source of truth)
  await figma.clientStorage.setAsync(storageKey(library), JSON.stringify(fullStyles));
  loadedLibrary = library;

  // Count total entries across all array values
  let textCount = 0;
  for (const arr of textStyleMap.values()) textCount += arr.length;
  let paintCount = 0;
  for (const arr of paintStyleMap.values()) paintCount += arr.length;

  return {
    textStyles: textCount,
    paintStyles: paintCount,
    effectStyles: effectStyleMap.size,
  };
}

// ─── Available paint style names (for error self-correction) ───

/**
 * Return a list of available paint style names (up to `limit`).
 * Used when a hardcoded color has no match — the agent can self-correct
 * by picking from the available list.
 */
export function getAvailablePaintStyleNames(limit = 20): string[] {
  const names: string[] = [];
  for (const entries of paintStyleMap.values()) {
    for (const entry of entries) {
      names.push(entry.name);
      if (names.length >= limit) return names;
    }
  }
  return names;
}

/** Return a list of available text style names (up to `limit`). */
export function getAvailableTextStyleNames(limit = 20): string[] {
  const names: string[] = [];
  for (const entries of textStyleMap.values()) {
    for (const entry of entries) {
      names.push(entry.name);
      if (names.length >= limit) return names;
    }
  }
  return names;
}

/** Return a list of available effect style names (up to `limit`). */
export function getAvailableEffectStyleNames(limit = 20): string[] {
  const names: string[] = [];
  for (const entry of effectStyleMap.values()) {
    names.push(entry.name);
    if (names.length >= limit) return names;
  }
  return names;
}

/**
 * Search paint styles by hex value (case-insensitive).
 * Returns the closest match info or null.
 */
export function findClosestPaintStyle(hex: string): { name: string; hex: string } | null {
  const target = hex.toLowerCase().replace('#', '');
  if (target.length < 6) return null;

  const tr = parseInt(target.slice(0, 2), 16);
  const tg = parseInt(target.slice(2, 4), 16);
  const tb = parseInt(target.slice(4, 6), 16);
  if (Number.isNaN(tr) || Number.isNaN(tg) || Number.isNaN(tb)) return null;

  let bestDist = Infinity;
  let bestName = '';
  let bestHex = '';

  for (const [styleHex, entries] of paintStyleMap) {
    const h = styleHex.replace('#', '');
    if (h.length < 6) continue;
    const sr = parseInt(h.slice(0, 2), 16);
    const sg = parseInt(h.slice(2, 4), 16);
    const sb = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(sr)) continue;
    // Weighted Euclidean distance — human vision is most sensitive to green, least to blue.
    // Weights from "redmean" approximation (low-cost perceptual color distance).
    const rmean = (tr + sr) / 2;
    const dr = tr - sr;
    const dg = tg - sg;
    const db = tb - sb;
    const dist = Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = entries[0].name;
      bestHex = styleHex;
    }
  }

  // Only suggest if reasonably close (distance < 80 in weighted RGB space ≈ visually similar)
  if (bestDist < 80 && bestName) {
    return { name: bestName, hex: bestHex };
  }
  return null;
}

// ─── Text style suggestion ───

/**
 * Suggest a matching text style for manually specified font properties.
 * When the agent sets fontSize/fontFamily/fontWeight manually instead of using a text style,
 * this function finds the closest registered text style and returns a suggestion hint.
 *
 * Returns both exact and fuzzy matches with actionable hints.
 *
 * @param fontSize - The font size to match
 * @param fontFamily - Optional font family hint
 * @param fontWeight - Optional font weight hint
 * @returns Suggestion with style name and match quality, or null
 */
export function suggestTextStyle(
  fontSize: number,
  fontFamily?: string,
  fontWeight?: string,
): { name: string; exact: boolean; hint: string } | null {
  const entries = textStyleMap.get(fontSize);
  if (entries && entries.length > 0) {
    // Exact fontSize match — check if family/weight also match
    if (fontFamily && fontWeight) {
      const exact = entries.find((e) => e.fontFamily === fontFamily && e.fontWeight === fontWeight);
      if (exact)
        return {
          name: exact.name,
          exact: true,
          hint: `Text style "${exact.name}" matches exactly. Consider using it for consistency.`,
        };
    }
    // Partial match
    return {
      name: entries[0].name,
      exact: false,
      hint: `Text style "${entries[0].name}" has the same fontSize (${fontSize}px). Consider using it.`,
    };
  }

  // No exact fontSize match — find closest
  let bestDiff = Infinity;
  let bestName = '';
  let bestSize = 0;
  for (const [size, styleEntries] of textStyleMap) {
    const diff = Math.abs(size - fontSize);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestName = styleEntries[0].name;
      bestSize = size;
    }
  }
  if (bestName && bestDiff <= 4) {
    return {
      name: bestName,
      exact: false,
      hint: `No text style at ${fontSize}px. Closest: "${bestName}" (${bestSize}px, ${bestDiff}px away).`,
    };
  }
  return null;
}

// ─── Effect style name-based lookup ───

/**
 * Get an effect style matching the given name (case-insensitive).
 * Used by create_frame's effectStyleName param to find library effect styles.
 */
export function getEffectStyleByName(name: string): { id: string; name: string } | null {
  const lowerName = name.toLowerCase();
  for (const entry of effectStyleMap.values()) {
    if (entry.name.toLowerCase() === lowerName) return entry;
  }
  return null;
}

// ─── Clear (on library switch) ───

export function clearStyleRegistry(): void {
  textStyleMap.clear();
  textStyleByName.clear();
  paintStyleMap.clear();
  effectStyleMap.clear();
  loadedLibrary = null;
}

// ─── Library style ID set (for foreign-style lint rule) ───

/**
 * Collect all registered style IDs from the current library into a Set.
 * Used by the foreign-style lint rule to detect cross-library style references.
 * Returns an empty set if no library is loaded.
 */
export function getLibraryStyleIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const entries of textStyleMap.values()) {
    for (const entry of entries) ids.add(entry.id);
  }
  for (const entries of paintStyleMap.values()) {
    for (const entry of entries) ids.add(entry.id);
  }
  for (const entry of effectStyleMap.values()) {
    ids.add(entry.id);
  }
  return ids;
}

/**
 * Collect all registered style keys from the current library into a Set.
 * Style keys are stable across Figma documents; style IDs are document-local.
 */
export function getLibraryStyleKeySet(): Set<string> {
  const keys = new Set<string>();
  for (const entries of textStyleMap.values()) {
    for (const entry of entries) keys.add(entry.key);
  }
  for (const entries of paintStyleMap.values()) {
    for (const entry of entries) keys.add(entry.key);
  }
  for (const entry of effectStyleMap.values()) {
    keys.add(entry.key);
  }
  return keys;
}

/**
 * Collect style IDs from local Figma styles (text, paint, effect).
 * Fallback for when the style registry is empty (styles never registered via AI).
 * Async because it uses Figma's getLocal*StylesAsync APIs.
 */
export async function getLocalStyleIdSet(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const [textStyles, paintStyles, effectStyles] = await Promise.all([
      figma.getLocalTextStylesAsync(),
      figma.getLocalPaintStylesAsync(),
      figma.getLocalEffectStylesAsync(),
    ]);
    for (const ts of textStyles) ids.add(ts.id);
    for (const ps of paintStyles) ids.add(ps.id);
    for (const es of effectStyles) ids.add(es.id);
  } catch {
    /* best-effort */
  }
  return ids;
}

/**
 * Collect local/imported style IDs whose stable keys match the selected library registry.
 * This closes the gap where Figma gives the same library style a different local ID
 * than the one cached from a previous import.
 */
export async function getLocalStyleIdSetForKeys(styleKeys: Set<string>): Promise<Set<string>> {
  const ids = new Set<string>();
  if (styleKeys.size === 0) return ids;
  try {
    const [textStyles, paintStyles, effectStyles] = await Promise.all([
      figma.getLocalTextStylesAsync(),
      figma.getLocalPaintStylesAsync(),
      figma.getLocalEffectStylesAsync(),
    ]);
    for (const ts of textStyles) if (styleKeys.has(ts.key)) ids.add(ts.id);
    for (const ps of paintStyles) if (styleKeys.has(ps.key)) ids.add(ps.id);
    for (const es of effectStyles) if (styleKeys.has(es.key)) ids.add(es.id);
  } catch {
    /* best-effort */
  }
  return ids;
}

// ─── Library variable ID set (for foreign-variable lint rule) ───

/** Cache for library variable IDs to avoid repeated collection scans. */
let _libraryVariableIdCache: { ids: Set<string>; library: string; ts: number } | null = null;
const VARIABLE_ID_CACHE_TTL_MS = 30_000;

/**
 * Collect variable IDs that belong to the selected library (or local file).
 * Used by the foreign-variable lint rule to detect cross-library variable references.
 *
 * When selectedLibrary is '__local__' or falsy: collects ALL local variable IDs
 * (the file IS the design system — all collections are valid).
 *
 * When selectedLibrary is a specific library name: collects variable IDs from
 * (a) local non-remote collections (file-authored variables), and
 * (b) remote collections whose key matches the selected library.
 * Variables from OTHER remote libraries are excluded — those are "foreign".
 *
 * Uses a 30s TTL cache keyed by library name.
 */
export async function getLibraryVariableIdSet(selectedLibrary?: string | null): Promise<Set<string>> {
  const cacheKey = selectedLibrary || LOCAL_LIBRARY;
  const now = Date.now();
  if (
    _libraryVariableIdCache &&
    _libraryVariableIdCache.library === cacheKey &&
    now - _libraryVariableIdCache.ts < VARIABLE_ID_CACHE_TTL_MS
  ) {
    return _libraryVariableIdCache.ids;
  }

  const ids = new Set<string>();
  try {
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();

    // __local__ mode or no library: all variables in the file are valid.
    // In local mode the file IS the design system — all collections (including
    // remote ones imported for reference) are considered part of the system.
    if (!selectedLibrary || selectedLibrary === LOCAL_LIBRARY) {
      for (const collection of localCollections) {
        for (const varId of collection.variableIds) {
          ids.add(varId);
        }
      }
    } else {
      // Specific library mode: determine which remote collections belong to it.
      // Resolve the actual variable API name (may differ from display name when
      // a library file has been duplicated — see resolveVariableLibraryName).
      const resolvedName = await resolveVariableLibraryName(selectedLibrary);
      const availableCollections = await getAvailableLibraryCollectionsCached();
      const selectedLibraryKeys = new Set(
        availableCollections.filter((c) => c.libraryName === resolvedName).map((c) => c.key),
      );

      for (const collection of localCollections) {
        if (!collection.remote) {
          // Local (non-remote) collections are always valid
          for (const varId of collection.variableIds) {
            ids.add(varId);
          }
        } else if (selectedLibraryKeys.has(collection.key)) {
          // Remote collection belongs to the selected library
          for (const varId of collection.variableIds) {
            ids.add(varId);
          }
        }
        // else: remote collection from a different library — skip (foreign)
      }
    }
  } catch {
    /* best-effort */
  }

  _libraryVariableIdCache = { ids, library: cacheKey, ts: now };
  return ids;
}

/** Invalidate the library variable ID cache (call on library/mode switch). */
export function invalidateVariableIdCache(): void {
  _libraryVariableIdCache = null;
}

// Register with centralized cache manager
registerCache('style-registry', () => {
  clearStyleRegistry();
  invalidateVariableIdCache();
});
