/**
 * Foreign style rule — detect nodes using paint/text/effect styles
 * that don't belong to the currently selected library.
 *
 * Existing rules (hardcoded-token, spec-color, no-text-style) skip nodes
 * that have a fillStyleId/textStyleId set, assuming "has a style = compliant".
 * This rule closes that gap by verifying the style actually belongs to the
 * selected library — not a leftover from a different library or file.
 *
 * Only active in library mode when libraryStyleIds or libraryStyleKeys is populated.
 */

import type { AbstractNode, FixDescriptor, LintContext, LintRule, LintViolation } from '../../types.js';
import { tr } from '../../types.js';

function hasKnownLibraryStyles(ctx: LintContext): boolean {
  return (ctx.libraryStyleIds?.size ?? 0) > 0 || (ctx.libraryStyleKeys?.size ?? 0) > 0;
}

function belongsToSelectedLibrary(ctx: LintContext, styleId?: string, styleKey?: string): boolean {
  if (styleId && ctx.libraryStyleIds?.has(styleId)) return true;
  if (styleKey && ctx.libraryStyleKeys?.has(styleKey)) return true;
  return false;
}

function shouldReportForeignStyle(
  ctx: LintContext,
  styleId: string | undefined,
  styleKey: string | undefined,
  styleRemote: boolean | undefined,
): boolean {
  if (!styleId) return false;
  if (belongsToSelectedLibrary(ctx, styleId, styleKey)) return false;

  // The selected-library style registry can be partial/stale because library
  // styles are restored from cached registered keys. Figma can still tell us
  // that the applied style is remote/imported; in that case we cannot prove it
  // belongs to another library, so avoid a noisy false positive.
  if (styleRemote === true) return false;
  if (styleRemote !== false && !styleKey) return false;

  return true;
}

export const foreignStyleRule: LintRule = {
  name: 'foreign-style',
  description: 'Detect styles (fill, text, effect) that belong to a different library than the one selected.',
  category: 'token',
  severity: 'heuristic',
  ai: {
    preventionHint:
      'Use fillVariableName/textStyleName from the selected library — avoid applying styles from other libraries',
    phase: ['styling'],
    tags: ['color', 'text'],
  },

  check(node: AbstractNode, ctx: LintContext): LintViolation[] {
    // Only active in library mode with a library selected and style references populated
    if (ctx.mode !== 'library' || !ctx.selectedLibrary) return [];
    if (!hasKnownLibraryStyles(ctx)) return [];

    // NOTE: Unlike hardcoded-token / spec-color, this rule does NOT skip
    // insideComponentSubtree. Cross-library style references are a dependency
    // management issue that component authors need to see — regardless of
    // nesting depth. Value-compliance rules skip component internals (noise
    // from icon vectors etc.), but source-compliance rules should not.

    const violations: LintViolation[] = [];

    // Check fillStyleId
    if (shouldReportForeignStyle(ctx, node.fillStyleId, node.fillStyleKey, node.fillStyleRemote)) {
      violations.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: 'foreign-style',
        severity: 'heuristic',
        currentValue: `fillStyleId: ${node.fillStyleId}`,
        suggestion: tr(
          ctx.lang,
          `"${node.name}" uses a fill style from a different library — rebind to a variable or style from "${ctx.selectedLibrary}"`,
          `「${node.name}」使用了其他库的填充样式——请改用「${ctx.selectedLibrary}」中的变量或样式`,
        ),
        autoFixable: true,
        fixData: {
          property: 'fills',
          hex: node.fills?.find((f) => f.type === 'SOLID' && f.visible !== false)?.color ?? null,
          opacity: node.fills?.find((f) => f.type === 'SOLID' && f.visible !== false)?.opacity ?? 1,
          nodeType: node.type,
          clearStyleId: true,
        },
      });
    }

    // Check textStyleId
    if (shouldReportForeignStyle(ctx, node.textStyleId, node.textStyleKey, node.textStyleRemote)) {
      const hasValidFontSize = node.fontSize != null;
      violations.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: 'foreign-style',
        severity: 'heuristic',
        currentValue: `textStyleId: ${node.textStyleId}`,
        suggestion: tr(
          ctx.lang,
          `"${node.name}" uses a text style from a different library — apply a text style from "${ctx.selectedLibrary}"`,
          `「${node.name}」使用了其他库的文字样式——请改用「${ctx.selectedLibrary}」中的文字样式`,
        ),
        autoFixable: hasValidFontSize,
        fixData: { fontSize: node.fontSize, fontFamily: node.fontName?.family },
      });
    }

    // Check effectStyleId
    if (shouldReportForeignStyle(ctx, node.effectStyleId, node.effectStyleKey, node.effectStyleRemote)) {
      violations.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: 'foreign-style',
        severity: 'heuristic',
        currentValue: `effectStyleId: ${node.effectStyleId}`,
        suggestion: tr(
          ctx.lang,
          `"${node.name}" uses an effect style from a different library — apply an effect style from "${ctx.selectedLibrary}"`,
          `「${node.name}」使用了其他库的效果样式——请改用「${ctx.selectedLibrary}」中的效果样式`,
        ),
        autoFixable: false,
        fixData: {},
      });
    }

    return violations;
  },

  describeFix(v): FixDescriptor | null {
    if (!v.fixData) return null;
    const prop = v.fixData.property as string | undefined;
    // Fill style → rebind to library color variable
    if (prop === 'fills') {
      return {
        kind: 'deferred',
        strategy: 'library-color-bind',
        data: { property: 'fills', hex: v.fixData.hex, opacity: v.fixData.opacity, nodeType: v.fixData.nodeType },
      };
    }
    // Text style → rebind to library text style
    if (v.fixData.fontSize != null) {
      return {
        kind: 'deferred',
        strategy: 'library-text-style',
        data: { fontSize: v.fixData.fontSize, fontFamily: v.fixData.fontFamily },
      };
    }
    return null;
  },
};
