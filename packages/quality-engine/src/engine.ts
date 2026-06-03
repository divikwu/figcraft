/**
 * Lint engine — runs rules against abstract nodes, collects violations.
 */

import { classifyInteractive } from './interactive/classifier.js';
import type { InteractiveKind } from './interactive/taxonomy.js';
import { elevationConsistencyRule } from './rules/layout/elevation-consistency.js';
import { elevationHierarchyRule } from './rules/layout/elevation-hierarchy.js';
import { emptyContainerRule } from './rules/layout/empty-container.js';
// Layout
import { maxNestingDepthRule } from './rules/layout/max-nesting-depth.js';
import { mobileDimensionsRule } from './rules/layout/mobile-dimensions.js';
import { noAutolayoutRule } from './rules/layout/no-autolayout.js';
import { overflowParentRule } from './rules/layout/overflow-parent.js';
import { screenBottomOverflowRule } from './rules/layout/screen-bottom-overflow.js';
import { sectionSpacingCollapseRule } from './rules/layout/section-spacing-collapse.js';
import { spacerFrameRule } from './rules/layout/spacer-frame.js';
import { textOverflowRule } from './rules/layout/text-overflow.js';
import { unboundedHugRule } from './rules/layout/unbounded-hug.js';
// Naming
import { defaultNameRule } from './rules/naming/default-name.js';
import { placeholderTextRule } from './rules/naming/placeholder-text.js';
import { foreignStyleRule } from './rules/spec/foreign-style.js';
import { foreignVariableRule } from './rules/spec/foreign-variable.js';
import { hardcodedTokenRule } from './rules/spec/hardcoded-token.js';
import { noTextStyleRule } from './rules/spec/no-text-style.js';
import { specBorderRadiusRule } from './rules/spec/spec-border-radius.js';
// Token / spec compliance
import { specColorRule } from './rules/spec/spec-color.js';
import { specTypographyRule } from './rules/spec/spec-typography.js';
// Structure
import { buttonGhostStructureRule } from './rules/structure/button-ghost-structure.js';
import { buttonIconStructureRule } from './rules/structure/button-icon-structure.js';
import { buttonOutlineStructureRule } from './rules/structure/button-outline-structure.js';
import { buttonSolidStructureRule } from './rules/structure/button-solid-structure.js';
import { buttonTextStructureRule } from './rules/structure/button-text-structure.js';
import { componentBindingsRule } from './rules/structure/component-bindings.js';
import { ctaWidthInconsistentRule } from './rules/structure/cta-width-inconsistent.js';
import { formConsistencyRule } from './rules/structure/form-consistency.js';
import { inputFieldStructureRule } from './rules/structure/input-field-structure.js';
import { linkStandaloneStructureRule } from './rules/structure/link-standalone-structure.js';
import { navOvercrowdedRule } from './rules/structure/nav-overcrowded.js';
import { nestedInteractiveShellRule } from './rules/structure/nested-interactive-shell.js';
import { rootMisclassifiedInteractiveRule } from './rules/structure/root-misclassified-interactive.js';
import { screenShellInvalidRule } from './rules/structure/screen-shell-invalid.js';
import { socialRowCrampedRule } from './rules/structure/social-row-cramped.js';
import { statsRowCrampedRule } from './rules/structure/stats-row-cramped.js';
// WCAG accessibility
import { wcagContrastRule } from './rules/wcag/wcag-contrast.js';
import { wcagLineHeightRule } from './rules/wcag/wcag-line-height.js';
import { wcagNonTextContrastRule } from './rules/wcag/wcag-non-text-contrast.js';
import { wcagTargetSizeRule } from './rules/wcag/wcag-target-size.js';
import { wcagTextSizeRule } from './rules/wcag/wcag-text-size.js';
import { getRuleFrequencyOrder, recordInteractiveClassification } from './stats.js';
import type {
  AbstractNode,
  LintContext,
  LintRule,
  LintCategory as LintRuleCategory,
  LintSeverity,
  LintViolation,
  RuleAI,
} from './types.js';
import { getContextSeverity, SEVERITY_ORDER } from './types.js';
import { isVisibleSolidPaint, resolveSolidPaintHex } from './utils/paint.js';

