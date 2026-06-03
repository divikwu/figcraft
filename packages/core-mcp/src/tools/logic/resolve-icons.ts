/**
 * Resolve icon children in create_frame params.
 *
 * Recursively walks the children/items tree, collects all {type: "icon"} nodes,
 * fetches their SVGs in parallel (deduped by icon@size), and replaces them
 * in-place with {type: "svg", svg, _iconMeta: {fill, colorVariableName}}.
 *
 * Runs in MCP Server (has network access). Plugin side handles _iconMeta
 * for color application after SVG node creation.
 */

import { fetchIconSvg } from '../iconify.js';

export interface IconWarning {
  icon: string;
  error: string;
}

/**
 * Resolve all icon children in a create_frame params object.
 * Mutates the params in-place, replacing icon children with svg children.
 * Returns warnings for any icons that failed to fetch.
 */
export async function resolveIconChildren(params: Record<string, unknown>): Promise<IconWarning[]> {
  // Collect all icon nodes from children and items trees
  const iconNodes: Array<{ node: Record<string, unknown>; key: string }> = [];
  collectIconNodes(params.children, iconNodes);

  // Also handle batch items — each item can have its own children
  if (Array.isArray(params.items)) {
    for (const item of params.items) {
      if (item && typeof item === 'object') {
        collectIconNodes((item as Record<string, unknown>).children, iconNodes);
      }
    }
  }

  if (iconNodes.length === 0) return [];

  // Dedupe by icon@size for parallel fetch
  const uniqueKeys = new Map<string, { icon: string; size: number }>();
  for (const { node } of iconNodes) {
    const icon = node.icon as string;
    const size = (node.size as number) ?? 24;
    const key = `${icon}@${size}`;
    if (!uniqueKeys.has(key)) {
      uniqueKeys.set(key, { icon, size });
    }
  }

  // Parallel fetch all unique icons
  const fetchResults = new Map<string, { svg: string } | { error: string }>();
  await Promise.all(
    [...uniqueKeys.entries()].map(async ([key, { icon, size }]) => {
      const result = await fetchIconSvg(icon, size);
      fetchResults.set(key, result);
    }),
  );

  // Replace icon nodes with svg nodes in-place
  const warnings: IconWarning[] = [];
  for (const { node } of iconNodes) {
    const icon = node.icon as string;
    const size = (node.size as number) ?? 24;
    const key = `${icon}@${size}`;
    const result = fetchResults.get(key)!;

    if ('error' in result) {
      warnings.push({ icon, error: result.error });
      // Convert to an empty svg placeholder so creation doesn't break
      node.type = 'svg';
      node.svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>';
      delete node.icon;
      delete node.size;
      continue;
    }

    // Build _iconMeta for Plugin-side color application
    const iconMeta: Record<string, unknown> = {};
    if (node.fill) iconMeta.fill = node.fill;
    if (node.colorVariableName) iconMeta.colorVariableName = node.colorVariableName;

    // Replace in-place: icon → svg
    node.type = 'svg';
    node.svg = result.svg;
    if (!node.name) node.name = icon;
    if (Object.keys(iconMeta).length > 0) {
      node._iconMeta = iconMeta;
    }

    // Clean up icon-specific params
    delete node.icon;
    delete node.size;
    delete node.fill;
    delete node.colorVariableName;
  }

  return warnings;
}

/** Recursively collect all {type: "icon"} nodes from a children array. */
function collectIconNodes(children: unknown, result: Array<{ node: Record<string, unknown>; key: string }>): void {
  if (!Array.isArray(children)) return;

  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;

    if (node.type === 'icon' && typeof node.icon === 'string') {
      result.push({ node, key: node.icon as string });
    }

    // Recurse into nested children (frame children can have children)
    if (Array.isArray(node.children)) {
      collectIconNodes(node.children, result);
    }
  }
}
