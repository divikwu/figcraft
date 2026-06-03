/**
 * Lint engine types — abstract node, rules, violations.
 */

import type { InteractiveMeta } from './interactive/taxonomy.js';

/** Supported UI languages for violation messages. */
export type Lang = 'en' | 'zh';

/** Pick localized message by language (defaults to English when unset). */
export function tr(lang: Lang | undefined, en: string, zh: string): string {
  return lang === 'zh' ? zh : en;
}

/** Simplified node for lint analysis (decoupled from Figma API). */
export interface AbstractNode {
  id: string;
  name: string;
  type: string;
  role?: string;
  // Style values
  fills?: Array<{
    type: string;
    color?: string;
    opacity?: number;
    visible?: boolean;
    /** Per-paint variable bindings. Modern Figma API binds the color on the paint itself. */
    boundVariables?: { color?: { type: string; id: string } };
  }>;
  strokes?: Array<{
    type: string;
    color?: string;
    opacity?: number;
    visible?: boolean;
    boundVariables?: { color?: { type: string; id: string } };
  }>;
  cornerRadius?: number | number[];
  fontSize?: number;
  fontName?: { family: string; style: string };
  lineHeight?: unknown;
  letterSpacing?: unknown;
  opacity?: number;
  width?: number;
  height?: number;
  // Layout
  layoutMode?: string;
  layoutPositioning?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  // Position
  x?: number;
  y?: number;
  // Text content
  characters?: string;
  // Bindings
  boundVariables?: Record<string, unknown>;
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
  /** Stable Figma style keys, when the source adapter can resolve them from style IDs. */
  fillStyleKey?: string;
  strokeStyleKey?: string;
  textStyleKey?: string;
  effectStyleKey?: string;
  /** Whether the applied style is imported from a library. */
  fillStyleRemote?: boolean;
  strokeStyleRemote?: boolean;
  textStyleRemote?: boolean;
  effectStyleRemote?: boolean;
  // Effects (shadows, blurs) — used for elevation consistency checks
  effects?: Array<{
    type: string; // DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR
    visible?: boolean;
    radius?: number;
    spread?: number;
    offset?: { x: number; y: number };
    color?: string; // hex
    opacity?: number;
  }>;
  // Component
  componentPropertyDefinitions?: Record<string, { type: string; defaultValue?: unknown; variantOptions?: string[] }>;
  componentPropertyReferences?: Record<string, string>;
  // Layout alignment
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  clipsContent?: boolean;
  strokeWeight?: number;
  layoutAlign?: string;
  /** Prototype scroll direction: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH'. Declares intentional overflow. */
  overflowDirection?: string;
  // Text layout
  textAutoResize?: string;
  /** 'DISABLED' | 'ENDING' — ENDING means the designer explicitly opted into truncation. */
  textTruncation?: string;
  maxLines?: number | null;
  // Children
  children?: AbstractNode[];
  // Parent background color (hex, propagated during lint traversal for contrast checks)
  parentBgColor?: string;
  /**
   * Per-mode resolved colors for bound color variables.
   * Keyed by mode name (e.g. "Light", "Dark"), value is hex color.
   * Used by wcag-contrast to check contrast in all modes, not just the current one.
   * Only populated when the node's fill/text color is bound to a mode-aware variable.
   */
  variableModeColors?: Record<string, string>;
  /** Per-mode resolved colors for the parent background variable. */
  parentBgModeColors?: Record<string, string>;
  // Parent width (propagated during lint traversal for overflow checks)
  parentWidth?: number;
  // Parent layout mode (propagated during lint traversal for overflow fix strategy)
  parentLayoutMode?: string;
  // Parent itemSpacing (propagated during lint traversal for WCAG 2.5.8 spacing-exception)
  parentItemSpacing?: number;
  // Lint exclusion: comma-separated rule names or '*' to skip all rules
  lintIgnore?: string;
  /** Interactive classification (populated by classifier before rule execution). */
  interactive?: InteractiveMeta;
  /** True if the node sits inside a COMPONENT/INSTANCE subtree — propagated by engine. */
  insideComponentSubtree?: boolean;
  /** Detected platform ('ios' | 'android' | 'web' | 'mobile' | 'desktop'), propagated from screen-like ancestors. */
  platform?: string;
  /** Prototype reactions (hover / click / pressed). Populated when available from the source. */
  reactions?: unknown[];
  /** True if this node is drawn over a non-SOLID (image/video/gradient) backdrop — propagated by engine. */
  overComplexBg?: boolean;
  /** Visibility flag — false means hidden (skipped by lint traversal). */
  visible?: boolean;
}

export interface LintContext {
  /** Available color tokens (hex values). */
  colorTokens: Map<string, string>;
  /** Available spacing tokens (numeric values). */
  spacingTokens: Map<string, number>;
  /** Available radius tokens (numeric values). */
  radiusTokens: Map<string, number>;
  /** Available typography tokens. */
  typographyTokens: Map<string, { fontSize?: number; fontFamily?: string; fontWeight?: string }>;
  /** Variable ID map for auto-fix (token name → variable ID). */
  variableIds: Map<string, string>;
  /** Current operation mode. */
  mode?: 'library' | 'spec';
  /** Selected library name (only relevant in library mode). */
  selectedLibrary?: string | null;
  /** UI language for violation messages ('en' | 'zh', default 'en'). */
  lang?: Lang;
  /**
   * Set of style IDs belonging to the selected library (or local file).
   * Used by foreign-style rule to detect cross-library style references.
   * When empty/undefined, foreign-style rule is skipped.
   */
  libraryStyleIds?: Set<string>;
  /**
   * Stable style keys belonging to the selected library.
   * Used with libraryStyleIds because Figma style IDs are document-local.
   */
  libraryStyleKeys?: Set<string>;
  /**
   * Set of variable IDs belonging to the selected library (or local file).
   * Used by foreign-variable rule to detect cross-library variable references.
   * When empty/undefined, foreign-variable rule is skipped.
   */
  libraryVariableIds?: Set<string>;
}

