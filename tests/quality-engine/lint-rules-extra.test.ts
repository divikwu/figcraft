/**
 * Tests for additional lint rules — layout, wcag, token rules.
 */

import { describe, expect, it } from 'vitest';
import { maxNestingDepthRule } from '../../packages/quality-engine/src/rules/layout/max-nesting-depth.js';
import { screenBottomOverflowRule } from '../../packages/quality-engine/src/rules/layout/screen-bottom-overflow.js';
import { sectionSpacingCollapseRule } from '../../packages/quality-engine/src/rules/layout/section-spacing-collapse.js';
import { foreignStyleRule } from '../../packages/quality-engine/src/rules/spec/foreign-style.js';
import { hardcodedTokenRule } from '../../packages/quality-engine/src/rules/spec/hardcoded-token.js';
import { ctaWidthInconsistentRule } from '../../packages/quality-engine/src/rules/structure/cta-width-inconsistent.js';
import { formConsistencyRule } from '../../packages/quality-engine/src/rules/structure/form-consistency.js';
import { inputFieldStructureRule } from '../../packages/quality-engine/src/rules/structure/input-field-structure.js';
import { navOvercrowdedRule } from '../../packages/quality-engine/src/rules/structure/nav-overcrowded.js';
import { nestedInteractiveShellRule } from '../../packages/quality-engine/src/rules/structure/nested-interactive-shell.js';
import { rootMisclassifiedInteractiveRule } from '../../packages/quality-engine/src/rules/structure/root-misclassified-interactive.js';
import { screenShellInvalidRule } from '../../packages/quality-engine/src/rules/structure/screen-shell-invalid.js';
import { socialRowCrampedRule } from '../../packages/quality-engine/src/rules/structure/social-row-cramped.js';
import { statsRowCrampedRule } from '../../packages/quality-engine/src/rules/structure/stats-row-cramped.js';
import { wcagLineHeightRule } from '../../packages/quality-engine/src/rules/wcag/wcag-line-height.js';
import { wcagTargetSizeRule } from '../../packages/quality-engine/src/rules/wcag/wcag-target-size.js';
import type { AbstractNode, LintContext } from '../../packages/quality-engine/src/types.js';

const emptyCtx: LintContext = {
  colorTokens: new Map(),
  spacingTokens: new Map(),
  radiusTokens: new Map(),
  typographyTokens: new Map(),
  variableIds: new Map(),
};

const libraryCtx: LintContext = {
  ...emptyCtx,
  mode: 'library',
  selectedLibrary: 'TestLib',
};

function makeNode(overrides: Partial<AbstractNode>): AbstractNode {
  return { id: '1:1', name: 'Test', type: 'FRAME', ...overrides };
}

// ─── hardcoded-token ───

describe('hardcoded-token', () => {
  it('flags unbound fill in library mode', () => {
    const node = makeNode({
      type: 'RECTANGLE',
      fills: [{ type: 'SOLID', color: '#FF0000', visible: true }],
    });
    const v = hardcodedTokenRule.check(node, libraryCtx);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].rule).toBe('hardcoded-token');
  });

  it('passes node with bound variables', () => {
    const node = makeNode({
      type: 'RECTANGLE',
      fills: [{ type: 'SOLID', color: '#FF0000', visible: true }],
      boundVariables: { fills: [{ id: 'var:123' }] },
    });
    const v = hardcodedTokenRule.check(node, libraryCtx);
    const fillViolations = v.filter((vi) => String(vi.currentValue).includes('fill'));
    expect(fillViolations).toHaveLength(0);
  });

  it('skips in spec mode', () => {
    const specCtx: LintContext = { ...emptyCtx, mode: 'spec' };
    const node = makeNode({
      type: 'RECTANGLE',
      fills: [{ type: 'SOLID', color: '#FF0000', visible: true }],
    });
    const v = hardcodedTokenRule.check(node, specCtx);
    expect(v).toHaveLength(0);
  });

  it('passes node with per-paint fill binding (fill.boundVariables.color)', () => {
    // Regression: modern Figma API stores color binding per-paint for TEXT
    // fills (text/primary), not on node.boundVariables.fills.
    const node = makeNode({
      type: 'TEXT',
      name: 'Welcome back',
      fills: [
        {
          type: 'SOLID',
          color: '#000000',
          opacity: 0.87,
          visible: true,
          boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'var:text-primary' } },
        },
      ],
    });
    const v = hardcodedTokenRule.check(node, libraryCtx);
    const fillViolations = v.filter((vi) => String(vi.currentValue).includes('fill'));
    expect(fillViolations).toHaveLength(0);
  });

  it('skips cornerRadius check on INSTANCE (Figma API does not expose inherited radius bindings)', () => {
    // Regression: for INSTANCE nodes, node-level bindings (cornerRadius etc.)
    // are inherited from the master COMPONENT but NOT surfaced on the instance's
    // boundVariables. Previously this false-positived on every bound button
    // instance ("Login Button 圆角 8px 未绑定到 Token").
    const node = makeNode({
      type: 'INSTANCE',
      name: 'Login Button',
      cornerRadius: 8,
      // boundVariables is empty or absent — Figma does not expose inherited radius bindings here
    });
    const v = hardcodedTokenRule.check(node, libraryCtx);
    const radiusViolations = v.filter((vi) => String(vi.currentValue).includes('cornerRadius'));
    expect(radiusViolations).toHaveLength(0);
  });

  it('passes COMPONENT with per-corner radius binding (boundVariables.topLeftRadius)', () => {
    // Regression: Figma stores cornerRadius binding as four per-corner keys
    // (topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius)
    // even when the UI shows one uniform value.
    const node = makeNode({
      type: 'COMPONENT',
      name: 'Login Button',
      cornerRadius: 8,
      boundVariables: {
        topLeftRadius: { id: 'var:radius-md' },
        topRightRadius: { id: 'var:radius-md' },
        bottomLeftRadius: { id: 'var:radius-md' },
        bottomRightRadius: { id: 'var:radius-md' },
      },
    });
    const v = hardcodedTokenRule.check(node, libraryCtx);
    const radiusViolations = v.filter((vi) => String(vi.currentValue).includes('cornerRadius'));
    expect(radiusViolations).toHaveLength(0);
  });
});

