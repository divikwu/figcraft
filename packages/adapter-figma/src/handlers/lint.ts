/**
 * Lint handlers — check, fix, rules, annotations.
 *
 * Linter runs entirely in Plugin side (review correction #2).
 */

import type {
  AbstractNode,
  LintContext,
  LintReport,
  LintCategory as LintRuleCategory,
  LintViolation,
} from '@figcraft/quality-engine';
import { getAvailableRules, runLint } from '@figcraft/quality-engine';
import type { CompressedNode } from '@figcraft/shared';
import { createContext, simplifyNode } from '../adapters/node-simplifier.js';
import { LOCAL_LIBRARY } from '../constants.js';
import { registerHandler } from '../registry.js';
import { hexToFigmaRgb } from '../utils/color.js';
import { getAvailableLibraryCollectionsCached } from '../utils/design-context.js';
import type { DeferredStrategyHandler } from '../utils/fix-applicator.js';
import { applyFixDescriptor, builtInDeferredStrategies } from '../utils/fix-applicator.js';
import { findNodeByIdAsync } from '../utils/node-lookup.js';
import {
  ensureLoaded,
  getLibraryStyleIdSet,
  getLibraryStyleKeySet,
  getLibraryVariableIdSet,
  getLocalStyleIdSet,
  getLocalStyleIdSetForKeys,
  getTextStyleId,
} from '../utils/style-registry.js';
import { isRgbaLike, isVariableAlias, setSpacingProp } from '../utils/type-guards.js';
import { getCachedLang, getCachedModeLibrary } from './write-nodes.js';

// Cache last-built LintContext Maps to avoid redundant Map construction on repeated calls
// with the same tokenContext (common in iterative lint workflows).
let _cachedTokenContextKey: string | null = null;
let _cachedTokenMaps: Pick<
  LintContext,
  'colorTokens' | 'spacingTokens' | 'radiusTokens' | 'typographyTokens' | 'variableIds'
> | null = null;

