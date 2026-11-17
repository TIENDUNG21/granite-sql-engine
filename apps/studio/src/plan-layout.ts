import type { PlanNodeInfo } from '@granite/core';

export interface PlacedNode {
  readonly node: PlanNodeInfo;
  readonly depth: number;
  /** Top-left corner of the node box. */
  x: number;
  readonly y: number;
  readonly parent: PlacedNode | undefined;
}

export interface PlanLayout {
  /** Every node in pre-order (root first). */
  readonly nodes: PlacedNode[];
  readonly width: number;
  readonly height: number;
}

export interface BoxSize {
  readonly width: number;
  readonly height: number;
  readonly gapX: number;
  readonly gapY: number;
}

/**
 * Lay a plan tree out top-down. Leaves take consecutive columns in left-to-right
 * order and every parent is centred over its first and last child. Because each
 * subtree owns a contiguous run of columns, boxes never overlap; plan trees are
 * narrow (joins are binary), so this simple scheme stays compact.
 */
export function layoutPlan(root: PlanNodeInfo, size: BoxSize): PlanLayout {
  const nodes: PlacedNode[] = [];
  const column = size.width + size.gapX;
  let leaves = 0;
  let maxDepth = 0;

  const place = (node: PlanNodeInfo, depth: number, parent: PlacedNode | undefined): PlacedNode => {
    const placed: PlacedNode = { node, depth, x: 0, y: depth * (size.height + size.gapY), parent };
    nodes.push(placed);
    maxDepth = Math.max(maxDepth, depth);
    if (node.children.length === 0) {
      placed.x = leaves++ * column;
    } else {
      const children = node.children.map((child) => place(child, depth + 1, placed));
      placed.x = (children[0]!.x + children.at(-1)!.x) / 2;
    }
    return placed;
  };

  place(root, 0, undefined);
  return {
    nodes,
    width: leaves * column - size.gapX,
    height: (maxDepth + 1) * (size.height + size.gapY) - size.gapY,
  };
}
