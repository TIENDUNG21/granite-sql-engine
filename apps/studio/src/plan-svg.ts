import type { PlanNodeInfo } from '@granite/core';
import { escapeHtml } from './highlight.ts';
import { layoutPlan, type BoxSize } from './plan-layout.ts';

const WIDTH = 260;
/** Approximate advance of the 11.5px monospace font, used to truncate details. */
const CHAR_WIDTH = 7;
const PAD = 12;

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The plan tree as a standalone SVG document. Each box shows the operator,
 * its detail (truncated, full text in the tooltip), the planner's estimates
 * and, after EXPLAIN ANALYZE, the measured rows and time with a bar for the
 * node's share of the total time.
 */
export function planToSvg(root: PlanNodeInfo): string {
  const analyzed = root.actualRows !== undefined;
  const size: BoxSize = { width: WIDTH, height: analyzed ? 88 : 70, gapX: 20, gapY: 36 };
  const layout = layoutPlan(root, size);
  const margin = 2;
  const totalTime = root.timeMs ?? 0;
  const maxChars = Math.floor((WIDTH - 2 * PAD) / CHAR_WIDTH);

  const edges = layout.nodes
    .filter((n) => n.parent)
    .map((n) => {
      const p = n.parent!;
      const px = p.x + WIDTH / 2;
      const cx = n.x + WIDTH / 2;
      const mid = p.y + size.height + size.gapY / 2;
      return `<path class="edge" d="M${px} ${p.y + size.height}V${mid}H${cx}V${n.y}"/>`;
    });

  const boxes = layout.nodes.map(({ node, x, y }) => {
    const lines = [
      `<text class="op" x="${PAD}" y="22">${escapeHtml(node.op)}</text>`,
      `<text class="detail" x="${PAD}" y="40">${escapeHtml(truncate(node.detail, maxChars))}</text>`,
      `<text class="est" x="${PAD}" y="58">est ${formatCount(node.rows)} rows · cost ${node.cost}</text>`,
    ];
    let bar = '';
    if (node.actualRows !== undefined) {
      const time = node.timeMs ?? 0;
      lines.push(
        `<text class="actual" x="${PAD}" y="75">actual ${formatCount(node.actualRows)} rows · ${time} ms</text>`,
      );
      const share = totalTime > 0 ? Math.min(1, time / totalTime) : 0;
      bar = `<rect class="bar" x="1" y="${size.height - 4}" width="${Math.max(0, (WIDTH - 2) * share).toFixed(1)}" height="3"/>`;
    }
    const title = escapeHtml(`${node.op} ${node.detail}`.trim());
    return (
      `<g class="node" transform="translate(${x + margin} ${y + margin})">` +
      `<title>${title}</title>` +
      `<rect class="box" width="${WIDTH}" height="${size.height}" rx="6"/>` +
      bar +
      lines.join('') +
      '</g>'
    );
  });

  const width = layout.width + 2 * margin;
  const height = layout.height + 2 * margin;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="plan" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" role="img" aria-label="Query plan">` +
    `<g transform="translate(${margin} ${margin})">${edges.join('')}</g>` +
    boxes.join('') +
    '</svg>'
  );
}
