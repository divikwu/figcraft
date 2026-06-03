/**
 * Node simplifier — ~90% compression.
 *
 * Strips Figma node data to only layout + style + token binding essentials.
 * Supports configurable depth limits, time budgets, and detail levels
 * to prevent timeouts and control payload size on large pages.
 *
 * Detail levels:
 * - "summary"  (~80 bytes/node): id, name, type, dimensions, childCount — for tree browsing
 * - "standard" (~350 bytes/node): + fills, strokes, effects, text, layout — default inspection
 * - "full"     (~500 bytes/node): + boundVariables, componentProps, font details — for editing
 */

import type { CompressedNode } from '@figcraft/shared';
import { PLUGIN_DATA_KEYS } from '../constants.js';
import { figmaRgbaToHex } from '../utils/color.js';

/** Detail level for node simplification. */
export type SimplifyDetail = 'summary' | 'standard' | 'full';

/** Default maximum tree depth to prevent excessive payloads. */
const DEFAULT_MAX_DEPTH = 10;

/** Maximum total nodes in a single simplifyNode call. */
const MAX_NODES = 2000;

/** Default time budget for simplifyPage (ms). */
const DEFAULT_TIME_BUDGET_MS = 15_000;

/** Traversal context shared across recursive calls. */
export interface SimplifyContext {
  count: number;
  maxDepth: number;
  startTime: number;
  timeBudgetMs: number;
  timedOut: boolean;
  /** Detail level for node fields. Defaults to 'standard'. */
  detail: SimplifyDetail;
  /** If set, auto-degrade children beyond this depth to 'summary'. */
  degradeDepth?: number;
}

export function createContext(
  maxDepth?: number,
  timeBudgetMs?: number,
  detail?: SimplifyDetail,
  degradeDepth?: number,
): SimplifyContext {
  return {
    count: 0,
    maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
    startTime: Date.now(),
    timeBudgetMs: timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    timedOut: false,
    detail: detail ?? 'standard',
    degradeDepth,
  };
}

function isOverBudget(ctx: SimplifyContext): boolean {
  if (ctx.timedOut) return true;
  // Check time every 50 nodes to avoid excessive Date.now() calls
  if (ctx.count % 50 === 0 && Date.now() - ctx.startTime > ctx.timeBudgetMs) {
    ctx.timedOut = true;
    return true;
  }
  return false;
}

function getStyleMeta(styleId: string): { key?: string; remote?: boolean } {
  try {
    const style = figma.getStyleById(styleId);
    return { key: style?.key, remote: style?.remote };
  } catch {
    return {};
  }
}

