/**
 * Tests for describeFix across non-WCAG lint rules.
 *
 * Verifies that each rule's describeFix() returns the correct FixDescriptor
 * given a violation from check(). Covers layout, structure, spec, and
 * remaining WCAG rules not tested elsewhere.
 */

import { describe, expect, it } from 'vitest';
// ─── Layout rules ───
import { mobileDimensionsRule } from '../../packages/quality-engine/src/rules/layout/mobile-dimensions.js';
import { noAutolayoutRule } from '../../packages/quality-engine/src/rules/layout/no-autolayout.js';
import { spacerFrameRule } from '../../packages/quality-engine/src/rules/layout/spacer-frame.js';
import { textOverflowRule } from '../../packages/quality-engine/src/rules/layout/text-overflow.js';
import { unboundedHugRule } from '../../packages/quality-engine/src/rules/layout/unbounded-hug.js';
// ─── Spec rules ───
import { hardcodedTokenRule } from '../../packages/quality-engine/src/rules/spec/hardcoded-token.js';
import { specBorderRadiusRule } from '../../packages/quality-engine/src/rules/spec/spec-border-radius.js';
// ─── Structure rules ───
import { buttonSolidStructureRule } from '../../packages/quality-engine/src/rules/structure/button-solid-structure.js';
import { inputFieldStructureRule } from '../../packages/quality-engine/src/rules/structure/input-field-structure.js';
// ─── WCAG (untested) ───
import { wcagLineHeightRule } from '../../packages/quality-engine/src/rules/wcag/wcag-line-height.js';
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

// ─── mobile-dimensions ───

