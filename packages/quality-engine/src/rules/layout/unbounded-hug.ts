/**
 * Unbounded HUG rule — detect frames with HUG sizing on both axes without constraints.
 *
 * A frame that HUGs on both axes AND has children that use FILL/STRETCH creates a
 * layout paradox: the parent tries to shrink to content, but the child tries to
 * expand to fill the parent. This results in 0-width collapse or unpredictable sizing.
 *
 * Also flags HUG on the cross-axis of a constrained parent, which prevents the
 * frame from filling available space.
 *
 * Auto-fix: change cross-axis sizing to FILL (layoutAlign: STRETCH).
 */

import type { AbstractNode, FixDescriptor, LintContext, LintRule, LintViolation } from '../../types.js';
import { tr } from '../../types.js';

/** Check if a node effectively uses HUG sizing on a given axis. */
function _isHugOnAxis(node: AbstractNode, axis: 'horizontal' | 'vertical'): boolean {
  // No layoutMode means no auto-layout — sizing concepts don't apply
  if (!node.layoutMode || node.layoutMode === 'NONE') return false;

  const isVertical = node.layoutMode === 'VERTICAL';

  if (axis === 'horizontal') {
    // Horizontal is cross-axis for VERTICAL layout
    // Cross-axis sizing is determined by counterAxisSizingMode
    // If no explicit width and not STRETCH, it's effectively HUG
    if (isVertical) {
      // For VERTICAL layout, cross-axis (horizontal) defaults to HUG unless STRETCH
      // We check: no explicit width AND no layoutAlign=STRETCH from parent
      return node.width == null || node.width === 0;
    } else {
      // For HORIZONTAL layout, horizontal is primary axis
      // Primary axis HUG = primaryAxisSizingMode is AUTO (content-sized)
      // Heuristic: if no explicit width, it's HUG
      return node.width == null || node.width === 0;
    }
  } else {
    if (isVertical) {
      return node.height == null || node.height === 0;
    } else {
      return node.height == null || node.height === 0;
    }
  }
}

/** Check if any child uses FILL/STRETCH sizing. */
function hasStretchChild(node: AbstractNode): boolean {
  if (!node.children) return false;
  return node.children.some((child) => {
    const la = child.layoutAlign;
    return la === 'STRETCH';
  });
}

export const unboundedHugRule: LintRule = {
  name: 'unbounded-hug',
  description: 'Detect frames with HUG sizing that contain FILL/STRETCH children, causing layout collapse.',
  category: 'layout',
  severity: 'unsafe',
  ai: {
    preventionHint:
      'HUG containers must not contain STRETCH children — use FILL parent or set child to fixed/HUG sizing',
    phase: ['layout'],
  },

  check(node: AbstractNode, ctx: LintContext): LintViolation[] {
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT') return [];
    if (!node.layoutMode || node.layoutMode === 'NONE') return [];
    if (!node.children || node.children.length === 0) return [];

    const violations: LintViolation[] = [];
    const isVertical = node.layoutMode === 'VERTICAL';

    // Check 1: Frame has no explicit dimension on cross-axis AND has STRETCH children
    // This is the HUG/STRETCH paradox — parent HUGs but child wants to FILL
    const crossDim = isVertical ? 'width' : 'height';
    const crossAxis = isVertical ? 'horizontal' : 'vertical';

    if (node[crossDim] == null || node[crossDim] === 0) {
      if (hasStretchChild(node)) {
        violations.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: 'unbounded-hug',
          severity: 'unsafe',
          currentValue: `HUG on ${crossAxis} axis with STRETCH children`,
          suggestion: tr(
            ctx.lang,
            `"${node.name}" HUGs on ${crossAxis} axis but has STRETCH children — children will collapse to 0. Set an explicit ${crossDim} or use layoutAlign: STRETCH on this frame.`,
            `「${node.name}」在${crossAxis === 'horizontal' ? '横向' : '纵向'}使用 HUG 但子节点用 STRETCH——子节点会坍缩为 0。请设置明确的 ${crossDim},或在该 frame 上用 layoutAlign: STRETCH。`,
          ),
          autoFixable: true,
          fixData: {
            fix: 'stretch-self',
            layoutAlign: 'STRETCH',
          },
        });
      }
    }

    // Check 2: Both axes have no explicit dimension (HUG/HUG) with children
    // This is less severe but still suspicious — the frame has no size constraints at all
    if (node.width == null && node.height == null && node.children.length > 0) {
      // Only flag if this is a non-root frame (root frames are expected to have no parent constraints)
      // We can't check parent here, but we can check if it has a name suggesting it's a section
      const isLikelyRoot = /^(screen|page|mobile|desktop|tablet)/i.test(node.name);
      if (!isLikelyRoot) {
        violations.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: 'unbounded-hug',
          severity: 'style',
          currentValue: 'HUG on both axes (no explicit width or height)',
          suggestion: tr(
            ctx.lang,
            `"${node.name}" has no explicit dimensions — it will shrink to content size. If this is inside an auto-layout parent, consider layoutAlign: STRETCH on the cross-axis.`,
            `「${node.name}」没有明确尺寸——会缩到内容大小。如果在自动布局父级内,建议在交叉轴上设置 layoutAlign: STRETCH。`,
          ),
          autoFixable: true,
          fixData: {
            fix: 'stretch-cross-axis',
            crossAxis: isVertical ? 'horizontal' : 'vertical',
          },
        });
      }
    }

    return violations;
  },

  describeFix(v): FixDescriptor | null {
    if (!v.fixData) return null;
    if (v.fixData.fix === 'stretch-self') {
      return { kind: 'set-properties', props: { layoutAlign: v.fixData.layoutAlign ?? 'STRETCH' } };
    }
    if (v.fixData.fix === 'stretch-cross-axis') {
      // For HUG/HUG frames, stretch the cross-axis so the frame fills available space
      return { kind: 'set-properties', props: { layoutAlign: 'STRETCH' } };
    }
    return null;
  },
};
