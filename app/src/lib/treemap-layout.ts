export interface TreemapRect<T> {
  node: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function squarify<T extends { size: number }>(children: readonly T[], w: number, h: number): TreemapRect<T>[] {
  const valued = children.filter((child) => Number.isFinite(child.size) && child.size > 0).sort((a, b) => b.size - a.size);
  const total = valued.reduce((sum, child) => sum + child.size, 0);
  if (total <= 0 || w <= 0 || h <= 0) return [];
  const items = valued.map((node) => ({ node, area: (node.size / total) * w * h }));
  const rects: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let width = w;
  let height = h;
  const worst = (row: { area: number }[], side: number) => {
    if (!row.length) return Infinity;
    const sum = row.reduce((value, item) => value + item.area, 0);
    const max = Math.max(...row.map((item) => item.area));
    const min = Math.min(...row.map((item) => item.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const layout = (row: { node: T; area: number }[]) => {
    const area = row.reduce((sum, item) => sum + item.area, 0);
    if (width >= height) {
      const column = area / height;
      let offset = y;
      for (const item of row) {
        const rowHeight = item.area / column;
        rects.push({ node: item.node, x, y: offset, w: column, h: rowHeight });
        offset += rowHeight;
      }
      x += column;
      width -= column;
    } else {
      const rowHeight = area / width;
      let offset = x;
      for (const item of row) {
        const rowWidth = item.area / rowHeight;
        rects.push({ node: item.node, x: offset, y, w: rowWidth, h: rowHeight });
        offset += rowWidth;
      }
      y += rowHeight;
      height -= rowHeight;
    }
  };
  let row: { node: T; area: number }[] = [];
  for (const item of items) {
    const next = [...row, item];
    if (!row.length || worst(row, Math.min(width, height)) >= worst(next, Math.min(width, height))) {
      row = next;
    } else {
      layout(row);
      row = [item];
    }
  }
  if (row.length) layout(row);
  return rects;
}

/** Add the Figma gutter without changing the underlying size-driven tiling. */
export function layoutTreemap<T extends { size: number }>(children: readonly T[], w: number, h: number, gap: number): TreemapRect<T>[] {
  if (w <= 0 || h <= 0) return [];
  return squarify(children, w + gap, h + gap)
    .map((rect) => ({ ...rect, w: Math.max(0, rect.w - gap), h: Math.max(0, rect.h - gap) }))
    .filter((rect) => rect.w > 0 && rect.h > 0);
}