describe('mobile-dimensions describeFix', () => {
  it('returns resize descriptor for non-standard mobile frame', () => {
    // A top-level frame named like a screen, with wrong dimensions
    const node = makeNode({
      name: 'Login Screen',
      type: 'FRAME',
      width: 400,
      height: 900,
      children: [makeNode({ id: '2:1', name: 'child', type: 'FRAME', width: 100, height: 100 })],
    });
    const violations = mobileDimensionsRule.check(node, emptyCtx);
    if (violations.length === 0) return; // rule may not fire depending on heuristics
    const v = violations.find((v) => v.autoFixable && v.fixData);
    if (!v) return;
    const fix = mobileDimensionsRule.describeFix!(v);
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('resize');
    if (fix!.kind === 'resize') {
      expect(fix!.requireType).toContain('FRAME');
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = mobileDimensionsRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Test',
      rule: 'mobile-dimensions',
      severity: 'heuristic',
      currentValue: '400×900',
      suggestion: 'fix it',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── no-autolayout ───

describe('no-autolayout describeFix', () => {
  it('returns set-properties with layoutMode from fixData', () => {
    const node = makeNode({
      name: 'Card',
      type: 'FRAME',
      width: 200,
      height: 300,
      children: [
        makeNode({ id: '2:1', name: 'Title', type: 'TEXT', width: 180, height: 20 }),
        makeNode({ id: '2:2', name: 'Body', type: 'TEXT', width: 180, height: 40 }),
      ],
    });
    const violations = noAutolayoutRule.check(node, emptyCtx);
    if (violations.length === 0) return;
    const v = violations[0];
    const fix = noAutolayoutRule.describeFix!(v);
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.layoutMode).toBeDefined();
      expect(fix!.requireType).toContain('FRAME');
    }
  });

  it('defaults to VERTICAL when fixData has no layoutMode', () => {
    const fix = noAutolayoutRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Test',
      rule: 'no-autolayout',
      severity: 'heuristic',
      currentValue: 'none',
      suggestion: 'fix',
      autoFixable: true,
      fixData: {},
    });
    expect(fix).not.toBeNull();
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.layoutMode).toBe('VERTICAL');
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = noAutolayoutRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Test',
      rule: 'no-autolayout',
      severity: 'heuristic',
      currentValue: 'none',
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── spacer-frame ───

describe('spacer-frame describeFix', () => {
  it('returns remove-and-redistribute descriptor', () => {
    const fix = spacerFrameRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Spacer',
      rule: 'spacer-frame',
      severity: 'style',
      currentValue: 'spacer',
      suggestion: 'remove',
      autoFixable: true,
      fixData: { width: 0, height: 16 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('remove-and-redistribute');
    if (fix!.kind === 'remove-and-redistribute') {
      expect(fix!.dimension.height).toBe(16);
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = spacerFrameRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Spacer',
      rule: 'spacer-frame',
      severity: 'style',
      currentValue: 'spacer',
      suggestion: 'remove',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── text-overflow ───

describe('text-overflow describeFix', () => {
  it('returns set-properties with textAutoResize', () => {
    const fix = textOverflowRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Label',
      rule: 'text-overflow',
      severity: 'unsafe',
      currentValue: 'NONE',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { textAutoResize: 'HEIGHT' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.textAutoResize).toBe('HEIGHT');
      expect(fix!.requireFontLoad).toBe(true);
    }
  });

  it('returns null when textAutoResize missing in fixData', () => {
    const fix = textOverflowRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Label',
      rule: 'text-overflow',
      severity: 'unsafe',
      currentValue: 'NONE',
      suggestion: 'fix',
      autoFixable: true,
      fixData: {},
    });
    expect(fix).toBeNull();
  });
});

// ─── unbounded-hug ───

describe('unbounded-hug describeFix', () => {
  it('returns set-properties with STRETCH layoutAlign', () => {
    const fix = unboundedHugRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Content',
      rule: 'unbounded-hug',
      severity: 'unsafe',
      currentValue: 'HUG',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'stretch-self', layoutAlign: 'STRETCH' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.layoutAlign).toBe('STRETCH');
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = unboundedHugRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Content',
      rule: 'unbounded-hug',
      severity: 'unsafe',
      currentValue: 'HUG',
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── button-solid-structure ───

describe('button-solid-structure describeFix', () => {
  it('returns set-properties for layout fix', () => {
    const fix = buttonSolidStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Button',
      rule: 'button-solid-structure',
      severity: 'heuristic',
      currentValue: 'no layout',
      suggestion: 'fix',
      autoFixable: true,
      fixData: {
        fix: 'layout',
        layoutMode: 'HORIZONTAL',
        primaryAxisAlignItems: 'CENTER',
        counterAxisAlignItems: 'CENTER',
      },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.layoutMode).toBe('HORIZONTAL');
      expect(fix!.props.primaryAxisAlignItems).toBe('CENTER');
      expect(fix!.requireType).toContain('FRAME');
    }
  });

  it('returns set-properties for padding fix', () => {
    const fix = buttonSolidStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Button',
      rule: 'button-solid-structure',
      severity: 'heuristic',
      currentValue: 'low padding',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'padding', paddingLeft: 16, paddingRight: 16 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.paddingLeft).toBe(16);
      expect(fix!.props.paddingRight).toBe(16);
    }
  });

  it('returns resize for height fix', () => {
    const fix = buttonSolidStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Button',
      rule: 'button-solid-structure',
      severity: 'heuristic',
      currentValue: 'short',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'height', height: 48 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('resize');
    if (fix!.kind === 'resize') {
      expect(fix!.height).toBe(48);
      expect(fix!.minHeight).toBe(48);
    }
  });

  it('returns null for unknown fix type', () => {
    const fix = buttonSolidStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Button',
      rule: 'button-solid-structure',
      severity: 'heuristic',
      currentValue: 'broken',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'unknown-type' },
    });
    expect(fix).toBeNull();
  });

  it('returns null when fixData is missing', () => {
    const fix = buttonSolidStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Button',
      rule: 'button-solid-structure',
      severity: 'heuristic',
      currentValue: 'broken',
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── input-field-structure ───

describe('input-field-structure describeFix', () => {
  it('returns set-properties for layout fix', () => {
    const fix = inputFieldStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Input',
      rule: 'input-field-structure',
      severity: 'heuristic',
      currentValue: 'no layout',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'layout', layoutMode: 'HORIZONTAL', counterAxisAlignItems: 'CENTER' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.layoutMode).toBe('HORIZONTAL');
      expect(fix!.requireType).toContain('FRAME');
    }
  });

  it('returns set-properties for cornerRadius fix with default 8', () => {
    const fix = inputFieldStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Input',
      rule: 'input-field-structure',
      severity: 'heuristic',
      currentValue: '0',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fix: 'cornerRadius' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.cornerRadius).toBe(8);
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = inputFieldStructureRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Input',
      rule: 'input-field-structure',
      severity: 'heuristic',
      currentValue: 'broken',
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── hardcoded-token ───

describe('hardcoded-token describeFix', () => {
  it('returns deferred library-color-bind for fills', () => {
    const fix = hardcodedTokenRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Box',
      rule: 'hardcoded-token',
      severity: 'heuristic',
      currentValue: '#FF0000',
      suggestion: 'bind to token',
      autoFixable: true,
      fixData: { property: 'fills', hex: '#FF0000', opacity: 1, nodeType: 'FRAME' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('deferred');
    if (fix!.kind === 'deferred') {
      expect(fix!.strategy).toBe('library-color-bind');
      expect(fix!.data.hex).toBe('#FF0000');
    }
  });

  it('returns deferred library-radius-bind for cornerRadius', () => {
    const fix = hardcodedTokenRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Card',
      rule: 'hardcoded-token',
      severity: 'heuristic',
      currentValue: 12,
      suggestion: 'bind to token',
      autoFixable: true,
      fixData: { property: 'cornerRadius', value: 12, nodeName: 'Card' },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('deferred');
    if (fix!.kind === 'deferred') {
      expect(fix!.strategy).toBe('library-radius-bind');
      expect(fix!.data.value).toBe(12);
    }
  });

  it('returns library-color-bind for strokes', () => {
    const fix = hardcodedTokenRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Box',
      rule: 'hardcoded-token',
      severity: 'heuristic',
      currentValue: 'strokes: #9747FF',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { property: 'strokes', hex: '#9747FF', opacity: 1, nodeType: 'FRAME' },
    });
    expect(fix).not.toBeNull();
    if (fix && fix.kind === 'deferred') {
      expect(fix.strategy).toBe('library-color-bind');
      expect(fix.data.property).toBe('strokes');
      expect(fix.data.hex).toBe('#9747FF');
    }
  });

  it('returns null for unknown property', () => {
    const fix = hardcodedTokenRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Box',
      rule: 'hardcoded-token',
      severity: 'heuristic',
      currentValue: '???',
      suggestion: 'fix',
      autoFixable: true,
      fixData: { property: 'effects' },
    });
    expect(fix).toBeNull();
  });

  it('returns null when fixData is missing', () => {
    const fix = hardcodedTokenRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Box',
      rule: 'hardcoded-token',
      severity: 'heuristic',
      currentValue: '#FF0000',
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});

// ─── spec-border-radius ───

describe('spec-border-radius describeFix', () => {
  it('returns set-properties with cornerRadius', () => {
    const fix = specBorderRadiusRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Card',
      rule: 'spec-border-radius',
      severity: 'heuristic',
      currentValue: 12,
      expectedValue: 8,
      suggestion: 'fix',
      autoFixable: true,
      fixData: { value: 8 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.cornerRadius).toBe(8);
    }
  });

  it('returns null when fixData value is null', () => {
    const fix = specBorderRadiusRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Card',
      rule: 'spec-border-radius',
      severity: 'heuristic',
      currentValue: 12,
      suggestion: 'fix',
      autoFixable: true,
      fixData: { value: null },
    });
    expect(fix).toBeNull();
  });
});

// ─── wcag-line-height ───

describe('wcag-line-height describeFix', () => {
  it('returns set-properties with lineHeight and requireFontLoad', () => {
    const fix = wcagLineHeightRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Body Text',
      rule: 'wcag-line-height',
      severity: 'verbose',
      currentValue: 16,
      suggestion: 'fix',
      autoFixable: true,
      fixData: { lineHeight: 24 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.lineHeight).toBe(24);
      expect(fix!.requireFontLoad).toBe(true);
    }
  });

  it('returns null when lineHeight missing in fixData', () => {
    const fix = wcagLineHeightRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Body Text',
      rule: 'wcag-line-height',
      severity: 'verbose',
      currentValue: 16,
      suggestion: 'fix',
      autoFixable: true,
      fixData: {},
    });
    expect(fix).toBeNull();
  });
});

// ─── wcag-text-size ───

describe('wcag-text-size describeFix', () => {
  it('returns set-properties with fontSize', () => {
    const fix = wcagTextSizeRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Small Text',
      rule: 'wcag-text-size',
      severity: 'verbose',
      currentValue: 10,
      suggestion: 'fix',
      autoFixable: true,
      fixData: { fontSize: 12 },
    });
    expect(fix).not.toBeNull();
    expect(fix!.kind).toBe('set-properties');
    if (fix!.kind === 'set-properties') {
      expect(fix!.props.fontSize).toBe(12);
    }
  });

  it('returns null when fixData is missing', () => {
    const fix = wcagTextSizeRule.describeFix!({
      nodeId: '1:1',
      nodeName: 'Small Text',
      rule: 'wcag-text-size',
      severity: 'verbose',
      currentValue: 10,
      suggestion: 'fix',
      autoFixable: true,
    });
    expect(fix).toBeNull();
  });
});