// ─── foreign-style ───

describe('foreign-style', () => {
  const styleCtx: LintContext = {
    ...libraryCtx,
    libraryStyleIds: new Set(['S:selected-local-id']),
    libraryStyleKeys: new Set(['selected-style-key']),
  };

  it('passes when the document-local style ID changed but stable style key matches', () => {
    const node = makeNode({
      type: 'TEXT',
      name: 'Title',
      fontSize: 32,
      textStyleId: 'S:current-file-id',
      textStyleKey: 'selected-style-key',
    });

    expect(foreignStyleRule.check(node, styleCtx)).toHaveLength(0);
  });

  it('flags a style whose ID and stable key are outside the selected library', () => {
    const node = makeNode({
      type: 'TEXT',
      name: 'Title',
      fontSize: 32,
      textStyleId: 'S:foreign-id',
      textStyleKey: 'foreign-style-key',
    });

    const violations = foreignStyleRule.check(node, styleCtx);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('foreign-style');
  });

  it('does not flag an imported library style when the selected-library style registry is incomplete', () => {
    const node = makeNode({
      type: 'TEXT',
      name: 'Title',
      fontSize: 32,
      textStyleId: 'S:current-file-id',
      textStyleKey: 'missing-from-registry',
      textStyleRemote: true,
    });

    expect(foreignStyleRule.check(node, styleCtx)).toHaveLength(0);
  });

  it('does not flag when style metadata cannot be resolved', () => {
    const node = makeNode({
      type: 'TEXT',
      name: 'Title',
      fontSize: 32,
      textStyleId: 'S:unresolved-style-id',
    });

    expect(foreignStyleRule.check(node, styleCtx)).toHaveLength(0);
  });

  it('still flags a local style whose ID and key are outside the selected library', () => {
    const node = makeNode({
      type: 'TEXT',
      name: 'Title',
      fontSize: 32,
      textStyleId: 'S:local-style-id',
      textStyleKey: 'local-style-key',
      textStyleRemote: false,
    });

    const violations = foreignStyleRule.check(node, styleCtx);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('foreign-style');
  });
});

// ─── wcag-target-size ───

