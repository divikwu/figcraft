/**
 * Node creation handlers — create_frame, create_text, and supporting logic.
 *
 * Extracted from write-nodes.ts for maintainability.
 */

import { simplifyNode } from '../adapters/node-simplifier.js';
import { PAGE_GAP, PLUGIN_DATA_KEYS, SECTION_GAP, SECTION_PADDING } from '../constants.js';
import { registerHandler } from '../registry.js';
import { hexToFigmaRgb, hexToFigmaRgba } from '../utils/color.js';
import { autoBindTypography } from '../utils/design-context.js';
import {
  applySizingOverrides,
  getLayoutSizing,
  importAndResolveComponent,
  setBlendMode,
  setEffectStyleIdAsync,
  setFillStyleIdAsync,
  setLayoutGrow,
  setLayoutPositioning,
  setLayoutSizing,
  setLayoutWrap,
  setStrokeProps,
  setTextStyleIdAsync,
} from '../utils/figma-compat.js';
import { assertHandler } from '../utils/handler-error.js';
import type { Hint, StructuredHint } from '../utils/hint-aggregator.js';
import { aggregateHints, structuredHintsToTyped } from '../utils/hint-aggregator.js';
import { type ImageScaleMode, imagePaintFromBase64 } from '../utils/image-paint.js';
import {
  applyCornerRadius,
  applyFill,
  applyStroke,
  applyTokenFields,
  setComponentProperties,
} from '../utils/node-helpers.js';
import { assertOnCurrentPage, findNodeByIdAsync } from '../utils/node-lookup.js';
import {
  ensureLoaded,
  getAvailableEffectStyleNames,
  getAvailableTextStyleNames,
  getEffectStyleByName,
  getTextStyleByName,
  getTextStyleId,
} from '../utils/style-registry.js';
import { applyIconColor } from './icon-svg.js';
import type { Inference } from './inline-tree.js';
import {
  buildCorrectedPayload,
  formatDiff,
  inferDirection,
  structuredHintsToInferences,
  validateParams,
} from './inline-tree.js';
import { PRE_RULE_TO_LINT_RULE, quickLintSummary } from './lint-inline.js';
import { getCachedModeLibrary, resolveFontAsync } from './write-nodes.js';

// ─── Platform detection & font resolution ───

type Platform = 'ios' | 'android' | 'web' | 'unknown';

/** CJK Unicode range detection. */
const CJK_RE =
  /[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{30000}-\u{3134F}\u3000-\u303F\uFF00-\uFFEF]/u;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/;
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;

/** Detect platform from screen dimensions. */
function detectPlatformFromDimensions(width: number, height: number): Platform {
  // iOS: iPhone SE (375×667) → iPhone 16 Pro Max (440×956)
  if (width >= 375 && width <= 440 && height >= 667 && height <= 960) return 'ios';
  // iOS: iPad range
  if (width >= 768 && width <= 1024 && height >= 1024 && height <= 1366) return 'ios';
  // Android: common widths 360–412, heights 640–915
  if (width >= 340 && width < 375 && height >= 640 && height <= 920) return 'android';
  if (width >= 412 && width <= 414 && height >= 869 && height <= 920) return 'android';
  // Web: wider than mobile
  if (width >= 1024) return 'web';
  return 'unknown';
}

/** Walk up the node tree to find the nearest screen ancestor and detect platform. */
function detectPlatformFromAncestors(node: BaseNode): Platform {
  let current: BaseNode | null = node;
  while (current) {
    if ('width' in current && 'height' in current) {
      const w = Math.round((current as any).width);
      const h = Math.round((current as any).height);
      const role = 'getPluginData' in current ? (current as SceneNode).getPluginData(PLUGIN_DATA_KEYS.ROLE) : '';
      if (role === 'screen') {
        return detectPlatformFromDimensions(w, h);
      }
    }
    current = current.parent;
  }
  return 'unknown';
}

const PLATFORM_FONTS: Record<
  Platform,
  {
    latin: string;
    cjkSC: string;
    cjkTC: string;
    cjkJP: string;
    cjkKR: string;
  }
> = {
  ios: {
    latin: 'SF Pro Text',
    cjkSC: 'PingFang SC',
    cjkTC: 'PingFang TC',
    cjkJP: 'Hiragino Sans',
    cjkKR: 'Apple SD Gothic Neo',
  },
  android: {
    latin: 'Roboto',
    cjkSC: 'Noto Sans SC',
    cjkTC: 'Noto Sans TC',
    cjkJP: 'Noto Sans JP',
    cjkKR: 'Noto Sans KR',
  },
  web: {
    latin: 'Inter',
    cjkSC: 'Noto Sans SC',
    cjkTC: 'Noto Sans TC',
    cjkJP: 'Noto Sans JP',
    cjkKR: 'Noto Sans KR',
  },
  unknown: {
    latin: 'Inter',
    cjkSC: 'Inter',
    cjkTC: 'Inter',
    cjkJP: 'Inter',
    cjkKR: 'Inter',
  },
};

/** Detect the dominant script in text content and return the appropriate font family. */
function platformDefaultFont(platform: Platform, content: string): string {
  const fonts = PLATFORM_FONTS[platform];
  if (!content) return fonts.latin;

  // Check for CJK scripts — prioritize by specificity
  if (HANGUL_RE.test(content)) return fonts.cjkKR;
  if (KANA_RE.test(content)) return fonts.cjkJP;
  // Distinguish SC vs TC: use SC as default for CJK (most common in mainland China)
  if (CJK_RE.test(content)) return fonts.cjkSC;

  return fonts.latin;
}

// ─── Shared context for library-aware creation ───
interface TokenBindingFailure {
  requested: string;
  type: 'variable' | 'style';
  action: 'skipped' | 'used_fallback' | 'scope-mismatch' | 'ambiguous';
}

interface CreateContext {
  useLib: boolean;
  library: string | undefined;
  libraryBindings: string[];
  hints: StructuredHint[];
  warnings: string[];
  /** Structured token binding failures for agent parsing. */
  tokenBindingFailures: TokenBindingFailure[];
  /** Typed hints emitted directly (bypassing StructuredHint conversion). */
  typedHints: Hint[];
  /** Dedupe tracker for teachIdForNextTime — keyed by `${field}|${variableId}`. */
  idHintsSeen: Set<string>;
  /** Detected target platform for font resolution. */
  platform: Platform;
  /** Hash of the image fill created from local bytes, when present. */
  imageHash?: string;
}

async function initCreateContext(): Promise<CreateContext> {
  const [mode, library] = await getCachedModeLibrary();
  const useLib = mode === 'library' && !!library;
  if (useLib) await ensureLoaded(library!);
  return {
    useLib,
    library,
    libraryBindings: [],
    hints: [],
    warnings: [],
    tokenBindingFailures: [],
    typedHints: [],
    idHintsSeen: new Set(),
    platform: 'unknown',
  };
}

/**
 * When a binding was resolved via NAME (autoBoundId set), emit a dedup'd
 * typed hint teaching the agent to pass the variable ID next time. No-op
 * when autoBoundId is undefined (ID path / style / failure).
 */
function teachIdForNextTime(
  ctx: CreateContext,
  result: { autoBound: string | null; autoBoundId?: string },
  field: 'fillVariableId' | 'strokeVariableId' | 'fontColorVariableId',
): void {
  if (!result.autoBound || !result.autoBoundId) return;
  const dedupKey = `${field}|${result.autoBoundId}`;
  if (ctx.idHintsSeen.has(dedupKey)) return;
  ctx.idHintsSeen.add(dedupKey);
  const name = result.autoBound.replace(/^var:/, '');
  ctx.typedHints.push({
    type: 'suggest',
    message: `Resolved '${name}' → ${result.autoBoundId}. Next time pass ${field}: '${result.autoBoundId}' to skip name resolution.`,
  });
}

// ─── Alias normalization: fillVariableName/fillStyleName → fill ───

/**
 * Reject common mis-shapes of fill / strokeColor.
 *
 * `fill` is a string parameter (hex color or variable/style name). Users frequently
 * try to pass objects like `{ variableId: "..." }` or `{ variableName: "..." }`,
 * which currently fall through all type guards in applyFill() and return `null`
 * silently — causing the agent to lose feedback and enter 8-12 step retry loops.
 *
 * This guard runs BEFORE normalization and throws a self-correcting error that
 * names the correct parameter directly, so the agent can fix in one round-trip.
 * Internal shapes (`_variable`, `_variableId`, `_style`) set by normalization
 * itself are allowed — only USER-facing mis-shapes are rejected.
 */
function rejectBadFillShape(
  p: Record<string, unknown>,
  key: 'fill' | 'strokeColor',
  aliasKey: 'fillVariable' | 'strokeVariable',
): void {
  const v = p[key];
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return;
  const obj = v as Record<string, unknown>;

  // Allow already-normalized internal shapes (set by this function itself on a
  // previous call, or by inline children that came pre-normalized).
  if ('_variable' in obj || '_variableId' in obj || '_style' in obj) return;

  // Allow raw Paint[] arrays — already filtered above by Array.isArray, but be defensive.
  if ('type' in obj && typeof obj.type === 'string') return;

  // Detect known wrong shapes and map to correct param names.
  const mapping: Record<string, string> = {
    variableId: `${aliasKey}Id`,
    variableName: `${aliasKey}Name`,
    variable: `${aliasKey}Name`,
    styleName: key === 'fill' ? 'fillStyleName' : 'strokeStyleName',
    style: key === 'fill' ? 'fillStyleName' : 'strokeStyleName',
    id: `${aliasKey}Id`,
    name: `${aliasKey}Name`,
  };

  for (const [badKey, correctParam] of Object.entries(mapping)) {
    if (badKey in obj) {
      const badValue = obj[badKey];
      const valueLiteral = typeof badValue === 'string' ? `"${badValue}"` : JSON.stringify(badValue);
      throw new Error(
        `⛔ "${key}" is a string parameter, not an object. ` +
          `You passed ${key}:{${badKey}:${valueLiteral}} — use ${correctParam}:${valueLiteral} instead. ` +
          `${key === 'fill' ? 'fill' : 'strokeColor'} accepts hex colors ("#RRGGBB") or plain string names; ` +
          `for variable/style binding use the dedicated ${aliasKey}Id / ${aliasKey}Name / ${key === 'fill' ? 'fillStyleName' : 'strokeStyleName'} parameters.`,
      );
    }
  }
}

/**
 * Reject the raw Plugin API plural fields `fills` and `strokes` at create_frame entry.
 *
 * `nodes(method:"update")` patch path accepts `props.fills` / `props.strokes` because
 * it's a power-user surface that mirrors the Figma Plugin API field names. But
 * `create_frame` / `create_component` use the singular figcraft aliases `fill` and
 * `strokeColor`. When agents copy params between the two surfaces, `fills`/`strokes`
 * is SILENTLY DROPPED at create time — the frame is built without the requested
 * paint, the agent sees an unstyled node, retries N times, and never gets feedback.
 *
 * This guard runs BEFORE normalization and throws a self-correcting error that
 * names the canonical alias plus the alternative (patch path or variable binding).
 */
function rejectRawPaintFields(p: Record<string, unknown>): void {
  for (const [rawKey, alias, variableAlias] of [
    ['fills', 'fill', 'fillVariable'],
    ['strokes', 'strokeColor', 'strokeVariable'],
  ] as const) {
    if (!(rawKey in p) || p[rawKey] == null) continue;
    const v = p[rawKey];
    const valueLiteral = typeof v === 'string' ? `"${v}"` : Array.isArray(v) ? `[${v.length} item(s)]` : 'object';
    throw new Error(
      `⛔ "${rawKey}" is the raw Plugin API field — not accepted by create_frame/create_component. ` +
        `You passed ${rawKey}: ${valueLiteral}. Use one of:\n` +
        `  • ${alias}: "#RRGGBB"  (hex color)\n` +
        `  • ${variableAlias}Id: "VariableID:..."  (bind by ID — preferred, zero name lookup)\n` +
        `  • ${variableAlias}Name: "token/name"  (bind by name)\n` +
        `  • ${alias === 'fill' ? 'fillStyleName' : 'strokeStyleName'}: "Style/Name"  (paint style)\n` +
        `If you genuinely need to set a raw Paint[] array (rare), use nodes(method:"update", props:{${rawKey}: ...}) on the created node instead.`,
    );
  }
}

