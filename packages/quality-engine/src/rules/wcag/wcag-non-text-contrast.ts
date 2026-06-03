/**
 * WCAG 1.4.11 Non-text Contrast (AA) — scoped to button surfaces only.
 *
 * Spec: "The visual presentation of the following have a contrast ratio of at
 * least 3:1 against adjacent color(s):
 *   — User Interface Components: Visual information required to identify
 *     user interface components and states, except for inactive components..."
 *
 * "Required to identify" is the key clause. The only interactive kinds that
 * fail this way in practice are:
 *   — `button-solid`: if the fill ≈ parent bg, the button's surface disappears
 *   — `button-outline`: if the stroke ≈ parent bg, the border disappears
 *
 * Every other node that has a fill/stroke (image containers, cards, section
 * backgrounds, decorative frames, ghost/text buttons, inputs with separate
 * internal contrast concerns) is NOT a "UI component with surface information
 * required to identify it" under 1.4.11. Running contrast math on them is
 * noise. Kinds that need their own contrast contract (toggle track vs thumb,
 * checkbox box vs mark, etc.) deserve dedicated rules — not a generic
 * fill-vs-parent formula shoehorned onto everything.
 */

import type { AbstractNode, LintContext, LintRule, LintViolation } from '../../types.js';
import { tr } from '../../types.js';
import { hexToRgbTuple } from '../../utils/color.js';
import { isVisibleSolidPaint, resolveSolidPaintRgb } from '../../utils/paint.js';
import { contrastRatioTuple } from './wcag-helpers.js';

const NON_TEXT_THRESHOLD = 3;

function getParentBg(node: AbstractNode): [number, number, number] | null {
  if (!node.parentBgColor) return null;
  return hexToRgbTuple(node.parentBgColor);
}

export const wcagNonTextContrastRule: LintRule = {
  name: 'wcag-non-text-contrast',
  description:
    'Solid/outline buttons need ≥ 3:1 contrast between their surface (fill or stroke) and the adjacent background (WCAG 1.4.11).',
  category: 'wcag',
  severity: 'heuristic',
  ai: {
    preventionHint:
      'Solid button fill and outline button stroke must contrast ≥ 3:1 with the parent background so the button surface is identifiable. Other surfaces (image containers, cards, ghost buttons) are out of scope for WCAG 1.4.11.',
    phase: ['styling', 'accessibility'],
    tags: ['button', 'contrast'],
  },

  check(node: AbstractNode, ctx: LintContext): LintViolation[] {
    const ikind = node.interactive?.kind;
    // WCAG 1.4.11 applies to UI components whose surface is required for
    // identification. Only solid and outline buttons qualify under the narrow
    // spec reading. Other kinds have different contrast contracts (or none).
    if (ikind !== 'button-solid' && ikind !== 'button-outline') return [];

    // Button placed over image / video / gradient — can't measure contrast
    // reliably. Same stance as wcag-contrast on text over images.
    if (node.overComplexBg) return [];

    const parentBg = getParentBg(node);
    if (!parentBg) return [];

    if (ikind === 'button-outline') {
      // Outline: stroke is the surface.
      const stroke = node.strokes?.find(isVisibleSolidPaint);
      if (!stroke) return [];
      if (!node.strokeWeight || node.strokeWeight <= 0) return [];
      const strokeRgb = resolveSolidPaintRgb(stroke, node.parentBgColor);
      if (!strokeRgb) return [];
      const ratio = contrastRatioTuple(strokeRgb, parentBg);
      if (ratio >= NON_TEXT_THRESHOLD) return [];
      return [
        {
          nodeId: node.id,
          nodeName: node.name,
          rule: 'wcag-non-text-contrast',
          severity: 'heuristic',
          currentValue: `${ratio.toFixed(2)}:1 (stroke vs bg)`,
          expectedValue: `>= ${NON_TEXT_THRESHOLD}:1`,
          suggestion: tr(
            ctx.lang,
            `"${node.name}" outline button stroke contrast is ${ratio.toFixed(2)}:1 — below WCAG 1.4.11's 3:1 minimum. The border needs to be visible against the parent background.`,
            `「${node.name}」描边按钮的描边对比度仅 ${ratio.toFixed(2)}:1——低于 WCAG 1.4.11 最小 3:1。边框需要能从父背景中辨认出来。`,
          ),
          autoFixable: false,
        },
      ];
    }

    // button-solid: fill is the surface.
    const fill = node.fills?.find(isVisibleSolidPaint);
    if (!fill) return [];
    const fillRgb = resolveSolidPaintRgb(fill, node.parentBgColor);
    if (!fillRgb) return [];
    const ratio = contrastRatioTuple(fillRgb, parentBg);
    if (ratio >= NON_TEXT_THRESHOLD) return [];
    return [
      {
        nodeId: node.id,
        nodeName: node.name,
        rule: 'wcag-non-text-contrast',
        severity: 'heuristic',
        currentValue: `${ratio.toFixed(2)}:1 (fill vs bg)`,
        expectedValue: `>= ${NON_TEXT_THRESHOLD}:1`,
        suggestion: tr(
          ctx.lang,
          `"${node.name}" solid button fill contrast is ${ratio.toFixed(2)}:1 — below WCAG 1.4.11's 3:1 minimum. The button surface needs to be distinguishable from the parent background.`,
          `「${node.name}」填充按钮的填充对比度仅 ${ratio.toFixed(2)}:1——低于 WCAG 1.4.11 最小 3:1。按钮表面需要能从父背景中辨认出来。`,
        ),
        autoFixable: false,
      },
    ];
  },
};
