/**
 * Inline lint helpers — run lint entirely within the plugin sandbox,
 * avoiding bridge round-trips for lint_check → lint_fix → lint_check.
 *
 * Key optimization: converts Figma nodes directly to AbstractNode,
 * skipping the simplifyNode → CompressedNode → compressedToAbstract chain.
 */

import type { AbstractNode, LintContext, LintOptions, LintViolation } from '@figcraft/quality-engine';
import { runLint } from '@figcraft/quality-engine';
import { PLUGIN_DATA_KEYS } from '../constants.js';
import { registerCache } from '../utils/cache-manager.js';
import { figmaRgbaToHex } from '../utils/color.js';
import { applyFixDescriptor, builtInDeferredStrategies } from '../utils/fix-applicator.js';
import {
  ensureLoaded,
  getLibraryStyleIdSet,
  getLibraryStyleKeySet,
  getLibraryVariableIdSet,
  getLocalStyleIdSet,
  getLocalStyleIdSetForKeys,
} from '../utils/style-registry.js';
import { getCachedLang, getCachedModeLibrary } from './write-nodes.js';

/**
 * Map from validateTree/inferStructure rule names to quality-engine rule names.
 * Used to build skipRules set so quality-engine doesn't re-check rules
 * already handled by pre-creation validation.
 */
export const PRE_RULE_TO_LINT_RULE: Record<string, string> = {
  'button-structure-pre': 'button-structure',
  'input-structure-pre': 'input-field-structure',
  'hug-stretch-paradox': 'unbounded-hug',
  'form-consistency-pre': 'form-consistency',
  'screen-shell-pre': 'screen-shell-invalid',
  'system-bar-fullbleed-pre': 'system-bar-fullbleed',
  'cta-width-pre': 'cta-width-inconsistent',
  'mobile-dimensions-pre': 'mobile-dimensions',
  'no-spacer-frame': 'spacer-frame',
  'no-autolayout-multi-children': 'no-autolayout',
};

function getStyleMeta(styleId: string): { key?: string; remote?: boolean } {
  try {
    const style = figma.getStyleById(styleId);
    return { key: style?.key, remote: style?.remote };
  } catch {
    return {};
  }
}

/**
 * Convert a Figma SceneNode directly to AbstractNode for quality-engine.
 * Skips the intermediate CompressedNode serialization step.
 */