// NOTE: Rules with `suppressesInSubtree` must appear BEFORE the rules they
// suppress so that same-node suppression works. Cascade-parent rules go first.
const ALL_RULES: LintRule[] = [
  // ── Cascade-parent rules (run first so suppression takes effect) ──
  screenShellInvalidRule, // suppresses layout + header + overflow rules in subtree
  rootMisclassifiedInteractiveRule, // suppresses button/input structure in subtree
  nestedInteractiveShellRule, // suppresses button/input structure in subtree
  noAutolayoutRule, // suppresses overflow-parent + unbounded-hug in subtree
  // ── Token compliance (require tokens/library to activate) ──
  specColorRule,
  specTypographyRule,
  specBorderRadiusRule,
  hardcodedTokenRule,
  noTextStyleRule,
  foreignStyleRule,
  foreignVariableRule,
  // ── WCAG accessibility (always active) ──
  wcagContrastRule,
  wcagTargetSizeRule,
  wcagTextSizeRule,
  wcagLineHeightRule,
  wcagNonTextContrastRule,
  // ── Layout structure (always active) ──
  emptyContainerRule,
  spacerFrameRule,
  maxNestingDepthRule,
  // ── Variant-aware interactive rules (classifier-driven) ──
  buttonSolidStructureRule,
  buttonOutlineStructureRule,
  buttonGhostStructureRule,
  buttonTextStructureRule,
  buttonIconStructureRule,
  linkStandaloneStructureRule,
  textOverflowRule,
  formConsistencyRule,
  ctaWidthInconsistentRule,
  overflowParentRule,
  unboundedHugRule,
  sectionSpacingCollapseRule,
  screenBottomOverflowRule,
  socialRowCrampedRule,
  navOvercrowdedRule,
  statsRowCrampedRule,
  inputFieldStructureRule,
  mobileDimensionsRule,
  elevationConsistencyRule,
  elevationHierarchyRule,
  // ── Naming (always active) ──
  defaultNameRule,
  placeholderTextRule,
  // ── Component (always active) ──
  componentBindingsRule,
];

export interface LintOptions {
  rules?: string[];
  categories?: LintRuleCategory[];
  offset?: number;
  limit?: number;
  /** Maximum violations to collect before stopping (early-exit for large pages). */
  maxViolations?: number;
  /** Minimum severity to include in results (default: all). */
  minSeverity?: LintSeverity;
  /** Rule names to skip (used to avoid re-checking rules already handled by pre-creation validation). */
  skipRules?: Set<string>;
}

export interface LintReport {
  summary: {
    total: number;
    pass: number;
    violations: number;
    truncated?: boolean;
    bySeverity: Record<LintSeverity, number>;
  };
  categories: Array<{
    rule: string;
    description: string;
    count: number;
    nodes: LintViolation[];
  }>;
  pagination?: { total: number; offset: number; limit: number; hasMore: boolean };
}

/** Extract the topmost visible solid fill hex color from a node (for background propagation). */
function extractSolidFillHex(node: AbstractNode, inheritedBg?: string): string | undefined {
  if (!node.fills) return undefined;
  for (let i = node.fills.length - 1; i >= 0; i--) {
    const fill = node.fills[i];
    if (isVisibleSolidPaint(fill)) return resolveSolidPaintHex(fill, inheritedBg);
  }
  return undefined;
}

/**
 * True when the node's topmost visible fill is a complex type (IMAGE, VIDEO,
 * GRADIENT_*) — meaning any text layered on this node sits over an image,
 * video, or gradient backdrop whose numeric contrast can't be reliably
 * computed without pixel sampling. Figma's `fills[]` is bottom-to-top, so
 * the last visible entry is what users see.
 */
function topmostFillIsComplex(node: AbstractNode): boolean {
  if (!node.fills || node.fills.length === 0) return false;
  // fills[] is bottom-to-top. Find the topmost visible fill.
  for (let i = node.fills.length - 1; i >= 0; i--) {
    const f = node.fills[i];
    if (f.visible === false) continue;
    const t = f.type;
    return (
      t === 'IMAGE' ||
      t === 'VIDEO' ||
      t === 'GRADIENT_LINEAR' ||
      t === 'GRADIENT_RADIAL' ||
      t === 'GRADIENT_ANGULAR' ||
      t === 'GRADIENT_DIAMOND'
    );
  }
  return false;
}

/** Heuristic: is this node a screen root? */
const SCREEN_NAME_RE =
  /welcome|sign.?in|sign.?up|forgot\s+password|create\s+account|screen|page|onboarding|settings|profile|dashboard|checkout|pricing|empty\s+state|home|landing|detail|list/i;