/**
 * 5-level severity system:
 * - error:     breakage that must be fixed (component binding errors)
 * - unsafe:    layout issues that cause visual bugs (overflow, unbounded HUG)
 * - heuristic: best-practice violations detected by tooling (hardcoded tokens, no auto-layout)
 * - style:     cosmetic / naming preferences (empty container, default name)
 * - verbose:   WCAG AAA & enhancement checks (excluded by default)
 */
export type LintSeverity = 'error' | 'unsafe' | 'heuristic' | 'style' | 'verbose';
export type LintCategory = 'token' | 'layout' | 'naming' | 'wcag' | 'component';

/** Severity ordering from most to least severe (used for downgrade logic). */
export const SEVERITY_ORDER: readonly LintSeverity[] = ['error', 'unsafe', 'heuristic', 'style', 'verbose'] as const;

/**
 * Downgrade a severity by one level.
 * error → unsafe, unsafe → heuristic, heuristic → style, style → verbose, verbose → verbose (floor).
 */
export function downgradeSeverity(severity: LintSeverity): LintSeverity {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)];
}

/** Node types that are always considered leaf (no meaningful children). */
const LEAF_TYPES = new Set(['TEXT', 'VECTOR', 'LINE', 'ELLIPSE', 'RECTANGLE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);

/** Check if a node is a leaf (no children or inherently childless type). */
export function isLeafNode(node: AbstractNode): boolean {
  if (LEAF_TYPES.has(node.type)) return true;
  return !node.children || node.children.length === 0;
}

/** Check if a node is small (width or height < 48px). */
export function isSmallNode(node: AbstractNode): boolean {
  return (node.width != null && node.width < 48) || (node.height != null && node.height < 48);
}

/**
 * Compute context-aware severity for a violation.
 * Leaf nodes and small nodes get downgraded by one level to reduce noise.
 */
export function getContextSeverity(baseSeverity: LintSeverity, node: AbstractNode): LintSeverity {
  if (isLeafNode(node) || isSmallNode(node)) {
    return downgradeSeverity(baseSeverity);
  }
  return baseSeverity;
}

/**
 * Declarative fix descriptor — tells the adapter WHAT to fix,
 * not HOW (no Figma API references). Lives in quality-engine to keep it pure.
 */
export type FixDescriptor =
  | { kind: 'set-properties'; props: Record<string, unknown>; requireType?: string[]; requireFontLoad?: boolean }
  | { kind: 'resize'; width?: number; height?: number; minHeight?: number; requireType?: string[] }
  | { kind: 'remove-and-redistribute'; dimension: { width?: number; height?: number } }
  | { kind: 'deferred'; strategy: string; data: Record<string, unknown> };

export interface LintViolation {
  nodeId: string;
  nodeName: string;
  rule: string;
  severity: LintSeverity;
  /** Original severity before context downgrade (omitted when no downgrade occurred). */
  baseSeverity?: LintSeverity;
  currentValue: unknown;
  expectedValue?: unknown;
  suggestion: string;
  autoFixable: boolean;
  /** Fix data for auto-fix handler. */
  fixData?: Record<string, unknown>;
  /** Declarative fix descriptor (new system — co-located with rule). */
  fixDescriptor?: FixDescriptor;
  /** Structured fix call that can be directly executed by the AI agent. */
  fixCall?: { tool: string; params: Record<string, unknown> };
}

/** AI knowledge metadata — tells AI how to prevent violations, not just detect them. */
export interface RuleAI {
  /** One-line instruction for AI: how to avoid triggering this rule during creation. */
  preventionHint: string;
  /** Design phases this rule applies to (for prompt filtering). */
  phase?: Array<'layout' | 'structure' | 'content' | 'styling' | 'accessibility'>;
  /** Semantic tags for element-type queries (e.g. 'button', 'input', 'screen'). */
  tags?: string[];
}

export interface LintRule {
  name: string;
  description: string;
  category: LintCategory;
  severity: LintSeverity;
  check(node: AbstractNode, ctx: LintContext): LintViolation[];
  /** Produce a declarative fix descriptor for a violation. Co-located with the rule. */
  describeFix?(violation: LintViolation): FixDescriptor | null;
  /** AI knowledge layer — tells AI how to prevent this violation. */
  ai?: RuleAI;
  /**
   * When this rule fires on a node, suppress the named rules on that node and
   * all its descendants. Used by cascade-parent rules (e.g. screen-shell-invalid
   * suppresses layout rules in its subtree — no point flagging inner layout
   * when the shell itself is wrong). Must run BEFORE the suppressed rules.
   */
  suppressesInSubtree?: string[];
}

/** LintRule that MUST implement describeFix — use for compile-time guarantee on fixable rules. */
export interface FixableLintRule extends LintRule {
  describeFix(violation: LintViolation): FixDescriptor | null;
}

/** Define a fixable rule with compile-time enforcement of describeFix. */
export function defineFixableRule(rule: FixableLintRule): FixableLintRule {
  return rule;
}