export function figmaNodeToAbstract(node: SceneNode): AbstractNode {
  const result: AbstractNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Role from plugin data
  try {
    const role = node.getPluginData(PLUGIN_DATA_KEYS.ROLE);
    if (role) result.role = role;
  } catch {
    /* ignore */
  }

  // Geometry
  if ('width' in node) result.width = (node as any).width;
  if ('height' in node) result.height = (node as any).height;
  if ('x' in node) result.x = (node as any).x;
  if ('y' in node) result.y = (node as any).y;
  if ('opacity' in node) result.opacity = (node as any).opacity;

  // Visibility — engine skips hidden subtrees via `node.visible === false`.
  // Without copying this, designers' hidden layers (alt states, reference-only
  // content) get linted and surface as noise.
  if ('visible' in node) result.visible = (node as any).visible;

  // Fills
  if ('fills' in node) {
    const fills = (node as any).fills;
    if (fills !== figma.mixed && Array.isArray(fills)) {
      result.fills = fills.map((f: Paint) => {
        const entry: AbstractNode['fills'] extends (infer T)[] | undefined ? T : never = {
          type: f.type,
          visible: f.visible,
        };
        if (f.type === 'SOLID') {
          const solid = f as SolidPaint;
          entry.color = figmaRgbaToHex({
            r: solid.color.r,
            g: solid.color.g,
            b: solid.color.b,
          });
          entry.opacity = solid.opacity;
        }
        // Per-paint variable binding — modern Figma API binds on the paint,
        // not on node.boundVariables.fills. Critical for TEXT fills (text/primary,
        // text/secondary, etc.) which are always bound this way.
        const pbv = (f as { boundVariables?: { color?: { type: string; id: string } } }).boundVariables;
        if (pbv?.color) {
          entry.boundVariables = { color: { type: pbv.color.type, id: pbv.color.id } };
        }
        return entry;
      });
    }
  }

  // Strokes
  if ('strokes' in node) {
    const strokes = (node as any).strokes;
    if (Array.isArray(strokes)) {
      result.strokes = strokes.map((s: Paint) => {
        const entry: any = { type: s.type, visible: s.visible };
        if (s.type === 'SOLID') {
          const solid = s as SolidPaint;
          entry.color = figmaRgbaToHex({
            r: solid.color.r,
            g: solid.color.g,
            b: solid.color.b,
            a: solid.opacity ?? 1,
          });
        }
        return entry;
      });
    }
  }

  // Corner radius
  if ('cornerRadius' in node) {
    const cr = (node as any).cornerRadius;
    if (cr !== figma.mixed) result.cornerRadius = cr;
  }

  // Stroke weight
  if ('strokeWeight' in node) {
    const sw = (node as any).strokeWeight;
    if (sw !== figma.mixed) result.strokeWeight = sw;
  }

  // Layout
  if ('layoutMode' in node) result.layoutMode = (node as any).layoutMode;
  if ('layoutPositioning' in node) result.layoutPositioning = (node as any).layoutPositioning;
  if ('itemSpacing' in node) result.itemSpacing = (node as any).itemSpacing;
  if ('paddingLeft' in node) result.paddingLeft = (node as any).paddingLeft;
  if ('paddingRight' in node) result.paddingRight = (node as any).paddingRight;
  if ('paddingTop' in node) result.paddingTop = (node as any).paddingTop;
  if ('paddingBottom' in node) result.paddingBottom = (node as any).paddingBottom;
  if ('primaryAxisAlignItems' in node) result.primaryAxisAlignItems = (node as any).primaryAxisAlignItems;
  if ('counterAxisAlignItems' in node) result.counterAxisAlignItems = (node as any).counterAxisAlignItems;
  if ('clipsContent' in node) result.clipsContent = (node as any).clipsContent;
  if ('layoutAlign' in node) result.layoutAlign = (node as any).layoutAlign;
  if ('overflowDirection' in node) {
    const od = (node as any).overflowDirection;
    if (od && od !== 'NONE') result.overflowDirection = od;
  }

  // Text
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    result.characters = textNode.characters;
    if (textNode.fontSize !== figma.mixed) result.fontSize = textNode.fontSize as number;
    if (textNode.fontName !== figma.mixed) {
      result.fontName = {
        family: (textNode.fontName as FontName).family,
        style: (textNode.fontName as FontName).style,
      };
    }
    result.lineHeight = textNode.lineHeight;
    result.letterSpacing = textNode.letterSpacing;
    result.textAutoResize = textNode.textAutoResize;
    if ('textTruncation' in textNode && textNode.textTruncation) {
      result.textTruncation = textNode.textTruncation;
    }
    if ('maxLines' in textNode) {
      result.maxLines = (textNode as TextNode).maxLines;
    }
  }

  // Bindings
  result.boundVariables = (node as any).boundVariables ?? {};
  if ('fillStyleId' in node) {
    const fsi = (node as any).fillStyleId;
    if (fsi && fsi !== figma.mixed) {
      const meta = getStyleMeta(fsi);
      result.fillStyleId = fsi;
      result.fillStyleKey = meta.key;
      result.fillStyleRemote = meta.remote;
    }
  }
  if ('strokeStyleId' in node) {
    const ssi = (node as any).strokeStyleId;
    if (ssi && ssi !== figma.mixed) {
      const meta = getStyleMeta(ssi);
      result.strokeStyleId = ssi;
      result.strokeStyleKey = meta.key;
      result.strokeStyleRemote = meta.remote;
    }
  }
  if ('textStyleId' in node) {
    const tsi = (node as any).textStyleId;
    if (tsi && tsi !== figma.mixed) {
      const meta = getStyleMeta(tsi);
      result.textStyleId = tsi;
      result.textStyleKey = meta.key;
      result.textStyleRemote = meta.remote;
    }
  }
  if ('effectStyleId' in node) {
    const esi = (node as any).effectStyleId;
    if (esi && esi !== figma.mixed) {
      const meta = getStyleMeta(esi);
      result.effectStyleId = esi;
      result.effectStyleKey = meta.key;
      result.effectStyleRemote = meta.remote;
    }
  }

  // Component properties
  if ('componentPropertyDefinitions' in node) {
    result.componentPropertyDefinitions = (node as any).componentPropertyDefinitions;
  }
  if ('componentPropertyReferences' in node) {
    result.componentPropertyReferences = (node as any).componentPropertyReferences;
  }

  // Children — hidden siblings stripped to mirror compressedToAbstract and keep
  // rules that peek `node.children` consistent with the engine's hidden-subtree skip.
  if ('children' in node) {
    const children = (node as any).children as SceneNode[];
    result.children = children.filter((c) => c.visible !== false).map(figmaNodeToAbstract);
  }

  return result;
}