function normalizeAliases(p: Record<string, unknown>): void {
  // Pre-validation: reject raw Plugin API plural fields (fills / strokes) that are
  // silently dropped by create_frame's singular API surface.
  rejectRawPaintFields(p);

  // Pre-validation: reject mis-shaped fill/strokeColor before alias resolution.
  // Silent fallthrough here causes the infamous "create_component retries 10x" loop.
  rejectBadFillShape(p, 'fill', 'fillVariable');
  rejectBadFillShape(p, 'strokeColor', 'strokeVariable');

  // Conflict detection: fill + alias cannot coexist
  const fillAliases = [
    'fillVariableId',
    'fillVariableName',
    'fillStyleName',
    'fontColorVariableId',
    'fontColorVariableName',
    'fontColorStyleName',
  ].filter((k) => p[k] != null);
  if (p.fill != null && fillAliases.length > 0) {
    throw new Error(`Conflicting fill: "fill" and "${fillAliases.join('", "')}" both specified. Use only one.`);
  }
  if (p.strokeColor != null && (p.strokeVariableName != null || p.strokeVariableId != null)) {
    throw new Error(
      'Conflicting stroke: "strokeColor" and "strokeVariableName/strokeVariableId" both specified. Use only one.',
    );
  }
  // Fill aliases — ID takes priority over name (ID binding is direct, zero resolution)
  if (!p.fill && p.fillVariableId) {
    p.fill = { _variableId: p.fillVariableId };
    delete p.fillVariableId;
  } else if (!p.fill && p.fillVariableName) {
    p.fill = { _variable: p.fillVariableName };
    delete p.fillVariableName;
  } else if (!p.fill && p.fillStyleName) {
    p.fill = { _style: p.fillStyleName };
    delete p.fillStyleName;
  }
  // Font color aliases (for text) — ID takes priority
  if (!p.fill && p.fontColorVariableId) {
    p.fill = { _variableId: p.fontColorVariableId };
    delete p.fontColorVariableId;
  } else if (!p.fill && p.fontColorVariableName) {
    p.fill = { _variable: p.fontColorVariableName };
    delete p.fontColorVariableName;
  } else if (!p.fill && p.fontColorStyleName) {
    p.fill = { _style: p.fontColorStyleName };
    delete p.fontColorStyleName;
  }
  // Stroke aliases — ID takes priority
  if (!p.strokeColor && p.strokeVariableId) {
    p.strokeColor = { _variableId: p.strokeVariableId };
    delete p.strokeVariableId;
  } else if (!p.strokeColor && p.strokeVariableName) {
    p.strokeColor = { _variable: p.strokeVariableName };
    delete p.strokeVariableName;
  }
  // Padding shorthand — CSS cascade: padding sets base, per-side overrides
  if (p.padding != null) {
    if (p.paddingTop == null) p.paddingTop = p.padding;
    if (p.paddingRight == null) p.paddingRight = p.padding;
    if (p.paddingBottom == null) p.paddingBottom = p.padding;
    if (p.paddingLeft == null) p.paddingLeft = p.padding;
    delete p.padding;
  }
}

// ─── Batch progress ───
function sendBatchProgress(commandId: string | undefined, current: number, total: number): void {
  if (!commandId) return;
  figma.ui.postMessage({ type: 'command_progress', commandId, current, total });
}

// ─── Font style normalization: numeric weights → Figma style names ───
const WEIGHT_TO_STYLE: Record<string, string> = {
  '100': 'Thin',
  '200': 'ExtraLight',
  '300': 'Light',
  '400': 'Regular',
  '500': 'Medium',
  '600': 'SemiBold',
  '700': 'Bold',
  '800': 'ExtraBold',
  '900': 'Black',
};
function normalizeFontStyle(style: string): string {
  // Numeric weight (e.g. "700") → Figma style name (e.g. "Bold")
  if (/^\d{3}$/.test(style)) return WEIGHT_TO_STYLE[style] ?? 'Regular';
  // CamelCase split: "SemiBold" → "Semi Bold", "ExtraLight" → "Extra Light"
  const split = style.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Common aliases
  const lower = split.toLowerCase();
  if (lower === 'normal') return 'Regular';
  if (lower === 'bold italic' || lower === 'bolditalic') return 'Bold Italic';
  if (lower === 'italic') return 'Italic';
  return split;
}

// ─── Local color matching (no library mode) ───
// Tries to match a node's current solid fill to a local COLOR variable or paint style.
// Uses a short-lived cache to avoid redundant async fetches during batch operations.

interface ColorVarEntry {
  variable: Variable;
  rgb: { r: number; g: number; b: number };
}

let _colorVarCache: { entries: ColorVarEntry[]; ts: number } | null = null;
let _paintStyleCache: { styles: PaintStyle[]; ts: number } | null = null;
const COLOR_CACHE_TTL = 10_000; // 10s — covers batch operations

async function getCachedColorVars(): Promise<ColorVarEntry[]> {
  if (_colorVarCache && Date.now() - _colorVarCache.ts < COLOR_CACHE_TTL) {
    return _colorVarCache.entries;
  }
  const colorVars = await figma.variables.getLocalVariablesAsync('COLOR');
  const uniqueCollIds = [...new Set(colorVars.map((v) => v.variableCollectionId))];
  const fetchedColls = await Promise.all(uniqueCollIds.map((id) => figma.variables.getVariableCollectionByIdAsync(id)));
  const collectionMap = new Map<string, VariableCollection>();
  for (let i = 0; i < uniqueCollIds.length; i++) {
    if (fetchedColls[i]) collectionMap.set(uniqueCollIds[i], fetchedColls[i]!);
  }
  const entries: ColorVarEntry[] = [];
  for (const v of colorVars) {
    const collection = collectionMap.get(v.variableCollectionId);
    if (!collection) continue;
    const val = v.valuesByMode[collection.defaultModeId];
    if (val && typeof val === 'object' && 'r' in val) {
      entries.push({ variable: v, rgb: val as { r: number; g: number; b: number } });
    }
  }
  _colorVarCache = { entries, ts: Date.now() };
  return entries;
}

async function getCachedPaintStyles(): Promise<PaintStyle[]> {
  if (_paintStyleCache && Date.now() - _paintStyleCache.ts < COLOR_CACHE_TTL) {
    return _paintStyleCache.styles;
  }
  const styles = await figma.getLocalPaintStylesAsync();
  _paintStyleCache = { styles, ts: Date.now() };
  return styles;
}

async function tryLocalColorMatch(
  node: SceneNode & { fills: readonly Paint[] | Paint[] },
  _role: string,
): Promise<string | null> {
  const fills = node.fills as Paint[];
  if (!fills.length || fills[0].type !== 'SOLID') return null;
  const color = (fills[0] as SolidPaint).color;

  // Try local COLOR variables first (cached)
  const colorEntries = await getCachedColorVars();
  for (const { variable: v, rgb: vc } of colorEntries) {
    if (Math.abs(vc.r - color.r) < 0.01 && Math.abs(vc.g - color.g) < 0.01 && Math.abs(vc.b - color.b) < 0.01) {
      const newFills = [...fills];
      newFills[0] = figma.variables.setBoundVariableForPaint(newFills[0] as SolidPaint, 'color', v);
      node.fills = newFills;
      return `var:${v.name}`;
    }
  }

  // Try local paint styles (cached)
  const paintStyles = await getCachedPaintStyles();
  for (const s of paintStyles) {
    if (s.paints.length === 1 && s.paints[0].type === 'SOLID') {
      const sc = (s.paints[0] as SolidPaint).color;
      if (Math.abs(sc.r - color.r) < 0.01 && Math.abs(sc.g - color.g) < 0.01 && Math.abs(sc.b - color.b) < 0.01) {
        try {
          await setFillStyleIdAsync(node, s.id);
          return `fill:${s.name}`;
        } catch {
          /* skip */
        }
      }
    }
  }

  return null;
}

// ─── Smart default: infer interactiveKind when role='button' is declared ───
// Mirrors the classifier's structural heuristics so the created node starts
// with declared metadata (confidence 1) — no downstream guessing needed.
function inferButtonVariant(p: Record<string, unknown>): string | null {
  const hasFill = p.fill != null || p.fillVariableName != null || p.fillStyleName != null;
  const hasStroke = p.strokeColor != null || p.strokeVariableName != null;
  const w = typeof p.width === 'number' ? p.width : undefined;
  const h = typeof p.height === 'number' ? p.height : undefined;
  const cr = typeof p.cornerRadius === 'number' ? p.cornerRadius : 0;
  const isSquareish = w != null && h != null && Math.abs(w - h) <= Math.max(4, Math.min(w, h) * 0.15);
  const isCircular = w != null && h != null && cr >= Math.min(w, h) / 2 - 1;

  // FAB: circular, reasonable size, usually no label
  if (isCircular && isSquareish && w != null && w >= 48 && w <= 72) return 'button-fab';

  // Icon button: small square, likely only an icon/vector child
  if (isSquareish && w != null && w <= 48) {
    const children = Array.isArray(p.children) ? (p.children as Array<Record<string, unknown>>) : [];
    const hasTextChild = children.some((c) => c.type === 'text');
    const hasIconChild = children.some((c) => c.type === 'icon' || c.type === 'svg' || c.type === 'vector');
    if (hasIconChild && !hasTextChild) return 'button-icon';
  }

  if (hasFill) return 'button-solid';
  if (hasStroke) return 'button-outline';
  return 'button-ghost';
}

// ─── Smart default: infer layoutMode from AL params ───
function inferLayoutMode(p: Record<string, unknown>, hints: StructuredHint[]): 'HORIZONTAL' | 'VERTICAL' | null {
  const hasALParams =
    p.itemSpacing != null ||
    p.paddingTop != null ||
    p.paddingRight != null ||
    p.paddingBottom != null ||
    p.paddingLeft != null ||
    p.primaryAxisAlignItems != null ||
    p.counterAxisAlignItems != null ||
    (p.layoutWrap != null && p.layoutWrap !== 'NO_WRAP');
  const hasHUGSizing = p.layoutSizingHorizontal === 'HUG' || p.layoutSizingVertical === 'HUG';
  const hasChildren = Array.isArray(p.children) && p.children.length > 0;

  // Conflict: explicit NONE + AL params is contradictory
  if (p.layoutMode === 'NONE' && (hasALParams || hasHUGSizing)) {
    const conflicting = [hasALParams && 'padding/spacing/alignment', hasHUGSizing && 'HUG sizing']
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `layoutMode:"NONE" conflicts with ${conflicting}. ` +
        'Static frames do not support layout properties. Remove layoutMode:"NONE" to enable auto-layout.',
    );
  }

  if (p.layoutMode) return null; // explicit — no inference

  if (hasALParams || hasHUGSizing) {
    const direction = inferDirection(p);
    hints.push({
      confidence: 'deterministic',
      field: 'layoutMode',
      value: direction,
      reason: `inferred from padding/spacing/alignment params${direction === 'HORIZONTAL' ? ' (horizontal signals detected)' : ''}`,
    });
    return direction;
  }
  if (hasChildren) {
    const direction = inferDirection(p);
    hints.push({
      confidence: 'deterministic',
      field: 'layoutMode',
      value: direction,
      reason: `inferred from children param${direction === 'HORIZONTAL' ? ' (horizontal signals detected)' : ''}`,
    });
    return direction;
  }
  return null;
}

// ─── Per-child inline validation (O(1) checks, runs after each appendChild) ───

/**
 * Per-child inline validation + self-healing.
 *
 * Runs immediately after each child is created and appended. Two behaviors:
 * - **Self-heal**: deterministic fixes applied immediately (text overflow → HEIGHT resize)
 * - **Warn**: issues without a clear fix are reported for AI to handle
 *
 * Touch target & cross-sibling consistency are deferred to quickLintSummary
 * (wcag-target-size, form-consistency) which uses more reliable heuristics.
 */