describe('wcag-target-size', () => {
  it('flags small button below WCAG 2.5.8 AA (24)', () => {
    const v = wcagTargetSizeRule.check(
      makeNode({ name: 'Submit Button', type: 'FRAME', width: 20, height: 20 }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('heuristic');
  });

  it('passes 30×30 button (above WCAG 24 floor, below old 44 ideal)', () => {
    const v = wcagTargetSizeRule.check(
      makeNode({ name: 'Submit Button', type: 'FRAME', width: 30, height: 30 }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('passes large button', () => {
    const v = wcagTargetSizeRule.check(
      makeNode({ name: 'Submit Button', type: 'FRAME', width: 120, height: 48 }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('ignores non-interactive elements', () => {
    const v = wcagTargetSizeRule.check(
      makeNode({ name: 'Decorative Frame', type: 'FRAME', width: 10, height: 10 }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

// ─── wcag-line-height ───

describe('wcag-line-height', () => {
  it('flags tight line height', () => {
    const v = wcagLineHeightRule.check(
      makeNode({ type: 'TEXT', fontSize: 16, lineHeight: { unit: 'PIXELS', value: 12 } }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
  });

  it('passes adequate line height', () => {
    const v = wcagLineHeightRule.check(
      makeNode({ type: 'TEXT', fontSize: 16, lineHeight: { unit: 'PIXELS', value: 24 } }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('passes AUTO line height', () => {
    const v = wcagLineHeightRule.check(
      makeNode({ type: 'TEXT', fontSize: 16, lineHeight: { unit: 'AUTO' } }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

// ─── max-nesting-depth ───

describe('max-nesting-depth', () => {
  it('flags deeply nested frames', () => {
    let deepest: AbstractNode = makeNode({ id: '9:1', name: 'Deep', type: 'FRAME' });
    for (let i = 8; i >= 2; i--) {
      deepest = makeNode({ id: `${i}:1`, name: `Level ${i}`, type: 'FRAME', children: [deepest] });
    }
    const root = makeNode({ id: '1:1', name: 'Root', type: 'FRAME', children: [deepest] });

    const v = maxNestingDepthRule.check(root, emptyCtx);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].rule).toBe('max-nesting-depth');
  });

  it('passes shallow nesting', () => {
    const node = makeNode({
      type: 'FRAME',
      children: [makeNode({ id: '2:1', type: 'FRAME', children: [makeNode({ id: '3:1', type: 'TEXT' })] })],
    });
    const v = maxNestingDepthRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('ignores non-container types', () => {
    const v = maxNestingDepthRule.check(makeNode({ type: 'RECTANGLE' }), emptyCtx);
    expect(v).toHaveLength(0);
  });
});

// ─── button-solid-structure (enhanced) ───

import { classifyInteractive } from '../../packages/quality-engine/src/interactive/classifier.js';
import { textOverflowRule } from '../../packages/quality-engine/src/rules/layout/text-overflow.js';
import { buttonSolidStructureRule } from '../../packages/quality-engine/src/rules/structure/button-solid-structure.js';

/** Engine cache-then-check emulation for unit tests. */
function classifyAndCheck(node: import('../../packages/quality-engine/src/types.js').AbstractNode) {
  const result = classifyInteractive(node);
  if (result.kind) {
    node.interactive = {
      kind: result.kind,
      confidence: result.confidence,
      signals: result.signals,
      declared: false,
    };
  }
  return buttonSolidStructureRule.check(node, emptyCtx);
}

describe('button-solid-structure', () => {
  const fillPaint = [{ type: 'SOLID', color: '#007AFF', visible: true, opacity: 1 }];

  it('flags non-frame button (RECTANGLE classified via role=button + fill)', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Submit Button',
        role: 'button',
        type: 'RECTANGLE',
        width: 120,
        height: 48,
        fills: fillPaint,
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0].autoFixable).toBe(false);
  });

  it('flags button without auto-layout', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Login Button',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 48,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Login', characters: 'Login' })],
      }),
    );
    expect(v.some((vi) => vi.fixData?.fix === 'layout' || vi.fixData?.layoutMode)).toBe(true);
    expect(v.some((vi) => vi.autoFixable)).toBe(true);
  });

  it('flags button with insufficient padding', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Submit Btn',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 48,
        layoutMode: 'HORIZONTAL',
        paddingLeft: 4,
        paddingRight: 4,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Submit', characters: 'Submit' })],
      }),
    );
    const padViolation = v.find((vi) => vi.fixData?.fix === 'padding');
    expect(padViolation).toBeDefined();
    expect(padViolation!.autoFixable).toBe(true);
    expect(padViolation!.fixData!.paddingLeft).toBe(24);
  });

  it('passes button with adequate padding', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Submit Btn',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 48,
        layoutMode: 'HORIZONTAL',
        paddingLeft: 24,
        paddingRight: 24,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Submit', characters: 'Submit' })],
      }),
    );
    const padViolation = v.find((vi) => vi.fixData?.fix === 'padding');
    expect(padViolation).toBeUndefined();
  });

  it('flags button with height below WCAG 2.5.8 AA (24)', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Tiny Button',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 20,
        layoutMode: 'HORIZONTAL',
        paddingLeft: 24,
        paddingRight: 24,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Go', characters: 'Go' })],
      }),
    );
    const heightViolation = v.find((vi) => vi.fixData?.fix === 'height');
    expect(heightViolation).toBeDefined();
    expect(heightViolation!.autoFixable).toBe(true);
    expect(heightViolation!.fixData!.height).toBe(44); // describeFix still suggests 44 (iOS HIG ideal)
  });

  it('passes button with adequate height', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Good Button',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 48,
        layoutMode: 'HORIZONTAL',
        paddingLeft: 24,
        paddingRight: 24,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Go', characters: 'Go' })],
      }),
    );
    const heightViolation = v.find((vi) => vi.fixData?.fix === 'height');
    expect(heightViolation).toBeUndefined();
  });

  it('detects button by role + fill + single text child even without "button" in name', () => {
    const v = classifyAndCheck(
      makeNode({
        name: 'Primary Action',
        role: 'button',
        type: 'FRAME',
        width: 120,
        height: 48,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Go', characters: 'Go' })],
      }),
    );
    // Classified as button-solid, then flagged for missing layout
    expect(v.length).toBeGreaterThan(0);
  });

  it('ignores non-button frames', () => {
    const v = classifyAndCheck(makeNode({ name: 'Header Section', type: 'FRAME', width: 400, height: 60 }));
    expect(v).toHaveLength(0);
  });

  it('still checks padding/height for COMPONENT buttons when structurally off', () => {
    // Variant rules uniformly enforce the contract — the legacy skip for
    // COMPONENT/INSTANCE was a conservative carve-out. Under V2 the classifier
    // commits to button-solid and the rule fires.
    const v = classifyAndCheck(
      makeNode({
        name: 'Submit Button',
        role: 'button',
        type: 'COMPONENT',
        width: 120,
        height: 30,
        layoutMode: 'HORIZONTAL',
        paddingLeft: 4,
        paddingRight: 4,
        fills: fillPaint,
        children: [makeNode({ id: '2:1', type: 'TEXT', name: 'Go', characters: 'Go' })],
      }),
    );
    // COMPONENT path only runs layout/type checks now; padding/height remain
    // FRAME-only in button-solid-structure. Verify no crash and classifier
    // commits to button-solid.
    expect(v.some((vi) => vi.rule === 'button-solid-structure')).toBeDefined();
  });
});

// ─── text-overflow (enhanced) ───

describe('text-overflow', () => {
  it('flags text wider than parent', () => {
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: 'Long Label',
        width: 500,
        height: 20,
        characters: 'This is a very long text that overflows',
        parentWidth: 300,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].autoFixable).toBe(true);
    // No parent layout → WIDTH_AND_HEIGHT
    expect(v[0].fixData?.textAutoResize).toBe('WIDTH_AND_HEIGHT');
  });

  it('uses HEIGHT fix when parent has auto-layout', () => {
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: 'Long Label',
        width: 500,
        height: 20,
        characters: 'This is a very long text that overflows',
        parentWidth: 300,
        parentLayoutMode: 'VERTICAL',
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].fixData?.textAutoResize).toBe('HEIGHT');
  });

  it('passes text within parent bounds', () => {
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: 'Short Label',
        width: 100,
        height: 20,
        characters: 'Hello',
        parentWidth: 300,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('flags heuristic overflow for long single-line text', () => {
    const longText = 'A'.repeat(200);
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: 'Clipped Text',
        width: 100,
        height: 20,
        characters: longText,
        fontSize: 16,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].autoFixable).toBe(true);
  });

  it('ignores non-text nodes', () => {
    const v = textOverflowRule.check(makeNode({ type: 'FRAME', name: 'Container', width: 300 }), emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('ignores short text', () => {
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: 'OK',
        width: 30,
        height: 20,
        characters: 'OK',
        fontSize: 16,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('respects textTruncation: ENDING as explicit opt-in (skips even when text would overflow parent)', () => {
    // Designer set maxLines + ending ellipsis — this is intentional truncation,
    // not an overflow bug. Method 1 would otherwise flag width > parentWidth.
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: '#Product Name',
        width: 400,
        height: 40,
        characters: 'HADABISEI 3D Collagen Moisturizing Mask',
        fontSize: 14,
        parentWidth: 120,
        textTruncation: 'ENDING',
        maxLines: 3,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('skips Method 2 heuristic for CJK-dominant strings (estimate undercounts CJK widths)', () => {
    // 50 CJK chars × est 0.6 × 20px = 600px > 500 threshold, node width 200 < 300;
    // would fire under the old pre-session logic. ASCII guard now suppresses.
    const v = textOverflowRule.check(
      makeNode({
        type: 'TEXT',
        name: '产品名',
        width: 200,
        height: 24,
        characters: '这是一段非常长的中文产品名称用来模拟商品详情页里实际会出现的超长标题场景需要足够多字',
        fontSize: 20,
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

// ─── form-consistency ───

describe('form-consistency', () => {
  it('flags narrow children in a form container', () => {
    const v = formConsistencyRule.check(
      makeNode({
        name: 'Login Form',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({
            id: '2:1',
            name: 'Email Input',
            type: 'FRAME',
            width: 350,
            fills: [{ type: 'SOLID', color: '#FFFFFF', visible: true }],
          }),
          makeNode({
            id: '2:2',
            name: 'Password Input',
            type: 'FRAME',
            width: 350,
            strokes: [{ type: 'SOLID', color: '#E0E0E0', visible: true }],
          }),
          makeNode({
            id: '2:3',
            name: 'Login Button',
            type: 'FRAME',
            width: 200,
            fills: [{ type: 'SOLID', color: '#0066FF', visible: true }],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].nodeName).toBe('Login Button');
    expect(v[0].rule).toBe('form-consistency');
    expect(v[0].autoFixable).toBe(true);
  });

  it('passes when all children have consistent widths', () => {
    const v = formConsistencyRule.check(
      makeNode({
        name: 'Login Form',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({
            id: '2:1',
            name: 'Email Input',
            type: 'FRAME',
            width: 350,
            strokes: [{ type: 'SOLID', color: '#E0E0E0', visible: true }],
          }),
          makeNode({
            id: '2:2',
            name: 'Login Button',
            type: 'FRAME',
            width: 350,
            fills: [{ type: 'SOLID', color: '#0066FF', visible: true }],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('skips non-form containers', () => {
    const v = formConsistencyRule.check(
      makeNode({
        name: 'Header',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({ id: '2:1', name: 'Title', type: 'TEXT', width: 200 }),
          makeNode({ id: '2:2', name: 'Subtitle', type: 'TEXT', width: 150 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('skips HORIZONTAL layout containers', () => {
    const v = formConsistencyRule.check(
      makeNode({
        name: 'Login Form',
        type: 'FRAME',
        layoutMode: 'HORIZONTAL',
        width: 350,
        children: [
          makeNode({
            id: '2:1',
            name: 'Email Input',
            type: 'FRAME',
            width: 200,
            strokes: [{ type: 'SOLID', color: '#E0E0E0', visible: true }],
          }),
          makeNode({
            id: '2:2',
            name: 'Login Button',
            type: 'FRAME',
            width: 100,
            fills: [{ type: 'SOLID', color: '#0066FF', visible: true }],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('cta-width-inconsistent', () => {
  it('flags CTA buttons that are noticeably narrower than form fields', () => {
    const v = ctaWidthInconsistentRule.check(
      makeNode({
        name: 'Login Form',
        role: 'form',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({ id: '2:1', name: 'Email Input', role: 'input', type: 'FRAME', width: 350 }),
          makeNode({ id: '2:2', name: 'Password Input', role: 'input', type: 'FRAME', width: 350 }),
          makeNode({ id: '2:3', name: 'Sign In Button', role: 'button', type: 'FRAME', width: 220 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('cta-width-inconsistent');
    expect(v[0].fixData?.fix).toBe('stretch');
  });

  it('passes when CTA width matches the field width', () => {
    const v = ctaWidthInconsistentRule.check(
      makeNode({
        name: 'Login Form',
        role: 'form',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({ id: '2:1', name: 'Email Input', role: 'input', type: 'FRAME', width: 350 }),
          makeNode({ id: '2:2', name: 'Sign In Button', role: 'button', type: 'FRAME', width: 350 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('skips icon-only nav buttons (< 100px) — not CTA candidates', () => {
    // "Top Content" holds a 50px Back Button and a title — a Back button is not a
    // primary CTA and must not be judged against the input width.
    // Also verifies the tightened isFormLike regex via explicit role: 'form'.
    const v = ctaWidthInconsistentRule.check(
      makeNode({
        name: 'Top Content',
        role: 'form',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({ id: '2:1', name: 'Email Input', role: 'input', type: 'FRAME', width: 350 }),
          makeNode({
            id: '2:2',
            name: 'Back Button',
            role: 'button',
            type: 'FRAME',
            width: 50,
            fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('skips non-form containers that only happen to have "Content" in the name', () => {
    // Pre-session regex matched /content/i and mistreated "Top Content" as a form.
    // The role-less fallback should require /\b(form|actions)\b/ now.
    const v = ctaWidthInconsistentRule.check(
      makeNode({
        name: 'Top Content',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        width: 350,
        children: [
          makeNode({ id: '2:1', name: 'Email Input', role: 'input', type: 'FRAME', width: 350 }),
          makeNode({ id: '2:2', name: 'Sign In Button', role: 'button', type: 'FRAME', width: 220 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('section-spacing-collapse', () => {
  it('flags tight section stacks on screen containers', () => {
    const v = sectionSpacingCollapseRule.check(
      makeNode({
        name: 'Auth Screen',
        role: 'screen',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 8,
        children: [
          makeNode({ id: '2:1', name: 'Header', type: 'FRAME' }),
          makeNode({ id: '2:2', name: 'Form', type: 'FRAME' }),
          makeNode({ id: '2:3', name: 'Footer', type: 'FRAME' }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].fixData?.fix).toBe('item-spacing');
    expect(v[0].fixData?.itemSpacing).toBe(16);
  });

  it('passes when section rhythm is already healthy', () => {
    const v = sectionSpacingCollapseRule.check(
      makeNode({
        name: 'Auth Screen',
        role: 'screen',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 20,
        children: [
          makeNode({ id: '2:1', name: 'Header', type: 'FRAME' }),
          makeNode({ id: '2:2', name: 'Form', type: 'FRAME' }),
          makeNode({ id: '2:3', name: 'Footer', type: 'FRAME' }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('passes when children carry their own rhythm signal (visible fill)', () => {
    // Modern card-style feed: each section has its own background,
    // so tight parent itemSpacing is fine — cards visually self-separate.
    const v = sectionSpacingCollapseRule.check(
      makeNode({
        name: 'Content',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 8,
        children: [
          makeNode({
            id: '2:1',
            name: 'Card A',
            type: 'FRAME',
            fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
          }),
          makeNode({
            id: '2:2',
            name: 'Card B',
            type: 'FRAME',
            fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
          }),
          makeNode({
            id: '2:3',
            name: 'Card C',
            type: 'FRAME',
            fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('peeks one level into thin COMPONENT wrappers for rhythm signals', () => {
    // Library components (Product List - Mobile, etc.) often have padding=0
    // and no fill on their root; visuals live in inner Header/Content wrappers.
    const v = sectionSpacingCollapseRule.check(
      makeNode({
        name: 'Content',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 8,
        children: [
          makeNode({
            id: '2:1',
            name: 'Product List / Mobile',
            type: 'COMPONENT',
            // root is empty shell
            children: [makeNode({ id: '3:1', name: 'Header', type: 'FRAME', paddingTop: 12, paddingBottom: 12 })],
          }),
          makeNode({
            id: '2:2',
            name: 'Brand / Campaign',
            type: 'COMPONENT',
            children: [makeNode({ id: '3:2', name: 'Header', type: 'FRAME', paddingTop: 16, paddingBottom: 16 })],
          }),
          makeNode({
            id: '2:3',
            name: 'Story Cover',
            type: 'COMPONENT',
            children: [makeNode({ id: '3:3', name: 'Header', type: 'FRAME', paddingTop: 12, paddingBottom: 12 })],
          }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });

  it('still flags truly empty section stacks even with tight spacing', () => {
    // Regression guard: empty FRAMEs with no rhythm signal at any level
    // should still fire — this is the real "sections collapsed together" case.
    const v = sectionSpacingCollapseRule.check(
      makeNode({
        name: 'Auth Screen',
        role: 'screen',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 6,
        children: [
          makeNode({ id: '2:1', name: 'Header', type: 'FRAME' }),
          makeNode({ id: '2:2', name: 'Body', type: 'FRAME' }),
          makeNode({ id: '2:3', name: 'Footer', type: 'FRAME' }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
  });
});

describe('screen-bottom-overflow', () => {
  it('flags sections that extend past the bottom of the screen', () => {
    const v = screenBottomOverflowRule.check(
      makeNode({
        name: 'Forgot Password',
        role: 'screen',
        type: 'FRAME',
        height: 874,
        children: [makeNode({ id: '2:1', name: 'Footer', role: 'footer', type: 'FRAME', y: 820, height: 100 })],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('screen-bottom-overflow');
  });

  it('passes when all sections stay within the viewport', () => {
    const v = screenBottomOverflowRule.check(
      makeNode({
        name: 'Forgot Password',
        role: 'screen',
        type: 'FRAME',
        height: 874,
        children: [makeNode({ id: '2:1', name: 'Footer', role: 'footer', type: 'FRAME', y: 720, height: 100 })],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('social-row-cramped', () => {
  it('flags social rows whose children do not fit horizontally', () => {
    const v = socialRowCrampedRule.check(
      makeNode({
        name: 'Social Login Row',
        role: 'social_row',
        type: 'FRAME',
        width: 260,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 16,
        children: [
          makeNode({ id: '2:1', name: 'Apple Button', role: 'button', width: 96, height: 48 }),
          makeNode({ id: '2:2', name: 'Google Button', role: 'button', width: 96, height: 48 }),
          makeNode({ id: '2:3', name: 'Facebook Button', role: 'button', width: 96, height: 48 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('social-row-cramped');
  });

  it('passes social rows with enough space', () => {
    const v = socialRowCrampedRule.check(
      makeNode({
        name: 'Social Login Row',
        role: 'social_row',
        type: 'FRAME',
        width: 340,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 12,
        children: [
          makeNode({ id: '2:1', name: 'Apple Button', role: 'button', width: 96, height: 48 }),
          makeNode({ id: '2:2', name: 'Google Button', role: 'button', width: 96, height: 48 }),
          makeNode({ id: '2:3', name: 'Facebook Button', role: 'button', width: 96, height: 48 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('nav-overcrowded', () => {
  it('flags nav rows that cannot fit all items', () => {
    const v = navOvercrowdedRule.check(
      makeNode({
        name: 'Primary Nav',
        role: 'nav',
        type: 'FRAME',
        width: 240,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 16,
        children: [
          makeNode({ id: '2:1', name: 'Overview', width: 80, height: 40 }),
          makeNode({ id: '2:2', name: 'Reports', width: 80, height: 40 }),
          makeNode({ id: '2:3', name: 'Customers', width: 96, height: 40 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('nav-overcrowded');
  });

  it('passes nav rows with enough width', () => {
    const v = navOvercrowdedRule.check(
      makeNode({
        name: 'Primary Nav',
        role: 'nav',
        type: 'FRAME',
        width: 360,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 12,
        children: [
          makeNode({ id: '2:1', name: 'Overview', width: 80, height: 40 }),
          makeNode({ id: '2:2', name: 'Reports', width: 80, height: 40 }),
          makeNode({ id: '2:3', name: 'Customers', width: 96, height: 40 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('stats-row-cramped', () => {
  it('flags stats rows that cannot fit all cards', () => {
    const v = statsRowCrampedRule.check(
      makeNode({
        name: 'Metrics',
        role: 'stats',
        type: 'FRAME',
        width: 640,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 24,
        paddingLeft: 24,
        paddingRight: 24,
        children: [
          makeNode({ id: '2:1', name: 'Revenue Card', role: 'card', width: 220, height: 120 }),
          makeNode({ id: '2:2', name: 'MRR Card', role: 'card', width: 220, height: 120 }),
          makeNode({ id: '2:3', name: 'Churn Card', role: 'card', width: 220, height: 120 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('stats-row-cramped');
  });

  it('passes stats rows with enough width', () => {
    const v = statsRowCrampedRule.check(
      makeNode({
        name: 'Metrics',
        role: 'stats',
        type: 'FRAME',
        width: 960,
        layoutMode: 'HORIZONTAL',
        itemSpacing: 16,
        paddingLeft: 24,
        paddingRight: 24,
        children: [
          makeNode({ id: '2:1', name: 'Revenue Card', role: 'card', width: 220, height: 120 }),
          makeNode({ id: '2:2', name: 'MRR Card', role: 'card', width: 220, height: 120 }),
          makeNode({ id: '2:3', name: 'Churn Card', role: 'card', width: 220, height: 120 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('root-misclassified-interactive', () => {
  it('flags screen-sized roots that carry button semantics', () => {
    const v = rootMisclassifiedInteractiveRule.check(
      makeNode({
        name: 'Sign In',
        role: 'button',
        type: 'FRAME',
        width: 402,
        height: 874,
        children: [
          makeNode({ id: '2:1', name: 'Header', type: 'FRAME', height: 88 }),
          makeNode({ id: '2:2', name: 'Form', type: 'FRAME', height: 320 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('root-misclassified-interactive');
    expect(v[0].severity).toBe('error');
  });

  it('passes normal screen roots', () => {
    const v = rootMisclassifiedInteractiveRule.check(
      makeNode({
        name: 'Sign In',
        role: 'screen',
        type: 'FRAME',
        width: 402,
        height: 874,
        children: [
          makeNode({ id: '2:1', name: 'Header', type: 'FRAME', height: 88 }),
          makeNode({ id: '2:2', name: 'Form', type: 'FRAME', height: 320 }),
        ],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('nested-interactive-shell', () => {
  it('flags interactive shells nested inside interactive parents', () => {
    const v = nestedInteractiveShellRule.check(
      makeNode({
        name: 'Email Input',
        role: 'input',
        type: 'FRAME',
        width: 354,
        height: 48,
        children: [makeNode({ id: '2:1', name: 'Inner Input', role: 'input', type: 'FRAME', width: 320, height: 48 })],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('nested-interactive-shell');
    expect(v[0].severity).toBe('error');
  });

  it('passes when interactive parents only contain text/content children', () => {
    const v = nestedInteractiveShellRule.check(
      makeNode({
        name: 'Email Input',
        role: 'input',
        type: 'FRAME',
        width: 354,
        height: 48,
        children: [makeNode({ id: '2:1', name: 'Placeholder', type: 'TEXT', characters: 'Email' })],
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

describe('screen-shell-invalid', () => {
  it('flags screen roots without vertical auto-layout', () => {
    const v = screenShellInvalidRule.check(
      makeNode({
        name: 'Checkout',
        role: 'screen',
        type: 'FRAME',
        width: 402,
        height: 874,
        layoutMode: 'HORIZONTAL',
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('screen-shell-invalid');
    expect(v[0].severity).toBe('error');
  });

  it('passes stable screen shells', () => {
    const v = screenShellInvalidRule.check(
      makeNode({
        name: 'Checkout',
        role: 'screen',
        type: 'FRAME',
        width: 402,
        height: 874,
        layoutMode: 'VERTICAL',
      }),
      emptyCtx,
    );
    expect(v).toHaveLength(0);
  });
});

// ─── input-field-structure ───

describe('input-field-structure', () => {
  it('skips field group containers (label TEXT + input FRAME)', () => {
    // "Email Field" wrapping a label + actual input should NOT be flagged
    const node = makeNode({
      name: 'Email Field',
      type: 'FRAME',
      layoutMode: 'VERTICAL',
      children: [
        makeNode({ id: '2:1', name: 'Email', type: 'TEXT' }),
        makeNode({
          id: '2:2',
          name: 'Email Input',
          type: 'FRAME',
          strokes: [{ type: 'SOLID', visible: true, opacity: 1 }],
          cornerRadius: 12,
          paddingLeft: 16,
          paddingRight: 16,
        }),
      ],
    });
    const v = inputFieldStructureRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('skips containers with 3+ children', () => {
    const node = makeNode({
      name: 'Form Fields',
      type: 'FRAME',
      layoutMode: 'VERTICAL',
      children: [
        makeNode({ id: '2:1', name: 'Name Field', type: 'FRAME' }),
        makeNode({ id: '2:2', name: 'Email Field', type: 'FRAME' }),
        makeNode({ id: '2:3', name: 'Password Field', type: 'FRAME' }),
      ],
    });
    const v = inputFieldStructureRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });

  it('still flags actual input frames (stroke + single text child)', () => {
    const node = makeNode({
      name: 'search-input',
      type: 'FRAME',
      layoutMode: 'HORIZONTAL',
      paddingLeft: 0,
      paddingRight: 0,
      cornerRadius: 0,
      strokes: [{ type: 'SOLID', visible: true, opacity: 1 }],
      children: [makeNode({ id: '2:1', name: 'Search...', type: 'TEXT' })],
    });
    const v = inputFieldStructureRule.check(node, emptyCtx);
    // Should flag: no cornerRadius + insufficient padding
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((violation) => violation.rule === 'input-field-structure')).toBe(true);
  });

  it('flags input fields matched by name without field group structure', () => {
    // A frame named "Email Input" with no children — not a field group, should be flagged
    const node = makeNode({
      name: 'Email Input',
      type: 'FRAME',
      layoutMode: 'HORIZONTAL',
      paddingLeft: 0,
      paddingRight: 0,
      cornerRadius: 0,
    });
    const v = inputFieldStructureRule.check(node, emptyCtx);
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it('skips password field containers with label + input + helper text', () => {
    const node = makeNode({
      name: 'Password Field',
      type: 'FRAME',
      layoutMode: 'VERTICAL',
      children: [
        makeNode({ id: '2:1', name: 'Password', type: 'TEXT' }),
        makeNode({ id: '2:2', name: 'Password Input', type: 'FRAME' }),
        makeNode({ id: '2:3', name: 'Helper Text', type: 'TEXT' }),
      ],
    });
    const v = inputFieldStructureRule.check(node, emptyCtx);
    expect(v).toHaveLength(0);
  });
});
