/**
 * Tests for WCAG lint rules: contrast, target-size, text-size, line-height.
 */

import { describe, expect, it } from 'vitest';
import { runLint } from '../../packages/quality-engine/src/engine.js';
import { wcagContrastRule } from '../../packages/quality-engine/src/rules/wcag/wcag-contrast.js';
import { wcagLineHeightRule } from '../../packages/quality-engine/src/rules/wcag/wcag-line-height.js';
import { wcagNonTextContrastRule } from '../../packages/quality-engine/src/rules/wcag/wcag-non-text-contrast.js';
import { wcagTargetSizeRule } from '../../packages/quality-engine/src/rules/wcag/wcag-target-size.js';
import { wcagTextSizeRule } from '../../packages/quality-engine/src/rules/wcag/wcag-text-size.js';
import type { AbstractNode, LintContext } from '../../packages/quality-engine/src/types.js';

const emptyCtx: LintContext = {
  colorTokens: new Map(),
  spacingTokens: new Map(),
  radiusTokens: new Map(),
  typographyTokens: new Map(),
  variableIds: new Map(),
};

function makeNode(overrides: Partial<AbstractNode>): AbstractNode {
  return { id: '1:1', name: 'Test', type: 'FRAME', ...overrides };
}

// ─── severity calibration ───

describe('wcag severity calibration', () => {
  it('wcag-contrast has unsafe severity', () => {
    expect(wcagContrastRule.severity).toBe('unsafe');
  });
  it('wcag-target-size has heuristic severity', () => {
    expect(wcagTargetSizeRule.severity).toBe('heuristic');
  });
  it('wcag-text-size has heuristic severity', () => {
    expect(wcagTextSizeRule.severity).toBe('heuristic');
  });
  it('wcag-line-height has heuristic severity', () => {
    expect(wcagLineHeightRule.severity).toBe('heuristic');
  });
  it('wcag-non-text-contrast has heuristic severity', () => {
    expect(wcagNonTextContrastRule.severity).toBe('heuristic');
  });
});

// ─── preventionHint ───

describe('wcag preventionHint', () => {
  it('wcag-contrast has preventionHint', () => {
    expect(wcagContrastRule.ai?.preventionHint).toBeDefined();
  });
  it('wcag-target-size has preventionHint', () => {
    expect(wcagTargetSizeRule.ai?.preventionHint).toBeDefined();
  });
  it('wcag-text-size has preventionHint', () => {
    expect(wcagTextSizeRule.ai?.preventionHint).toBeDefined();
  });
  it('wcag-line-height has preventionHint', () => {
    expect(wcagLineHeightRule.ai?.preventionHint).toBeDefined();
  });
  it('wcag-non-text-contrast has preventionHint', () => {
    expect(wcagNonTextContrastRule.ai?.preventionHint).toBeDefined();
  });
});

// ─── wcag-target-size describeFix ───

describe('wcag-target-size describeFix', () => {
  it('returns resize descriptor for undersized button (below WCAG 24 floor)', () => {
    const node = makeNode({ name: 'Button', width: 20, height: 20 });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(1);
    expect(violations[0].autoFixable).toBe(true);
    const fix = wcagTargetSizeRule.describeFix!(violations[0]);
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('resize');
    if (fix!.kind === 'resize') {
      // fix suggests the iOS HIG ideal (44), not just the WCAG floor
      expect(fix!.width).toBe(44);
      expect(fix!.height).toBe(44);
    }
  });

  it('only resizes the axis that is too small', () => {
    const node = makeNode({ name: 'Button', width: 100, height: 20 });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(1);
    const fix = wcagTargetSizeRule.describeFix!(violations[0]);
    expect(fix).not.toBeNull();
    if (fix!.kind === 'resize') {
      expect(fix!.width).toBeUndefined();
      expect(fix!.height).toBe(44);
    }
  });

  it('passes 30×30 interactive element (above WCAG 24 floor)', () => {
    const node = makeNode({ name: 'Button', width: 30, height: 30 });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(0);
  });

  // Regression: auto-classified link/button kinds must also be handed off
  // to the kind-specific structure rules. Previously the fallback only
  // respected declared=true, so "Forgot Link" / "Sign Up Link" got
  // double-flagged alongside link-standalone-structure.
  it('defers to structure rule when classifier auto-labels as link-standalone (confidence >= 0.7)', () => {
    const node = makeNode({
      name: 'Forgot Link',
      width: 354,
      height: 20,
      interactive: { kind: 'link-standalone', confidence: 0.7 },
    });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(0);
  });

  it('defers to structure rule when classifier auto-labels as button-solid (confidence >= 0.7)', () => {
    const node = makeNode({
      name: 'Button',
      width: 20,
      height: 20,
      interactive: { kind: 'button-solid', confidence: 0.75 },
    });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(0);
  });

  it('still flags when classifier confidence is too low to commit (< 0.7, not declared)', () => {
    const node = makeNode({
      name: 'Link',
      width: 354,
      height: 20,
      interactive: { kind: 'link-standalone', confidence: 0.5 },
    });
    const violations = wcagTargetSizeRule.check(node, emptyCtx);
    expect(violations).toHaveLength(1);
  });
});