/**
 * Cached lint context — avoids repeated figma.clientStorage.getAsync calls
 * during multi-pass lint flows where multiple lint passes run in quick succession.
 * Cache is invalidated after 30s (same TTL as getCachedModeLibrary).
 */
let _cachedLintCtx: LintContext | null = null;
let _lintCtxTimestamp = 0;
const LINT_CTX_TTL_MS = 30_000;

/** Invalidate the cached lint context (call when mode/library changes). */
export function invalidateLintContextCache(): void {
  _cachedLintCtx = null;
  _lintCtxTimestamp = 0;
}

// Register with centralized cache manager
registerCache('lint-context', invalidateLintContextCache);

/**
 * Build a LintContext from plugin storage (runs entirely in plugin sandbox).
 * Mirrors the logic in lint.ts lint_check handler but without bridge round-trip.
 *
 * Uses a 30s TTL cache to avoid repeated figma.clientStorage.getAsync calls
 * during multi-pass lint flows (e.g. scoped lint + final lint).
 */
export async function buildLintContextFromStorage(): Promise<LintContext> {
  const now = Date.now();
  if (_cachedLintCtx !== null && now - _lintCtxTimestamp < LINT_CTX_TTL_MS) {
    return _cachedLintCtx;
  }

  const [[currentMode, currentLibrary], currentLang] = await Promise.all([
    getCachedModeLibrary() as Promise<['library' | 'spec', string | undefined]>,
    getCachedLang(),
  ]);

  // In inline lint we don't have tokenContext from MCP — use empty maps.
  // Token-based rules (spec-color, hardcoded-token, etc.) will be filtered
  // out entirely by the engine when no tokens AND no library is selected,
  // which is acceptable for post-create lint (no authoritative source to
  // check against).
  const ctx: LintContext = {
    colorTokens: new Map(),
    spacingTokens: new Map(),
    radiusTokens: new Map(),
    typographyTokens: new Map(),
    variableIds: new Map(),
    mode: currentMode,
    selectedLibrary: currentLibrary || null,
    lang: currentLang,
  };

  // Populate libraryStyleIds for foreign-style rule (library mode only)
  if (currentMode === 'library' && currentLibrary) {
    await ensureLoaded(currentLibrary);
    let styleIds = getLibraryStyleIdSet();
    const styleKeys = getLibraryStyleKeySet();
    if (styleKeys.size > 0) {
      for (const id of await getLocalStyleIdSetForKeys(styleKeys)) styleIds.add(id);
      ctx.libraryStyleKeys = styleKeys;
    }
    // Fallback: if style registry is empty (styles never registered via AI),
    // collect local style IDs (includes imported library styles) as baseline.
    if (styleIds.size === 0) {
      styleIds = await getLocalStyleIdSet();
    }
    if (styleIds.size > 0) {
      ctx.libraryStyleIds = styleIds;
    }

    // Populate libraryVariableIds for foreign-variable rule
    const variableIds = await getLibraryVariableIdSet(currentLibrary);
    if (variableIds.size > 0) {
      ctx.libraryVariableIds = variableIds;
    }
  }

  _cachedLintCtx = ctx;
  _lintCtxTimestamp = now;
  return ctx;
}

/**
 * Apply a single lint violation fix directly on a Figma node.
 * Delegates to the generic applyFixDescriptor, skipping deferred fixes
 * (library lookups are too expensive for inline mode).
 *
 * Returns true if fix was applied, false otherwise.
 */
async function applyFixDirect(node: SceneNode, violation: LintViolation): Promise<{ fixed: boolean; error?: string }> {
  if (!violation.autoFixable || !violation.fixDescriptor) {
    return { fixed: false };
  }

  return applyFixDescriptor(node, violation.fixDescriptor, {
    allowDeferred: true,
    deferredStrategies: builtInDeferredStrategies,
  });
}

/** Build a node ID → SceneNode map from created node IDs. */
function buildNodeMap(nodeIds: string[]): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const id of nodeIds) {
    const node = figma.getNodeById(id);
    if (node && 'type' in node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      map.set(id, node as SceneNode);
    }
  }
  return map;
}

/** Lightweight lint summary for post-creation feedback (no fixing, minimal overhead). */
export interface QuickLintSummary {
  violations: number;
  autoFixable: number;
  topIssues: Array<{ rule: string; count: number; severity: string }>;
  /** Component reuse suggestions — existing components that match created nodes. */
  componentSuggestions?: Array<{ nodeName: string; componentName: string; componentId: string; isSet: boolean }>;
}

