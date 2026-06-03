/**
 * WCAG contrast rule — check text/background contrast ratio.
 *
 * Walks up the node tree (via parentBgColor on AbstractNode) to find the
 * nearest ancestor with a solid fill, then checks contrast against that
 * background. Falls back to white/black worst-case when no parent bg is known.
 */

import type { AbstractNode, LintContext, LintRule, LintViolation } from '../../types.js';
import { tr } from '../../types.js';
import { hexToRgbTuple } from '../../utils/color.js';
import { isVisibleSolidPaint, resolveSolidPaintRgb } from '../../utils/paint.js';
import { contrastRatioTuple, isLargeText } from './wcag-helpers.js';

/**
 * Extract the effective background color from a node's parentBgColor field.
 * Returns an RGB tuple or null if unknown.
 */
function getParentBg(node: AbstractNode): [number, number, number] | null {
  if (!node.parentBgColor) return null;
  return hexToRgbTuple(node.parentBgColor);
}

export const wcagContrastRule: LintRule = {
  name: 'wcag-contrast',
  description: 'Check that text has enough contrast against its background for readability (WCAG AA).',
  category: 'wcag',
  severity: 'unsafe',
  ai: {
    preventionHint:
      'Ensure text has at least 4.5:1 contrast ratio against its background (3:1 for large text ≥18px or ≥14px bold)',
    phase: ['accessibility'],
    tags: ['text'],
  },

  check(node: AbstractNode, ctx: LintContext): LintViolation[] {
    if (node.type !== 'TEXT') return [];
    if (!node.fills || node.fills.length === 0) return [];
    // Text over image / video / gradient — backdrop is pixel-level and can't
    // be reliably measured without sampling. axe-core / Stark / Adee all
    // take the same "skip if backdrop is uncertain" stance.
    if (node.overComplexBg) return [];

    const fgFill = node.fills.find(isVisibleSolidPaint);
    if (!fgFill) return [];

    const fgRgb = resolveSolidPaintRgb(fgFill, node.parentBgColor);
    if (!fgRgb) return [];

    const large = isLargeText(node.fontSize, node.fontName?.style);
    const threshold = large ? 3 : 4.5;

    const violations: LintViolation[] = [];

    // Use actual parent background when available, otherwise fall back to white/black
    const parentBg = getParentBg(node);
    if (parentBg) {
      const ratio = contrastRatioTuple(fgRgb, parentBg);
      if (ratio < threshold) {
        violations.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: 'wcag-contrast',
          severity: 'unsafe',
          currentValue: `${ratio.toFixed(2)}:1`,
          expectedValue: `>= ${threshold}:1`,
          suggestion: tr(
            ctx.lang,
            `"${node.name}" text color may be hard to read — contrast is only ${ratio.toFixed(2)}:1 against its background (needs at least ${threshold}:1)`,
            `「${node.name}」文字颜色可能难以阅读——与背景对比度仅 ${ratio.toFixed(2)}:1(至少需要 ${threshold}:1)`,
          ),
          autoFixable: false,
        });
      }
    } else {
      // Fallback: check against both white and black (conservative)
      const ratioOnWhite = contrastRatioTuple(fgRgb, [1, 1, 1]);
      const ratioOnBlack = contrastRatioTuple(fgRgb, [0, 0, 0]);

      if (ratioOnWhite < threshold && ratioOnBlack < threshold) {
        const worstRatio = Math.max(ratioOnWhite, ratioOnBlack);
        violations.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: 'wcag-contrast',
          severity: 'unsafe',
          currentValue: `${worstRatio.toFixed(2)}:1`,
          expectedValue: `>= ${threshold}:1`,
          suggestion: tr(
            ctx.lang,
            `"${node.name}" text color may be hard to read — contrast is only ${worstRatio.toFixed(2)}:1 (needs at least ${threshold}:1)`,
            `「${node.name}」文字颜色可能难以阅读——对比度仅 ${worstRatio.toFixed(2)}:1(至少需要 ${threshold}:1)`,
          ),
          autoFixable: false,
        });
      }
    }

    // Dark mode / multi-mode check: if variable mode colors are available,
    // verify contrast in every mode (e.g. light AND dark)
    if (node.variableModeColors && node.parentBgModeColors) {
      const modes = new Set([...Object.keys(node.variableModeColors), ...Object.keys(node.parentBgModeColors)]);
      for (const mode of modes) {
        const fgHex = node.variableModeColors[mode];
        const bgHex = node.parentBgModeColors[mode];
        if (!fgHex || !bgHex) continue;
        const fg = hexToRgbTuple(fgHex);
        const bg = hexToRgbTuple(bgHex);
        if (!fg || !bg) continue;
        const ratio = contrastRatioTuple(fg, bg);
        if (ratio < threshold) {
          violations.push({
            nodeId: node.id,
            nodeName: node.name,
            rule: 'wcag-contrast',
            severity: 'unsafe',
            currentValue: `${ratio.toFixed(2)}:1 (${mode} mode)`,
            expectedValue: `>= ${threshold}:1`,
            suggestion: tr(
              ctx.lang,
              `"${node.name}" fails contrast in ${mode} mode — ${ratio.toFixed(2)}:1 (needs ${threshold}:1). Check that both text and background variables resolve to adequate contrast in all modes.`,
              `「${node.name}」在 ${mode} 模式下对比度不足——${ratio.toFixed(2)}:1(需要 ${threshold}:1)。请检查文字和背景变量在所有模式下都具有足够对比度。`,
            ),
            autoFixable: false,
          });
        }
      }
    }

    return violations;
  },
};