/**
 * Detect platform classification for a screen-like node.
 * Returns undefined if this isn't a screen root (let inherited value stick).
 * Mobile: width ≤ 500 (covers 375/390/402/412/430 common mobile widths).
 * Desktop: width > 500 (covers tablet/web/desktop).
 */
function detectPlatform(node: AbstractNode): 'mobile' | 'desktop' | undefined {
  const isScreenLike =
    node.role === 'screen' || node.role === 'page' || (SCREEN_NAME_RE.test(node.name) && (node.width ?? 0) >= 300);
  if (!isScreenLike) return undefined;
  if (node.width == null) return undefined;
  return node.width <= 500 ? 'mobile' : 'desktop';
}

/** Run lint rules on a flat list of abstract nodes. */
export function runLint(nodes: AbstractNode[], ctx: LintContext, options: LintOptions = {}): LintReport {
  let activeRules = ALL_RULES;

  if (options.categories) {
    activeRules = activeRules.filter((r) => options.categories!.includes(r.category));
  }
  if (options.rules) {
    activeRules = activeRules.filter((r) => options.rules!.includes(r.name));
  }
  if (options.skipRules && options.skipRules.size > 0) {
    activeRules = activeRules.filter((r) => !options.skipRules!.has(r.name));
  }

  // Token rules require an authoritative source (DTCG tokens or Figma library).
  // Without a source, the rules produce no meaningful signal — filter them out
  // entirely rather than downgrading severity (cleaner UX, rules won't appear
  // in the category breakdown at all).
  const hasTokens =
    ctx.colorTokens.size > 0 ||
    ctx.spacingTokens.size > 0 ||
    ctx.radiusTokens.size > 0 ||
    ctx.typographyTokens.size > 0;
  const hasLibrary = ctx.mode === 'library' && !!ctx.selectedLibrary;
  const hasTokenSource = hasTokens || hasLibrary;
  if (!hasTokenSource) {
    activeRules = activeRules.filter((r) => r.category !== 'token');
  }

  // Severity filter (5-level: error=0, unsafe=1, heuristic=2, style=3, verbose=4)
  const SEVERITY_RANK: Record<LintSeverity, number> = { error: 0, unsafe: 1, heuristic: 2, style: 3, verbose: 4 };
  const minRank = options.minSeverity ? SEVERITY_RANK[options.minSeverity] : 3; // default: up to 'style' (excludes verbose)

  const allViolations: LintViolation[] = [];
  const maxV = options.maxViolations ?? Infinity;
  let earlyExit = false;
  // Cascade suppression: stack of suppressed rule names for the current subtree.
  // When a rule with `suppressesInSubtree` fires on a node, its target rules are
  // added to the suppression frame for that node's descendants, then removed on
  // the way back up.
  const suppressionStack: Array<Set<string>> = [];
  const isCurrentlySuppressed = (ruleName: string): boolean => {
    for (const frame of suppressionStack) if (frame.has(ruleName)) return true;
    return false;
  };

  function walk(node: AbstractNode, parentInteractiveKind?: InteractiveKind) {
    if (earlyExit) return;
    // Hidden nodes (and their entire subtree) are skipped — designers hide layers
    // as reference / alternate states; linting them produces noise on intentionally
    // invisible content.
    if (node.visible === false) return;
    // Classify interactive kind once per node (memoize on node.interactive).
    // Phase 0: telemetry only — no existing rule consumes node.interactive yet.
    // Declared meta short-circuits inside the classifier.
    if (!node.interactive || node.interactive.declared !== true) {
      const result = classifyInteractive(node, parentInteractiveKind);
      if (result.kind) {
        node.interactive = {
          kind: result.kind,
          state: result.state,
          variant: result.variant,
          confidence: result.confidence,
          signals: result.signals,
          declared: false,
        };
      } else {
        // Record the null classification for telemetry without mutating node.interactive
        recordInteractiveClassification(null, result.confidence, false, result.signals);
      }
    }
    if (node.interactive) {
      recordInteractiveClassification(
        node.interactive.kind,
        node.interactive.confidence,
        node.interactive.declared === true,
        node.interactive.signals,
      );
    }
    // Node-level lint exclusion via lintIgnore field. Syntax supports:
    //  - '*'              — skip all rules
    //  - exact rule name  — e.g. 'button-solid-structure'
    //  - wildcard prefix  — e.g. 'button-*' matches any rule name starting with 'button-'
    const ignoreAll = node.lintIgnore === '*';
    const ignoreEntries =
      !ignoreAll && node.lintIgnore
        ? node.lintIgnore
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const ignoreExact = ignoreEntries ? new Set(ignoreEntries.filter((e) => !e.endsWith('*'))) : undefined;
    const ignorePrefixes = ignoreEntries
      ? ignoreEntries.filter((e) => e.endsWith('*')).map((e) => e.slice(0, -1))
      : undefined;
    const matchesIgnore = (ruleName: string): boolean => {
      if (ignoreExact?.has(ruleName)) return true;
      if (ignorePrefixes?.some((p) => ruleName.startsWith(p))) return true;
      return false;
    };
    // Suppressions collected at this node — apply to descendants and also to
    // later rules evaluated on this same node (cascade-parent must run first
    // in activeRules order for same-node suppression to take effect).
    const subtreeSuppressions = new Set<string>();
    for (const rule of activeRules) {
      if (ignoreAll || matchesIgnore(rule.name)) continue;
      if (isCurrentlySuppressed(rule.name) || subtreeSuppressions.has(rule.name)) continue;
      const violations = rule.check(node, ctx);
      for (const v of violations) {
        // Context-aware severity: leaf nodes and small nodes get downgraded
        const contextSev = getContextSeverity(v.severity, node);
        if (contextSev !== v.severity) {
          if (!v.baseSeverity) v.baseSeverity = v.severity;
          v.severity = contextSev;
        }
        // Generate fix descriptor from rule, then derive fixCall
        if (v.autoFixable && !v.fixDescriptor && rule.describeFix) {
          v.fixDescriptor = rule.describeFix(v) ?? undefined;
        }
        if (v.autoFixable && !v.fixCall && v.fixDescriptor) {
          v.fixCall = generateFixCallFromDescriptor(v);
        }
        // Filter by minimum severity
        if (SEVERITY_RANK[v.severity] <= minRank) {
          allViolations.push(v);
        }
      }
      // If this rule fired and declares subtree suppressions, stage them for children
      if (violations.length > 0 && rule.suppressesInSubtree?.length) {
        for (const name of rule.suppressesInSubtree) subtreeSuppressions.add(name);
      }
      if (allViolations.length >= maxV) {
        earlyExit = true;
        return;
      }
    }
    if (node.children) {
      // Propagate background color to children for WCAG contrast checks.
      // The nearest ancestor with a visible solid fill is the effective background.
      const nodeBg = extractSolidFillHex(node, node.parentBgColor);
      const effectiveBg = nodeBg ?? node.parentBgColor;
      // Propagate parent width for text overflow checks.
      const effectiveWidth = node.width ?? node.parentWidth;
      // Propagate parent layout mode for text overflow fix strategy.
      const effectiveLayoutMode = node.layoutMode ?? node.parentLayoutMode;
      // Propagate parent itemSpacing for WCAG 2.5.8 spacing-exception.
      // Only propagate one level (direct parent, and only when parent is auto-layout)
      // — siblings-of-siblings / ABSOLUTE parents don't have a consistent sibling gap.
      const effectiveItemSpacing = node.layoutMode ? node.itemSpacing : undefined;
      // Propagate per-mode background colors for dark mode contrast checks.
      const effectiveBgModes = node.variableModeColors ?? node.parentBgModeColors;
      // Propagate platform from screen-like ancestors (sticky — inherited wins).
      // Used by platform-aware rules (e.g. wcag-text-size: 10px mobile vs 12px desktop).
      const effectivePlatform = node.platform ?? detectPlatform(node);
      // Mark descendants of COMPONENT/INSTANCE. Token-binding / spec-compliance
      // rules use this to skip internal leaves — binding belongs at the
      // component boundary, not on every vector inside.
      const nextInsideComponent =
        node.insideComponentSubtree === true || node.type === 'COMPONENT' || node.type === 'INSTANCE';
      // Mark descendants that sit over a complex (non-SOLID) backdrop. Drives
      // contrast-rule skips when the actual rendered background is an image /
      // video / gradient whose pixel-level contrast can't be computed.
      const parentIsComplex = topmostFillIsComplex(node);
      const overComplexBase = node.overComplexBg === true || parentIsComplex;
      let earlierSiblingIsComplex = false;
      const hasSuppressions = subtreeSuppressions.size > 0;
      if (hasSuppressions) suppressionStack.push(subtreeSuppressions);
      for (const child of node.children) {
        if (earlyExit) break;
        if (effectiveBg) child.parentBgColor = effectiveBg;
        if (effectiveBgModes) child.parentBgModeColors = effectiveBgModes;
        if (effectiveWidth != null) child.parentWidth = effectiveWidth;
        if (effectiveLayoutMode) child.parentLayoutMode = effectiveLayoutMode;
        if (effectiveItemSpacing != null) child.parentItemSpacing = effectiveItemSpacing;
        if (effectivePlatform) child.platform = effectivePlatform;
        if (nextInsideComponent) child.insideComponentSubtree = true;
        if (overComplexBase || earlierSiblingIsComplex) child.overComplexBg = true;
        walk(child, node.interactive?.kind);
        // Earlier-sibling rule: children are drawn bottom-to-top in children
        // array order. A later child sits VISUALLY on top of earlier children,
        // so an earlier sibling with a complex fill becomes the backdrop for
        // later siblings at this parent level.
        if (topmostFillIsComplex(child)) earlierSiblingIsComplex = true;
      }
      if (hasSuppressions) suppressionStack.pop();
    }
  }

  for (const node of nodes) {
    walk(node);
  }

  // Group by rule
  const byRule = new Map<string, LintViolation[]>();
  for (const v of allViolations) {
    const existing = byRule.get(v.rule) ?? [];
    existing.push(v);
    byRule.set(v.rule, existing);
  }

  const categories = activeRules
    .filter((r) => byRule.has(r.name))
    .map((r) => ({
      rule: r.name,
      description: r.description,
      count: byRule.get(r.name)!.length,
      nodes: byRule.get(r.name)!,
    }));

  const totalViolations = allViolations.length;

  // Apply pagination
  const offset = options.offset ?? 0;
  const limit = options.limit ?? totalViolations;
  let paginatedCategories = categories;
  let pagination: LintReport['pagination'];

  if (options.offset !== undefined || options.limit !== undefined) {
    // Flatten, paginate, then regroup
    const sliced = allViolations.slice(offset, offset + limit);
    const slicedByRule = new Map<string, LintViolation[]>();
    for (const v of sliced) {
      const existing = slicedByRule.get(v.rule) ?? [];
      existing.push(v);
      slicedByRule.set(v.rule, existing);
    }
    paginatedCategories = activeRules
      .filter((r) => slicedByRule.has(r.name))
      .map((r) => ({
        rule: r.name,
        description: r.description,
        count: slicedByRule.get(r.name)!.length,
        nodes: slicedByRule.get(r.name)!,
      }));
    pagination = {
      total: totalViolations,
      offset,
      limit,
      hasMore: offset + limit < totalViolations,
    };
  }

  // Count total nodes checked (approximate by counting unique nodeIds)
  const checkedNodeIds = new Set<string>();
  function countNodes(node: AbstractNode) {
    checkedNodeIds.add(node.id);
    node.children?.forEach(countNodes);
  }
  nodes.forEach(countNodes);

  // Count violations by severity
  const bySeverity: Record<LintSeverity, number> = { error: 0, unsafe: 0, heuristic: 0, style: 0, verbose: 0 };
  for (const v of allViolations) {
    bySeverity[v.severity]++;
  }

  return {
    summary: {
      total: checkedNodeIds.size,
      pass: checkedNodeIds.size - new Set(allViolations.map((v) => v.nodeId)).size,
      violations: totalViolations,
      bySeverity,
      ...(earlyExit ? { truncated: true } : {}),
    },
    categories: paginatedCategories,
    pagination,
  };
}