/** Simplify a Figma node tree into compressed JSON. */
export function simplifyNode(
  node: SceneNode,
  depth = 0,
  counter?: { count: number },
  ctx?: SimplifyContext,
): CompressedNode {
  // Legacy counter support for backward compatibility
  const context =
    ctx ??
    (counter
      ? {
          count: counter.count,
          maxDepth: DEFAULT_MAX_DEPTH,
          startTime: Date.now(),
          timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
          timedOut: false,
          detail: 'standard' as SimplifyDetail,
        }
      : createContext());
  context.count++;
  // Sync legacy counter if provided
  if (counter) counter.count = context.count;

  // Determine effective detail level: auto-degrade deep children to summary
  const effectiveDetail = context.degradeDepth != null && depth >= context.degradeDepth ? 'summary' : context.detail;

  // ── Summary level: minimal fields for tree browsing ──
  const base: CompressedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: 'x' in node ? node.x : 0,
    y: 'y' in node ? node.y : 0,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
    visible: node.visible,
  };

  // Summary: add childCount hint (without including actual children data)
  if (effectiveDetail === 'summary') {
    if ('children' in node) {
      const childCount = (node as ChildrenMixin).children.length;
      if (childCount > 0) base.truncatedChildCount = childCount;
    }
    // Include layoutMode even in summary — critical for understanding structure
    if ('layoutMode' in node) {
      const frame = node as FrameNode;
      if (frame.layoutMode !== 'NONE') {
        base.layoutMode = frame.layoutMode as 'HORIZONTAL' | 'VERTICAL' | 'GRID';
      }
    }
    // Text content in summary (characters only, no font details)
    if (node.type === 'TEXT') {
      base.characters = (node as TextNode).characters;
    }
    return base;
  }

  // ── Standard + Full: add role and lintIgnore ──
  base.role = 'getPluginData' in node ? node.getPluginData(PLUGIN_DATA_KEYS.ROLE) || undefined : undefined;
  base.lintIgnore = 'getPluginData' in node ? node.getPluginData(PLUGIN_DATA_KEYS.LINT_IGNORE) || undefined : undefined;

  // Fills & strokes
  if ('fills' in node && node.fills !== figma.mixed) {
    const fills = node.fills as readonly Paint[];
    if (fills.length > 0) {
      base.fills = fills.map(simplifyPaint);
    }
  }
  if ('strokes' in node && (node as GeometryMixin).strokes.length > 0) {
    base.strokes = (node as GeometryMixin).strokes.map(simplifyPaint);
  }

  // Effects
  if ('effects' in node) {
    const effects = (node as BlendMixin).effects;
    if (effects.length > 0) {
      base.effects = effects.map(simplifyEffect);
    }
  }

  // Corner radius
  if ('cornerRadius' in node) {
    const rn = node as RectangleCornerMixin & { cornerRadius: number | typeof figma.mixed };
    if (rn.cornerRadius !== figma.mixed) {
      base.cornerRadius = rn.cornerRadius;
    } else {
      base.cornerRadius = [rn.topLeftRadius, rn.topRightRadius, rn.bottomRightRadius, rn.bottomLeftRadius];
    }
  }

  // Opacity
  if ('opacity' in node) {
    const op = (node as BlendMixin).opacity;
    if (op !== 1) {
      base.opacity = op;
    }
  }

  // Auto layout
  if ('layoutMode' in node) {
    const frame = node as FrameNode;
    if (frame.layoutMode !== 'NONE') {
      base.layoutMode = frame.layoutMode as 'HORIZONTAL' | 'VERTICAL' | 'GRID';
      base.itemSpacing = frame.itemSpacing;
      base.paddingLeft = frame.paddingLeft;
      base.paddingRight = frame.paddingRight;
      base.paddingTop = frame.paddingTop;
      base.paddingBottom = frame.paddingBottom;
      if (frame.primaryAxisAlignItems) base.primaryAxisAlignItems = frame.primaryAxisAlignItems;
      if (frame.counterAxisAlignItems) base.counterAxisAlignItems = frame.counterAxisAlignItems;
      // GRID-specific properties
      if (frame.layoutMode === 'GRID') {
        base.gridRowCount = frame.gridRowCount;
        base.gridColumnCount = frame.gridColumnCount;
        base.gridRowGap = frame.gridRowGap;
        base.gridColumnGap = frame.gridColumnGap;
      }
    }
  }

  // Clip content
  if ('clipsContent' in node) {
    const frame = node as FrameNode;
    if (frame.clipsContent) base.clipsContent = true;
    else base.clipsContent = false; // preserve explicit opt-out (lint rules rely on the distinction)
  }

  // Prototype scroll direction — declares intentional overflow on an axis
  if ('overflowDirection' in node) {
    const proto = node as FrameNode;
    if (proto.overflowDirection && proto.overflowDirection !== 'NONE') {
      base.overflowDirection = proto.overflowDirection;
    }
  }

  // Stroke weight
  if ('strokeWeight' in node) {
    const sw = (node as GeometryMixin).strokeWeight;
    if (typeof sw === 'number' && sw > 0) base.strokeWeight = sw;
  }

  // Layout align (for children of auto-layout frames)
  if ('layoutAlign' in node) {
    const la = (node as SceneNode & { layoutAlign: string }).layoutAlign;
    if (la && la !== 'INHERIT') base.layoutAlign = la;
  }

  // Layout positioning (for children of auto-layout frames)
  if ('layoutPositioning' in node) {
    const positioned = node as SceneNode & { layoutPositioning: string };
    if (positioned.layoutPositioning === 'ABSOLUTE') {
      base.layoutPositioning = 'ABSOLUTE';
    }
  }

  // Text (standard: characters + fontSize; full: + fontName, lineHeight, letterSpacing)
  if (node.type === 'TEXT') {
    const text = node as TextNode;
    base.characters = text.characters;
    if (text.fontSize !== figma.mixed) {
      base.fontSize = text.fontSize;
    }
    if (text.textAutoResize) {
      base.textAutoResize = text.textAutoResize;
    }
    if ('textTruncation' in text && text.textTruncation) {
      base.textTruncation = text.textTruncation;
    }
    if ('maxLines' in text) {
      base.maxLines = text.maxLines;
    }
    // Full detail: include font details
    if (effectiveDetail === 'full') {
      if (text.fontName !== figma.mixed) {
        base.fontName = text.fontName;
      }
      if (text.lineHeight !== figma.mixed) {
        base.lineHeight = text.lineHeight;
      }
      if (text.letterSpacing !== figma.mixed) {
        base.letterSpacing = text.letterSpacing;
      }
    }
  }

  // ── Full detail only: variable bindings, style IDs, component props ──
  if (effectiveDetail === 'full') {
    // Variable bindings
    if ('boundVariables' in node) {
      const bv = (node as SceneNode & { boundVariables: Record<string, unknown> }).boundVariables;
      if (bv && Object.keys(bv).length > 0) {
        base.boundVariables = simplifyBoundVariables(bv);
      }
    }

    // Style IDs
    if ('fillStyleId' in node) {
      const fid = (node as GeometryMixin).fillStyleId;
      if (typeof fid === 'string' && fid) {
        const meta = getStyleMeta(fid);
        base.fillStyleId = fid;
        base.fillStyleKey = meta.key;
        base.fillStyleRemote = meta.remote;
      }
    }
    if ('strokeStyleId' in node) {
      const sid = (node as GeometryMixin).strokeStyleId;
      if (typeof sid === 'string' && sid) {
        const meta = getStyleMeta(sid);
        base.strokeStyleId = sid;
        base.strokeStyleKey = meta.key;
        base.strokeStyleRemote = meta.remote;
      }
    }
    if ('textStyleId' in node) {
      const tid = (node as TextNode).textStyleId;
      if (typeof tid === 'string' && tid) {
        const meta = getStyleMeta(tid);
        base.textStyleId = tid;
        base.textStyleKey = meta.key;
        base.textStyleRemote = meta.remote;
      }
    }
    if ('effectStyleId' in node) {
      const eid = (node as BlendMixin).effectStyleId;
      if (typeof eid === 'string' && eid) {
        const meta = getStyleMeta(eid);
        base.effectStyleId = eid;
        base.effectStyleKey = meta.key;
        base.effectStyleRemote = meta.remote;
      }
    }

    // Component property definitions (COMPONENT / COMPONENT_SET nodes)
    // Variant components (COMPONENT whose parent is COMPONENT_SET) don't support
    // componentPropertyDefinitions directly — read from the parent set instead.
    // Wrapped in try-catch: Figma API may throw in edge cases (detached nodes, file state transitions).
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      try {
        const isVariant = node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET';
        const propDefSource = isVariant
          ? (node.parent as ComponentSetNode)
          : (node as ComponentNode | ComponentSetNode);
        if (
          propDefSource.componentPropertyDefinitions &&
          Object.keys(propDefSource.componentPropertyDefinitions).length > 0
        ) {
          const defs: Record<string, { type: string; defaultValue?: unknown; variantOptions?: string[] }> = {};
          for (const [key, def] of Object.entries(propDefSource.componentPropertyDefinitions)) {
            const entry: { type: string; defaultValue?: unknown; variantOptions?: string[] } = { type: def.type };
            if (def.defaultValue !== undefined) entry.defaultValue = def.defaultValue;
            if (def.type === 'VARIANT' && 'variantOptions' in def) {
              entry.variantOptions = (
                def as ComponentPropertyDefinitions[string] & { variantOptions?: string[] }
              ).variantOptions;
            }
            defs[key] = entry;
          }
          base.componentPropertyDefinitions = defs;
        }
      } catch {
        // componentPropertyDefinitions not accessible — skip silently
      }
    }

    // Component property references (instances and children that reference component props)
    if ('componentPropertyReferences' in node) {
      const refs = (node as SceneNode & { componentPropertyReferences: Record<string, string> | null })
        .componentPropertyReferences;
      if (refs && Object.keys(refs).length > 0) {
        base.componentPropertyReferences = { ...refs };
      }
    }
  } else {
    // Standard detail: include style IDs (lightweight, needed for lint) but not variable bindings or component props
    if ('fillStyleId' in node) {
      const fid = (node as GeometryMixin).fillStyleId;
      if (typeof fid === 'string' && fid) {
        const meta = getStyleMeta(fid);
        base.fillStyleId = fid;
        base.fillStyleKey = meta.key;
        base.fillStyleRemote = meta.remote;
      }
    }
    if ('strokeStyleId' in node) {
      const sid = (node as GeometryMixin).strokeStyleId;
      if (typeof sid === 'string' && sid) {
        const meta = getStyleMeta(sid);
        base.strokeStyleId = sid;
        base.strokeStyleKey = meta.key;
        base.strokeStyleRemote = meta.remote;
      }
    }
    if ('textStyleId' in node) {
      const tid = (node as TextNode).textStyleId;
      if (typeof tid === 'string' && tid) {
        const meta = getStyleMeta(tid);
        base.textStyleId = tid;
        base.textStyleKey = meta.key;
        base.textStyleRemote = meta.remote;
      }
    }
    if ('effectStyleId' in node) {
      const eid = (node as BlendMixin).effectStyleId;
      if (typeof eid === 'string' && eid) {
        const meta = getStyleMeta(eid);
        base.effectStyleId = eid;
        base.effectStyleKey = meta.key;
        base.effectStyleRemote = meta.remote;
      }
    }
  }

  // Children (respect depth limit, node count limit, and time budget)
  if ('children' in node && depth < context.maxDepth && context.count < MAX_NODES && !isOverBudget(context)) {
    const children = (node as ChildrenMixin).children;
    if (children.length > 0) {
      base.children = [];
      for (const child of children) {
        if (context.count >= MAX_NODES || isOverBudget(context)) {
          base.truncated = true;
          base.truncatedChildCount = children.length - base.children.length;
          break;
        }
        base.children.push(simplifyNode(child, depth + 1, counter, context));
      }
    }
  } else if ('children' in node && (node as ChildrenMixin).children.length > 0) {
    // At depth/count/time limit but has children — mark as truncated
    base.truncated = true;
    base.truncatedChildCount = (node as ChildrenMixin).children.length;
  }

  return base;
}