/**
 * Run a lightweight lint scan on a node and return a summary.
 * Does NOT fix anything — just counts violations and top issues.
 * Returns null if no violations found (to avoid bloating the response).
 */
export async function quickLintSummary(
  nodeId: string,
  autoFix = false,
  skipRules?: Set<string>,
): Promise<QuickLintSummary | null> {
  const node = figma.getNodeById(nodeId);
  if (!node || !('type' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') return null;

  const ctx = await buildLintContextFromStorage();
  const abstractNode = figmaNodeToAbstract(node as SceneNode);
  const report = runLint([abstractNode], ctx, {
    maxViolations: 20,
    minSeverity: 'heuristic',
    skipRules,
  });

  if (report.summary.violations === 0) return null;

  const allViolations = report.categories.flatMap((c) => c.nodes);
  const autoFixable = allViolations.filter((v) => v.autoFixable).length;

  // ── Auto-fix deterministic layout issues (no library lookups) ──
  let autoFixed = 0;
  if (autoFix && autoFixable > 0) {
    const fixableViolations = allViolations.filter((v) => v.autoFixable && v.fixDescriptor);
    for (const v of fixableViolations) {
      // Skip deferred fixes (library lookups) — too expensive for inline mode
      if (v.fixDescriptor!.kind === 'deferred') continue;
      // Skip heuristic/style severity — these are guesses that risk breaking layouts
      if (v.severity === 'heuristic' || v.severity === 'style') continue;
      const fixNode = figma.getNodeById(v.nodeId);
      if (!fixNode || !('type' in fixNode)) continue;
      const result = await applyFixDirect(fixNode as SceneNode, v);
      if (result.fixed) autoFixed++;
    }
  }

  // Top issues: grouped by rule, sorted by count descending, max 5
  const topIssues = report.categories
    .map((c) => ({ rule: c.rule, count: c.count, severity: c.nodes[0]?.severity ?? 'heuristic' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── Component reuse suggestions ──
  // Check if any child node names match existing components (lightweight scan)
  const suggestions: QuickLintSummary['componentSuggestions'] = [];
  try {
    const sceneNode = node as SceneNode;
    if ('children' in sceneNode) {
      const childNames = new Set<string>();
      for (const child of (sceneNode as FrameNode).children) {
        childNames.add(child.name.toLowerCase());
      }
      if (childNames.size > 0) {
        // Walk page-level components (shallow — only top-level and their direct children)
        for (const pageChild of figma.currentPage.children) {
          if (pageChild.type === 'COMPONENT' || pageChild.type === 'COMPONENT_SET') {
            const compName = pageChild.name.toLowerCase();
            for (const cn of childNames) {
              if (compName === cn || compName.includes(cn) || cn.includes(compName)) {
                suggestions.push({
                  nodeName: cn,
                  componentName: pageChild.name,
                  componentId: pageChild.id,
                  isSet: pageChild.type === 'COMPONENT_SET',
                });
                break;
              }
            }
            if (suggestions.length >= 3) break; // limit suggestions
          }
        }
      }
    }
  } catch {
    /* component scan is best-effort */
  }

  const result: QuickLintSummary = {
    violations: autoFix ? report.summary.violations - autoFixed : report.summary.violations,
    autoFixable: autoFix ? autoFixable - autoFixed : autoFixable,
    topIssues,
  };
  if (autoFixed > 0) (result as any).autoFixed = autoFixed;
  if (suggestions.length > 0) result.componentSuggestions = suggestions;
  return result;
}

export interface InlineLintResult {
  initial: { total: number; pass: number; violations: number; bySeverity: Record<string, number> };
  fixable: number;
  fixed: number;
  fixFailed: number;
  remaining: number;
  final: { total: number; pass: number; violations: number; bySeverity: Record<string, number> };
  scopedNodeIds: string[];
  fixErrors?: Array<{ nodeId: string; error: string }>;
  remainingViolations?: LintViolation[];
}

/**
 * Run lint + fix entirely within the plugin sandbox.
 * Replaces the 3-call bridge round-trip: lint_check → lint_fix → lint_check.
 *
 * @param rootNodeIds - IDs of root nodes to lint (typically createdRootIds)
 * @param options.skipRules - Rule names to skip (already handled by pre-creation validation)
 * @param options.maxViolations - Max violations to collect
 * @param options.includeRemainingViolations - Include remaining violations in result
 * @param options.minSeverity - Minimum severity to include
 */
export async function runInlineLintAndFix(
  rootNodeIds: string[],
  options: {
    skipRules?: Set<string>;
    maxViolations?: number;
    includeRemainingViolations?: boolean;
    minSeverity?: 'error' | 'unsafe' | 'heuristic' | 'style' | 'verbose';
  } = {},
): Promise<InlineLintResult> {
  const ctx = await buildLintContextFromStorage();

  // Collect root SceneNodes
  const rootNodes: SceneNode[] = [];
  for (const id of rootNodeIds) {
    const node = figma.getNodeById(id);
    if (node && 'type' in node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      rootNodes.push(node as SceneNode);
    }
  }

  if (rootNodes.length === 0) {
    const empty = {
      total: 0,
      pass: 0,
      violations: 0,
      bySeverity: { error: 0, unsafe: 0, heuristic: 0, style: 0, verbose: 0 },
    };
    return {
      initial: empty,
      fixable: 0,
      fixed: 0,
      fixFailed: 0,
      remaining: 0,
      final: empty,
      scopedNodeIds: rootNodeIds,
    };
  }

  // Convert Figma nodes directly to AbstractNode (skip CompressedNode intermediate)
  const abstractNodes = rootNodes.map(figmaNodeToAbstract);

  // Run initial lint
  const lintOptions: LintOptions = {
    maxViolations: options.maxViolations ?? 200,
    minSeverity: options.minSeverity ?? 'heuristic',
    skipRules: options.skipRules,
  };
  const initialReport = runLint(abstractNodes, ctx, lintOptions);

  // Collect fixable violations
  const allViolations = initialReport.categories.flatMap((c) => c.nodes);
  const fixable = allViolations.filter((v) => v.autoFixable);

  const initialSummary = {
    total: initialReport.summary.total,
    pass: initialReport.summary.pass,
    violations: initialReport.summary.violations,
    bySeverity: initialReport.summary.bySeverity,
  };

  // P0 optimization: if nothing is fixable, skip the fix loop, re-conversion, and re-lint entirely.
  // The final state is identical to the initial state when no fixes can be applied.
  if (fixable.length === 0) {
    const result: InlineLintResult = {
      initial: initialSummary,
      fixable: 0,
      fixed: 0,
      fixFailed: 0,
      remaining: initialReport.summary.violations,
      final: initialSummary,
      scopedNodeIds: rootNodeIds,
    };
    if (options.includeRemainingViolations) {
      result.remainingViolations = allViolations;
    }
    return result;
  }

  // Build node map for direct access
  const allNodeIds = new Set<string>();
  function collectIds(node: AbstractNode) {
    allNodeIds.add(node.id);
    node.children?.forEach(collectIds);
  }
  abstractNodes.forEach(collectIds);
  const nodeMap = buildNodeMap([...allNodeIds]);

  // Apply fixes directly on Figma nodes
  let fixed = 0;
  let fixFailed = 0;
  const fixErrors: Array<{ nodeId: string; error: string }> = [];

  for (const violation of fixable) {
    const node = nodeMap.get(violation.nodeId);
    if (!node) {
      fixFailed++;
      fixErrors.push({ nodeId: violation.nodeId, error: 'Node not found in map' });
      continue;
    }
    const fixResult = await applyFixDirect(node, violation);
    if (fixResult.fixed) {
      fixed++;
    } else {
      fixFailed++;
      if (fixResult.error) {
        fixErrors.push({ nodeId: violation.nodeId, error: fixResult.error });
      }
    }
  }

  // Re-lint after fixes (re-convert nodes since they've been mutated)
  const finalAbstractNodes = rootNodes.map(figmaNodeToAbstract);
  const finalReport = runLint(finalAbstractNodes, ctx, lintOptions);

  const result: InlineLintResult = {
    initial: initialSummary,
    fixable: fixable.length,
    fixed,
    fixFailed,
    remaining: finalReport.summary.violations,
    final: {
      total: finalReport.summary.total,
      pass: finalReport.summary.pass,
      violations: finalReport.summary.violations,
      bySeverity: finalReport.summary.bySeverity,
    },
    scopedNodeIds: rootNodeIds,
  };

  if (fixErrors.length > 0) {
    result.fixErrors = fixErrors;
  }

  if (options.includeRemainingViolations) {
    result.remainingViolations = finalReport.categories.flatMap((c) => c.nodes);
  }

  return result;
}
