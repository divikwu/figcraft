/**
 * Form consistency rule — detect form containers where children have inconsistent widths.
 *
 * Flags VERTICAL auto-layout frames whose name suggests a form/content container
 * where some children use layoutAlign: STRETCH but others don't, creating
 * visual misalignment (e.g. inputs stretch but buttons have fixed width).
 *
 * Auto-fix: set layoutAlign=STRETCH on non-stretching interactive children.
 */

import type { AbstractNode, FixDescriptor, LintContext, LintRule, LintViolation } from '../../types.js';
import { tr } from '../../types.js';

const FORM_NAME_RE = /form|content|body|fields|inputs|登录|注册|表单|内容/i;
const INTERACTIVE_RE = /button|btn|input|field|divider|separator|social|action|submit|login|register|按钮|输入|分割/i;

function isInteractiveChild(node: AbstractNode): boolean {
  if (INTERACTIVE_RE.test(node.name)) return true;
  // Frames with stroke (input-like) or fill (button-like) that are direct children
  if (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
    const hasFill = node.fills?.some((f) => f.visible !== false && f.type === 'SOLID');
    const hasStroke = node.strokes?.some((f) => f.visible !== false);
    if (hasFill || hasStroke) return true;
  }
  return false;
}

export const formConsistencyRule: LintRule = {
  name: 'form-consistency',
  description:
    'Form containers should have consistent child widths — all interactive children should use layoutAlign: STRETCH.',
  category: 'layout',
  severity: 'heuristic',
  ai: {
    preventionHint: 'Form children (inputs, buttons, dividers) must all use layoutAlign: STRETCH for consistent width',
    phase: ['structure'],
    tags: ['input', 'button'],
  },

  check(node: AbstractNode, ctx: LintContext): LintViolation[] {
    // Only check VERTICAL auto-layout frames that look like forms
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT') return [];
    if (node.layoutMode !== 'VERTICAL') return [];
    if (!node.children || node.children.length < 2) return [];
    if (!FORM_NAME_RE.test(node.name)) return [];

    const violations: LintViolation[] = [];

    // Find interactive children and check if they all use STRETCH
    const interactiveKids = node.children.filter(isInteractiveChild);
    if (interactiveKids.length < 2) return [];

    const _stretchKids = interactiveKids.filter(
      (c) =>
        c.layoutMode !== undefined || // has layout properties
        c.width === node.width || // fills parent width
        c.layoutAlign === 'STRETCH',
    );

    // Check for mixed widths among interactive children
    const widths = new Set(interactiveKids.map((c) => c.width).filter((w) => w != null));
    if (widths.size > 1) {
      // Some children have different widths — flag the ones that don't match the parent
      for (const child of interactiveKids) {
        if (child.width != null && node.width != null && child.width < node.width * 0.9) {
          violations.push({
            nodeId: child.id,
            nodeName: child.name,
            rule: 'form-consistency',
            severity: 'heuristic',
            currentValue: `width ${Math.round(child.width!)}px in ${Math.round(node.width)}px parent "${node.name}"`,
            suggestion: tr(
              ctx.lang,
              `"${child.name}" in form "${node.name}" is narrower than siblings. Set layoutAlign: STRETCH for consistent width.`,
              `「${child.name}」在表单「${node.name}」中比同级更窄。请设置 layoutAlign: STRETCH 以保持宽度一致。`,
            ),
            autoFixable: true,
            fixData: {
              fix: 'stretch',
              layoutAlign: 'STRETCH',
            },
          });
        }
      }
    }

    return violations;
  },

  describeFix(v): FixDescriptor | null {
    if (!v.fixData) return null;
    return { kind: 'set-properties', props: { layoutAlign: v.fixData.layoutAlign ?? 'STRETCH' } };
  },
};