/**
 * Derive a fixCall from a FixDescriptor (new system).
 * Covers all descriptor kinds mechanically — no per-rule switch needed.
 */
function generateFixCallFromDescriptor(v: LintViolation): LintViolation['fixCall'] {
  const desc = v.fixDescriptor;
  if (!desc) return undefined;
  const nodeId = v.nodeId;
  switch (desc.kind) {
    case 'set-properties':
      return { tool: 'nodes', params: { method: 'update', nodeId, props: desc.props } };
    case 'resize':
      return {
        tool: 'nodes',
        params: {
          method: 'update',
          nodeId,
          props: {
            ...(desc.width != null ? { width: desc.width } : {}),
            ...(desc.height != null ? { height: desc.height } : {}),
          },
        },
      };
    case 'remove-and-redistribute':
      return { tool: 'nodes', params: { method: 'delete', nodeId } };
    case 'deferred':
      return undefined;
  }
}

/** Get all available rule names with optional AI metadata. */
export function getAvailableRules(): Array<{
  name: string;
  description: string;
  category: string;
  severity: string;
  autoFixable: boolean;
  ai?: RuleAI;
}> {
  return ALL_RULES.map((r) => ({
    name: r.name,
    description: r.description,
    category: r.category,
    severity: r.severity,
    autoFixable: !!r.describeFix,
    ...(r.ai ? { ai: r.ai } : {}),
  }));
}

