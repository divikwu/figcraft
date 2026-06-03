/**
 * Shared type definitions used by both MCP Server and Plugin.
 */

// ─── Design Token (DTCG-resolved, sent from MCP Server to Plugin) ───

export interface DesignToken {
  /** Dot-path in DTCG tree, e.g. "color.brand.primary" */
  path: string;
  /** DTCG $type */
  type: DtcgType;
  /** Resolved value (aliases already dereferenced) */
  value: unknown;
  /** DTCG $description */
  description?: string;
  /** Extensions from $extensions */
  extensions?: Record<string, unknown>;
}

export type DtcgType =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'duration'
  | 'cubicBezier'
  | 'number'
  | 'strokeStyle'
  | 'border'
  | 'transition'
  | 'shadow'
  | 'gradient'
  | 'typography'
  | 'boolean'
  | 'string';

// NOTE: Sync types (SyncResult, SyncFailure, TokenDiffEntry) and Lint types
// (LintReport, LintCategory, LintViolation) were removed — they were never
// imported. Lint types live in @figcraft/quality-engine. Sync types are
// inlined where needed.

// ─── Compressed Node ───

export interface CompressedNode {
  id: string;
  name: string;
  type: string;
  role?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  children?: CompressedNode[];
  // Style properties (only included when present)
  fills?: unknown[];
  strokes?: unknown[];
  effects?: unknown[];
  cornerRadius?: number | number[];
  opacity?: number;
  // Layout
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'GRID' | 'NONE';
  layoutPositioning?: 'ABSOLUTE';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  clipsContent?: boolean;
  strokeWeight?: number;
  layoutAlign?: string;
  // GRID layout (layoutMode === 'GRID')
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  // Text
  characters?: string;
  fontSize?: number;
  fontName?: unknown;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  textAutoResize?: string;
  textTruncation?: string;
  maxLines?: number | null;
  overflowDirection?: string;
  // Variable/Style bindings
  boundVariables?: Record<string, unknown>;
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
  fillStyleKey?: string;
  strokeStyleKey?: string;
  textStyleKey?: string;
  effectStyleKey?: string;
  fillStyleRemote?: boolean;
  strokeStyleRemote?: boolean;
  textStyleRemote?: boolean;
  effectStyleRemote?: boolean;
  // Component properties
  componentPropertyDefinitions?: Record<string, { type: string; defaultValue?: unknown; variantOptions?: string[] }>;
  componentPropertyReferences?: Record<string, string>;
  // Lint exclusion: comma-separated rule names or '*' to skip all rules
  lintIgnore?: string;
  // Truncation indicator — set when node tree was cut short by depth/count/time limits
  truncated?: boolean;
  /** Number of direct children omitted due to limits. */
  truncatedChildCount?: number;
}

// NOTE: OperationMode and BatchResult were removed — never imported.
// BatchResult lives in packages/adapter-figma/src/utils/batch.ts.