// ─── wcag-contrast (AA) ───

describe('wcag-contrast', () => {
  it('passes high contrast text (black)', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 14,
      fills: [{ type: 'SOLID', color: '#000000', visible: true }],
    });
    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('passes white text (good contrast on black)', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 14,
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
    });
    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('uses 3:1 threshold for large text', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 24,
      fills: [{ type: 'SOLID', color: '#767676', visible: true }],
    });
    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('skips non-text nodes', () => {
    const v = wcagContrastRule.check(makeNode({ type: 'RECTANGLE' }), emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('skips text without fills', () => {
    const node = makeNode({ type: 'TEXT', fontSize: 14 });
    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('skips invisible fills', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 14,
      fills: [{ type: 'SOLID', color: '#cccccc', visible: false }],
    });
    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });
});

describe('wcag-contrast alpha compositing', () => {
  it('uses the composited parent background for text over translucent button fills', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
      children: [
        makeNode({
          id: 'button',
          name: 'Product Details',
          type: 'FRAME',
          fills: [{ type: 'SOLID', color: '#000000', opacity: 0.04, visible: true }],
          children: [
            makeNode({
              id: 'action',
              name: 'Action',
              type: 'TEXT',
              fontSize: 18,
              fills: [{ type: 'SOLID', color: '#000000', visible: true }],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'action') ?? [];
    expect(violations).toHaveLength(0);
  });

  it('uses the composited foreground color when text fill is translucent', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 14,
      parentBgColor: '#ffffff',
      fills: [{ type: 'SOLID', color: '#000000', opacity: 0.2, visible: true }],
    });

    const v = wcagContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(1);
    expect(v[0].currentValue).not.toBe('21.00:1');
  });
});

// ─── wcag-non-text-contrast (WCAG 1.4.11) — scoped to button-solid / button-outline ───

describe('wcag-non-text-contrast', () => {
  it('flags white-on-white solid button (fill invisible against parent bg)', () => {
    // The canonical 1.4.11 failure: a filled button whose surface blends
    // into the background makes the button itself unidentifiable.
    const node = makeNode({
      type: 'FRAME',
      width: 200,
      height: 48,
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
      parentBgColor: '#ffffff',
      interactive: { kind: 'button-solid', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(1);
    expect(v[0].currentValue).toContain('fill');
  });

  it('passes solid button with high-contrast fill', () => {
    const node = makeNode({
      type: 'FRAME',
      width: 200,
      height: 48,
      fills: [{ type: 'SOLID', color: '#000000', visible: true }],
      parentBgColor: '#ffffff',
      interactive: { kind: 'button-solid', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('flags outline button whose stroke blends into parent bg', () => {
    const node = makeNode({
      type: 'FRAME',
      width: 200,
      height: 48,
      strokes: [{ type: 'SOLID', color: '#f5f5f5', visible: true }],
      strokeWeight: 1,
      parentBgColor: '#ffffff',
      interactive: { kind: 'button-outline', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(1);
    expect(v[0].currentValue).toContain('stroke');
  });

  it('passes outline button with visible stroke', () => {
    const node = makeNode({
      type: 'FRAME',
      width: 200,
      height: 48,
      strokes: [{ type: 'SOLID', color: '#333333', visible: true }],
      strokeWeight: 1,
      parentBgColor: '#ffffff',
      interactive: { kind: 'button-outline', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('regression: image container (low-contrast placeholder fill) is NOT flagged', () => {
    // The user-visible screenshot regression: a 96×96 `image / default`
    // component instance with a placeholder fill like #f5f5f5 on a colored
    // card. It's a content holder, not a UI component — 1.4.11 doesn't apply.
    const node = makeNode({
      type: 'INSTANCE',
      name: 'image / default',
      width: 96,
      height: 96,
      fills: [{ type: 'SOLID', color: '#f5f5f5', visible: true }],
      parentBgColor: '#c8e6c9',
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('regression: a decorative card with low-contrast fill is NOT flagged', () => {
    const node = makeNode({
      type: 'FRAME',
      name: 'Card',
      width: 200,
      height: 100,
      fills: [{ type: 'SOLID', color: '#f5f5f5', visible: true }],
      parentBgColor: '#ffffff',
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('regression: a button-ghost (no surface) is NOT flagged even with low-contrast fill', () => {
    const node = makeNode({
      type: 'FRAME',
      width: 100,
      height: 40,
      fills: [{ type: 'SOLID', color: '#f5f5f5', visible: true }],
      parentBgColor: '#ffffff',
      interactive: { kind: 'button-ghost', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('skips TEXT nodes (handled by wcag-contrast for 1.4.3)', () => {
    const node = makeNode({
      type: 'TEXT',
      fontSize: 14,
      fills: [{ type: 'SOLID', color: '#cccccc', visible: true }],
      parentBgColor: '#ffffff',
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('returns empty when no parentBgColor is propagated', () => {
    const node = makeNode({
      type: 'FRAME',
      width: 200,
      height: 48,
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
      interactive: { kind: 'button-solid', confidence: 1, declared: true },
    });
    const v = wcagNonTextContrastRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });
});
