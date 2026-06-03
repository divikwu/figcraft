/**
 * WCAG 2.5.8 Spacing exception — unit tests for the shared helper + integration
 * with `link-standalone-structure` and `button-text-structure`.
 *
 * Locks in the regression from the user's login-screen screenshot:
 *   `Forgot Link` FRAME (354×20, VERTICAL parent, itemSpacing 8) should pass.
 */
import { describe, expect, it } from 'vitest';
import { buttonIconStructureRule } from '../../packages/quality-engine/src/rules/structure/button-icon-structure.js';
import { buttonTextStructureRule } from '../../packages/quality-engine/src/rules/structure/button-text-structure.js';
import { linkStandaloneStructureRule } from '../../packages/quality-engine/src/rules/structure/link-standalone-structure.js';
import { wcagTargetSizeRule } from '../../packages/quality-engine/src/rules/wcag/wcag-target-size.js';
import type { AbstractNode, LintContext } from '../../packages/quality-engine/src/types.js';
import { satisfiesSpacingException } from '../../packages/quality-engine/src/utils/wcag-spacing.js';

const emptyCtx: LintContext = {
  colorTokens: new Map(),
  spacingTokens: new Map(),
  radiusTokens: new Map(),
  typographyTokens: new Map(),
  variableIds: new Map(),
  lang: 'en',
};

function makeNode(overrides: Partial<AbstractNode>): AbstractNode {
  return { id: '1:1', name: 'Test', type: 'FRAME', visible: true, ...overrides };
}

describe('satisfiesSpacingException — geometry', () => {
  it('20h target in VERTICAL layout passes when itemSpacing ≥ 2', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 20, width: 354, parentLayoutMode: 'VERTICAL', parentItemSpacing: 8 }),
    );
    expect(r.exempt).toBe(true);
    expect(r.requiredGap).toBe(2);
    expect(r.actualGap).toBe(8);
  });

  it('20h target in VERTICAL layout fails when itemSpacing is 0', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 20, width: 354, parentLayoutMode: 'VERTICAL', parentItemSpacing: 0 }),
    );
    expect(r.exempt).toBe(false);
    expect(r.requiredGap).toBe(2);
  });

  it('12h target in VERTICAL needs ≥ 6 gap (passes at exactly 6)', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 12, width: 354, parentLayoutMode: 'VERTICAL', parentItemSpacing: 6 }),
    );
    expect(r.exempt).toBe(true);
    expect(r.requiredGap).toBe(6);
  });

  it('18w icon in HORIZONTAL needs ≥ 3 gap (passes at 4)', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 40, width: 18, parentLayoutMode: 'HORIZONTAL', parentItemSpacing: 4 }),
    );
    expect(r.exempt).toBe(true);
    expect(r.requiredGap).toBe(3);
  });

  it('28h target (already ≥ 24) is exempt regardless of gap', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 28, width: 354, parentLayoutMode: 'VERTICAL', parentItemSpacing: 0 }),
    );
    expect(r.exempt).toBe(true);
  });

  it('no parent auto-layout (undefined) never exempts', () => {
    const r = satisfiesSpacingException(makeNode({ height: 20, width: 354 }));
    expect(r.exempt).toBe(false);
    expect(r.axis).toBeNull();
  });

  it('absolute/NONE layout never exempts (requires full sibling geometry)', () => {
    const r = satisfiesSpacingException(
      makeNode({ height: 20, width: 354, parentLayoutMode: 'NONE', parentItemSpacing: 100 }),
    );
    expect(r.exempt).toBe(false);
  });
});

describe('wcag-target-size — skips classifier-owned kinds (E: dedup)', () => {
  it('link-standalone node is NOT double-flagged by wcag-target-size', () => {
    const node = makeNode({
      name: 'Forgot Link',
      type: 'FRAME',
      width: 354,
      height: 20,
      interactive: { kind: 'link-standalone', confidence: 1, declared: true },
    });
    expect(wcagTargetSizeRule.check(node, emptyCtx)).toHaveLength(0);
  });

  it('button-text node is NOT double-flagged by wcag-target-size', () => {
    const node = makeNode({
      name: 'Cancel',
      type: 'TEXT',
      characters: 'Cancel',
      width: 48,
      height: 20,
      interactive: { kind: 'button-text', confidence: 1, declared: true },
    });
    expect(wcagTargetSizeRule.check(node, emptyCtx)).toHaveLength(0);
  });

  it('button-solid undersized is NOT double-flagged by wcag-target-size', () => {
    const node = makeNode({
      name: 'Mini CTA',
      type: 'FRAME',
      width: 40,
      height: 20,
      interactive: { kind: 'button-solid', confidence: 1, declared: true },
    });
    expect(wcagTargetSizeRule.check(node, emptyCtx)).toHaveLength(0);
  });

  it('unclassified interactive-looking node still uses the WCAG 24 fallback', () => {
    // No classifier commitment → falls back to name regex
    const node = makeNode({
      name: 'Some Toggle Thing',
      type: 'FRAME',
      width: 20,
      height: 20,
    });
    const v = wcagTargetSizeRule.check(node, emptyCtx);
    expect(v).toHaveLength(1);
    expect(String(v[0].currentValue)).toMatch(/20×20/);
  });
});

