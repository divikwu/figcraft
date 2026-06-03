/**
 * Image & vector handlers — set image fills, create vectors, flatten nodes.
 */

import { simplifyNode } from '../adapters/node-simplifier.js';
import { registerHandler } from '../registry.js';
import { assertHandler, HandlerError } from '../utils/handler-error.js';
import { type ImageScaleMode, imagePaintFromBase64 } from '../utils/image-paint.js';
import type { TokenBindingFailure } from '../utils/node-helpers.js';
import { applyCornerRadius, applyFill, applyStroke } from '../utils/node-helpers.js';
import { findNodeByIdAsync } from '../utils/node-lookup.js';
import { ensureLoaded } from '../utils/style-registry.js';
import { getCachedModeLibrary } from './write-nodes.js';

// Shared helper for shape creation (rectangle, ellipse) to avoid duplication
async function createShape(
  factory: () => SceneNode & GeometryMixin & MinimalFillsMixin & MinimalStrokesMixin & BlendMixin & LayoutMixin,
  defaultName: string,
  params: Record<string, unknown>,
  applyExtras?: (
    node: ReturnType<typeof factory>,
    libraryBindings: string[],
    useLib: boolean,
    library: string | undefined,
  ) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const [mode, library] = await getCachedModeLibrary();
  const useLib = mode === 'library' && !!library;
  if (useLib) await ensureLoaded(library!);
  const libraryBindings: string[] = [];
  const warnings: string[] = [];
  const bindingFailures: TokenBindingFailure[] = [];

  const node = factory();
  node.name = (params.name as string) ?? defaultName;
  (node as any).resize((params.width as number) ?? 100, (params.height as number) ?? 100);
  if (params.x != null) (node as any).x = params.x as number;
  if (params.y != null) (node as any).y = params.y as number;

  // Fill with token auto-binding
  const fillInput = params.fillVariableName
    ? { _variable: params.fillVariableName }
    : params.fillStyleName
      ? { _style: params.fillStyleName }
      : params.fill;
  if (fillInput != null) {
    const fillResult = await applyFill(node as any, fillInput as any, 'background', useLib, library);
    if (fillResult.autoBound) libraryBindings.push(fillResult.autoBound);
    if (fillResult.colorHint) warnings.push(fillResult.colorHint);
    if (fillResult.bindingFailure) bindingFailures.push(fillResult.bindingFailure);
  }

  // Stroke with token auto-binding
  const strokeInput = params.strokeVariableName ? { _variable: params.strokeVariableName } : params.strokeColor;
  if (strokeInput != null) {
    const strokeResult = await applyStroke(
      node as any,
      strokeInput as any,
      (params.strokeWeight as number) ?? 1,
      useLib,
      library,
    );
    if (strokeResult.autoBound) libraryBindings.push(strokeResult.autoBound);
    if (strokeResult.colorHint) warnings.push(strokeResult.colorHint);
    if (strokeResult.bindingFailure) bindingFailures.push(strokeResult.bindingFailure);
  }

  if (params.opacity != null) (node as any).opacity = params.opacity as number;
  if (params.rotation != null) (node as any).rotation = params.rotation as number;
  if (params.visible === false) (node as any).visible = false;

  // Shape-specific properties (corner radius, stroke details, etc.)
  if (applyExtras) await applyExtras(node as any, libraryBindings, useLib, library);

  if (params.parentId) {
    const parent = await findNodeByIdAsync(params.parentId as string);
    if (parent && 'appendChild' in parent) (parent as FrameNode).appendChild(node as SceneNode);
  }

  const result = simplifyNode(node as SceneNode) as unknown as Record<string, unknown>;
  if (libraryBindings.length > 0) {
    result._libraryBindings = libraryBindings;
  }
  if (warnings.length > 0) {
    result._warnings = warnings;
  }
  if (bindingFailures.length > 0) {
    result._tokenBindingFailures = bindingFailures;
  }
  return result;
}