function validateChildNode(node: SceneNode, parent: FrameNode, childPath: string, ctx: CreateContext): void {
  try {
    const w = Math.round(node.width);
    const h = Math.round(node.height);

    // ── Self-heal: text issues with deterministic fixes ──
    if (node.type === 'TEXT') {
      const text = node as TextNode;
      const parentContentWidth = parent.width - parent.paddingLeft - parent.paddingRight;

      // Empty text + WIDTH_AND_HEIGHT → will collapse to 0 width.
      // Fix: switch to HEIGHT resize so it keeps parent width.
      if ((!text.characters || text.characters.trim() === '') && text.textAutoResize === 'WIDTH_AND_HEIGHT') {
        text.textAutoResize = 'HEIGHT';
        ctx.hints.push({
          confidence: 'deterministic',
          field: 'textAutoResize',
          value: 'HEIGHT',
          reason: `[${childPath}] empty text auto-healed: WIDTH_AND_HEIGHT → HEIGHT to prevent 0-width collapse`,
        });
      }

      // Text overflows parent content area → switch to HEIGHT resize (wrap).
      else if (text.textAutoResize === 'WIDTH_AND_HEIGHT' && w > parentContentWidth + 2) {
        text.textAutoResize = 'HEIGHT';
        ctx.hints.push({
          confidence: 'deterministic',
          field: 'textAutoResize',
          value: 'HEIGHT',
          reason: `[${childPath}] text overflow auto-healed: width ${w} > parent ${Math.round(parentContentWidth)}, switched to HEIGHT resize`,
        });
      }

      // Line height below fontSize → text lines overlap (WCAG readability).
      const fontSize = typeof text.fontSize === 'number' ? text.fontSize : 0;
      if (fontSize > 0) {
        const lh = text.lineHeight as { unit: string; value?: number };
        if (lh && lh.unit === 'PIXELS' && lh.value != null && lh.value < fontSize) {
          const fixed = Math.ceil(fontSize * 1.0);
          text.lineHeight = { unit: 'PIXELS', value: fixed };
          ctx.hints.push({
            confidence: 'deterministic',
            field: 'lineHeight',
            value: fixed,
            reason: `[${childPath}] line-height ${lh.value}px < fontSize ${fontSize}px, auto-healed to ${fixed}px`,
          });
        }
      }

      // Font size below mobile readability (suggest — may be intentional)
      if (fontSize > 0 && fontSize < 12) {
        ctx.typedHints.push({
          type: 'suggest',
          message: `[${childPath}] fontSize ${fontSize} below mobile minimum (12px)`,
        });
      }
    }

    // ── Suggest: structural anomalies without deterministic fixes ──

    // Collapsed dimensions (cause varies — HUG+empty, FILL in HUG parent, etc.)
    if (w <= 0 || h <= 0) {
      // Skip if already self-healed above (text node would have been fixed)
      if (node.type !== 'TEXT') {
        ctx.typedHints.push({ type: 'suggest', message: `[${childPath}] collapsed to ${w}×${h} — check sizing` });
      }
    }

    // Invisible frame (no fills, no strokes, no children)
    if (node.type === 'FRAME') {
      const frame = node as FrameNode;
      const hasFills = Array.isArray(frame.fills) && (frame.fills as readonly Paint[]).some((f) => f.visible !== false);
      const hasStrokes =
        Array.isArray(frame.strokes) && (frame.strokes as readonly Paint[]).some((s) => s.visible !== false);
      if (!hasFills && !hasStrokes && frame.children.length === 0) {
        ctx.typedHints.push({
          type: 'suggest',
          message: `[${childPath}] invisible empty frame — no fills, strokes, or children`,
        });
      }
    }

    // Text-as-icon placeholder detection (Layer 2 warning)
    if (node.type === 'TEXT') {
      const chars = (node as TextNode).characters.trim();
      const iconPlaceholders: Record<string, string> = {
        '>': 'lucide:chevron-right',
        '›': 'lucide:chevron-right',
        '→': 'lucide:arrow-right',
        '<': 'lucide:chevron-left',
        '‹': 'lucide:chevron-left',
        '←': 'lucide:arrow-left',
        '...': 'lucide:ellipsis',
        '…': 'lucide:ellipsis',
        '•••': 'lucide:ellipsis',
        '×': 'lucide:x',
        '✕': 'lucide:x',
        X: 'lucide:x',
      };
      if (iconPlaceholders[chars]) {
        ctx.typedHints.push({
          type: 'warn',
          message: `[${childPath}] "${chars}" looks like an icon placeholder — use icon_create(icon:"${iconPlaceholders[chars]}") instead of text`,
        });
      }
    }

    // Rectangle-as-container detection (Layer 2 warning)
    if (node.type === 'RECTANGLE') {
      const nameLC = node.name.toLowerCase();
      if (/logo|avatar|icon|placeholder|image|thumb/.test(nameLC)) {
        ctx.typedHints.push({
          type: 'warn',
          message: `[${childPath}] "${node.name}" is a rectangle — use type:"frame" with centered icon inside if it needs children later`,
        });
      }
    }
  } catch {
    // Validation must never block creation
  }
}

// ─── Smart default: infer child sizing from parent auto-layout ───

/** Shape types that only support FIXED and FILL sizing (not HUG). */
const SHAPE_TYPES = new Set(['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'LINE', 'VECTOR']);

/** Detect screen-sized frames (mobile/tablet/desktop) — these should keep FIXED sizing, not HUG. */
function isScreenSize(node: SceneNode): boolean {
  if (!('width' in node) || !('height' in node)) return false;
  const w = Math.round((node as any).width);
  const h = Math.round((node as any).height);
  // Normalize: long = max, short = min (handles landscape orientation)
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  // Mobile: iPhone SE (320×568) → iPhone 16 Pro Max (440×960), Samsung/Pixel (360-412)
  const isMobile = short >= 320 && short <= 440 && long >= 568 && long <= 960;
  // Tablet: iPad mini (744×1133) → iPad Pro 12.9" (1024×1366), iPad Pro 11" (834×1194)
  const isTablet = short >= 744 && short <= 1024 && long >= 1024 && long <= 1366;
  // Web/Desktop: width ≥ 1024, height ≥ 600 (excludes narrow sidebar-style frames)
  const isDesktop = w >= 1024 && h >= 600;
  return isMobile || isTablet || isDesktop;
}

/** Check if a node is a shape or SVG-generated frame without auto-layout. */
function isShapeNode(node: SceneNode): boolean {
  if (SHAPE_TYPES.has(node.type)) return true;
  // SVG createNodeFromSvg() returns a FRAME but without auto-layout — treat as shape
  if (node.type === 'FRAME' && (node as FrameNode).layoutMode === 'NONE' && (node as FrameNode).children.length > 0) {
    // Heuristic: frames created from SVG have mostly vector children
    // Use majority check — an SVG frame may contain a TEXT label alongside vector shapes
    const kids = (node as FrameNode).children;
    const vectorCount = kids.filter(
      (c) => c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION' || c.type === 'GROUP',
    ).length;
    if (vectorCount > kids.length / 2) return true;
  }
  return false;
}

function inferChildSizing(
  node: SceneNode,
  parent: BaseNode | null,
  explicitH: string | undefined,
  explicitV: string | undefined,
  hints: StructuredHint[],
  hasExplicitWidth?: boolean,
  hasExplicitHeight?: boolean,
): void {
  // Root-level frames (direct children of page, no auto-layout parent):
  // Default to HUG/HUG so the frame wraps its content instead of collapsing to Figma's default 100px.
  //
  // 缺陷 B fix: SectionNode has no `layoutMode` property, so sections fall into this
  // "root" branch. When the caller passed explicit width/height, we must NOT override
  // with HUG — HUG + HORIZONTAL auto-layout + HUG children = 0×0 collapse. Force FIXED
  // on any axis that has an explicit dimension before the HUG fallback runs.
  if (!parent || !('layoutMode' in parent) || (parent as FrameNode).layoutMode === 'NONE') {
    // Screen dimensions or role='screen' → always FIXED even when root frame (no auto-layout parent)
    if (isScreenSize(node) || (node as any).getPluginData?.('role') === 'screen') {
      if (!explicitH) {
        setLayoutSizing(node, 'horizontal', 'FIXED');
        hints.push({
          confidence: 'deterministic',
          field: 'layoutSizingHorizontal',
          value: 'FIXED',
          reason: 'screen dimensions detected — locked to FIXED',
        });
      }
      if (!explicitV) {
        setLayoutSizing(node, 'vertical', 'FIXED');
        hints.push({
          confidence: 'deterministic',
          field: 'layoutSizingVertical',
          value: 'FIXED',
          reason: 'screen dimensions detected — locked to FIXED',
        });
      }
      return;
    }
    if ('layoutMode' in node && node.type !== 'INSTANCE' && (node as FrameNode).layoutMode !== 'NONE') {
      if (!explicitH) {
        // 缺陷 B: explicit width overrides the HUG default so section-parented
        // auto-layout frames don't collapse their children to 0.
        const sizing = hasExplicitWidth ? 'FIXED' : 'HUG';
        setLayoutSizing(node, 'horizontal', sizing);
        hints.push({
          confidence: 'deterministic',
          field: 'layoutSizingHorizontal',
          value: sizing,
          reason: hasExplicitWidth
            ? 'explicit width provided under non-auto-layout parent — FIXED'
            : 'root frame — HUG to wrap content (no auto-layout parent)',
        });
      }
      if (!explicitV) {
        const sizing = hasExplicitHeight ? 'FIXED' : 'HUG';
        setLayoutSizing(node, 'vertical', sizing);
        hints.push({
          confidence: 'deterministic',
          field: 'layoutSizingVertical',
          value: sizing,
          reason: hasExplicitHeight
            ? 'explicit height provided under non-auto-layout parent — FIXED'
            : 'root frame — HUG to wrap content (no auto-layout parent)',
        });
      }
    }
    return;
  }
  const parentFrame = parent as FrameNode;
  const parentDir = parentFrame.layoutMode;
  if (parentDir === 'NONE') return;

  // GRID layout: children default to FILL on both axes (fill their grid cell),
  // or FIXED when explicit dimensions are provided.
  if (parentDir === 'GRID') {
    const isShape = isShapeNode(node) || node.type === 'INSTANCE';
    if (!explicitH) {
      const val = hasExplicitWidth ? 'FIXED' : isShape ? 'FIXED' : 'FILL';
      setLayoutSizing(node, 'horizontal', val);
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingHorizontal',
        value: val,
        reason: hasExplicitWidth
          ? 'explicit width in GRID cell — FIXED'
          : isShape
            ? 'shape in GRID cell — FIXED'
            : 'GRID child — FILL to fill cell',
      });
    }
    if (!explicitV) {
      const val = hasExplicitHeight ? 'FIXED' : isShape ? 'FIXED' : 'FILL';
      setLayoutSizing(node, 'vertical', val);
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingVertical',
        value: val,
        reason: hasExplicitHeight
          ? 'explicit height in GRID cell — FIXED'
          : isShape
            ? 'shape in GRID cell — FIXED'
            : 'GRID child — FILL to fill cell',
      });
    }
    return;
  }

  // Mobile screen dimensions → always FIXED on both axes (never HUG/FILL)
  if (isScreenSize(node)) {
    if (!explicitH) {
      setLayoutSizing(node, 'horizontal', 'FIXED');
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingHorizontal',
        value: 'FIXED',
        reason: 'mobile screen dimensions detected — locked to FIXED',
      });
    }
    if (!explicitV) {
      setLayoutSizing(node, 'vertical', 'FIXED');
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingVertical',
        value: 'FIXED',
        reason: 'mobile screen dimensions detected — locked to FIXED',
      });
    }
    return;
  }

  const isVertical = parentDir === 'VERTICAL';
  const isShape = isShapeNode(node) || node.type === 'INSTANCE';

  // SPACE_BETWEEN + single child → FILL on primary axis (HUG defeats SPACE_BETWEEN)
  if (parentFrame.primaryAxisAlignItems === 'SPACE_BETWEEN' && parentFrame.children.length === 1 && !isShape) {
    const primaryAxis = isVertical ? 'vertical' : 'horizontal';
    const primaryField = isVertical ? 'layoutSizingVertical' : 'layoutSizingHorizontal';
    const primaryExplicit = isVertical ? explicitV : explicitH;
    if (!primaryExplicit) {
      setLayoutSizing(node, primaryAxis, 'FILL');
      hints.push({
        confidence: 'deterministic',
        field: primaryField,
        value: 'FILL',
        reason: 'single child under SPACE_BETWEEN parent — FILL to stretch (HUG defeats SPACE_BETWEEN)',
      });
      if (isVertical) explicitV = 'FILL';
      else explicitH = 'FILL';
    }
  }

  // Determine safe cross-axis default:
  // - If parent HUGs on cross-axis → child can't FILL (would collapse to 0), use HUG (or FIXED for shapes)
  // - If parent uses CENTER/MAX/BASELINE alignment → FILL would override alignment, use HUG/FIXED
  // - Otherwise → FILL (stretch to fill parent)
  const fixedLabel = node.type === 'INSTANCE' ? 'instance keeps defined size' : 'shape keeps explicit size';
  function safeCrossDefault(): { sizing: 'FILL' | 'HUG' | 'FIXED'; reason: string } {
    const crossSizing = getLayoutSizing(parentFrame, isVertical ? 'horizontal' : 'vertical');
    if (crossSizing === 'HUG') {
      return isShape
        ? { sizing: 'FIXED', reason: `parent HUGs on cross-axis; ${fixedLabel}` }
        : { sizing: 'HUG', reason: 'parent HUGs on cross-axis' };
    }
    const crossAlign = parentFrame.counterAxisAlignItems;
    if (crossAlign === 'CENTER' || crossAlign === 'MAX') {
      return isShape
        ? { sizing: 'FIXED', reason: `parent aligns children ${crossAlign}; ${fixedLabel}` }
        : { sizing: 'HUG', reason: `parent aligns children ${crossAlign} — FILL would override` };
    }
    if ((crossAlign as string) === 'BASELINE') {
      return isShape
        ? { sizing: 'FIXED', reason: `parent uses BASELINE alignment; ${fixedLabel}` }
        : { sizing: 'HUG', reason: 'parent uses BASELINE alignment — FILL would override' };
    }
    return { sizing: 'FILL', reason: 'stretch to fill parent' };
  }

  const cross = safeCrossDefault();

  // Shapes and instances don't support HUG — use FIXED for primary axis instead
  const isInstance = node.type === 'INSTANCE';
  const primaryDefault = isShape ? 'FIXED' : 'HUG';
  const primaryReason = isShape
    ? isInstance
      ? 'instance preserves component-defined size along flow'
      : 'shape keeps explicit size along flow'
    : 'shrink to content along flow';

  // Cross-axis → FILL or HUG/FIXED (context-dependent), primary-axis → HUG or FIXED (shapes)
  if (!explicitH) {
    if (hasExplicitWidth) {
      // Explicit width provided without layoutSizingHorizontal → keep FIXED (don't override with HUG/FILL)
      setLayoutSizing(node, 'horizontal', 'FIXED');
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingHorizontal',
        value: 'FIXED',
        reason: 'explicit width provided — keeping FIXED',
      });
    } else {
      const val = isVertical ? cross.sizing : primaryDefault;
      setLayoutSizing(node, 'horizontal', val);
      const reason = isVertical ? cross.reason : primaryReason;
      const confidence = val === 'FILL' ? 'ambiguous' : 'deterministic';
      hints.push({ confidence, field: 'layoutSizingHorizontal', value: val, reason });
    }
  }
  if (!explicitV) {
    if (hasExplicitHeight) {
      // Explicit height provided without layoutSizingVertical → keep FIXED (don't override with HUG/FILL)
      setLayoutSizing(node, 'vertical', 'FIXED');
      hints.push({
        confidence: 'deterministic',
        field: 'layoutSizingVertical',
        value: 'FIXED',
        reason: 'explicit height provided — keeping FIXED',
      });
    } else {
      const val = isVertical ? primaryDefault : cross.sizing;
      setLayoutSizing(node, 'vertical', val);
      const reason = isVertical ? primaryReason : cross.reason;
      const confidence = val === 'FILL' ? 'ambiguous' : 'deterministic';
      hints.push({ confidence, field: 'layoutSizingVertical', value: val, reason });
    }
  }
}