/** Simplify a page to compressed node list. */
export function simplifyPage(
  page: PageNode,
  maxNodes = 200,
  maxDepth?: number,
  timeBudgetMs?: number,
  detail?: SimplifyDetail,
  degradeDepth?: number,
): CompressedNode[] {
  const results: CompressedNode[] = [];
  const ctx = createContext(maxDepth, timeBudgetMs, detail, degradeDepth);
  for (const child of page.children) {
    if (results.length >= maxNodes) break;
    if (isOverBudget(ctx)) break;
    results.push(simplifyNode(child, 0, undefined, ctx));
  }
  return results;
}

// ─── Helpers ───

function simplifyPaint(paint: Paint): unknown {
  const base: Record<string, unknown> = {
    type: paint.type,
    visible: paint.visible,
    opacity: paint.opacity,
  };
  if (paint.type === 'SOLID') {
    const s = paint as SolidPaint;
    base.color = figmaRgbaToHex(s.color);
  }
  // Per-paint variable binding — modern Figma API binds color on the paint,
  // not on node.boundVariables.fills. Needed by hardcoded-token / spec-color
  // so they don't false-positive on correctly-bound paints (especially TEXT).
  const pbv = (paint as { boundVariables?: { color?: { type: string; id: string } } }).boundVariables;
  if (pbv?.color) {
    base.boundVariables = { color: { type: pbv.color.type, id: pbv.color.id } };
  }
  return base;
}