/**
 * Generate a prevention checklist from rule AI metadata.
 * Returns an array of preventionHint strings, filtered by phase/tags/severity.
 * Used by the prompt system to derive self-review checklists from rules.
 */
export function getPreventionChecklist(options?: {
  phases?: string[];
  tags?: string[];
  minSeverity?: LintSeverity;
  /** Sort by violation frequency (most frequent first). Requires session stats from recordLintRun(). */
  sortBy?: 'frequency';
}): string[] {
  const maxIdx = options?.minSeverity ? SEVERITY_ORDER.indexOf(options.minSeverity) : SEVERITY_ORDER.indexOf('style'); // default: up to style

  const filtered = ALL_RULES.filter((r) => {
    if (!r.ai?.preventionHint) return false;
    // Severity filter
    if (SEVERITY_ORDER.indexOf(r.severity) > maxIdx) return false;
    // Phase filter
    if (options?.phases?.length && r.ai.phase) {
      if (!r.ai.phase.some((p) => options.phases!.includes(p))) return false;
    }
    // Tag filter
    if (options?.tags?.length && r.ai.tags) {
      if (!r.ai.tags.some((t) => options.tags!.includes(t))) return false;
    }
    return true;
  });

  // Sort by violation frequency if requested (high-frequency rules first)
  if (options?.sortBy === 'frequency') {
    const freqOrder = getRuleFrequencyOrder();
    const freqMap = new Map(freqOrder.map((name, idx) => [name, idx]));
    filtered.sort((a, b) => {
      const aIdx = freqMap.get(a.name) ?? Infinity;
      const bIdx = freqMap.get(b.name) ?? Infinity;
      return aIdx - bIdx;
    });
  }

  return filtered.map((r) => r.ai!.preventionHint);
}