export function registerLintHandlers(): void {
  registerHandler('lint_check', async (params) => {
    const nodeIds = params.nodeIds as string[] | undefined;
    const rules = params.rules as string[] | undefined;
    const categories = params.categories as string[] | undefined;
    const offset = params.offset as number | undefined;
    const limit = params.limit as number | undefined;
    const maxViolations = params.maxViolations as number | undefined;
    const annotate = params.annotate as boolean | undefined;
    const minSeverity = params.minSeverity as 'error' | 'unsafe' | 'heuristic' | 'style' | 'verbose' | undefined;

    // Token context (passed from MCP Server or loaded from cache)
    const tokenContext = params.tokenContext as
      | {
          colorTokens?: Record<string, string>;
          spacingTokens?: Record<string, number>;
          radiusTokens?: Record<string, number>;
          typographyTokens?: Record<string, { fontSize?: number; fontFamily?: string; fontWeight?: string }>;
          variableIds?: Record<string, string>;
        }
      | undefined;

    // Read current mode and selected library from cache (avoids repeated clientStorage reads)
    const [[currentMode, currentLibrary], currentLang] = await Promise.all([
      getCachedModeLibrary() as Promise<['library' | 'spec', string | undefined]>,
      getCachedLang(),
    ]);

    // Build lint context — cache Maps when tokenContext is unchanged (common in iterative workflows)
    const tokenContextKey = tokenContext ? JSON.stringify(tokenContext) : null;
    if (tokenContextKey !== _cachedTokenContextKey || _cachedTokenMaps === null) {
      _cachedTokenContextKey = tokenContextKey;
      _cachedTokenMaps = {
        colorTokens: new Map(Object.entries(tokenContext?.colorTokens ?? {})),
        spacingTokens: new Map(Object.entries(tokenContext?.spacingTokens ?? {})),
        radiusTokens: new Map(Object.entries(tokenContext?.radiusTokens ?? {})),
        typographyTokens: new Map(Object.entries(tokenContext?.typographyTokens ?? {})),
        variableIds: new Map(Object.entries(tokenContext?.variableIds ?? {})),
      };
    }
    const ctx: LintContext = {
      ..._cachedTokenMaps,
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

    // Collect nodes to lint
    let targetNodes: SceneNode[];
    let scope: { type: 'selection' | 'page'; count: number; names?: string[] };
    if (nodeIds && nodeIds.length > 0) {
      const resolved = await Promise.all(nodeIds.map((id) => findNodeByIdAsync(id)));
      targetNodes = resolved.filter(
        (n): n is SceneNode => n !== null && 'type' in n && n.type !== 'PAGE' && n.type !== 'DOCUMENT',
      );
      scope = { type: 'selection', count: targetNodes.length, names: targetNodes.slice(0, 5).map((n) => n.name) };
    } else {
      // Use selection, or fall back to current page children
      const selection = figma.currentPage.selection;
      if (selection.length > 0) {
        targetNodes = [...selection];
        scope = { type: 'selection', count: targetNodes.length, names: targetNodes.slice(0, 5).map((n) => n.name) };
      } else {
        // Default page-level scope: filter out remote library components.
        // Remote components are the library author's responsibility — auditing
        // them here produces noise for consumers with no authority to fix.
        // Local components (any publishStatus) are kept as-is: they're the
        // user's own work and worth scanning. Explicit selection (above)
        // bypasses this filter — user's intent always wins.
        targetNodes = [...figma.currentPage.children].filter((n) => {
          if (n.type !== 'COMPONENT' && n.type !== 'COMPONENT_SET') return true;
          return !(n as ComponentNode | ComponentSetNode).remote;
        });
        scope = { type: 'page', count: targetNodes.length };
      }
    }

    // Cap top-level nodes to prevent oversized payloads on huge pages
    const MAX_TOP_NODES = 200;
    let truncatedNodes = false;
    if (targetNodes.length > MAX_TOP_NODES) {
      targetNodes = targetNodes.slice(0, MAX_TOP_NODES);
      truncatedNodes = true;
    }

    // Convert to abstract nodes.
    // Lint rules depend on node-level boundVariables, componentPropertyDefinitions,
    // componentPropertyReferences, and text fontName/lineHeight/letterSpacing —
    // all gated behind `detail: 'full'` in the simplifier. Without this, rules
    // like hardcoded-token misreport violations after successful auto-fix (the
    // new binding is invisible to the next lint pass) and component-bindings
    // never triggers on real Figma data.
    const abstractNodes = targetNodes.map((n) =>
      compressedToAbstract(simplifyNode(n, 0, undefined, createContext(undefined, undefined, 'full'))),
    );

    // Enrich nodes with per-mode variable colors for dark mode contrast checks
    await enrichVariableModeColors(abstractNodes);

    // Run lint
    const report = runLint(abstractNodes, ctx, {
      rules,
      categories: categories as LintRuleCategory[] | undefined,
      offset,
      limit,
      maxViolations,
      minSeverity,
    });

    // Annotate if requested
    if (annotate) {
      await annotateViolations(report);
    }

    return { ...report, scope: { ...scope, pageName: figma.currentPage.name, truncated: truncatedNodes } };
  });

  // ─── Deferred fix strategies (async library lookups) ───

  const bindVariableToPaint: DeferredStrategyHandler = async (node, data) => {
    const variableId = data.variableId as string | undefined;
    const property = data.property as string;
    if (!variableId) return { fixed: false, error: 'No variableId' };
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (!variable || !('fills' in node)) return { fixed: false, error: 'Variable not found' };
    const geom = node as GeometryMixin;
    if (property === 'fills') {
      const rawFills = geom.fills;
      if (rawFills === figma.mixed) return { fixed: false, error: 'Mixed fills' };
      const fills = [...rawFills] as Paint[];
      if (fills.length > 0 && fills[0].type === 'SOLID') {
        fills[0] = figma.variables.setBoundVariableForPaint(fills[0] as SolidPaint, 'color', variable);
        geom.fills = fills;
        return { fixed: true };
      }
      // Gradient fills: Figma API doesn't support variable binding on gradient stops
      if (fills.length > 0 && fills[0].type.startsWith('GRADIENT_')) {
        return { fixed: false, error: 'Gradient fill — variable binding requires converting to solid fill first' };
      }
      if (fills.length > 0 && fills[0].type === 'IMAGE') {
        return { fixed: false, error: 'Image fill — variable binding not applicable' };
      }
    } else if (property === 'strokes') {
      const strokes = [...geom.strokes] as Paint[];
      if (strokes.length > 0 && strokes[0].type === 'SOLID') {
        strokes[0] = figma.variables.setBoundVariableForPaint(strokes[0] as SolidPaint, 'color', variable);
        geom.strokes = strokes;
        return { fixed: true };
      }
    }
    return { fixed: false, error: 'No bindable paint found' };
  };

  const libraryColorBind: DeferredStrategyHandler = async (node, data, libraryName) => {
    const hex = data.hex as string | null;
    const nodeType = data.nodeType as string | undefined;
    const property = (data.property as string | undefined) ?? 'fills';
    const targetOpacity = (data.opacity as number | undefined) ?? 1;
    if (!hex || !('fills' in node)) return { fixed: false, error: 'Missing hex or not a geometry node' };
    if (!libraryName) return { fixed: false, error: 'No library selected' };

    const targetRgb = hexToFigmaRgb(hex);
    const isTextNode = nodeType === 'TEXT' || node.type === 'TEXT';
    let bestVar: Variable | null = null;
    let bestDist = Infinity;
    let bestTextVar: Variable | null = null;
    let bestTextDist = Infinity;
    let bestTextIsPrimary = false;

    const evaluateVariable = (variable: Variable, c: RGBA | RGB) => {
      const a = 'a' in c ? c.a : 1;
      const dist =
        (c.r - targetRgb.r) ** 2 + (c.g - targetRgb.g) ** 2 + (c.b - targetRgb.b) ** 2 + (a - targetOpacity) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestVar = variable;
      }
      if (isTextNode) {
        const name = variable.name.toLowerCase();
        if (name.includes('text')) {
          const isPrimary = name.includes('primary') || name.endsWith('text/default') || name.endsWith('/900');
          if (dist < bestTextDist || (dist === bestTextDist && isPrimary && !bestTextIsPrimary)) {
            bestTextDist = dist;
            bestTextVar = variable;
            bestTextIsPrimary = isPrimary;
          }
        }
      }
    };

    if (libraryName === LOCAL_LIBRARY) {
      const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
      for (const col of localCollections) {
        for (const varId of col.variableIds) {
          const variable = await figma.variables.getVariableByIdAsync(varId);
          if (!variable || variable.resolvedType !== 'COLOR') continue;
          const modeId = col.modes[0]?.modeId;
          if (!modeId) continue;
          const val = variable.valuesByMode[modeId];
          if (!val || !isRgbaLike(val)) continue;
          evaluateVariable(variable, val);
        }
      }
    } else {
      const collections = await getAvailableLibraryCollectionsCached();
      const colorCols = collections.filter(
        (c) => c.name.toLowerCase().includes('color') || c.name.toLowerCase().includes('primitives'),
      );
      if (isTextNode) {
        colorCols.sort((a, b) => {
          const aIsPrim = a.name.toLowerCase().includes('primitives') ? 1 : 0;
          const bIsPrim = b.name.toLowerCase().includes('primitives') ? 1 : 0;
          return aIsPrim - bIsPrim;
        });
      }
      for (const col of colorCols) {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const lv of libVars) {
          if (lv.resolvedType !== 'COLOR') continue;
          try {
            const imported = await figma.variables.importVariableByKeyAsync(lv.key);
            const modeIds = Object.keys(imported.valuesByMode);
            if (modeIds.length === 0) continue;
            const val = imported.valuesByMode[modeIds[0]];
            let c: RGBA | null = null;
            if (isRgbaLike(val)) {
              c = val;
            } else if (isVariableAlias(val)) {
              try {
                const aliasId = val.id;
                let resolved = await figma.variables.getVariableByIdAsync(aliasId);
                if (!resolved) {
                  try {
                    resolved = await figma.variables.importVariableByKeyAsync(aliasId);
                  } catch {
                    /* skip */
                  }
                }
                if (resolved) {
                  const resModes = Object.keys(resolved.valuesByMode);
                  for (const rm of resModes) {
                    const resVal = resolved.valuesByMode[rm];
                    if (isRgbaLike(resVal)) {
                      c = resVal;
                      break;
                    }
                    if (isVariableAlias(resVal)) {
                      try {
                        const deepId = resVal.id;
                        let deep = await figma.variables.getVariableByIdAsync(deepId);
                        if (!deep) {
                          try {
                            deep = await figma.variables.importVariableByKeyAsync(deepId);
                          } catch {
                            /* skip */
                          }
                        }
                        if (deep) {
                          const deepModes = Object.keys(deep.valuesByMode);
                          if (deepModes.length > 0) {
                            const dv = deep.valuesByMode[deepModes[0]];
                            if (isRgbaLike(dv)) {
                              c = dv;
                              break;
                            }
                          }
                        }
                      } catch {
                        /* skip */
                      }
                    }
                  }
                }
              } catch {
                /* skip */
              }
            }
            if (!c) continue;
            evaluateVariable(imported, c);
          } catch {
            /* skip */
          }
        }
      }
    }

    const finalVar = isTextNode && bestTextVar && bestTextDist < 0.01 ? bestTextVar : bestVar;
    const finalDist = isTextNode && bestTextVar && bestTextDist < 0.01 ? bestTextDist : bestDist;

    if (finalVar && finalDist < 0.01) {
      const geom = node as GeometryMixin;
      if (property === 'strokes') {
        const strokes = [...geom.strokes] as Paint[];
        if (strokes.length > 0 && strokes[0].type === 'SOLID') {
          strokes[0] = figma.variables.setBoundVariableForPaint(strokes[0] as SolidPaint, 'color', finalVar);
          geom.strokes = strokes;
          return { fixed: true };
        }
        return { fixed: false, error: 'No solid stroke to bind' };
      }
      const rawFills = geom.fills;
      if (rawFills === figma.mixed) return { fixed: false, error: 'Mixed fills' };
      const fills = [...rawFills] as Paint[];
      if (fills.length > 0 && fills[0].type === 'SOLID') {
        fills[0] = figma.variables.setBoundVariableForPaint(fills[0] as SolidPaint, 'color', finalVar);
        geom.fills = fills;
        return { fixed: true };
      }
      return { fixed: false, error: 'No solid fill to bind' };
    }
    return { fixed: false, error: finalVar ? 'No close color match in library' : 'No color variables found' };
  };

  const libraryRadiusBind: DeferredStrategyHandler = async (node, data, libraryName) => {
    if (!('cornerRadius' in node)) return { fixed: false, error: 'No cornerRadius support' };
    const targetValue = data.value as number;
    const nodeName = (data.nodeName as string | undefined) || '';
    if (!libraryName) return { fixed: false, error: 'No library selected' };

    interface RadiusCandidate {
      variable: Variable;
      value: number;
      dist: number;
    }
    const candidates: RadiusCandidate[] = [];

    const resolveValue = async (variable: Variable): Promise<number | null> => {
      const modeIds = Object.keys(variable.valuesByMode);
      if (modeIds.length === 0) return null;
      let val = variable.valuesByMode[modeIds[0]];
      if (isVariableAlias(val)) {
        try {
          const resolved = await figma.variables.getVariableByIdAsync(val.id);
          if (resolved) {
            const resModes = Object.keys(resolved.valuesByMode);
            if (resModes.length > 0) val = resolved.valuesByMode[resModes[0]];
          }
        } catch {
          /* skip */
        }
      }
      return typeof val === 'number' ? val : null;
    };

    if (libraryName === LOCAL_LIBRARY) {
      const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
      for (const col of localCollections) {
        for (const varId of col.variableIds) {
          const variable = await figma.variables.getVariableByIdAsync(varId);
          if (!variable || variable.resolvedType !== 'FLOAT') continue;
          const scopes = variable.scopes;
          if (scopes.length > 0 && !scopes.includes('CORNER_RADIUS') && !scopes.includes('ALL_SCOPES')) continue;
          const val = await resolveValue(variable);
          if (val === null) continue;
          candidates.push({ variable, value: val, dist: Math.abs(val - targetValue) });
        }
      }
    } else {
      const collections = await getAvailableLibraryCollectionsCached();
      const radiusCols = collections.filter((c) => {
        const n = c.name.toLowerCase();
        return n.includes('round') || n.includes('radius') || n.includes('corner') || n.includes('border');
      });
      const searchCols = radiusCols.length > 0 ? radiusCols : collections;
      for (const col of searchCols) {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const lv of libVars) {
          if (lv.resolvedType !== 'FLOAT') continue;
          try {
            const imported = await figma.variables.importVariableByKeyAsync(lv.key);
            const val = await resolveValue(imported);
            if (val === null) continue;
            candidates.push({ variable: imported, value: val, dist: Math.abs(val - targetValue) });
          } catch {
            /* skip */
          }
        }
      }
    }

    const RADIUS_TOLERANCE = 4;
    const eligible = candidates.filter((c) => c.dist <= RADIUS_TOLERANCE);
    let picked: RadiusCandidate | null = null;
    if (eligible.length > 0) {
      const nodeKeywords = nodeName
        .toLowerCase()
        .split(/[\s/\-_|]+/)
        .filter((w) => w.length > 1);
      let bestScore = -1;
      let bestDistVal = Infinity;
      for (const c of eligible) {
        const varNameLower = c.variable.name.toLowerCase();
        let score = 0;
        for (const kw of nodeKeywords) {
          if (varNameLower.includes(kw)) score++;
        }
        if (score > bestScore || (score === bestScore && c.dist < bestDistVal)) {
          bestScore = score;
          bestDistVal = c.dist;
          picked = c;
        }
      }
    }

    if (picked) {
      if (picked.dist > 0) (node as RectangleNode).cornerRadius = picked.value;
      (node as SceneNode).setBoundVariable('cornerRadius' as VariableBindableNodeField, picked.variable);
      return { fixed: true };
    }
    const closest = candidates.length > 0 ? candidates.reduce((a, b) => (a.dist < b.dist ? a : b)) : null;
    return {
      fixed: false,
      error: closest ? `No close radius match (closest differs by ${closest.dist}px)` : 'No radius variables found',
    };
  };

  /** Infer semantic role from node name and ancestor names. */
  function inferTextRole(node: SceneNode): string[] {
    const keywords: string[] = [];
    const name = node.name.toLowerCase();
    let current: BaseNode | null = node.parent;
    const ancestorNames: string[] = [name];
    while (current && 'name' in current) {
      ancestorNames.push((current as SceneNode).name.toLowerCase());
      current = current.parent;
    }
    const combined = ancestorNames.join(' ');
    if (/heading|header|title|h[1-6]/.test(combined)) keywords.push('heading', 'title', 'header');
    if (/body|paragraph|content|description/.test(combined)) keywords.push('body', 'paragraph');
    if (/caption|label|subtitle|sub/.test(combined)) keywords.push('caption', 'label', 'subtitle');
    if (/button|cta|action/.test(combined)) keywords.push('button', 'label');
    if (/input|field|placeholder/.test(combined)) keywords.push('body', 'input');
    return keywords;
  }

  const libraryTextStyle: DeferredStrategyHandler = async (node, data, libraryName) => {
    const targetSize = data.fontSize as number | undefined;
    if (!targetSize || node.type !== 'TEXT') return { fixed: false, error: 'Missing fontSize or not a text node' };
    if (!libraryName) return { fixed: false, error: 'No library selected' };

    const roleKeywords = inferTextRole(node);

    interface StyleCandidate {
      style: TextStyle;
      sizeDist: number;
      semanticScore: number;
    }
    const candidates: StyleCandidate[] = [];

    const scoreStyle = (style: TextStyle): StyleCandidate => {
      const sizeDist = Math.abs(style.fontSize - targetSize);
      let semanticScore = 0;
      if (roleKeywords.length > 0) {
        const styleLower = style.name.toLowerCase();
        for (const kw of roleKeywords) {
          if (styleLower.includes(kw)) semanticScore++;
        }
      }
      return { style, sizeDist, semanticScore };
    };

    if (libraryName === LOCAL_LIBRARY) {
      const localStyles = await figma.getLocalTextStylesAsync();
      for (const style of localStyles) candidates.push(scoreStyle(style));
    } else {
      await ensureLoaded(libraryName);
      const match = getTextStyleId(targetSize);
      if (match) {
        const style = figma.getStyleById(match.id);
        if (style && style.type === 'TEXT') candidates.push(scoreStyle(style as TextStyle));
      }
      // Fallback: if style registry has no match (styles never registered via AI),
      // search remote text styles already imported into the file. These come from
      // team libraries and are the correct source for library-mode fixes.
      // Exclude non-remote (locally authored) styles to avoid the original bug
      // where local styles were incorrectly used to "fix" foreign-style violations.
      if (candidates.length === 0) {
        const allStyles = await figma.getLocalTextStylesAsync();
        for (const style of allStyles) {
          if (style.remote) candidates.push(scoreStyle(style));
        }
      }
    }

    // Pick best: prefer semantic match, then closest size
    const eligible = candidates.filter((c) => c.sizeDist <= 4);
    eligible.sort((a, b) => {
      if (b.semanticScore !== a.semanticScore) return b.semanticScore - a.semanticScore;
      return a.sizeDist - b.sizeDist;
    });

    const picked = eligible[0];
    if (picked) {
      (node as TextNode).textStyleId = picked.style.id;
      return { fixed: true };
    }
    const closest = candidates.length > 0 ? candidates.reduce((a, b) => (a.sizeDist < b.sizeDist ? a : b)) : null;
    return {
      fixed: false,
      error: closest
        ? `Closest text style differs by ${closest.sizeDist}px`
        : 'No text styles found — run sync_library_styles first',
    };
  };

  const librarySpacingBind: DeferredStrategyHandler = async (node, data, libraryName) => {
    const targetValue = data.value as number;
    const property = data.property as string;
    if (!targetValue || !property) return { fixed: false, error: 'Missing value or property' };
    if (!libraryName) return { fixed: false, error: 'No library selected' };
    if (!(property in node)) return { fixed: false, error: `Node has no ${property}` };

    interface SpacingCandidate {
      variable: Variable;
      value: number;
      dist: number;
    }
    const candidates: SpacingCandidate[] = [];

    const resolveValue = async (variable: Variable): Promise<number | null> => {
      const modeIds = Object.keys(variable.valuesByMode);
      if (modeIds.length === 0) return null;
      let val = variable.valuesByMode[modeIds[0]];
      if (isVariableAlias(val)) {
        try {
          const resolved = await figma.variables.getVariableByIdAsync(val.id);
          if (resolved) {
            const resModes = Object.keys(resolved.valuesByMode);
            if (resModes.length > 0) val = resolved.valuesByMode[resModes[0]];
          }
        } catch {
          /* skip */
        }
      }
      return typeof val === 'number' ? val : null;
    };

    const SPACING_SCOPES = ['GAP', 'ALL_SCOPES'];

    if (libraryName === LOCAL_LIBRARY) {
      const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
      for (const col of localCollections) {
        for (const varId of col.variableIds) {
          const variable = await figma.variables.getVariableByIdAsync(varId);
          if (!variable || variable.resolvedType !== 'FLOAT') continue;
          const scopes = variable.scopes;
          if (scopes.length > 0 && !scopes.some((s) => SPACING_SCOPES.includes(s))) continue;
          const val = await resolveValue(variable);
          if (val === null) continue;
          candidates.push({ variable, value: val, dist: Math.abs(val - targetValue) });
        }
      }
    } else {
      const collections = await getAvailableLibraryCollectionsCached();
      const spacingCols = collections.filter((c) => {
        const n = c.name.toLowerCase();
        return n.includes('spacing') || n.includes('space') || n.includes('gap') || n.includes('padding');
      });
      const searchCols = spacingCols.length > 0 ? spacingCols : collections;
      for (const col of searchCols) {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const lv of libVars) {
          if (lv.resolvedType !== 'FLOAT') continue;
          try {
            const imported = await figma.variables.importVariableByKeyAsync(lv.key);
            const val = await resolveValue(imported);
            if (val === null) continue;
            candidates.push({ variable: imported, value: val, dist: Math.abs(val - targetValue) });
          } catch {
            /* skip */
          }
        }
      }
    }

    const SPACING_TOLERANCE = 4;
    const exact = candidates.find((c) => c.dist === 0);
    const picked = exact ?? candidates.filter((c) => c.dist <= SPACING_TOLERANCE).sort((a, b) => a.dist - b.dist)[0];

    if (picked) {
      if (picked.dist > 0) setSpacingProp(node, property, picked.value);
      (node as SceneNode).setBoundVariable(property as VariableBindableNodeField, picked.variable);
      return { fixed: true };
    }
    const closest = candidates.length > 0 ? candidates.reduce((a, b) => (a.dist < b.dist ? a : b)) : null;
    return {
      fixed: false,
      error: closest ? `No close spacing match (closest differs by ${closest.dist}px)` : 'No spacing variables found',
    };
  };

  /** All deferred fix strategies keyed by strategy name. */
  const DEFERRED_STRATEGIES: Record<string, DeferredStrategyHandler> = {
    'bind-variable-to-paint': bindVariableToPaint,
    'library-color-bind': libraryColorBind,
    'library-radius-bind': libraryRadiusBind,
    'library-text-style': libraryTextStyle,
    'library-spacing-bind': librarySpacingBind,
    ...builtInDeferredStrategies,
  };

  // ─── lint_fix handler — unified via applyFixDescriptor ───

  registerHandler('lint_fix', async (params) => {
    const violations = params.violations as LintViolation[];
    const [, cachedLibraryName] = await getCachedModeLibrary();

    let fixed = 0;
    let failed = 0;
    const errors: Array<{ nodeId: string; error: string }> = [];
    let skippedHeuristic = 0;

    for (const v of violations) {
      if (!v.autoFixable) continue;
      // Note: previously skipped heuristic/style severity, but autoFixable + fixDescriptor
      // already indicates the rule author considers the fix safe. Only skip verbose.
      if (v.severity === 'verbose') {
        skippedHeuristic++;
        continue;
      }

      const descriptor = v.fixDescriptor;
      if (!descriptor) {
        failed++;
        errors.push({ nodeId: v.nodeId, error: `No fix descriptor for rule ${v.rule}` });
        continue;
      }

      try {
        const node = await findNodeByIdAsync(v.nodeId);
        if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT') {
          failed++;
          errors.push({ nodeId: v.nodeId, error: 'Node not found' });
          continue;
        }

        const result = await applyFixDescriptor(node as SceneNode, descriptor, {
          allowDeferred: true,
          deferredStrategies: DEFERRED_STRATEGIES,
          libraryName: cachedLibraryName,
        });

        if (result.fixed) {
          fixed++;
        } else {
          failed++;
          if (result.error) errors.push({ nodeId: v.nodeId, error: result.error });
        }
      } catch (err) {
        failed++;
        errors.push({ nodeId: v.nodeId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { fixed, failed, skippedHeuristic, errors };
  });

  registerHandler('lint_rules', async () => {
    return { rules: getAvailableRules() };
  });

  registerHandler('clear_annotations', async (params) => {
    const nodeIds = params.nodeIds as string[] | undefined;
    const targets = nodeIds
      ? ((await Promise.all(nodeIds.map((id) => findNodeByIdAsync(id)))).filter(Boolean) as SceneNode[])
      : [...figma.currentPage.children];

    const MAX_DEPTH = 10;
    let cleared = 0;
    function walk(node: SceneNode, depth = 0) {
      if (depth > MAX_DEPTH) return;
      if ('annotations' in node) {
        const annotated = node as SceneNode & { annotations: unknown[] };
        if (annotated.annotations.length > 0) {
          annotated.annotations = [];
          cleared++;
        }
      }
      if ('children' in node) {
        for (const child of (node as ChildrenMixin).children) {
          walk(child, depth + 1);
        }
      }
    }
    for (const target of targets) {
      walk(target);
    }

    return { cleared };
  });
} // registerLintHandlers

// ─── Variable mode color enrichment for dark mode contrast checks ───

function rgbaToHex(color: { r: number; g: number; b: number }): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

/**
 * Enrich AbstractNodes with per-mode resolved colors from bound variables.
 * This enables wcag-contrast to check contrast in all variable modes (light/dark).
 * Best-effort: failures are silently skipped.
 */
async function enrichVariableModeColors(nodes: AbstractNode[]): Promise<void> {
  // Collect all variable IDs referenced by fills
  const varIds = new Set<string>();
  function collectVarIds(node: AbstractNode): void {
    const bv = node.boundVariables as Record<string, { id?: string } | Array<{ id?: string }>> | undefined;
    if (bv) {
      // fills may be array of bindings or single binding
      const fillBindings = bv.fills ?? bv['fills[0]'];
      if (fillBindings) {
        const bindings = Array.isArray(fillBindings) ? fillBindings : [fillBindings];
        for (const b of bindings) {
          if (b?.id) varIds.add(b.id);
        }
      }
    }
    if (node.children) node.children.forEach(collectVarIds);
  }
  nodes.forEach(collectVarIds);

  if (varIds.size === 0) return;

  // Resolve each variable's per-mode colors
  const modeColorMap = new Map<string, Record<string, string>>(); // varId → { modeName: hex }
  try {
    for (const varId of varIds) {
      const variable = await figma.variables.getVariableByIdAsync(varId);
      if (!variable || variable.resolvedType !== 'COLOR') continue;
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      if (!collection || collection.modes.length < 2) continue; // only multi-mode variables

      const modeColors: Record<string, string> = {};
      for (const mode of collection.modes) {
        const value = variable.valuesByMode[mode.modeId];
        if (value && typeof value === 'object' && 'r' in value) {
          modeColors[mode.name] = rgbaToHex(value as { r: number; g: number; b: number });
        }
      }
      if (Object.keys(modeColors).length >= 2) {
        modeColorMap.set(varId, modeColors);
      }
    }
  } catch {
    return; // best-effort
  }

  if (modeColorMap.size === 0) return;

  // Attach mode colors to nodes
  function attachModeColors(node: AbstractNode): void {
    const bv = node.boundVariables as Record<string, { id?: string } | Array<{ id?: string }>> | undefined;
    if (bv) {
      const fillBindings = bv.fills ?? bv['fills[0]'];
      if (fillBindings) {
        const bindings = Array.isArray(fillBindings) ? fillBindings : [fillBindings];
        for (const b of bindings) {
          if (b?.id && modeColorMap.has(b.id)) {
            node.variableModeColors = modeColorMap.get(b.id);
            break;
          }
        }
      }
    }
    if (node.children) node.children.forEach(attachModeColors);
  }
  nodes.forEach(attachModeColors);
}

// ─── Helpers ───

function compressedToAbstract(node: CompressedNode): AbstractNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    role: node.role,
    fills: node.fills as AbstractNode['fills'],
    strokes: node.strokes as AbstractNode['strokes'],
    cornerRadius: node.cornerRadius,
    fontSize: node.fontSize,
    fontName: node.fontName as AbstractNode['fontName'],
    lineHeight: node.lineHeight,
    letterSpacing: node.letterSpacing,
    opacity: node.opacity,
    width: node.width,
    height: node.height,
    layoutMode: node.layoutMode,
    layoutPositioning: node.layoutPositioning,
    itemSpacing: node.itemSpacing,
    paddingLeft: node.paddingLeft,
    paddingRight: node.paddingRight,
    paddingTop: node.paddingTop,
    paddingBottom: node.paddingBottom,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    clipsContent: node.clipsContent,
    strokeWeight: node.strokeWeight,
    layoutAlign: node.layoutAlign,
    overflowDirection: node.overflowDirection,
    x: node.x,
    y: node.y,
    characters: node.characters,
    textAutoResize: node.textAutoResize,
    textTruncation: node.textTruncation,
    maxLines: node.maxLines,
    boundVariables: node.boundVariables,
    fillStyleId: node.fillStyleId,
    strokeStyleId: node.strokeStyleId,
    textStyleId: node.textStyleId,
    effectStyleId: node.effectStyleId,
    fillStyleKey: node.fillStyleKey,
    strokeStyleKey: node.strokeStyleKey,
    textStyleKey: node.textStyleKey,
    effectStyleKey: node.effectStyleKey,
    fillStyleRemote: node.fillStyleRemote,
    strokeStyleRemote: node.strokeStyleRemote,
    textStyleRemote: node.textStyleRemote,
    effectStyleRemote: node.effectStyleRemote,
    effects: node.effects as AbstractNode['effects'],
    componentPropertyDefinitions: node.componentPropertyDefinitions,
    componentPropertyReferences: node.componentPropertyReferences,
    lintIgnore: node.lintIgnore,
    visible: node.visible,
    // Hidden children are stripped here so rules that peek `node.children` inherit
    // the same "hidden is invisible to lint" invariant the engine walk enforces.
    children: node.children?.filter((c) => c.visible !== false).map(compressedToAbstract),
  };
}

async function annotateViolations(report: LintReport): Promise<void> {
  // Group violations by nodeId so each node gets a single merged annotation
  const grouped = new Map<string, string[]>();
  for (const category of report.categories) {
    for (const violation of category.nodes) {
      const list = grouped.get(violation.nodeId);
      if (list) {
        list.push(violation.suggestion);
      } else {
        grouped.set(violation.nodeId, [violation.suggestion]);
      }
    }
  }

  for (const [nodeId, suggestions] of grouped) {
    const node = await findNodeByIdAsync(nodeId);
    if (!node || !('annotations' in node)) continue;
    const annotated = node as SceneNode & {
      annotations: Array<{ label: string }>;
    };
    // Remove previous FigCraft annotations to avoid stacking on re-runs
    const kept = (annotated.annotations || []).filter(
      (a) => !a.label.startsWith('[FigCraft]') && !a.label.startsWith('[figcraft]'),
    );
    const label =
      suggestions.length === 1
        ? `[FigCraft] ${suggestions[0]}`
        : `[FigCraft] ${suggestions.map((s) => `• ${s}`).join(' | ')}`;
    annotated.annotations = [...kept, { label }];
  }
}