// Fields already tracked by structuredHintsToInferences (avoids double-counting in _applied)
const INFERRED_FIELDS_SET = new Set(['layoutMode', 'layoutSizingHorizontal', 'layoutSizingVertical']);

// ─── Role-driven defaults: semantic role → missing property auto-fill ───
//
// Each entry only fills a field when the agent didn't pass it explicitly
// (see line ~930: `if (p[key] == null) p[key] = value`). Defaults are
// non-destructive — agents always win.
//
// Padding/spacing values are md-size baselines. Smaller/larger sizes can
// override per call. The 2026-04 Button regression (31 variants cloned with
// padding=0 because base had no padding and clone preserved that) made
// these defaults necessary — see plan elegant-wandering-raven.md A3.
const ROLE_DEFAULTS: Record<string, Record<string, unknown>> = {
  screen: { layoutMode: 'VERTICAL', clipsContent: true },
  button: {
    layoutMode: 'HORIZONTAL',
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'CENTER',
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 8,
    paddingBottom: 8,
    itemSpacing: 8,
  },
  input: {
    layoutMode: 'HORIZONTAL',
    counterAxisAlignItems: 'CENTER',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    itemSpacing: 8,
  },
  header: {
    layoutMode: 'HORIZONTAL',
    counterAxisAlignItems: 'CENTER',
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 12,
    paddingBottom: 12,
    itemSpacing: 12,
  },
};