function simplifyEffect(effect: Effect): unknown {
  const base: Record<string, unknown> = {
    type: effect.type,
    visible: effect.visible,
  };
  if ('radius' in effect) {
    base.radius = (effect as DropShadowEffect).radius;
  }
  if ('color' in effect) {
    const e = effect as DropShadowEffect;
    base.color = figmaRgbaToHex(e.color);
    base.opacity = e.color.a;
  }
  if ('offset' in effect) {
    const e = effect as DropShadowEffect;
    base.offset = e.offset;
  }
  return base;
}

function simplifyBoundVariables(bv: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(bv)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && 'id' in (val as Record<string, unknown>)) {
      result[key] = { id: (val as Record<string, unknown>).id };
    } else if (Array.isArray(val)) {
      result[key] = val.map((v) => {
        if (v && typeof v === 'object' && 'id' in v) return { id: v.id };
        // Handle nested objects within arrays (e.g. fills array with bound variables)
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const nested = v as Record<string, unknown>;
          if ('id' in nested) return { id: nested.id };
          // Recursively simplify nested bound variable objects
          const simplified: Record<string, unknown> = {};
          for (const [nk, nv] of Object.entries(nested)) {
            if (nv && typeof nv === 'object' && !Array.isArray(nv) && 'id' in (nv as Record<string, unknown>)) {
              simplified[nk] = { id: (nv as Record<string, unknown>).id };
            } else {
              simplified[nk] = nv;
            }
          }
          return simplified;
        }
        return v;
      });
    } else {
      result[key] = val;
    }
  }
  return result;
}
