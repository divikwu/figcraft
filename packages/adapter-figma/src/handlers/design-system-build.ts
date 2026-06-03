/**
 * Design System Build handlers — tools for building complete component libraries.
 *
 * P0 tools (flow-critical):
 *   - create_text_style: Create a new text style from params
 *   - create_effect_style: Create a new effect style from params
 *   - set_variable_code_syntax: Set code syntax on a variable (WEB/ANDROID/iOS)
 *   - layout_component_set: Auto-grid-layout variants after combineAsVariants
 *   - bind_component_property: Wire component property to child nodes
 *
 * P1 tools (efficiency):
 *   - batch_set_variable_binding: Bind variables to multiple nodes in one call
 *   - set_variable_values_multi_mode: Set a variable's value across multiple modes
 */

import { registerHandler } from '../registry.js';
import { hexToFigmaRgba } from '../utils/color.js';
import { resolveWeight } from '../utils/font-weight.js';
import { assertHandler, HandlerError } from '../utils/handler-error.js';
import { findNodeByIdAsync } from '../utils/node-lookup.js';
import { isVariableAlias } from '../utils/type-guards.js';
import { type ApplyIconColorResult, applyIconColor } from './icon-svg.js';
import { getCachedModeLibrary, resolveFontAsync } from './write-nodes.js';