// ─── Core frame setup (shared by create_frame and inline children) ───
async function setupFrame(
  frame: FrameNode,
  p: Record<string, unknown>,
  ctx: CreateContext,
  parentName?: string,
): Promise<void> {
  normalizeAliases(p);

  frame.name = (p.name as string) ?? 'Frame';
  if (p.x != null) frame.x = p.x as number;
  if (p.y != null) frame.y = p.y as number;

  // ── Semantic role ──
  if (p.role != null) {
    frame.setPluginData(PLUGIN_DATA_KEYS.ROLE, p.role as string);
  }

  // ── Interactive kind/state/variant declarations ──
  // Stored as plugin data so the lint classifier short-circuits to the declared
  // value. When role='button' is set but interactiveKind is missing, we infer
  // the variant from structure (fill → solid, stroke-only → outline, etc.) so
  // the agent doesn't need to restate obvious signals.
  if (p.interactiveKind != null) {
    frame.setPluginData(PLUGIN_DATA_KEYS.INTERACTIVE_KIND, p.interactiveKind as string);
  } else if (p.role === 'button') {
    const inferredKind = inferButtonVariant(p);
    if (inferredKind) {
      frame.setPluginData(PLUGIN_DATA_KEYS.INTERACTIVE_KIND, inferredKind);
      ctx.hints.push({
        confidence: 'deterministic',
        field: 'interactiveKind',
        value: inferredKind,
        reason: `role='button' + structural signals → ${inferredKind}`,
      });
    }
  } else if (p.role === 'link') {
    frame.setPluginData(PLUGIN_DATA_KEYS.INTERACTIVE_KIND, 'link-standalone');
  }
  if (p.interactiveState != null) {
    frame.setPluginData(PLUGIN_DATA_KEYS.INTERACTIVE_STATE, p.interactiveState as string);
  }
  if (p.interactiveVariant != null) {
    frame.setPluginData(PLUGIN_DATA_KEYS.INTERACTIVE_VARIANT, p.interactiveVariant as string);
  }

  // ── Role-driven defaults: fill missing properties from role semantics ──
  const effectiveRole = (p.role as string) || undefined;
  if (effectiveRole && ROLE_DEFAULTS[effectiveRole]) {
    for (const [key, value] of Object.entries(ROLE_DEFAULTS[effectiveRole])) {
      if (p[key] == null) {
        p[key] = value;
        ctx.hints.push({
          confidence: 'deterministic',
          field: key,
          value,
          reason: `role "${effectiveRole}" default`,
        });
      }
    }
  }

  // ── Smart default: infer layoutMode ──
  const inferredMode = inferLayoutMode(p, ctx.hints);
  const effectiveLayoutMode = (p.layoutMode as string) ?? inferredMode;

  // Resize — only when dimensions provided or no auto-layout
  if (p.width != null || p.height != null) {
    frame.resize((p.width as number) ?? 100, (p.height as number) ?? 100);
  } else if (!effectiveLayoutMode) {
    frame.resize(100, 100);
  }

  // ── Fill ──
  // Presentational containers (role:"presentation") in library mode:
  // use the explicit hex color as-is without token auto-binding.
  // These are display scaffolding (Wrapper, Stage, Flow Row), not actual UI surfaces.
  const fillStr = typeof p.fill === 'string' ? (p.fill as string) : null;
  const isHex = fillStr != null && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(fillStr);
  const isPresentation = p.role === 'presentation';
  const skipTokenBind = ctx.useLib && isHex && isPresentation;
  if (skipTokenBind) {
    frame.fills = [{ type: 'SOLID', color: hexToFigmaRgb(fillStr) }];
  } else if (p.fill != null) {
    const fillResult = await applyFill(frame, p.fill as any, 'background', ctx.useLib, ctx.library, {
      stylesPreloaded: true,
    });
    if (fillResult.autoBound) ctx.libraryBindings.push(fillResult.autoBound);
    teachIdForNextTime(ctx, fillResult, 'fillVariableId');
    if (fillResult.colorHint) ctx.warnings.push(fillResult.colorHint);
    if (fillResult.bindingFailure) ctx.tokenBindingFailures.push(fillResult.bindingFailure);
    // When not in library mode but fill is a hex color, try matching local variables/styles
    if (!fillResult.autoBound && !ctx.useLib && typeof p.fill === 'string') {
      try {
        const localBound = await tryLocalColorMatch(frame as any, 'background');
        if (localBound) ctx.libraryBindings.push(localBound);
      } catch {
        /* best effort */
      }
    }
  } else if (ctx.useLib) {
    // Only auto-bind surface fill to frames with a semantic role (e.g. role:"screen").
    // Structural containers (layout wrappers, rows, groups) should be transparent —
    // AI passes explicit fill/fillVariableName when a background is intended.
    if (p.role != null && p.role !== 'presentation') {
      const fillResult = await applyFill(frame, undefined, 'background', ctx.useLib, ctx.library, {
        stylesPreloaded: true,
      });
      if (fillResult.autoBound) ctx.libraryBindings.push(fillResult.autoBound);
      teachIdForNextTime(ctx, fillResult, 'fillVariableId');
      if (fillResult.colorHint) ctx.warnings.push(fillResult.colorHint);
      if (fillResult.bindingFailure) ctx.tokenBindingFailures.push(fillResult.bindingFailure);
    } else if (isPresentation) {
      // Presentational scaffolding (Wrapper, Stage, Flow Row) needs contrast background.
      // If AI omitted fill (e.g. due to "no hex" colorRules), apply default light gray.
      frame.fills = [{ type: 'SOLID', color: hexToFigmaRgb('#F3F4F6') }];
    } else {
      frame.fills = []; // structural container — transparent
    }
  } else {
    frame.fills = []; // clear default white
  }

  // ── Gradient fill ──
  if (p.gradient) {
    const g = p.gradient as { type?: string; stops: Array<{ color: string; position: number }>; angle?: number };
    if (g.stops && g.stops.length >= 2) {
      const gradStops: ColorStop[] = g.stops.map((s) => ({
        position: s.position,
        color: { ...hexToFigmaRgb(s.color), a: 1 },
      }));
      const gradType = (g.type ?? 'LINEAR') === 'RADIAL' ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR';
      // Compute transform from angle (default 180 = top-to-bottom)
      const angleDeg = g.angle ?? 180;
      const angleRad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      frame.fills = [
        {
          type: gradType,
          gradientStops: gradStops,
          gradientTransform: [
            [cos, sin, 0.5 - cos * 0.5 - sin * 0.5],
            [-sin, cos, 0.5 + sin * 0.5 - cos * 0.5],
          ],
        } as GradientPaint,
      ];
    }
  }

  // ── Image fill (URL/pexel:<id> or local base64 bytes from MCP server) ──
  if (typeof p.imageData === 'string' && p.imageData.length > 0) {
    try {
      const scaleMode = ((p.imageScaleMode as string | undefined) ?? 'FILL').toUpperCase() as ImageScaleMode;
      const imagePaint = imagePaintFromBase64(p.imageData, scaleMode);
      frame.fills = [imagePaint];
      if (imagePaint.imageHash) ctx.imageHash = imagePaint.imageHash;
    } catch (err) {
      throw new Error(`imageData failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (p.imageUrl) {
    try {
      const url = p.imageUrl as string;
      const image = await figma.createImageAsync(url);
      const scaleMode = (p.imageScaleMode as string) ?? 'FILL';
      frame.fills = [
        {
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode: scaleMode as 'FILL' | 'FIT' | 'CROP' | 'TILE',
        },
      ];
    } catch (err) {
      ctx.warnings.push(`imageUrl failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Stroke ──
  if (p.strokeColor != null) {
    const sr = await applyStroke(frame, p.strokeColor as any, (p.strokeWeight as number) ?? 1, ctx.useLib, ctx.library);
    if (sr.autoBound) ctx.libraryBindings.push(sr.autoBound);
    teachIdForNextTime(ctx, sr, 'strokeVariableId');
    if (sr.colorHint) ctx.warnings.push(sr.colorHint);
    if (sr.bindingFailure) ctx.tokenBindingFailures.push(sr.bindingFailure);
  }
  // When no strokeColor is requested, leave Figma defaults intact (strokes=[], strokeWeight=1).
  // strokes=[] already guarantees no visible border; preserving strokeWeight=1 keeps the
  // native default so users adding a stroke later in the Figma UI get the expected 1px.
  setStrokeProps(frame, {
    strokeAlign: p.strokeAlign && 'strokeAlign' in frame ? (p.strokeAlign as string) : undefined,
    dashPattern: p.strokeDashes && Array.isArray(p.strokeDashes) ? (p.strokeDashes as number[]) : undefined,
    strokeCap: p.strokeCap as string | undefined,
    strokeJoin: p.strokeJoin as string | undefined,
  });

  // ── Layout mode ──
  if (effectiveLayoutMode) {
    frame.layoutMode = effectiveLayoutMode as 'HORIZONTAL' | 'VERTICAL' | 'GRID';
    // ── GRID-specific properties ──
    if (effectiveLayoutMode === 'GRID') {
      if (p.gridRowCount != null) frame.gridRowCount = p.gridRowCount as number;
      if (p.gridColumnCount != null) frame.gridColumnCount = p.gridColumnCount as number;
      if (p.gridRowGap != null) frame.gridRowGap = p.gridRowGap as number;
      if (p.gridColumnGap != null) frame.gridColumnGap = p.gridColumnGap as number;
    }
    // When dimensions are explicitly provided with auto-layout, ensure FIXED sizing
    // (layoutMode assignment resets sizing to HUG by default, which would override resize).
    //
    // 缺陷 B fix: setting FIXED alone is insufficient — if `frame.layoutMode = ...`
    // already collapsed the frame (e.g. 360×48 → 0×0 on an empty HUG-default auto-layout),
    // FIXED just locks it at the collapsed size. Re-invoke resize() to restore the
    // explicit dimensions after setting the sizing mode.
    const needsFixedH = p.width != null && !p.layoutSizingHorizontal;
    const needsFixedV = p.height != null && !p.layoutSizingVertical;
    if (needsFixedH) {
      setLayoutSizing(frame, 'horizontal', 'FIXED');
    }
    if (needsFixedV) {
      setLayoutSizing(frame, 'vertical', 'FIXED');
    }
    if (needsFixedH || needsFixedV) {
      try {
        frame.resize(
          needsFixedH ? (p.width as number) : frame.width,
          needsFixedV ? (p.height as number) : frame.height,
        );
      } catch {
        /* resize can fail on 0-dimension frames in rare cases */
      }
    }
  }

  // ── Spacing & padding: bind to float tokens in library mode ──
  const spacingFields = [
    'itemSpacing',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
    'paddingBottom',
    'counterAxisSpacing',
  ] as const;
  if (ctx.useLib) {
    const tokenFieldMap: Record<string, number | undefined> = {};
    for (const key of spacingFields) {
      if (p[key] != null && typeof p[key] === 'number') tokenFieldMap[key] = p[key] as number;
    }
    if (Object.keys(tokenFieldMap).length > 0) {
      const bound = await applyTokenFields(frame as SceneNode, tokenFieldMap, undefined, ctx.library);
      ctx.libraryBindings.push(...bound);
    }
  }
  for (const key of spacingFields) {
    if (p[key] != null && !(ctx.useLib && typeof p[key] === 'number')) {
      (frame as any)[key] = p[key] as number;
    }
  }

  // ── Padding vs frame dimension sanity check ──
  {
    const fw = frame.width;
    const fh = frame.height;
    const pl = (p.paddingLeft as number) ?? 0;
    const pr = (p.paddingRight as number) ?? 0;
    const pt = (p.paddingTop as number) ?? 0;
    const pb = (p.paddingBottom as number) ?? 0;
    if (fw > 0 && pl + pr >= fw) {
      ctx.warnings.push(
        `Padding H (${pl}+${pr}=${pl + pr}) ≥ frame width (${fw}px) — children will have no horizontal space`,
      );
    }
    if (fh > 0 && pt + pb >= fh) {
      ctx.warnings.push(
        `Padding V (${pt}+${pb}=${pt + pb}) ≥ frame height (${fh}px) — children will have no vertical space`,
      );
    }
  }

  // ── Corner radius ──
  if (p.cornerRadius != null) {
    const radiusBound = await applyCornerRadius(
      frame as SceneNode,
      p.cornerRadius as any,
      ctx.useLib,
      undefined,
      ctx.library,
    );
    ctx.libraryBindings.push(...radiusBound);
  }
  // Per-corner overrides (after uniform cornerRadius so they take precedence)
  if (p.topLeftRadius != null) frame.topLeftRadius = p.topLeftRadius as number;
  if (p.topRightRadius != null) frame.topRightRadius = p.topRightRadius as number;
  if (p.bottomRightRadius != null) frame.bottomRightRadius = p.bottomRightRadius as number;
  if (p.bottomLeftRadius != null) frame.bottomLeftRadius = p.bottomLeftRadius as number;

  // ── Alignment ──
  if (p.primaryAxisAlignItems) {
    frame.primaryAxisAlignItems = p.primaryAxisAlignItems as 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  }
  if (p.counterAxisAlignItems) {
    frame.counterAxisAlignItems = p.counterAxisAlignItems as 'MIN' | 'CENTER' | 'MAX';
  }
  if (p.layoutWrap) {
    setLayoutWrap(frame, p.layoutWrap as string);
  }

  // ── Appearance ──
  if (p.opacity != null) frame.opacity = p.opacity as number;
  if (p.visible === false) frame.visible = false;
  if (p.rotation != null) frame.rotation = p.rotation as number;
  if (p.blendMode) setBlendMode(frame, p.blendMode as string);
  if (p.clipsContent != null) frame.clipsContent = p.clipsContent as boolean;
  if (p.layoutPositioning === 'ABSOLUTE') setLayoutPositioning(frame, 'ABSOLUTE');

  // ── Effect style (shadows/blurs) ──
  if (p.effectStyleName) {
    try {
      const name = p.effectStyleName as string;
      // 1. Search local styles first
      const effectStyles = await figma.getLocalEffectStylesAsync();
      const localMatch =
        effectStyles.find((s) => s.name === name) ??
        effectStyles.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (localMatch) {
        await setEffectStyleIdAsync(frame, localMatch.id);
      } else if (ctx.useLib && ctx.library) {
        // 2. Search style registry (library effect styles)
        await ensureLoaded(ctx.library);
        const registryMatch = getEffectStyleByName(name);
        if (registryMatch) {
          await setEffectStyleIdAsync(frame, registryMatch.id);
        } else {
          const avail = getAvailableEffectStyleNames(10);
          ctx.warnings.push(
            `effectStyle "${name}" not found in local styles or library "${ctx.library}".${avail.length > 0 ? ` Available: ${avail.join(', ')}` : ''}`,
          );
        }
      } else {
        const avail = getAvailableEffectStyleNames(10);
        ctx.warnings.push(
          `effectStyle "${name}" not found.${avail.length > 0 ? ` Available: ${avail.join(', ')}` : ''}`,
        );
      }
    } catch (err) {
      ctx.warnings.push(`effectStyle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Effect shorthands — only when no effectStyleName (library style takes priority)
    const effects: Effect[] = [];

    if (p.shadow) {
      const s = p.shadow as Record<string, unknown>;
      const rgba = hexToFigmaRgba((s.color as string) ?? '#00000040');
      effects.push({
        type: 'DROP_SHADOW',
        visible: true,
        color: rgba,
        offset: { x: (s.x as number) ?? 0, y: (s.y as number) ?? 4 },
        radius: (s.blur as number) ?? 12,
        spread: (s.spread as number) ?? 0,
        blendMode: 'NORMAL',
      });
    }

    if (p.innerShadow) {
      const s = p.innerShadow as Record<string, unknown>;
      const rgba = hexToFigmaRgba((s.color as string) ?? '#0000001A');
      effects.push({
        type: 'INNER_SHADOW',
        visible: true,
        color: rgba,
        offset: { x: (s.x as number) ?? 0, y: (s.y as number) ?? 2 },
        radius: (s.blur as number) ?? 4,
        spread: (s.spread as number) ?? 0,
        blendMode: 'NORMAL',
      });
    }

    if (p.blur) {
      effects.push({
        type: 'BACKGROUND_BLUR',
        visible: true,
        blurType: 'NORMAL',
        radius: p.blur as number,
      });
    }

    if (effects.length > 0) frame.effects = effects;
  }

  // ── Responsive constraints ──
  if (p.minWidth != null) frame.minWidth = p.minWidth as number;
  if (p.maxWidth != null) frame.maxWidth = p.maxWidth as number;
  if (p.minHeight != null) frame.minHeight = p.minHeight as number;
  if (p.maxHeight != null) frame.maxHeight = p.maxHeight as number;

  // ── Auto-infer responsive constraints when FILL + children + no explicit constraints ──
  if (p.minWidth == null && p.maxWidth == null && frame.layoutMode && frame.layoutMode !== 'NONE') {
    const name = frame.name.toLowerCase();
    // Cards and panels: set minWidth to avoid collapse
    if (/card|panel|tile/.test(name) && frame.width >= 120) {
      frame.minWidth = Math.max(120, Math.round(frame.width * 0.5));
      ctx.hints.push({
        confidence: 'deterministic',
        field: 'minWidth',
        value: frame.minWidth,
        reason: 'card/panel minimum',
      });
    }
    // Buttons: minimum touch target + label space
    if (/button|btn|cta/.test(name)) {
      // Skip minHeight when button is nested inside an input field — the parent
      // already provides the touch target, and forcing minHeight causes overflow.
      const isNestedInInput =
        parentName != null && /input|field|text.?field|search.?bar/.test(parentName.toLowerCase());
      frame.minWidth = Math.max(48, Math.round(frame.width * 0.5));
      if (!isNestedInInput) {
        frame.minHeight = frame.minHeight ?? Math.max(36, Math.min(frame.height, 48));
      }
      ctx.hints.push({
        confidence: 'deterministic',
        field: 'minWidth',
        value: frame.minWidth,
        reason: 'button constraints',
      });
      if (!isNestedInInput) {
        ctx.hints.push({
          confidence: 'deterministic',
          field: 'minHeight',
          value: frame.minHeight,
          reason: 'button constraints',
        });
      }
    }
    // Input fields: minimum usable width
    if (/input|field|text.?field|search.?bar/.test(name)) {
      frame.minWidth = Math.max(80, Math.round(frame.width * 0.4));
      ctx.hints.push({
        confidence: 'deterministic',
        field: 'minWidth',
        value: frame.minWidth,
        reason: 'input field minimum',
      });
    }
  }

  // ── Auto-infer role:"screen" from structural signals (multi-signal convergence) ──
  // Only when: no explicit role + root-level frame + explicit dimensions + screen-sized
  if (p.role == null && p.parentId == null && p.width != null && p.height != null && isScreenSize(frame)) {
    frame.setPluginData(PLUGIN_DATA_KEYS.ROLE, 'screen');
    ctx.hints.push({
      confidence: 'deterministic',
      field: 'role',
      value: 'screen',
      reason: 'root-level frame with screen dimensions — auto-tagged for lint identification',
    });
  }
}

// ─── Core text setup (shared by create_text and inline children) ───
async function setupText(text: TextNode, p: Record<string, unknown>, ctx: CreateContext): Promise<void> {
  normalizeAliases(p);

  const content = (p.content as string) ?? (p.text as string) ?? '';
  const name = (p.name as string) ?? (content || 'Text');
  const fontSize = (p.fontSize as number) ?? 14;
  const explicitFontFamily = p.fontFamily as string | undefined;
  const fontFamily = explicitFontFamily ?? platformDefaultFont(ctx.platform, content);
  const fontStyle = normalizeFontStyle((p.fontStyle as string) ?? 'Regular');

  // Warn when explicit font doesn't support detected CJK script
  if (explicitFontFamily && content) {
    const detectedCjk = HANGUL_RE.test(content)
      ? 'Korean'
      : KANA_RE.test(content)
        ? 'Japanese'
        : CJK_RE.test(content)
          ? 'Chinese'
          : null;
    if (detectedCjk) {
      const recommended = platformDefaultFont(ctx.platform, content);
      if (recommended !== explicitFontFamily) {
        ctx.warnings.push(
          `Font "${explicitFontFamily}" may not support ${detectedCjk} characters. ` +
            `Recommended: "${recommended}" for ${ctx.platform} platform. ` +
            `CJK text with a Latin-only font will show missing glyphs (tofu).`,
        );
      }
    }
  }

  const fontResolution = await resolveFontAsync(fontFamily, fontStyle);
  text.fontName = fontResolution.fontName;
  if (fontResolution.fallbackNote) ctx.warnings.push(fontResolution.fallbackNote);
  text.name = name;
  text.fontSize = fontSize;
  text.characters = content;

  if (p.x != null) text.x = p.x as number;
  if (p.y != null) text.y = p.y as number;

  // ── Width → fixed width + HEIGHT auto-resize ──
  if (p.width != null) {
    text.resize(p.width as number, text.height);
    text.textAutoResize = 'HEIGHT';
  }

  // ── Fill / color ──
  if (p.fill != null) {
    const fillResult = await applyFill(text, p.fill as any, 'textColor', ctx.useLib, ctx.library, {
      stylesPreloaded: true,
    });
    if (fillResult.autoBound) ctx.libraryBindings.push(fillResult.autoBound);
    teachIdForNextTime(ctx, fillResult, 'fontColorVariableId');
    if (fillResult.colorHint) ctx.warnings.push(fillResult.colorHint);
    if (fillResult.bindingFailure) ctx.tokenBindingFailures.push(fillResult.bindingFailure);
    // When not in library mode but fill is a hex color, try matching local variables/styles
    if (!fillResult.autoBound && !ctx.useLib && typeof p.fill === 'string') {
      try {
        const localBound = await tryLocalColorMatch(text as any, 'textColor');
        if (localBound) ctx.libraryBindings.push(localBound);
      } catch {
        /* best effort */
      }
    }
  } else if (ctx.useLib) {
    // Determine text color role from explicit role declaration
    const textRole = p.role === 'heading' ? 'headingColor' : p.role === 'secondary' ? 'textSecondary' : 'textColor';
    const fillResult = await applyFill(text, undefined, textRole, ctx.useLib, ctx.library, {
      stylesPreloaded: true,
    });
    if (fillResult.autoBound) ctx.libraryBindings.push(fillResult.autoBound);
    teachIdForNextTime(ctx, fillResult, 'fontColorVariableId');
    if (fillResult.colorHint) ctx.warnings.push(fillResult.colorHint);
    if (fillResult.bindingFailure) ctx.tokenBindingFailures.push(fillResult.bindingFailure);
  }

  // ── Line height (before typography binding so it can be overridden) ──
  if (p.lineHeight != null) {
    text.lineHeight = { value: p.lineHeight as number, unit: 'PIXELS' };
  }

  // ── Text style binding ──
  if (p.textStyleName) {
    let bound = false;
    // Try library style registry first (if library mode)
    if (ctx.useLib) {
      const styleMatch = getTextStyleByName(p.textStyleName as string);
      if (styleMatch) {
        try {
          await setTextStyleIdAsync(text, styleMatch.id);
          ctx.libraryBindings.push(`textStyle:${styleMatch.name}`);
          bound = true;
        } catch (err) {
          ctx.warnings.push(`textStyle bind failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Fallback: try local text styles, then library style import by key
    if (!bound) {
      try {
        const localStyles = await figma.getLocalTextStylesAsync();
        const name = p.textStyleName as string;
        const match =
          localStyles.find((s) => s.name === name) ??
          localStyles.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (match) {
          // Local style may use a different font than the node's current font — preload before applying
          if (typeof match.fontName === 'object') {
            await figma.loadFontAsync(match.fontName);
          }
          await setTextStyleIdAsync(text, match.id);
          ctx.libraryBindings.push(`textStyle:${match.name}`);
          bound = true;
        }
      } catch (err) {
        ctx.warnings.push(`textStyle lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Fallback: import library style by key from clientStorage registry
    if (!bound && ctx.useLib && ctx.library) {
      try {
        const name = p.textStyleName as string;
        const storedJson = (await figma.clientStorage.getAsync(`figcraft_styles_${ctx.library}`)) as string | undefined;
        if (storedJson) {
          const stored = JSON.parse(storedJson) as {
            textStyles: Array<{ key: string; name: string; fontSize: number; fontFamily: string; fontWeight: string }>;
          };
          const lower = name.toLowerCase();
          const entry = stored.textStyles.find((s) => s.name.toLowerCase() === lower);
          if (entry) {
            const imported = await figma.importStyleByKeyAsync(entry.key);
            // Preload font before applying
            const fontName = (imported as any).fontName;
            if (fontName && typeof fontName === 'object') {
              await figma.loadFontAsync(fontName);
            }
            await setTextStyleIdAsync(text, imported.id);
            ctx.libraryBindings.push(`textStyle:${entry.name}`);
            bound = true;
          }
        }
      } catch {
        /* best effort — style import failed */
      }
      if (!bound) {
        const avail = getAvailableTextStyleNames(10);
        ctx.warnings.push(
          `textStyle "${p.textStyleName}" not found.${avail.length > 0 ? ` Available: ${avail.join(', ')}` : ''}`,
        );
      }
    }
  } else if (ctx.useLib) {
    // Auto-bind typography by fontSize
    const fontHints = { fontFamily: fontResolution.fontName.family, fontWeight: fontResolution.fontName.style };
    const styleMatch = getTextStyleId(fontSize, fontHints);
    if (styleMatch) {
      try {
        // Preload the style's font before binding — setTextStyleIdAsync changes the
        // node's font, and subsequent writes (textAutoResize, etc.) require it loaded.
        await figma.loadFontAsync({ family: styleMatch.fontFamily, style: styleMatch.fontWeight });
        await setTextStyleIdAsync(text, styleMatch.id);
        ctx.libraryBindings.push(`textStyle:${styleMatch.name}`);
      } catch {
        /* skip */
      }
    } else {
      try {
        const typoResult = await autoBindTypography(text, fontSize, ctx.library!, {
          skipFontFamily: p.fontFamily !== undefined,
        });
        if (typoResult?.scale) ctx.libraryBindings.push(`typo:${typoResult.scale}`);
      } catch {
        /* skip */
      }
    }
  }

  // ── Typography props ──
  if (p.letterSpacing != null) {
    text.letterSpacing = { value: p.letterSpacing as number, unit: 'PIXELS' };
  }
  if (p.textAlignHorizontal) {
    text.textAlignHorizontal = p.textAlignHorizontal as 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  }
  if (p.textAlignVertical) {
    text.textAlignVertical = p.textAlignVertical as 'TOP' | 'CENTER' | 'BOTTOM';
  }
  if (p.textAutoResize && !p.width) {
    text.textAutoResize = p.textAutoResize as 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  }
  if (p.textCase) {
    text.textCase = p.textCase as 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  }
  if (p.textDecoration) {
    text.textDecoration = p.textDecoration as 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  }

  // ── Appearance ──
  if (p.opacity != null) text.opacity = p.opacity as number;
  if (p.visible === false) text.visible = false;

  // ── Component text property auto-bind (best effort) ──
  try {
    const ancestorComp = findAncestorComponent(text);
    if (ancestorComp) {
      const defs = ancestorComp.componentPropertyDefinitions;
      const matchingKey = Object.keys(defs).find((k) => defs[k].type === 'TEXT' && k.startsWith(`${text.name}#`));
      if (matchingKey) {
        text.componentPropertyReferences = { characters: matchingKey };
        ctx.warnings.push(`Auto-bound text "${text.name}" to component property`);
      }
    }
  } catch {
    /* best effort — do not fail text creation */
  }
}

/** Walk up the parent chain to find the nearest ComponentNode ancestor. */
function findAncestorComponent(node: BaseNode): ComponentNode | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'COMPONENT') return current as ComponentNode;
    current = current.parent;
  }
  return null;
}

// ─── Shape child helper (deduplicates rectangle/ellipse/star/polygon creation) ───
/** Insert child into parent, respecting optional index for ordering control. */
function insertOrAppend(parent: FrameNode, child: SceneNode, index?: number): void {
  if (index != null) {
    parent.insertChild(index, child);
  } else {
    parent.appendChild(child);
  }
}

async function createShapeChild(
  node: SceneNode,
  figmaType: string,
  defaultName: string,
  child: Record<string, unknown>,
  parent: FrameNode,
  ctx: CreateContext,
  opts?: { supportsCornerRadius?: boolean },
): Promise<{ id: string; type: string; name: string }> {
  (node as any).name = (child.name as string) ?? defaultName;
  (node as any).resize((child.width as number) ?? 100, (child.height as number) ?? 100);

  // P0-B: rectangle/ellipse inline children now support fillVariableId (ID-first).
  const fillInput = child.fillVariableId
    ? { _variableId: child.fillVariableId }
    : child.fillVariableName
      ? { _variable: child.fillVariableName }
      : child.fillStyleName
        ? { _style: child.fillStyleName }
        : child.fill;
  if (fillInput != null) {
    const fr = await applyFill(node as any, fillInput as any, 'background', ctx.useLib, ctx.library);
    if (fr.autoBound) ctx.libraryBindings.push(fr.autoBound);
    teachIdForNextTime(ctx, fr, 'fillVariableId');
    // P0-B consistency fix: previously this branch dropped colorHint / bindingFailure,
    // so rectangle/ellipse child fill failures were invisible to the harness rule.
    if (fr.colorHint) ctx.warnings.push(fr.colorHint);
    if (fr.bindingFailure) ctx.tokenBindingFailures.push(fr.bindingFailure);
  }
  const strokeInput = child.strokeVariableId
    ? { _variableId: child.strokeVariableId }
    : child.strokeVariableName
      ? { _variable: child.strokeVariableName }
      : child.strokeColor;
  if (strokeInput != null) {
    const sr = await applyStroke(
      node as any,
      strokeInput as any,
      (child.strokeWeight as number) ?? 1,
      ctx.useLib,
      ctx.library,
    );
    if (sr.autoBound) ctx.libraryBindings.push(sr.autoBound);
    teachIdForNextTime(ctx, sr, 'strokeVariableId');
    if (sr.colorHint) ctx.warnings.push(sr.colorHint);
    if (sr.bindingFailure) ctx.tokenBindingFailures.push(sr.bindingFailure);
  }
  if (opts?.supportsCornerRadius && child.cornerRadius != null) {
    const rb = await applyCornerRadius(node as any, child.cornerRadius as any, ctx.useLib, undefined, ctx.library);
    ctx.libraryBindings.push(...rb);
  }
  if (child.opacity != null) (node as any).opacity = child.opacity as number;
  if (child.rotation != null) (node as any).rotation = child.rotation as number;

  insertOrAppend(parent, node, child.index as number | undefined);
  inferChildSizing(
    node,
    parent,
    child.layoutSizingHorizontal as string | undefined,
    child.layoutSizingVertical as string | undefined,
    ctx.hints,
    child.width != null,
    child.height != null,
  );
  applySizingOverrides(node, child);
  return { id: node.id, type: figmaType, name: (node as any).name };
}

// ─── Inline children: recursive tree builder ───
const MAX_INLINE_DEPTH = 10;

/** Recursively collect unique font specs from text children for batch preloading. */
function collectTextFonts(children: unknown[], platform: Platform): Array<{ family: string; style: string }> {
  const fonts: Array<{ family: string; style: string }> = [];
  for (const childDef of children) {
    const child = childDef as Record<string, unknown>;
    const type = (child.type as string) ?? 'frame';
    if (type === 'text') {
      const content = (child.content as string) ?? (child.text as string) ?? '';
      fonts.push({
        family: (child.fontFamily as string) ?? platformDefaultFont(platform, content),
        style: normalizeFontStyle((child.fontStyle as string) ?? 'Regular'),
      });
      // textStyleName references a style that may use a different font — preload it too
      if (child.textStyleName) {
        const tsInfo = getTextStyleByName(child.textStyleName as string);
        if (tsInfo) {
          fonts.push({
            family: tsInfo.fontFamily,
            style: normalizeFontStyle(tsInfo.fontWeight ?? 'Regular'),
          });
        }
      }
    }
    if (Array.isArray(child.children)) {
      fonts.push(...collectTextFonts(child.children, platform));
    }
  }
  return fonts;
}

async function createInlineChildren(
  parent: FrameNode,
  children: unknown[],
  ctx: CreateContext,
  depth = 0,
): Promise<Array<{ id: string; type: string; name: string }>> {
  if (depth >= MAX_INLINE_DEPTH) {
    ctx.warnings.push(`Max inline children depth (${MAX_INLINE_DEPTH}) reached — deeper children skipped`);
    return [];
  }

  // Batch-preload all text fonts at root level (parallel Promise.all vs serial per-node)
  if (depth === 0) {
    const fonts = collectTextFonts(children, ctx.platform);
    const unique = [...new Map(fonts.map((f) => [`${f.family}:${f.style}`, f])).values()];
    if (unique.length > 0) {
      await Promise.all(unique.map((f) => resolveFontAsync(f.family, f.style)));
    }
  }

  const results: Array<{ id: string; type: string; name: string }> = [];

  for (const [idx, childDef] of children.entries()) {
    const child = { ...(childDef as Record<string, unknown>) };
    const childType = (child.type as string) ?? 'frame';
    const childName = (child.name as string) ?? `child[${idx}]`;
    const childPath = `${parent.name} > ${childName}`;
    let createdNode: SceneNode | undefined;

    try {
      if (childType === 'text') {
        const text = figma.createText();
        await setupText(text, child, ctx);
        insertOrAppend(parent, text, child.index as number | undefined);
        // Smart default: text in vertical AL → FILL width + HEIGHT resize
        inferChildSizing(
          text,
          parent,
          child.layoutSizingHorizontal as string | undefined,
          child.layoutSizingVertical as string | undefined,
          ctx.hints,
          child.width != null,
          child.height != null,
        );
        applySizingOverrides(text, child);
        // Text in vertical auto-layout: default to HEIGHT auto-resize when FILL width
        if (!child.textAutoResize && !child.width && parent.layoutMode === 'VERTICAL') {
          text.textAutoResize = 'HEIGHT';
        }
        createdNode = text;
        results.push({ id: text.id, type: 'TEXT', name: text.name });
      } else if (childType === 'rectangle') {
        const rect = figma.createRectangle();
        const result = await createShapeChild(rect, 'RECTANGLE', 'Rectangle', child, parent, ctx, {
          supportsCornerRadius: true,
        });
        createdNode = rect;
        results.push(result);
      } else if (childType === 'instance') {
        const componentId = child.componentId as string | undefined;
        const componentKey = child.componentKey as string | undefined;
        const componentSetKey = child.componentSetKey as string | undefined;
        assertHandler(
          componentId || componentKey || componentSetKey,
          'instance child requires componentId, componentKey, or componentSetKey',
        );

        const resolved = await importAndResolveComponent({
          componentSetKey,
          componentKey,
          componentId,
          variantProperties: child.variantProperties as Record<string, string> | undefined,
        });
        if (resolved.fallbackWarning)
          ctx.hints.push({
            confidence: 'ambiguous',
            field: 'variantProperties',
            value: child.variantProperties,
            reason: resolved.fallbackWarning,
          });

        const instance = resolved.component.createInstance();
        if (child.name) instance.name = child.name as string;
        if (child.width != null || child.height != null) {
          instance.resize((child.width as number) ?? instance.width, (child.height as number) ?? instance.height);
        }
        // Set component properties
        if (child.properties) {
          const { unmatchedProperties } = setComponentProperties(
            instance,
            child.properties as Record<string, string | boolean>,
          );
          if (unmatchedProperties.length > 0) {
            ctx.hints.push({
              confidence: 'ambiguous' as const,
              field: 'properties',
              value: unmatchedProperties.join(', '),
              reason: `Unmatched component properties (ignored): ${unmatchedProperties.join(', ')}`,
            });
          }
        }
        insertOrAppend(parent, instance, child.index as number | undefined);
        inferChildSizing(
          instance,
          parent,
          child.layoutSizingHorizontal as string | undefined,
          child.layoutSizingVertical as string | undefined,
          ctx.hints,
          child.width != null,
          child.height != null,
        );
        applySizingOverrides(instance, child);
        createdNode = instance;
        results.push({ id: instance.id, type: 'INSTANCE', name: instance.name });
      } else if (childType === 'ellipse') {
        const ellipse = figma.createEllipse();
        const result = await createShapeChild(ellipse, 'ELLIPSE', 'Ellipse', child, parent, ctx);
        createdNode = ellipse;
        results.push(result);
      } else if (childType === 'svg') {
        const svg = child.svg as string;
        assertHandler(svg, 'svg child requires svg parameter');
        const svgNode = figma.createNodeFromSvg(svg);
        svgNode.name = (child.name as string) ?? 'SVG';
        if (child.width != null || child.height != null) {
          svgNode.resize((child.width as number) ?? svgNode.width, (child.height as number) ?? svgNode.height);
        }
        insertOrAppend(parent, svgNode, child.index as number | undefined);
        inferChildSizing(
          svgNode,
          parent,
          child.layoutSizingHorizontal as string | undefined,
          child.layoutSizingVertical as string | undefined,
          ctx.hints,
          child.width != null,
          child.height != null,
        );
        applySizingOverrides(svgNode, child);
        // Apply icon color from _iconMeta (set by MCP Server resolve-icons).
        // Pass ctx.library so name lookup gets library-aware resolution — same
        // path as applyFill/applyStroke. See plan A2.
        if (child._iconMeta && typeof child._iconMeta === 'object') {
          const meta = child._iconMeta as Record<string, unknown>;
          const iconResult = await applyIconColor(
            svgNode,
            meta.fill as string | undefined,
            meta.colorVariableName as string | undefined,
            ctx.library,
          );
          if (iconResult.autoBound) ctx.libraryBindings.push(iconResult.autoBound);
          if (iconResult.colorHint) ctx.warnings.push(iconResult.colorHint);
          if (iconResult.bindingFailure) ctx.tokenBindingFailures.push(iconResult.bindingFailure);
        }
        createdNode = svgNode;
        results.push({ id: svgNode.id, type: 'FRAME', name: svgNode.name });
      } else if (childType === 'star') {
        const star = figma.createStar();
        if (child.pointCount != null) star.pointCount = child.pointCount as number;
        if (child.innerRadius != null) star.innerRadius = child.innerRadius as number;
        const result = await createShapeChild(star, 'STAR', 'Star', child, parent, ctx);
        createdNode = star;
        results.push(result);
      } else if (childType === 'polygon') {
        const polygon = figma.createPolygon();
        if (child.pointCount != null) polygon.pointCount = child.pointCount as number;
        const result = await createShapeChild(polygon, 'POLYGON', 'Polygon', child, parent, ctx);
        createdNode = polygon;
        results.push(result);
      } else {
        // frame type (default)
        const frame = figma.createFrame();
        try {
          await setupFrame(frame, child, ctx, parent.name);
          insertOrAppend(parent, frame, child.index as number | undefined);
          // Smart default sizing
          inferChildSizing(
            frame,
            parent,
            child.layoutSizingHorizontal as string | undefined,
            child.layoutSizingVertical as string | undefined,
            ctx.hints,
            child.width != null,
            child.height != null,
          );
          // Explicit sizing overrides smart defaults (AFTER appendChild)
          applySizingOverrides(frame, child);
          // Recurse into nested children
          if (Array.isArray(child.children) && child.children.length > 0) {
            await createInlineChildren(frame, child.children, ctx, depth + 1);
          }
          createdNode = frame;
          results.push({ id: frame.id, type: 'FRAME', name: frame.name });
        } catch (e) {
          frame.remove();
          throw e;
        }
      }
    } catch (e) {
      // Clean up orphaned node on failure (frame type handles its own cleanup above)
      if (createdNode) {
        try {
          createdNode.remove();
        } catch {
          /* already removed */
        }
      }
      throw e;
    }

    // ── Per-child post-creation: layoutGrow + validation ──
    if (createdNode) {
      // Apply layoutGrow for equal-distribution layouts (e.g. stats columns, card grids)
      if (child.layoutGrow != null) {
        setLayoutGrow(createdNode, child.layoutGrow as number);
      }
      validateChildNode(createdNode, parent, childPath, ctx);
    }
  }

  return results;
}

// ─── Post-creation root frame validation ───
// Checks the ROOT frame itself (not children — those are covered by per-child
// validateChildNode during createInlineChildren). Non-blocking.
function postCreationValidation(frame: FrameNode, warnings: string[]): void {
  try {
    const w = Math.round(frame.width);
    const h = Math.round(frame.height);

    // 1. Abnormal aspect ratio (likely a sizing/layout issue)
    if (h > 0 && w > 0) {
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio > 20) {
        warnings.push(
          `Root frame abnormal aspect ratio (${w}×${h}, ratio ${ratio.toFixed(0)}:1) — likely a sizing issue`,
        );
      }
    }

    // 2. Root frame collapsed
    if (w <= 1 || h <= 1) {
      warnings.push(`Root frame collapsed to ${w}×${h} — check sizing (HUG parent + FILL child?)`);
    }

    // 3. Absolute-layout overflow (only for non-auto-layout roots)
    if (frame.layoutMode === 'NONE' && 'children' in frame) {
      for (const child of frame.children) {
        if ('width' in child && 'height' in child) {
          const cx = (child as any).x ?? 0;
          const cy = (child as any).y ?? 0;
          const cw = (child as any).width as number;
          const ch = (child as any).height as number;
          if (cx + cw > w + 2 || cy + ch > h + 2) {
            warnings.push(
              `Child "${child.name}" (${Math.round(cw)}×${Math.round(ch)}) overflows root (${w}×${h}) in absolute layout`,
            );
          }
        }
      }
    }
  } catch {
    // Validation must never block creation
  }
}

/** Create a single frame with full pipeline (validate → setup → children → lint).
 *  @param skipLint Skip post-creation lint (used in batch mode to defer lint). */
async function createSingleFrame(params: Record<string, unknown>, skipLint = false): Promise<Record<string, unknown>> {
  const rootName = (params.name as string) ?? 'Frame';
  const preValidation = validateParams(params, rootName);

  // ── dryRun: validate + preview inferences without creating nodes ──
  if (params.dryRun) {
    const result: Record<string, unknown> = {
      dryRun: true,
      valid: !preValidation.hasConflict,
    };
    if (preValidation.hasConflict) {
      result.error = preValidation.conflictMessage;
    }
    if (preValidation.inferences.length > 0) {
      result.inferences = preValidation.inferences;
      const hasAmbiguity = preValidation.inferences.some((i) => i.confidence === 'ambiguous');
      if (hasAmbiguity) {
        result.ambiguous = true;
        result.diff = formatDiff(preValidation.inferences);
        result.correctedPayload = buildCorrectedPayload(params, preValidation.inferences);
      }
    }
    return result;
  }

  if (preValidation.hasConflict) {
    throw new Error(preValidation.conflictMessage);
  }

  // ── Two-Path Authoring: branch on access tier for ambiguous inferences ──
  const hasAmbiguousInference = preValidation.inferences.some((i) => i.confidence === 'ambiguous');
  if (hasAmbiguousInference) {
    const canEdit = !!(params._caps as Record<string, unknown> | undefined)?.edit;
    const diff = formatDiff(preValidation.inferences);
    const correctedPayload = buildCorrectedPayload(params, preValidation.inferences);

    if (canEdit) {
      // Edit-tier: auto-stage — create in a staging frame for later commit
      const stageFrame = figma.createFrame();
      stageFrame.name = `[staged] ${rootName}`;
      stageFrame.resize(1, 1);
      stageFrame.visible = false;
      // Store original parentId in plugin data for commit
      if (params.parentId) {
        stageFrame.setPluginData('stageTargetParentId', params.parentId as string);
      }
      stageFrame.setPluginData('stageOriginalParams', JSON.stringify(params));

      try {
        // Build the frame inside the stage container
        const ctx = await initCreateContext();
        const frame = figma.createFrame();
        const p = { ...params };
        await setupFrame(frame, p, ctx);
        stageFrame.appendChild(frame);

        if (Array.isArray(params.children) && params.children.length > 0) {
          await createInlineChildren(frame, params.children as unknown[], ctx);
        }

        return {
          id: stageFrame.id,
          status: 'staged',
          diff,
          correctedPayload,
          _typedHints: [
            { type: 'warn' as const, message: `Ambiguous layout staged — use commit to finalize or discard.` },
          ],
        };
      } catch (e) {
        stageFrame.remove();
        throw e;
      }
    } else {
      // Create-tier: reject with structured learning payload (not thrown)
      return {
        error: 'Ambiguous layout intent — review the diff and re-create with the corrected payload.',
        diff,
        correctedPayload,
      };
    }
  }

  const ctx = await initCreateContext();
  const frame = figma.createFrame();

  try {
    const p = { ...params };
    await setupFrame(frame, p, ctx);

    let parentNode: BaseNode | null = null;
    if (params.parentId) {
      parentNode = await findNodeByIdAsync(params.parentId as string);
      if (parentNode) assertOnCurrentPage(parentNode, params.parentId as string);
      if (parentNode && 'appendChild' in parentNode) {
        (parentNode as FrameNode).appendChild(frame);
      }
    }

    // ── Auto-position: stack below existing siblings in the target container ──
    // Applies in free-layout containers:
    //   - Page root (no parent) — scan currentPage.children, no padding, gap = PAGE_GAP
    //   - SectionNode — scan section.children, padding = SECTION_PADDING, gap = SECTION_GAP
    //   - FRAME/COMPONENT with layoutMode === 'NONE' — page-style (no padding, PAGE_GAP)
    // Skipped when:
    //   - User explicitly provided x or y (respect their intent)
    //   - Parent is auto-layout (HORIZONTAL / VERTICAL / GRID) — Figma positions children
    // Runs AFTER appendChild so frame.parent is correct and frame.y is already in the
    // target container's local coordinate space — no manual coordinate conversion needed.
    if (params.x == null && params.y == null) {
      const container = (parentNode ?? figma.currentPage) as BaseNode & ChildrenMixin;
      const parentLayoutMode =
        parentNode && 'layoutMode' in parentNode
          ? ((parentNode as { layoutMode?: string }).layoutMode ?? 'NONE')
          : 'NONE';
      if (parentLayoutMode === 'NONE' && 'children' in container) {
        if (parentNode?.type === 'SECTION') {
          // Section: padding from edges + gap between siblings, padding == gap.
          // Start maxBottom at SECTION_PADDING so an empty section places the first
          // child at (SECTION_PADDING, SECTION_PADDING) — symmetric visual rhythm.
          let maxBottom = SECTION_PADDING;
          for (const child of container.children) {
            if (child.id === frame.id) continue;
            if (!child.visible) continue;
            maxBottom = Math.max(maxBottom, child.y + child.height + SECTION_GAP);
          }
          frame.x = SECTION_PADDING;
          frame.y = maxBottom;
        } else {
          // Page or NONE frame: no padding, only gap between siblings.
          // Empty container → frame stays at (0, 0) per existing convention.
          let maxBottom = 0;
          for (const child of container.children) {
            if (child.id === frame.id) continue;
            if (!child.visible) continue;
            maxBottom = Math.max(maxBottom, child.y + child.height);
          }
          if (maxBottom > 0) {
            frame.y = maxBottom + PAGE_GAP;
          }
        }
      }
    }

    // Detect platform from screen ancestor for font resolution
    ctx.platform = detectPlatformFromAncestors(frame);
    // Also detect from frame itself if it's a screen
    if (ctx.platform === 'unknown' && params.width != null && params.height != null) {
      ctx.platform = detectPlatformFromDimensions(params.width as number, params.height as number);
    }

    inferChildSizing(
      frame,
      parentNode,
      params.layoutSizingHorizontal as string | undefined,
      params.layoutSizingVertical as string | undefined,
      ctx.hints,
      params.width != null,
      params.height != null,
    );
    applySizingOverrides(frame, params);

    let childResults: Array<{ id: string; type: string; name: string }> | undefined;
    if (Array.isArray(params.children) && params.children.length > 0) {
      childResults = await createInlineChildren(frame, params.children as unknown[], ctx);
    }

    // ── Post-creation structural validation ──
    postCreationValidation(frame, ctx.warnings);

    const result = simplifyNode(frame);
    const out = result as unknown as Record<string, unknown>;
    if (ctx.imageHash) out.imageHash = ctx.imageHash;
    if (ctx.libraryBindings.length > 0) out._libraryBindings = ctx.libraryBindings;
    // _hints removed — _typedHints carries the same info in structured form
    if (ctx.warnings.length > 0) out._warnings = ctx.warnings;
    if (ctx.tokenBindingFailures.length > 0) out._tokenBindingFailures = ctx.tokenBindingFailures;
    if (childResults) out._children = childResults;

    const allInferences: Inference[] = [
      ...preValidation.inferences,
      ...structuredHintsToInferences(ctx.hints, rootName),
    ];
    if (allInferences.length > 0) {
      const ambiguousInferences = allInferences.filter((i) => i.confidence === 'ambiguous');
      // Only include ambiguous inferences in response (deterministic ones are noise)
      if (ambiguousInferences.length > 0) {
        out._inferences = ambiguousInferences;
        out._diff = formatDiff(allInferences);
        out._correctedPayload = buildCorrectedPayload(params, allInferences);
      }
      out._inferenceCount = allInferences.length;

      // ── Inference transparency: show ALL deterministic auto-fixes to AI ──
      // Sources: preValidation inferences + ctx.hints (includes ROLE_DEFAULTS, auto-role, etc.)
      const appliedItems: string[] = [];
      for (const i of allInferences) {
        if (i.confidence === 'deterministic') {
          appliedItems.push(`${i.path}: ${i.field}=${JSON.stringify(i.to)} (${i.reason})`);
        }
      }
      // Also include ctx.hints NOT covered by INFERRED_FIELDS (e.g. role defaults for clipsContent)
      for (const h of ctx.hints) {
        if (h.confidence === 'deterministic' && !INFERRED_FIELDS_SET.has(h.field)) {
          appliedItems.push(`${h.path ?? rootName}: ${h.field}=${JSON.stringify(h.value)} (${h.reason})`);
        }
      }
      if (appliedItems.length > 0) out._applied = appliedItems;
    }

    // Attach typed hints for batch aggregation — cap at 10 most important
    const typedHints: Hint[] = [...structuredHintsToTyped(ctx.hints), ...ctx.typedHints];
    if (ctx.warnings.length > 0) {
      typedHints.push(...ctx.warnings.map((w) => ({ type: 'error' as const, message: w })));
    }
    if (typedHints.length > 0) {
      const priority: Record<string, number> = { error: 0, warn: 1, suggest: 2, confirm: 3 };
      typedHints.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
      const capped = typedHints.slice(0, 10);
      out._typedHints = capped;
      if (typedHints.length > 10) out._typedHintsTruncated = typedHints.length - 10;
    }

    if (!skipLint && childResults && childResults.length > 0) {
      try {
        // Build skipRules from pre-creation inferences to avoid redundant lint checks
        const skipRules = new Set<string>();
        for (const inf of preValidation.inferences) {
          if (inf.field === 'type' && inf.to === 'rectangle') {
            skipRules.add('spacer-frame');
          } else if (inf.field === 'layoutMode') {
            skipRules.add('no-autolayout');
          }
          const mapped = PRE_RULE_TO_LINT_RULE[inf.field];
          if (mapped) {
            if (Array.isArray(mapped)) {
              for (const rule of mapped) skipRules.add(rule);
            } else {
              skipRules.add(mapped);
            }
          }
        }
        const lintSummary = await quickLintSummary(frame.id, true, skipRules.size > 0 ? skipRules : undefined);
        if (lintSummary) out._lintSummary = lintSummary;
      } catch {
        /* lint failure should not block creation */
      }
    }

    // Preview hint: node is auto-focused in Figma viewport; AI can call export_image for visual verification
    if (!skipLint && !params.noPreview) {
      out._previewHint = `Use export_image(nodeId:"${frame.id}", scale:0.5) for visual verification`;
    }

    return out;
  } catch (e) {
    frame.remove();
    throw e;
  }
}

/** Create a single text node with full pipeline. */
async function createSingleText(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = await initCreateContext();
  const text = figma.createText();
  try {
    const p = { ...params };

    // ── Parent append ──
    let parentNode: BaseNode | null = null;
    if (params.parentId) {
      parentNode = await findNodeByIdAsync(params.parentId as string);
      if (parentNode) assertOnCurrentPage(parentNode, params.parentId as string);
      if (parentNode && 'appendChild' in parentNode) {
        (parentNode as FrameNode).appendChild(text);
      }
    }

    // Detect platform from screen ancestor for font resolution
    ctx.platform = detectPlatformFromAncestors(text);

    await setupText(text, p, ctx);

    // ── Smart default sizing (AFTER appendChild) ──
    inferChildSizing(
      text,
      parentNode,
      params.layoutSizingHorizontal as string | undefined,
      params.layoutSizingVertical as string | undefined,
      ctx.hints,
      params.width != null,
      params.height != null,
    );
    applySizingOverrides(text, params);
    if (
      !params.textAutoResize &&
      !params.width &&
      parentNode &&
      'layoutMode' in parentNode &&
      (parentNode as FrameNode).layoutMode === 'VERTICAL'
    ) {
      text.textAutoResize = 'HEIGHT';
    }

    const result = simplifyNode(text);
    const out = result as unknown as Record<string, unknown>;
    if (ctx.libraryBindings.length > 0) out._libraryBindings = ctx.libraryBindings;
    // _hints removed — _typedHints carries the same info
    if (ctx.warnings.length > 0) out._warnings = ctx.warnings;
    if (ctx.tokenBindingFailures.length > 0) out._tokenBindingFailures = ctx.tokenBindingFailures;
    // Attach typed hints for batch aggregation — cap at 10
    const typedHints: Hint[] = [...structuredHintsToTyped(ctx.hints), ...ctx.typedHints];
    if (ctx.warnings.length > 0) {
      typedHints.push(...ctx.warnings.map((w) => ({ type: 'error' as const, message: w })));
    }
    if (typedHints.length > 0) out._typedHints = typedHints;
    return out;
  } catch (e) {
    text.remove();
    throw e;
  }
}

export function registerCreateHandlers(): void {
  registerHandler('create_frame', async (params) => {
    // ── Batch mode: items[] array ──
    if (Array.isArray(params.items)) {
      const items = params.items as Array<Record<string, unknown>>;
      assertHandler(items.length > 0, 'items array must not be empty');
      assertHandler(items.length <= 20, 'Maximum 20 frames per batch');

      // Pre-validate all parentIds before starting batch creation
      const uniqueParentIds = [
        ...new Set(items.map((i) => i.parentId as string | undefined).filter(Boolean)),
      ] as string[];
      for (const pid of uniqueParentIds) {
        const node = await findNodeByIdAsync(pid);
        if (!node) throw new Error(`Batch aborted: parentId "${pid}" not found — no nodes were created`);
        if (!('appendChild' in node))
          throw new Error(`Batch aborted: parentId "${pid}" is not a container — no nodes were created`);
      }

      const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
      const allHints: Hint[] = [];
      const allInferences: Inference[] = [];
      // Aggregate token binding failures across the batch — per-item `out` carries
      // `_tokenBindingFailures` but the `results` array only stores {id,name,ok},
      // so without this loop the failures are silently dropped from the batch
      // response (tokenBindingFailuresRule in core-mcp harness would never see them).
      const allBindingFailures: unknown[] = [];
      const progressId = items.length > 3 ? (params._commandId as string | undefined) : undefined;
      if (progressId) sendBatchProgress(progressId, 0, items.length);
      for (const [idx, item] of items.entries()) {
        try {
          const out = await createSingleFrame(item, true); // skip per-item lint
          results.push({ id: (out as any).id, name: (out as any).name, ok: true });
          // Collect typed hints from per-item results
          if (out._typedHints) {
            allHints.push(...(out._typedHints as Hint[]));
            delete out._typedHints;
          }
          // Collect inferences for aggregated skipRules
          if (out._inferences) {
            allInferences.push(...(out._inferences as Inference[]));
            delete out._inferences;
          }
          // Collect token binding failures — same aggregation pattern as
          // create_component batch mode (see handlers/components/crud.ts).
          if (Array.isArray(out._tokenBindingFailures)) {
            allBindingFailures.push(...(out._tokenBindingFailures as unknown[]));
          }
        } catch (err) {
          results.push({
            id: '',
            name: (item.name as string) ?? 'Frame',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (progressId && (idx + 1) % 3 === 0) sendBatchProgress(progressId, idx + 1, items.length);
      }
      if (progressId) sendBatchProgress(progressId, items.length, items.length);
      // Run lint once for all created frames (instead of per-item)
      const createdIds = results.filter((r) => r.ok && r.id).map((r) => r.id);
      let batchLintSummary: unknown;
      if (createdIds.length > 0) {
        try {
          // Build aggregated skipRules from all items' inferences
          const batchSkipRules = new Set<string>();
          for (const inf of allInferences) {
            if (inf.field === 'type' && inf.to === 'rectangle') batchSkipRules.add('spacer-frame');
            else if (inf.field === 'layoutMode') batchSkipRules.add('no-autolayout');
            const mapped = PRE_RULE_TO_LINT_RULE[inf.field];
            if (mapped) {
              if (Array.isArray(mapped)) {
                for (const rule of mapped) batchSkipRules.add(rule);
              } else {
                batchSkipRules.add(mapped);
              }
            }
          }
          const summaries = await Promise.all(
            createdIds.map((id) => quickLintSummary(id, true, batchSkipRules.size > 0 ? batchSkipRules : undefined)),
          );
          const perItem: Array<{ nodeId: string; violations: number; autoFixed: number }> = [];
          let totalViolations = 0;
          let totalAutoFixed = 0;
          for (let i = 0; i < createdIds.length; i++) {
            const s = summaries[i];
            const v = s?.violations ?? 0;
            const af = (s as any)?.autoFixed ?? 0;
            totalViolations += v;
            totalAutoFixed += af;
            if (v > 0 || af > 0) perItem.push({ nodeId: createdIds[i], violations: v, autoFixed: af });
          }
          if (totalViolations > 0 || totalAutoFixed > 0) {
            batchLintSummary = { violations: totalViolations, autoFixed: totalAutoFixed, perItem };
          }
        } catch {
          /* lint failure should not block batch */
        }
      }
      const batchResult: Record<string, unknown> = {
        created: results.filter((r) => r.ok).length,
        total: items.length,
        items: results,
      };
      if (batchLintSummary) batchResult._lintSummary = batchLintSummary;
      if (allBindingFailures.length > 0) batchResult._tokenBindingFailures = allBindingFailures;
      // Aggregate hints: suppress confirmations, dedup suggest/warn, batch hardcoded colors
      const [, batchLib] = await getCachedModeLibrary();
      const aggregated = aggregateHints(allHints, { isLibraryMode: !!batchLib });
      if (aggregated.length > 0) batchResult.warnings = aggregated;
      return batchResult;
    }

    // ── Single mode (default) ──
    return createSingleFrame(params as Record<string, unknown>);
  });

  registerHandler('create_text', async (params) => {
    // ── Batch mode: items[] array ──
    if (Array.isArray(params.items)) {
      const items = params.items as Array<Record<string, unknown>>;
      assertHandler(items.length > 0, 'items array must not be empty');
      assertHandler(items.length <= 50, 'Maximum 50 text nodes per batch');

      // Pre-validate all parentIds before starting batch creation
      const uniqueParentIds = [
        ...new Set(items.map((i) => i.parentId as string | undefined).filter(Boolean)),
      ] as string[];
      for (const pid of uniqueParentIds) {
        const node = await findNodeByIdAsync(pid);
        if (!node) throw new Error(`Batch aborted: parentId "${pid}" not found — no nodes were created`);
        if (!('appendChild' in node))
          throw new Error(`Batch aborted: parentId "${pid}" is not a container — no nodes were created`);
      }

      const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
      const allHints: Hint[] = [];
      // Same aggregation fix as create_frame batch mode above — without this,
      // per-item token binding failures are dropped before reaching the harness
      // post-enrich rule.
      const allBindingFailures: unknown[] = [];
      const textProgressId = items.length > 3 ? (params._commandId as string | undefined) : undefined;
      if (textProgressId) sendBatchProgress(textProgressId, 0, items.length);
      for (const [idx, item] of items.entries()) {
        try {
          const out = await createSingleText(item);
          results.push({ id: out.id as string, name: out.name as string, ok: true });
          // Collect typed hints
          if (out._typedHints) {
            allHints.push(...(out._typedHints as Hint[]));
            delete out._typedHints;
          }
          if (Array.isArray(out._tokenBindingFailures)) {
            allBindingFailures.push(...(out._tokenBindingFailures as unknown[]));
          }
        } catch (err) {
          results.push({
            id: '',
            name: (item.content as string) ?? (item.name as string) ?? 'Text',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (textProgressId && (idx + 1) % 3 === 0) sendBatchProgress(textProgressId, idx + 1, items.length);
      }
      if (textProgressId) sendBatchProgress(textProgressId, items.length, items.length);
      const batchResult: Record<string, unknown> = {
        created: results.filter((r) => r.ok).length,
        total: items.length,
        items: results,
      };
      if (allBindingFailures.length > 0) batchResult._tokenBindingFailures = allBindingFailures;
      const [, textBatchLib] = await getCachedModeLibrary();
      const aggregated = aggregateHints(allHints, { isLibraryMode: !!textBatchLib });
      if (aggregated.length > 0) batchResult.warnings = aggregated;
      return batchResult;
    }

    // ── Single mode (default) ──
    return createSingleText(params as Record<string, unknown>);
  });
} // registerCreateHandlers
