/**
 * overComplexBg propagation + contrast-rule skip.
 *
 * Locks in the "Olivia Rhye" regression from the video-gallery screenshot:
 * white text floating over a photo-backed card was reported as 1.00:1 against
 * a walk-up-to-solid ancestor (page white), which is a meaningless number.
 * The fix: when a node's effective rendered backdrop is a non-SOLID fill
 * (IMAGE / VIDEO / GRADIENT), mark the subtree as overComplexBg and skip
 * wcag-contrast / wcag-non-text-contrast on those nodes.
 */
import { describe, expect, it } from 'vitest';
import { runLint } from '../../packages/quality-engine/src/engine.js';
import type { AbstractNode, LintContext } from '../../packages/quality-engine/src/types.js';

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

describe('overComplexBg propagation — engine walk', () => {
  it('regression: "Olivia Rhye" white text over a photo-card sibling is NOT flagged by wcag-contrast', () => {
    // Mirrors the screenshot:
    // video card
    //   content
    //     Rectangle 1 (IMAGE fill covers card) ← earlier sibling
    //     user
    //       Avatar label group
    //         Text and supporting text
    //           Text "Olivia Rhye" (white text)
    // Under a white page, the walk-up would find ancestor SOLID white and
    // report 1.00:1. With overComplexBg propagation, the text skips the check.
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
      children: [
        makeNode({
          id: 'card',
          name: 'video card - mobile',
          type: 'FRAME',
          children: [
            makeNode({
              id: 'content',
              name: 'content',
              type: 'FRAME',
              children: [
                makeNode({
                  id: 'rect-image',
                  name: 'Rectangle 1',
                  type: 'RECTANGLE',
                  fills: [
                    { type: 'IMAGE', visible: true } as unknown as AbstractNode['fills'] extends (infer T)[] | undefined
                      ? T
                      : never,
                  ],
                  width: 320,
                  height: 400,
                }),
                makeNode({
                  id: 'user',
                  name: 'user',
                  type: 'FRAME',
                  children: [
                    makeNode({
                      id: 'text',
                      name: 'Text',
                      type: 'TEXT',
                      characters: 'Olivia Rhye',
                      fontSize: 14,
                      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const contrastViolations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'text') ?? [];
    expect(contrastViolations).toHaveLength(0);
  });

  it('text inside a FRAME whose TOPMOST fill is IMAGE → overComplexBg', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      children: [
        makeNode({
          id: 'hero',
          name: 'Hero',
          type: 'FRAME',
          fills: [{ type: 'IMAGE', visible: true } as unknown as any],
          children: [
            makeNode({
              id: 'title',
              name: 'Title',
              type: 'TEXT',
              characters: 'Welcome',
              fontSize: 32,
              fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'title') ?? [];
    expect(violations).toHaveLength(0);
  });

  it('text over GRADIENT fill is also skipped (complex bg)', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      children: [
        makeNode({
          id: 'hero',
          type: 'FRAME',
          fills: [{ type: 'GRADIENT_LINEAR', visible: true } as unknown as any],
          children: [
            makeNode({
              id: 'title',
              type: 'TEXT',
              characters: 'Welcome',
              fontSize: 16,
              fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'title') ?? [];
    expect(violations).toHaveLength(0);
  });

  it('text over VIDEO fill is also skipped', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      children: [
        makeNode({
          id: 'card',
          type: 'FRAME',
          fills: [{ type: 'VIDEO', visible: true } as unknown as any],
          children: [
            makeNode({
              id: 'label',
              type: 'TEXT',
              characters: 'Live',
              fontSize: 12,
              fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'label') ?? [];
    expect(violations).toHaveLength(0);
  });

  it('fills stack [IMAGE_bottom, SOLID_top] — topmost is SOLID → contrast IS still checked', () => {
    // Designer stacks a solid overlay on top of the image to regain a known
    // backdrop. Topmost fill is what renders; we must NOT skip here.
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      children: [
        makeNode({
          id: 'card',
          type: 'FRAME',
          fills: [
            { type: 'IMAGE', visible: true } as unknown as any,
            { type: 'SOLID', color: '#ffffff', visible: true },
          ],
          children: [
            makeNode({
              id: 'title',
              type: 'TEXT',
              characters: 'Readable on white',
              fontSize: 14,
              fills: [{ type: 'SOLID', color: '#eeeeee', visible: true }], // low contrast on white
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    // Low-contrast light-gray text on the white overlay SHOULD still fire.
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'title') ?? [];
    expect(violations.length).toBeGreaterThan(0);
  });

  it('hidden complex fill is ignored — visible SOLID on top still drives the check', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      children: [
        makeNode({
          id: 'card',
          type: 'FRAME',
          fills: [
            { type: 'SOLID', color: '#000000', visible: true },
            { type: 'IMAGE', visible: false } as unknown as any,
          ],
          children: [
            makeNode({
              id: 'label',
              type: 'TEXT',
              characters: 'On black',
              fontSize: 14,
              fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    // White text on black = 21:1, high contrast — no violation.
    const violations =
      report.categories.find((c) => c.rule === 'wcag-contrast')?.nodes.filter((v) => v.nodeId === 'label') ?? [];
    expect(violations).toHaveLength(0);
    // And it reaches the rule (not skipped as overComplex) because the top
    // visible fill is SOLID.
  });

  it('wcag-non-text-contrast also skips button-solid over a photo hero', () => {
    const page = makeNode({
      id: 'page',
      role: 'page',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
      children: [
        makeNode({
          id: 'hero',
          type: 'FRAME',
          fills: [{ type: 'IMAGE', visible: true } as unknown as any],
          children: [
            makeNode({
              id: 'cta',
              type: 'FRAME',
              fills: [{ type: 'SOLID', color: '#ffffff', visible: true }],
              children: [{ id: 'cta:text', name: 'Shop', type: 'TEXT' }],
              interactive: { kind: 'button-solid', confidence: 1, declared: true },
            }),
          ],
        }),
      ],
    });

    const report = runLint([page], emptyCtx);
    const violations =
      report.categories.find((c) => c.rule === 'wcag-non-text-contrast')?.nodes.filter((v) => v.nodeId === 'cta') ?? [];
    // White button over image — backdrop is complex, rule should skip.
    expect(violations).toHaveLength(0);
  });
});