describe('link-standalone-structure — integrates spacing exception (regression)', () => {
  it('regression: "Forgot Link" FRAME (354×20) in VERTICAL layout + itemSpacing 8 passes', () => {
    const node = makeNode({
      id: '1:2',
      name: 'Forgot Link',
      type: 'FRAME',
      width: 354,
      height: 20,
      platform: 'mobile',
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 8,
      interactive: { kind: 'link-standalone', confidence: 1, declared: true },
    });
    expect(linkStandaloneStructureRule.check(node, emptyCtx)).toHaveLength(0);
  });

  it("link with itemSpacing 0 still fires (exception doesn't apply)", () => {
    const node = makeNode({
      name: 'Forgot Link',
      type: 'FRAME',
      width: 354,
      height: 20,
      platform: 'mobile',
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 0,
      interactive: { kind: 'link-standalone', confidence: 1, declared: true },
    });
    const v = linkStandaloneStructureRule.check(node, emptyCtx);
    expect(v.length).toBeGreaterThanOrEqual(1);
    // Message should mention the itemSpacing path
    expect(v.some((vi) => /itemSpacing|spacing/i.test(vi.suggestion))).toBe(true);
  });

  it('desktop link (non-mobile) is not affected by mobile line-height check', () => {
    const node = makeNode({
      name: 'Learn More Link',
      type: 'FRAME',
      width: 100,
      height: 20,
      platform: 'desktop',
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 0,
      interactive: { kind: 'link-standalone', confidence: 1, declared: true },
    });
    const v = linkStandaloneStructureRule.check(node, emptyCtx);
    // No mobile height violation; color binding is no longer this rule's concern.
    expect(v).toHaveLength(0);
  });

  it('FRAME shell with no fills does NOT emit a color-binding violation (single-responsibility)', () => {
    // This is the screenshot regression: the FRAME has no fills at all — its
    // color lives on the TEXT child. link-standalone-structure must not flag
    // the frame for unbound color; hardcoded-token handles TEXT color concerns.
    const node = makeNode({
      name: 'Sign Up Link',
      type: 'FRAME',
      width: 354,
      height: 28, // above the 24 line-height threshold
      platform: 'mobile',
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 16,
      interactive: { kind: 'link-standalone', confidence: 1, declared: true },
      // explicitly no fills, no fillStyleId, no boundVariables — legacy rule would have fired
    });
    expect(linkStandaloneStructureRule.check(node, emptyCtx)).toHaveLength(0);
  });
});

describe('button-text-structure — integrates spacing exception', () => {
  it('TEXT button (line-height 20) in VERTICAL layout with itemSpacing 6 passes', () => {
    const node = makeNode({
      name: 'Cancel',
      type: 'TEXT',
      characters: 'Cancel',
      height: 20,
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 6,
      interactive: { kind: 'button-text', confidence: 1, declared: true },
    });
    expect(buttonTextStructureRule.check(node, emptyCtx)).toHaveLength(0);
  });

  it('TEXT button (line-height 18) in VERTICAL with itemSpacing 2 fails (needs ≥ 3)', () => {
    const node = makeNode({
      name: 'Skip',
      type: 'TEXT',
      characters: 'Skip',
      height: 18,
      parentLayoutMode: 'VERTICAL',
      parentItemSpacing: 2,
      interactive: { kind: 'button-text', confidence: 1, declared: true },
    });
    const v = buttonTextStructureRule.check(node, emptyCtx);
    expect(v.length).toBeGreaterThan(0);
  });
});

describe('button-icon-structure — WCAG 2.5.8 AA + Spacing exception (regression)', () => {
  it('regression: 48×32 search button inside a search bar passes (≥ 24 both dims)', () => {
    const node = makeNode({
      name: 'Search',
      type: 'FRAME',
      width: 48,
      height: 32,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'Search icon', type: 'VECTOR' }],
    });
    // Dimension check passes (both ≥ 24); only name-descriptive check may apply.
    const v = buttonIconStructureRule.check(node, emptyCtx);
    // No size-related violations
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(false);
  });

  it('regression: 32×32 next arrow inside a section header passes (≥ 24 both dims)', () => {
    const node = makeNode({
      name: 'Next chevron',
      type: 'FRAME',
      width: 32,
      height: 32,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'Chevron', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(false);
  });

  it('24×24 at the floor passes (no violation)', () => {
    const node = makeNode({
      name: 'Menu toggle',
      type: 'FRAME',
      width: 24,
      height: 24,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'Menu', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(false);
  });

  it('20×20 icon with HORIZONTAL parent itemSpacing 4 passes via spacing exception', () => {
    const node = makeNode({
      name: 'Close',
      type: 'FRAME',
      width: 20,
      height: 20,
      parentLayoutMode: 'HORIZONTAL',
      parentItemSpacing: 4,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'X', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(false);
  });

  it('20×20 icon without parent spacing fails (no exception)', () => {
    const node = makeNode({
      name: 'Close',
      type: 'FRAME',
      width: 20,
      height: 20,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'X', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(true);
  });

  it('12×12 icon + itemSpacing 4 still fails (needs ≥ 6)', () => {
    const node = makeNode({
      name: 'Tiny',
      type: 'FRAME',
      width: 12,
      height: 12,
      parentLayoutMode: 'HORIZONTAL',
      parentItemSpacing: 4,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'X', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(true);
  });

  it('44×44 standard icon button still passes', () => {
    const node = makeNode({
      name: 'Favorite',
      type: 'FRAME',
      width: 44,
      height: 44,
      interactive: { kind: 'button-icon', confidence: 1, declared: true },
      children: [{ id: '2:1', name: 'Heart', type: 'VECTOR' }],
    });
    const v = buttonIconStructureRule.check(node, emptyCtx);
    expect(v.some((vi) => /低于|below/.test(vi.suggestion))).toBe(false);
  });
});