export function registerDesignSystemBuildHandlers(): void {
  // ═══════════════════════════════════════════════════════════════
  // P0-1: create_text_style
  // ═══════════════════════════════════════════════════════════════

  registerHandler('create_text_style', async (params) => {
    const name = params.name as string;
    const fontFamily = (params.fontFamily as string) ?? 'Inter';
    const fontStyle = params.fontStyle as string | undefined;
    const fontWeight = params.fontWeight as number | string | undefined;
    const fontSize = params.fontSize as number | undefined;
    const lineHeight = params.lineHeight as number | string | undefined;
    const letterSpacing = params.letterSpacing as number | string | undefined;
    const description = params.description as string | undefined;

    assertHandler(name, 'name is required');

    // Check for existing style with same name (idempotent)
    const existing = (await figma.getLocalTextStylesAsync()).find((s) => s.name === name);
    if (existing) {
      return { id: existing.id, name: existing.name, fontSize: existing.fontSize, alreadyExists: true };
    }

    const style = figma.createTextStyle();
    style.name = name;
    if (description) style.description = description;

    try {
      // Resolve font style from fontStyle or fontWeight
      const resolvedStyle = fontStyle ?? resolveWeight(fontWeight);
      const { fontName, fallbackNote } = await resolveFontAsync(fontFamily, resolvedStyle);
      style.fontName = fontName;

      if (fontSize != null) style.fontSize = fontSize;

      if (lineHeight != null) {
        if (typeof lineHeight === 'string' && lineHeight.endsWith('%')) {
          style.lineHeight = { value: parseFloat(lineHeight), unit: 'PERCENT' };
        } else if (typeof lineHeight === 'string' && lineHeight === 'AUTO') {
          style.lineHeight = { unit: 'AUTO' };
        } else {
          style.lineHeight = {
            value: typeof lineHeight === 'number' ? lineHeight : parseFloat(String(lineHeight)),
            unit: 'PIXELS',
          };
        }
      }

      if (letterSpacing != null) {
        if (typeof letterSpacing === 'string' && letterSpacing.endsWith('%')) {
          style.letterSpacing = { value: parseFloat(letterSpacing), unit: 'PERCENT' };
        } else {
          style.letterSpacing = {
            value: typeof letterSpacing === 'number' ? letterSpacing : parseFloat(String(letterSpacing)),
            unit: 'PIXELS',
          };
        }
      }

      return {
        id: style.id,
        name: style.name,
        fontSize: style.fontSize,
        ...(fallbackNote ? { fontFallback: fallbackNote } : {}),
      };
    } catch (err) {
      // Clean up the half-created style to avoid orphans
      try {
        style.remove();
      } catch {
        /* already removed or not removable */
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // P0-2: create_effect_style
  // ═══════════════════════════════════════════════════════════════

  registerHandler('create_effect_style', async (params) => {
    const name = params.name as string;
    const description = params.description as string | undefined;
    const effects = params.effects as Array<{
      type?: string;
      color?: string;
      offsetX?: number;
      offsetY?: number;
      blur?: number;
      spread?: number;
      visible?: boolean;
    }>;

    assertHandler(name, 'name is required');
    assertHandler(Array.isArray(effects) && effects.length > 0, 'effects array is required and must not be empty');

    // Check for existing style with same name (idempotent)
    const existing = (await figma.getLocalEffectStylesAsync()).find((s) => s.name === name);
    if (existing) {
      return { id: existing.id, name: existing.name, alreadyExists: true };
    }

    const figmaEffects: Effect[] = effects.map((e) => {
      const effectType = (e.type ?? 'DROP_SHADOW') as Effect['type'];
      if (effectType === 'DROP_SHADOW' || effectType === 'INNER_SHADOW') {
        return {
          type: effectType,
          visible: e.visible ?? true,
          color: e.color ? hexToFigmaRgba(e.color) : { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: e.offsetX ?? 0, y: e.offsetY ?? 0 },
          radius: e.blur ?? 0,
          spread: e.spread ?? 0,
          blendMode: 'NORMAL' as const,
          showShadowBehindNode: false,
        } as DropShadowEffect;
      }
      if (effectType === 'LAYER_BLUR' || effectType === 'BACKGROUND_BLUR') {
        return {
          type: effectType,
          visible: e.visible ?? true,
          radius: e.blur ?? 0,
        } as BlurEffect;
      }
      // Glass effect (beta, Frames only)
      if ((effectType as string) === 'GLASS') {
        return {
          type: 'GLASS' as any,
          visible: e.visible ?? true,
          radius: e.blur ?? 0,
        } as any;
      }
      // Unrecognized type — pass through as-is for forward compatibility
      return {
        type: effectType,
        visible: e.visible ?? true,
        ...(e.color ? { color: hexToFigmaRgba(e.color) } : {}),
        ...(e.offsetX != null || e.offsetY != null ? { offset: { x: e.offsetX ?? 0, y: e.offsetY ?? 0 } } : {}),
        ...(e.blur != null ? { radius: e.blur } : {}),
        ...(e.spread != null ? { spread: e.spread } : {}),
      } as Effect;
    });

    const style = figma.createEffectStyle();
    style.name = name;
    style.effects = figmaEffects;
    if (description) style.description = description;

    return { id: style.id, name: style.name };
  });

  // ═══════════════════════════════════════════════════════════════
  // P0-3: set_variable_code_syntax
  // ═══════════════════════════════════════════════════════════════

  registerHandler('set_variable_code_syntax', async (params) => {
    const variableId = params.variableId as string;
    const syntax = params.syntax as Record<string, string>;

    assertHandler(variableId, 'variableId is required');
    assertHandler(syntax && typeof syntax === 'object', 'syntax is required (e.g. { WEB: "var(--color-primary)" })');

    const variable = await figma.variables.getVariableByIdAsync(variableId);
    assertHandler(variable, `Variable not found: ${variableId}`, 'NOT_FOUND');

    const validPlatforms = ['WEB', 'ANDROID', 'iOS'] as const;
    const applied: string[] = [];

    for (const [platform, value] of Object.entries(syntax)) {
      const p = platform as (typeof validPlatforms)[number];
      assertHandler(
        validPlatforms.includes(p),
        `Invalid platform "${platform}". Must be one of: ${validPlatforms.join(', ')}`,
      );
      if (value) {
        variable.setVariableCodeSyntax(p, value);
        applied.push(p);
      } else {
        // Empty string = remove
        try {
          variable.removeVariableCodeSyntax(p);
        } catch {
          /* ignore if not set */
        }
        applied.push(`${p} (removed)`);
      }
    }

    return { ok: true, variableId: variable.id, variableName: variable.name, applied };
  });

  // ═══════════════════════════════════════════════════════════════
  // P0-4: layout_component_set
  // ═══════════════════════════════════════════════════════════════

  registerHandler('layout_component_set', async (params) => {
    const nodeId = params.nodeId as string;
    const gap = (params.gap as number) ?? 20;
    const padding = (params.padding as number) ?? 40;
    const columnAxis = params.columnAxis as string | undefined;
    const rowAxes = params.rowAxes as string[] | undefined;

    assertHandler(nodeId, 'nodeId is required');

    const node = await findNodeByIdAsync(nodeId);
    assertHandler(node && node.type === 'COMPONENT_SET', `ComponentSet not found: ${nodeId}`, 'NOT_FOUND');
    const cs = node as ComponentSetNode;
    const children = cs.children.filter((c) => c.type === 'COMPONENT') as ComponentNode[];
    assertHandler(children.length > 0, 'ComponentSet has no component children');

    // Parse variant properties from names: "Size=Small, Style=Primary, State=Default"
    type VariantInfo = { node: ComponentNode; props: Record<string, string> };
    const variants: VariantInfo[] = children.map((child) => {
      const props: Record<string, string> = {};
      child.name.split(',').forEach((part) => {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v) props[k] = v;
      });
      return { node: child, props };
    });

    // Discover all axes and their values (preserving order of first appearance)
    const axisValues = new Map<string, string[]>();
    for (const v of variants) {
      for (const [key, val] of Object.entries(v.props)) {
        if (!axisValues.has(key)) axisValues.set(key, []);
        const arr = axisValues.get(key)!;
        if (!arr.includes(val)) arr.push(val);
      }
    }

    // Determine column and row axes
    const allAxes = [...axisValues.keys()];
    const colAxis = columnAxis ?? allAxes[allAxes.length - 1] ?? allAxes[0];
    const rAxes = rowAxes ?? allAxes.filter((a) => a !== colAxis);

    const colValues = axisValues.get(colAxis) ?? [''];
    const numCols = colValues.length;

    // Build row keys: cartesian product of row axes values
    function buildRowKeys(axes: string[]): Array<Record<string, string>> {
      if (axes.length === 0) return [{}];
      const [first, ...rest] = axes;
      const restKeys = buildRowKeys(rest);
      const result: Array<Record<string, string>> = [];
      for (const val of axisValues.get(first) ?? ['']) {
        for (const restKey of restKeys) {
          result.push({ [first]: val, ...restKey });
        }
      }
      return result;
    }
    const rowKeys = buildRowKeys(rAxes);
    const numRows = rowKeys.length;

    // Measure max child dimensions per column and row for adaptive grid
    const colWidths = new Array(numCols).fill(0);
    const rowHeights = new Array(numRows).fill(0);

    for (const v of variants) {
      const colIdx = colValues.indexOf(v.props[colAxis] ?? '');
      const rowIdx = rowKeys.findIndex((rk) => rAxes.every((a) => rk[a] === (v.props[a] ?? '')));
      if (colIdx >= 0) colWidths[colIdx] = Math.max(colWidths[colIdx], v.node.width);
      if (rowIdx >= 0) rowHeights[rowIdx] = Math.max(rowHeights[rowIdx], v.node.height);
    }

    // Position each variant
    let positioned = 0;
    for (const v of variants) {
      const colIdx = colValues.indexOf(v.props[colAxis] ?? '');
      const rowIdx = rowKeys.findIndex((rk) => rAxes.every((a) => rk[a] === (v.props[a] ?? '')));
      if (colIdx < 0 || rowIdx < 0) continue;

      // Calculate x: padding + sum of previous column widths + gaps
      let x = padding;
      for (let c = 0; c < colIdx; c++) x += colWidths[c] + gap;

      // Calculate y: padding + sum of previous row heights + gaps
      let y = padding;
      for (let r = 0; r < rowIdx; r++) y += rowHeights[r] + gap;

      v.node.x = x;
      v.node.y = y;
      positioned++;
    }

    // Resize component set to fit
    let maxX = 0;
    let maxY = 0;
    for (const child of children) {
      maxX = Math.max(maxX, child.x + child.width);
      maxY = Math.max(maxY, child.y + child.height);
    }
    cs.resizeWithoutConstraints(maxX + padding, maxY + padding);

    return {
      ok: true,
      componentSetId: cs.id,
      positioned,
      grid: { columns: numCols, rows: numRows, columnAxis: colAxis, rowAxes: rAxes },
      size: { width: Math.round(maxX + padding), height: Math.round(maxY + padding) },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // P0-5: bind_component_property
  // ═══════════════════════════════════════════════════════════════

  // ── Core per-component binder (extracted so both single-component and
  //    cross-component batch paths share the same implementation) ──
  //
  // BindingSpec is a discriminated union on `nodeProperty`:
  //
  // 1. Property-reference bindings (characters / visible / mainComponent) wire
  //    a child node to an EXISTING component property defined on the component.
  //    The `propertyName` must match a real property added via create_component
  //    or update_component_property. Used at instance time — overrideable.
  //
  // 2. Bulk-color binding (iconColor) — NEW in plan elegant-wandering-raven.md
  //    B2. Applies a color (hex / variable name / variable ID) to the matched
  //    node's Vector descendants. NOT a runtime property — it's a build-time
  //    bulk-apply, so instances can't override it (variables CAN still update
  //    live, since the binding lives on the Vector's boundVariables).
  //    The `propertyName` field is repurposed as a label for error messages
  //    (it does NOT need to match a real component property).
  type PropertyRefBinding = {
    propertyName: string;
    targetNodeSelector: string;
    nodeProperty: 'characters' | 'visible' | 'mainComponent';
  };
  type IconColorBinding = {
    propertyName?: string; // Optional label for error messages (not a real component property).
    targetNodeSelector: string;
    nodeProperty: 'iconColor';
    // Color value — auto-detected:
    //   "#RRGGBB"           → hex
    //   "VariableID:..."    → direct binding by ID (preferred when known)
    //   "icon/primary"      → name lookup via findColorVariableByName
    value: string;
  };
  type BindingSpec = PropertyRefBinding | IconColorBinding;
  const validNodeProps = ['characters', 'visible', 'mainComponent', 'iconColor'];

  const validateBindingSpecs = (bindings: BindingSpec[]): void => {
    assertHandler(
      bindings.length > 0,
      'bindings array (or single propertyName/targetNodeSelector/nodeProperty) is required',
    );
    for (const b of bindings) {
      assertHandler(b.targetNodeSelector, 'targetNodeSelector is required for each binding (child node name to match)');
      assertHandler(
        b.nodeProperty && validNodeProps.includes(b.nodeProperty),
        `Invalid nodeProperty "${b.nodeProperty}". Must be one of: ${validNodeProps.join(', ')}`,
      );
      if (b.nodeProperty === 'iconColor') {
        const ib = b as IconColorBinding;
        assertHandler(
          typeof ib.value === 'string' && ib.value.length > 0,
          `iconColor binding requires "value" (hex "#RRGGBB", variable name, or "VariableID:..."). Got: ${JSON.stringify(ib.value)}`,
        );
      } else {
        assertHandler(
          (b as PropertyRefBinding).propertyName,
          'propertyName is required for characters/visible/mainComponent bindings',
        );
      }
    }
  };

  const bindOneComponent = async (
    nodeId: string,
    bindings: BindingSpec[],
    variantFilter?: Record<string, string>,
  ): Promise<{
    ok: boolean;
    bindingsProcessed: number;
    variantsTargeted: number;
    totalBound: number;
    totalNotFound: number;
    results: Array<{ propertyName: string; bound: number; notFound: number }>;
    errors?: Array<{ variantName: string; propertyName: string; error: string }>;
    notFoundHint?: {
      missingSelectors: string[];
      availableChildren: Array<{ name: string; type: string }>;
      suggestion: string;
    };
    variantFilterApplied?: { filter: Record<string, string>; matched: number; total: number };
  }> => {
    validateBindingSpecs(bindings);

    const node = await findNodeByIdAsync(nodeId);
    assertHandler(
      node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET'),
      `Component or ComponentSet not found: ${nodeId}`,
      'NOT_FOUND',
    );
    const comp = node as ComponentNode | ComponentSetNode;
    const defs = comp.componentPropertyDefinitions;
    const availableProps = Object.keys(defs);

    // Pre-resolve property-reference bindings to Figma's actual property key
    // (with the #id:id suffix). iconColor bindings skip this — they don't
    // reference an existing component property.
    const resolved: Array<{ spec: BindingSpec; propKey: string | null }> = [];
    for (const b of bindings) {
      if (b.nodeProperty === 'iconColor') {
        resolved.push({ spec: b, propKey: null });
        continue;
      }
      const propKey = availableProps.find((k) => k === b.propertyName || k.startsWith(`${b.propertyName}#`));
      if (!propKey) {
        throw new HandlerError(
          `Property "${b.propertyName}" not found on component. Available: [${availableProps.join(', ')}]`,
          'PROPERTY_NOT_FOUND',
        );
      }
      resolved.push({ spec: b, propKey });
    }

    // Walk all variant children (for ComponentSet) or the component itself
    const allVariants: SceneNode[] =
      comp.type === 'COMPONENT_SET' ? (comp.children.filter((c) => c.type === 'COMPONENT') as SceneNode[]) : [comp];

    // ── variantFilter: limit which variants the bindings apply to ──
    // Useful when one ComponentSet has 32 variants but you only want to wire
    // (e.g.) iconColor on Tertiary variants. Filter is `Record<propName, value>`
    // and matches Figma's per-variant `variantProperties` map exactly.
    let targets: SceneNode[] = allVariants;
    if (variantFilter && Object.keys(variantFilter).length > 0) {
      targets = allVariants.filter((v) => {
        if (v.type !== 'COMPONENT') return false;
        const vp = (v as ComponentNode).variantProperties;
        if (!vp) return false;
        return Object.entries(variantFilter).every(([k, val]) => vp[k] === val);
      });
      assertHandler(
        targets.length > 0,
        `variantFilter ${JSON.stringify(variantFilter)} matched 0 variants out of ${allVariants.length}. ` +
          `Available variant properties: ${
            allVariants[0]?.type === 'COMPONENT'
              ? JSON.stringify((allVariants[0] as ComponentNode).variantProperties ?? {})
              : '(none)'
          }`,
        'VARIANT_FILTER_NO_MATCH',
      );
    }

    type BindingResult = { propertyName: string; bound: number; notFound: number };
    const perBinding = new Map<string, BindingResult>();
    // Per-binding label used as the response's per-binding key. Pre-computed
    // once with the resolved array index appended to iconColor labels so two
    // bindings targeting the same selector don't collide in perBinding —
    // otherwise the second would silently overwrite the first's counter and
    // the user would see `bound: 2` while only the second `applyIconColor`
    // call actually took effect. Property-ref bindings keep the raw
    // propertyName (duplicate propertyNames there is a pre-existing caveat).
    const labels: string[] = resolved.map(({ spec }, i) =>
      spec.nodeProperty === 'iconColor'
        ? (spec.propertyName ?? `iconColor:${spec.targetNodeSelector}#${i}`)
        : (spec as PropertyRefBinding).propertyName,
    );
    for (const label of labels) {
      perBinding.set(label, { propertyName: label, bound: 0, notFound: 0 });
    }
    const errors: Array<{ variantName: string; propertyName: string; error: string }> = [];

    // Lazy-load library context only if any binding needs it (iconColor name lookup).
    // Cached via getCachedModeLibrary so the cost is one clientStorage hit at most.
    let libraryContext: string | undefined;
    const needsLibraryContext = resolved.some(({ spec }) => spec.nodeProperty === 'iconColor');
    if (needsLibraryContext) {
      try {
        const [, lib] = (await getCachedModeLibrary()) as ['library' | 'spec', string | undefined];
        libraryContext = lib;
      } catch {
        /* getCachedModeLibrary failure is non-fatal — iconColor falls back to local-only lookup */
      }
    }

    // ── Self-correcting error context (P0-2) ──
    // When a binding fails because targetNodeSelector matches no node, agents
    // currently re-list nodes via a separate call. Pre-walk every target ONCE
    // and emit a candidate list (name + type + id) so the next call can fix
    // itself. See memory: feedback_self_correcting_errors.
    const allChildNamesByVariant = new Map<string, Array<{ name: string; type: string; id: string }>>();
    for (const target of targets) {
      const candidates: Array<{ name: string; type: string; id: string }> = [];
      const walk = (n: SceneNode) => {
        if (n !== target) candidates.push({ name: n.name, type: n.type, id: n.id });
        if ('children' in n) {
          for (const c of (n as ChildrenMixin).children) walk(c as SceneNode);
        }
      };
      walk(target);
      allChildNamesByVariant.set(target.id, candidates);
    }

    for (const target of targets) {
      for (let specIdx = 0; specIdx < resolved.length; specIdx++) {
        const { spec, propKey } = resolved[specIdx];
        const label = labels[specIdx];
        const result = perBinding.get(label)!;
        try {
          const childNode = (target as FrameNode).findOne((n) => n.name === spec.targetNodeSelector);
          if (!childNode) {
            result.notFound++;
            continue;
          }

          // ── iconColor branch: bulk-apply color to Vector descendants ──
          if (spec.nodeProperty === 'iconColor') {
            if (childNode.type !== 'FRAME' && childNode.type !== 'GROUP') {
              errors.push({
                variantName: target.name,
                propertyName: label,
                error: `Node "${spec.targetNodeSelector}" is ${childNode.type}, not FRAME/GROUP — iconColor needs a frame containing Vector descendants`,
              });
              continue;
            }
            const value = (spec as IconColorBinding).value;
            // Auto-detect value type: hex / VariableID: prefix / bare name.
            const isHex = value.startsWith('#');
            const isId = value.startsWith('VariableID:');
            let iconResult: ApplyIconColorResult;
            if (isId) {
              iconResult = await applyIconColor(childNode as FrameNode, undefined, undefined, libraryContext, value);
            } else if (isHex) {
              iconResult = await applyIconColor(childNode as FrameNode, value, undefined, libraryContext);
            } else {
              iconResult = await applyIconColor(childNode as FrameNode, undefined, value, libraryContext);
            }
            if (iconResult.bindingFailure || iconResult.colorHint) {
              errors.push({
                variantName: target.name,
                propertyName: label,
                error: iconResult.colorHint ?? `iconColor binding failed for "${value}"`,
              });
              continue;
            }
            result.bound++;
            continue;
          }

          // ── Property-reference bindings (characters/visible/mainComponent) ──
          if (spec.nodeProperty === 'characters' && childNode.type !== 'TEXT') {
            errors.push({
              variantName: target.name,
              propertyName: label,
              error: `Node "${spec.targetNodeSelector}" is ${childNode.type}, not TEXT`,
            });
            continue;
          }
          if (spec.nodeProperty === 'mainComponent' && childNode.type !== 'INSTANCE') {
            errors.push({
              variantName: target.name,
              propertyName: label,
              error: `Node "${spec.targetNodeSelector}" is ${childNode.type}, not INSTANCE`,
            });
            continue;
          }
          const existing =
            (childNode as unknown as { componentPropertyReferences?: Record<string, string> })
              .componentPropertyReferences ?? {};
          (
            childNode as unknown as { componentPropertyReferences: Record<string, string> }
          ).componentPropertyReferences = {
            ...existing,
            // propKey is non-null for non-iconColor bindings (set in resolve loop above)
            [spec.nodeProperty]: propKey as string,
          };
          result.bound++;
        } catch (err) {
          errors.push({
            variantName: target.name,
            propertyName: label,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const results = Array.from(perBinding.values());
    const totalBound = results.reduce((s, r) => s + r.bound, 0);
    const totalNotFound = results.reduce((s, r) => s + r.notFound, 0);

    // Build self-correcting hint when ALL variants couldn't find a selector.
    // Picking the first variant's child list is enough — variants share structure.
    let notFoundHint:
      | undefined
      | {
          missingSelectors: string[];
          availableChildren: Array<{ name: string; type: string }>;
          suggestion: string;
        };
    if (totalNotFound > 0 && targets.length > 0) {
      const missingSelectors = resolved
        .filter((_, i) => {
          const r = perBinding.get(labels[i])!;
          return r.notFound > 0 && r.bound === 0;
        })
        .map(({ spec }) => spec.targetNodeSelector);
      if (missingSelectors.length > 0) {
        const firstVariantChildren = allChildNamesByVariant.get(targets[0].id) || [];
        const dedupedChildren = Array.from(
          new Map(firstVariantChildren.map((c) => [`${c.name}::${c.type}`, { name: c.name, type: c.type }])).values(),
        );
        notFoundHint = {
          missingSelectors,
          availableChildren: dedupedChildren,
          suggestion:
            `targetNodeSelector matches a child node by exact name. Pick one from availableChildren above and retry. ` +
            `Example: { propertyName: "Label", targetNodeSelector: "${dedupedChildren.find((c) => c.type === 'TEXT')?.name || 'label'}", nodeProperty: "characters" }`,
        };
      }
    }

    return {
      ok: errors.length === 0 && totalNotFound === 0,
      bindingsProcessed: bindings.length,
      variantsTargeted: targets.length,
      totalBound,
      totalNotFound,
      results,
      errors: errors.length > 0 ? errors : undefined,
      notFoundHint,
    };
  };

  registerHandler('bind_component_property', async (params) => {
    // ── Cross-component batch mode (items[]) ──
    // When an agent has N independent Components/ComponentSets that each need
    // their own bindings (e.g. 8 "Default" state components under 8 different
    // parent buttons each wanting Icon Left / Icon Right visibility wired up),
    // the legacy single-nodeId path forces N round-trips. items[] collapses
    // them into one call. Per-item errors do not block siblings.
    if (Array.isArray(params.items)) {
      const items = params.items as Array<{
        nodeId: string;
        bindings: BindingSpec[];
        variantFilter?: Record<string, string>;
      }>;
      assertHandler(items.length > 0, 'items array must not be empty');
      assertHandler(items.length <= 20, 'Maximum 20 components per batch');

      type ItemResult = {
        nodeId: string;
        ok: boolean;
        bindingsProcessed?: number;
        variantsTargeted?: number;
        totalBound?: number;
        totalNotFound?: number;
        results?: Array<{ propertyName: string; bound: number; notFound: number }>;
        errors?: Array<{ variantName: string; propertyName: string; error: string }>;
        notFoundHint?: {
          missingSelectors: string[];
          availableChildren: Array<{ name: string; type: string }>;
          suggestion: string;
        };
        error?: string;
      };
      const outItems: ItemResult[] = [];
      let created = 0;
      for (const item of items) {
        if (!item || typeof item.nodeId !== 'string' || !Array.isArray(item.bindings)) {
          outItems.push({
            nodeId: item?.nodeId || '',
            ok: false,
            error: 'Invalid item: requires {nodeId: string, bindings: BindingSpec[]}',
          });
          continue;
        }
        try {
          const r = await bindOneComponent(item.nodeId, item.bindings, item.variantFilter);
          outItems.push({ nodeId: item.nodeId, ...r });
          if (r.ok) created += 1;
        } catch (err) {
          outItems.push({
            nodeId: item.nodeId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        ok: outItems.every((i) => i.ok),
        action: 'batch',
        created,
        total: items.length,
        items: outItems,
      };
    }

    // ── Single-component legacy path ──
    const nodeId = params.nodeId as string;
    assertHandler(nodeId, 'nodeId is required (Component or ComponentSet) — or pass items[] for cross-component batch');

    // ── Accept both single binding (legacy) and array of bindings (P0-3) ──
    // The array form is the preferred shape — wiring a typical Button takes
    // 4-6 properties and a single call saves 4-6 round-trips through the model.
    const rawBindings = params.bindings as BindingSpec[] | undefined;
    const bindings: BindingSpec[] =
      rawBindings && Array.isArray(rawBindings)
        ? rawBindings
        : [
            {
              propertyName: params.propertyName as string,
              targetNodeSelector: params.targetNodeSelector as string,
              nodeProperty: params.nodeProperty as 'characters' | 'visible' | 'mainComponent',
            },
          ];

    const variantFilter = params.variantFilter as Record<string, string> | undefined;
    const single = await bindOneComponent(nodeId, bindings, variantFilter);
    return { action: 'single', ...single };
  });

  // ═══════════════════════════════════════════════════════════════
  // P1-1: batch_set_variable_binding
  // ═══════════════════════════════════════════════════════════════

  registerHandler('batch_set_variable_binding', async (params) => {
    const bindings = params.bindings as Array<{
      nodeId: string;
      field: string;
      variableId: string;
      paintIndex?: number;
    }>;

    assertHandler(Array.isArray(bindings) && bindings.length > 0, 'bindings array is required and must not be empty');

    let succeeded = 0;
    let failed = 0;
    const errors: Array<{ nodeId: string; field: string; error: string }> = [];

    // Pre-resolve all variables in parallel for efficiency
    const uniqueVarIds = [...new Set(bindings.map((b) => b.variableId))];
    const varMap = new Map<string, Variable>();
    await Promise.all(
      uniqueVarIds.map(async (id) => {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) varMap.set(id, v);
      }),
    );

    for (const binding of bindings) {
      try {
        const node = await findNodeByIdAsync(binding.nodeId);
        if (!node) {
          errors.push({ nodeId: binding.nodeId, field: binding.field, error: 'Node not found' });
          failed++;
          continue;
        }

        const variable = varMap.get(binding.variableId);
        if (!variable) {
          errors.push({
            nodeId: binding.nodeId,
            field: binding.field,
            error: `Variable not found: ${binding.variableId}`,
          });
          failed++;
          continue;
        }

        const field = binding.field;
        if ((field === 'fills' || field === 'strokes') && 'fills' in node) {
          const paintIndex = binding.paintIndex ?? 0;
          const paints = [...((node as GeometryMixin)[field] as Paint[])];
          if (paints[paintIndex]) {
            paints[paintIndex] = figma.variables.setBoundVariableForPaint(
              paints[paintIndex] as SolidPaint,
              'color',
              variable,
            );
            (node as GeometryMixin)[field] = paints;
          } else {
            // No existing paint — create a solid paint and bind
            const newPaint = figma.variables.setBoundVariableForPaint(
              { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
              'color',
              variable,
            );
            (node as GeometryMixin)[field] = [newPaint];
          }
        } else if ('setBoundVariable' in node) {
          (node as SceneNode).setBoundVariable(field as VariableBindableNodeField, variable);
        } else {
          errors.push({ nodeId: binding.nodeId, field, error: 'Node does not support variable binding' });
          failed++;
          continue;
        }

        succeeded++;
      } catch (err) {
        errors.push({
          nodeId: binding.nodeId,
          field: binding.field,
          error: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
    }

    return { succeeded, failed, total: bindings.length, errors: errors.length > 0 ? errors : undefined };
  });

  // ═══════════════════════════════════════════════════════════════
  // P1-2: set_variable_values_multi_mode
  // ═══════════════════════════════════════════════════════════════

  registerHandler('set_variable_values_multi_mode', async (params) => {
    const variableId = params.variableId as string;
    const valuesByMode = params.valuesByMode as Record<string, unknown>;

    assertHandler(variableId, 'variableId is required');
    assertHandler(
      valuesByMode && typeof valuesByMode === 'object' && Object.keys(valuesByMode).length > 0,
      'valuesByMode is required (e.g. { "Light": "#FFFFFF", "Dark": "#1A1A1A" })',
    );

    const variable = await figma.variables.getVariableByIdAsync(variableId);
    assertHandler(variable, `Variable not found: ${variableId}`, 'NOT_FOUND');

    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    assertHandler(collection, 'Variable collection not found', 'NOT_FOUND');

    // Build mode name → modeId map
    const modeMap = new Map<string, string>();
    for (const mode of collection.modes) {
      modeMap.set(mode.name, mode.modeId);
    }

    let set = 0;
    const errors: Array<{ modeName: string; error: string }> = [];

    for (const [modeName, rawValue] of Object.entries(valuesByMode)) {
      try {
        const modeId = modeMap.get(modeName);
        assertHandler(
          modeId,
          `Mode "${modeName}" not found in collection "${collection.name}". Available: ${collection.modes.map((m) => m.name).join(', ')}`,
        );

        let value: VariableValue;

        // Handle alias references: { type: "VARIABLE_ALIAS", id: "..." }
        if (isVariableAlias(rawValue)) {
          value = rawValue as VariableAlias;
        }
        // Handle hex color strings for COLOR variables
        else if (variable.resolvedType === 'COLOR' && typeof rawValue === 'string') {
          value = hexToFigmaRgba(rawValue);
        }
        // Pass through other values
        else {
          value = rawValue as VariableValue;
        }

        variable.setValueForMode(modeId!, value);
        set++;
      } catch (err) {
        errors.push({
          modeName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      ok: true,
      variableId: variable.id,
      variableName: variable.name,
      set,
      total: Object.keys(valuesByMode).length,
      errors: errors.length > 0 ? errors : undefined,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Extended Collections (Enterprise) — multi-brand theming
  // ═══════════════════════════════════════════════════════════════

  registerHandler('extend_collection', async (params) => {
    const collectionId = params.collectionId as string | undefined;
    const collectionKey = params.collectionKey as string | undefined;
    const name = params.name as string;

    assertHandler(name, 'name is required');
    assertHandler(collectionId || collectionKey, 'Either collectionId (local) or collectionKey (library) is required');

    if (collectionKey) {
      // Extend from library or local collection by key
      const extended = await figma.variables.extendLibraryCollectionByKeyAsync(collectionKey, name);
      return {
        id: extended.id,
        name: extended.name,
        isExtension: true,
        rootVariableCollectionId: extended.rootVariableCollectionId,
        modes: extended.modes.map((m: { modeId: string; name: string }) => ({ modeId: m.modeId, name: m.name })),
        variableCount: extended.variableIds.length,
      };
    }

    // Extend from local collection by ID
    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId!);
    assertHandler(collection, `Collection not found: ${collectionId}`, 'NOT_FOUND');
    assertHandler(!collection.remote, 'Cannot extend a remote collection by ID. Use collectionKey instead.');

    const extended = (collection as any).extend(name);
    return {
      id: extended.id,
      name: extended.name,
      isExtension: true,
      rootVariableCollectionId: extended.rootVariableCollectionId,
      modes: extended.modes.map((m: { modeId: string; name: string }) => ({ modeId: m.modeId, name: m.name })),
      variableCount: extended.variableIds.length,
    };
  });

  registerHandler('get_collection_overrides', async (params) => {
    const collectionId = params.collectionId as string;

    assertHandler(collectionId, 'collectionId is required');

    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    assertHandler(collection, `Collection not found: ${collectionId}`, 'NOT_FOUND');
    assertHandler((collection as any).isExtension, 'Collection is not an extended collection');

    const extended = collection as any;
    const overrides: Array<{ variableId: string; variableName: string; modeOverrides: Record<string, unknown> }> = [];

    for (const [variableId, modeValues] of Object.entries(
      extended.variableOverrides as Record<string, Record<string, unknown>>,
    )) {
      const variable = await figma.variables.getVariableByIdAsync(variableId);
      overrides.push({
        variableId,
        variableName: variable?.name ?? 'unknown',
        modeOverrides: modeValues,
      });
    }

    return {
      collectionId: extended.id,
      collectionName: extended.name,
      rootVariableCollectionId: extended.rootVariableCollectionId,
      overrideCount: overrides.length,
      overrides,
    };
  });

  registerHandler('remove_collection_override', async (params) => {
    const collectionId = params.collectionId as string;
    const variableId = params.variableId as string;

    assertHandler(collectionId, 'collectionId is required');
    assertHandler(variableId, 'variableId is required');

    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    assertHandler(collection, `Collection not found: ${collectionId}`, 'NOT_FOUND');
    assertHandler((collection as any).isExtension, 'Collection is not an extended collection');

    const variable = await figma.variables.getVariableByIdAsync(variableId);
    assertHandler(variable, `Variable not found: ${variableId}`, 'NOT_FOUND');

    (collection as any).removeOverridesForVariable(variable);
    return { ok: true };
  });
} // registerDesignSystemBuildHandlers