export function registerImageVectorHandlers(): void {
  registerHandler('set_image_fill', async (params) => {
    const nodeId = params.nodeId as string;
    const imageData = params.imageData as string; // base64-encoded image
    const scaleMode = ((params.scaleMode as string) ?? 'FILL').toUpperCase() as ImageScaleMode;

    const node = await findNodeByIdAsync(nodeId);
    assertHandler(node && 'fills' in node, `Node not found or does not support fills: ${nodeId}`, 'NOT_FOUND');

    const imagePaint = imagePaintFromBase64(imageData, scaleMode);
    (node as GeometryMixin).fills = [imagePaint];
    return {
      ok: true,
      id: (node as SceneNode).id,
      name: (node as SceneNode).name,
      width: 'width' in node ? (node as SceneNode & { width: number }).width : 0,
      height: 'height' in node ? (node as SceneNode & { height: number }).height : 0,
      imageHash: imagePaint.imageHash,
    };
  });

  registerHandler('create_vector', async (params) => {
    const svgString = params.svg as string;
    const name = (params.name as string) ?? 'Vector';
    const parentId = params.parentId as string | undefined;

    let vectorNode: FrameNode;
    try {
      vectorNode = figma.createNodeFromSvg(svgString);
    } catch (err) {
      throw new HandlerError(`Failed to parse SVG: ${err instanceof Error ? err.message : String(err)}`);
    }
    vectorNode.name = name;

    if (params.x != null) vectorNode.x = params.x as number;
    if (params.y != null) vectorNode.y = params.y as number;
    if (params.resize) {
      const [w, h] = params.resize as [number, number];
      vectorNode.resize(w, h);
    }

    if (parentId) {
      const parent = await findNodeByIdAsync(parentId);
      if (parent && 'appendChild' in parent) {
        (parent as FrameNode).appendChild(vectorNode);
      }
    }

    return simplifyNode(vectorNode);
  });

  registerHandler('group_nodes', async (params) => {
    const nodeIds = params.nodeIds as string[];
    const name = (params.name as string) || 'Group';

    assertHandler(nodeIds.length >= 2, 'At least 2 nodes required for grouping', 'INVALID_PARAMS');

    const nodes: SceneNode[] = [];
    for (const id of nodeIds) {
      const node = await findNodeByIdAsync(id);
      assertHandler(node, `Node not found: ${id}`, 'NOT_FOUND');
      nodes.push(node as SceneNode);
    }

    // Verify all nodes share the same parent
    const parentId = nodes[0].parent?.id;
    assertHandler(parentId, 'First node has no parent', 'INVALID_PARAMS');
    for (let i = 1; i < nodes.length; i++) {
      assertHandler(
        nodes[i].parent?.id === parentId,
        `All nodes must share the same parent. Node ${nodeIds[i]} has different parent.`,
        'INVALID_PARAMS',
      );
    }

    const group = figma.group(nodes, nodes[0].parent!);
    group.name = name;

    return {
      id: group.id,
      name: group.name,
      type: group.type,
      childCount: group.children.length,
    };
  });

  registerHandler('flatten_node', async (params) => {
    const nodeId = params.nodeId as string;
    const node = await findNodeByIdAsync(nodeId);
    assertHandler(node && 'type' in node, `Node not found: ${nodeId}`, 'NOT_FOUND');

    const sceneNode = node as SceneNode;
    const flat = figma.flatten([sceneNode]);
    return simplifyNode(flat);
  });

  registerHandler('create_star', async (params) => {
    const star = figma.createStar();
    star.name = (params.name as string) ?? 'Star';
    star.resize((params.width as number) ?? 100, (params.height as number) ?? 100);
    if (params.x != null) star.x = params.x as number;
    if (params.y != null) star.y = params.y as number;
    if (params.pointCount != null) star.pointCount = params.pointCount as number;
    if (params.innerRadius != null) star.innerRadius = params.innerRadius as number;

    if (params.fill && typeof params.fill === 'string') {
      const { hexToFigmaRgb } = await import('../utils/color.js');
      star.fills = [{ type: 'SOLID', color: hexToFigmaRgb(params.fill) }];
    }

    if (params.parentId) {
      const parent = await findNodeByIdAsync(params.parentId as string);
      if (parent && 'appendChild' in parent) (parent as FrameNode).appendChild(star);
    }

    return simplifyNode(star);
  });

  registerHandler('create_polygon', async (params) => {
    const polygon = figma.createPolygon();
    polygon.name = (params.name as string) ?? 'Polygon';
    polygon.resize((params.width as number) ?? 100, (params.height as number) ?? 100);
    if (params.x != null) polygon.x = params.x as number;
    if (params.y != null) polygon.y = params.y as number;
    if (params.pointCount != null) polygon.pointCount = params.pointCount as number;

    if (params.fill && typeof params.fill === 'string') {
      const { hexToFigmaRgb } = await import('../utils/color.js');
      polygon.fills = [{ type: 'SOLID', color: hexToFigmaRgb(params.fill) }];
    }

    if (params.parentId) {
      const parent = await findNodeByIdAsync(params.parentId as string);
      if (parent && 'appendChild' in parent) (parent as FrameNode).appendChild(polygon);
    }

    return simplifyNode(polygon);
  });

  registerHandler('create_rectangle', async (params) => {
    return createShape(
      () => figma.createRectangle() as any,
      'Rectangle',
      params,
      async (rect, libraryBindings, useLib, library) => {
        // Rectangle-specific: stroke details
        if (params.strokeAlign) rect.strokeAlign = params.strokeAlign as 'INSIDE' | 'OUTSIDE' | 'CENTER';
        if (params.strokeDashes && Array.isArray(params.strokeDashes)) {
          (rect as any).dashPattern = params.strokeDashes as number[];
        }
        if (params.strokeCap) (rect as any).strokeCap = params.strokeCap as string;
        if (params.strokeJoin) (rect as any).strokeJoin = params.strokeJoin as string;
        // Rectangle-specific: corner radius with token binding
        if (params.cornerRadius != null) {
          const radiusBound = await applyCornerRadius(
            rect as any,
            params.cornerRadius as any,
            useLib,
            undefined,
            library,
          );
          libraryBindings.push(...radiusBound);
        }
        // Per-corner overrides
        if (params.topLeftRadius != null) (rect as any).topLeftRadius = params.topLeftRadius as number;
        if (params.topRightRadius != null) (rect as any).topRightRadius = params.topRightRadius as number;
        if (params.bottomRightRadius != null) (rect as any).bottomRightRadius = params.bottomRightRadius as number;
        if (params.bottomLeftRadius != null) (rect as any).bottomLeftRadius = params.bottomLeftRadius as number;
      },
    );
  });

  registerHandler('create_ellipse', async (params) => {
    return createShape(() => figma.createEllipse() as any, 'Ellipse', params);
  });
} // registerImageVectorHandlers
