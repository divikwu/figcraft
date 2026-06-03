/**
 * Contract test: AbstractNode conversion parity.
 *
 * Ensures that `compressedToAbstract` (lint.ts) and `figmaNodeToAbstract`
 * (lint-inline.ts) cover the same set of AbstractNode fields.
 *
 * When a new field is added to AbstractNode, both converters must be updated.
 * This test catches the case where only one of the two is updated.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ── Core AbstractNode fields that BOTH converters must handle ─────────────────
// Excludes propagated-only fields (parentBgColor, parentWidth, parentLayoutMode)
// because those are injected by the lint traversal engine, not by converters.
const REQUIRED_ABSTRACT_NODE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'type',
  'role',
  'fills',
  'strokes',
  'cornerRadius',
  'fontSize',
  'fontName',
  'lineHeight',
  'letterSpacing',
  'opacity',
  'width',
  'height',
  'layoutMode',
  'layoutPositioning',
  'itemSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'clipsContent',
  'strokeWeight',
  'layoutAlign',
  'x',
  'y',
  'characters',
  'textAutoResize',
  'boundVariables',
  'fillStyleId',
  'strokeStyleId',
  'textStyleId',
  'effectStyleId',
  'fillStyleKey',
  'strokeStyleKey',
  'textStyleKey',
  'effectStyleKey',
  'fillStyleRemote',
  'strokeStyleRemote',
  'textStyleRemote',
  'effectStyleRemote',
  'componentPropertyDefinitions',
  'componentPropertyReferences',
  'visible',
  'children',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract AbstractNode field names that are written inside a named function.
 *
 * Strategy: isolate the function body, then match all patterns of the form
 *   result.FIELD = …   (figmaNodeToAbstract — imperative style)
 *   FIELD: …           (compressedToAbstract — object literal style)
 *
 * Only names that appear in REQUIRED_ABSTRACT_NODE_FIELDS are counted to
 * avoid false-positives from helper variable names like `fixType`.
 */
function extractCoveredFields(source: string, funcName: string): Set<string> {
  // Slice out the function body (from function declaration to the matching
  // closing brace).  We look for the first `{` after the function name and
  // then walk the source counting brace depth until we reach depth 0 again.
  const funcStart = source.indexOf(`function ${funcName}`);
  if (funcStart === -1) {
    throw new Error(`Function "${funcName}" not found in source`);
  }

  let braceDepth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;

  for (let i = funcStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      braceDepth++;
      if (bodyStart === -1) bodyStart = i;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && bodyStart !== -1) {
        bodyEnd = i;
        break;
      }
    }
  }

  if (bodyEnd === -1) {
    throw new Error(`Could not isolate body of function "${funcName}"`);
  }

  const body = source.slice(bodyStart, bodyEnd + 1);

  const covered = new Set<string>();

  // Pattern A — object-literal key:  `  fieldName:` (compressedToAbstract)
  const literalKey = /\b(\w+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = literalKey.exec(body)) !== null) {
    const field = m[1];
    if (REQUIRED_ABSTRACT_NODE_FIELDS.has(field)) {
      covered.add(field);
    }
  }

  // Pattern B — property assignment:  `result.fieldName =` (figmaNodeToAbstract)
  const propAssign = /result\.(\w+)\s*=/g;
  while ((m = propAssign.exec(body)) !== null) {
    const field = m[1];
    if (REQUIRED_ABSTRACT_NODE_FIELDS.has(field)) {
      covered.add(field);
    }
  }

  return covered;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AbstractNode conversion parity', () => {
  const lintSource = readFileSync(resolve('packages/adapter-figma/src/handlers/lint.ts'), 'utf-8');
  const inlineSource = readFileSync(resolve('packages/adapter-figma/src/handlers/lint-inline.ts'), 'utf-8');

  const compressedFields = extractCoveredFields(lintSource, 'compressedToAbstract');
  const figmaFields = extractCoveredFields(inlineSource, 'figmaNodeToAbstract');

  it('compressedToAbstract covers all required AbstractNode fields', () => {
    const missing = [...REQUIRED_ABSTRACT_NODE_FIELDS].filter((f) => !compressedFields.has(f));
    expect(missing, `compressedToAbstract is missing fields: ${missing.join(', ')}`).toEqual([]);
  });

  it('figmaNodeToAbstract covers all required AbstractNode fields', () => {
    const missing = [...REQUIRED_ABSTRACT_NODE_FIELDS].filter((f) => !figmaFields.has(f));
    expect(missing, `figmaNodeToAbstract is missing fields: ${missing.join(', ')}`).toEqual([]);
  });

  it('both converters cover the same set of fields (no drift between paths)', () => {
    const onlyInCompressed = [...compressedFields].filter((f) => !figmaFields.has(f));
    const onlyInFigma = [...figmaFields].filter((f) => !compressedFields.has(f));

    expect(
      onlyInCompressed,
      `Fields set by compressedToAbstract but NOT by figmaNodeToAbstract: ${onlyInCompressed.join(', ')}`,
    ).toEqual([]);

    expect(
      onlyInFigma,
      `Fields set by figmaNodeToAbstract but NOT by compressedToAbstract: ${onlyInFigma.join(', ')}`,
    ).toEqual([]);
  });

  it('REQUIRED_ABSTRACT_NODE_FIELDS is a subset of the AbstractNode interface (no phantom fields)', () => {
    // Read the AbstractNode interface source and verify every required field
    // actually appears as a declared member (catches typos in this test).
    const typesSource = readFileSync(resolve('packages/quality-engine/src/types.ts'), 'utf-8');
    const phantom = [...REQUIRED_ABSTRACT_NODE_FIELDS].filter(
      (f) => !typesSource.includes(`${f}?`) && !typesSource.includes(`${f}:`),
    );
    expect(
      phantom,
      `These fields in REQUIRED_ABSTRACT_NODE_FIELDS are not declared in AbstractNode: ${phantom.join(', ')}`,
    ).toEqual([]);
  });
});