// ─── Preflight audit ───

/**
 * Map lint violations to designPreflight categories.
 * Returns a compact audit object showing pass/warn/fail per category.
 */
export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface PreflightAudit {
  colorConsistency: PreflightStatus;
  typographyBound: PreflightStatus;
  semanticNaming: PreflightStatus;
  touchTargets: PreflightStatus;
  contentRealistic: PreflightStatus;
  emptyContainers: PreflightStatus;
}

const PREFLIGHT_RULE_MAP: Record<keyof PreflightAudit, string[]> = {
  colorConsistency: ['hardcoded-token', 'spec-color', 'foreign-style', 'foreign-variable'],
  typographyBound: ['no-text-style', 'spec-typography', 'foreign-style'],
  semanticNaming: ['default-name'],
  touchTargets: [
    'wcag-target-size',
    'button-solid-structure',
    'button-outline-structure',
    'button-ghost-structure',
    'button-text-structure',
    'button-icon-structure',
  ],
  contentRealistic: ['placeholder-text'],
  emptyContainers: ['empty-container'],
};

/**
 * Audit a lint report against designPreflight categories.
 * @param violationsByRule Map of rule name → violation count
 */
export function auditPreflightCompliance(violationsByRule: Map<string, number>): PreflightAudit {
  const audit: PreflightAudit = {
    colorConsistency: 'pass',
    typographyBound: 'pass',
    semanticNaming: 'pass',
    touchTargets: 'pass',
    contentRealistic: 'unknown',
    emptyContainers: 'pass',
  };

  for (const [category, rules] of Object.entries(PREFLIGHT_RULE_MAP)) {
    if (rules.length === 0) continue; // unknown categories stay unknown
    const totalViolations = rules.reduce((sum, r) => sum + (violationsByRule.get(r) ?? 0), 0);
    if (totalViolations === 0) {
      (audit as unknown as Record<string, PreflightStatus>)[category] = 'pass';
    } else if (totalViolations <= 2) {
      (audit as unknown as Record<string, PreflightStatus>)[category] = 'warn';
    } else {
      (audit as unknown as Record<string, PreflightStatus>)[category] = 'fail';
    }
  }

  return audit;
}
