import assert from "node:assert/strict";
import test from "node:test";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { layoutTreemap, squarify } = await import(`${output}/treemap-layout.js`);

test("disk areas remain proportional to real sizes without overlap", () => {
  const nodes = [1, 61, 3, 21, 14].map((size) => ({ size }));
  const rects = squarify(nodes, 928, 396);
  for (const rect of rects) {
    assert.ok(Math.abs(rect.w * rect.h / (928 * 396) - rect.node.size / 100) < 1e-8);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 928 + 1e-8 && rect.y + rect.h <= 396 + 1e-8);
    for (const other of rects) {
      if (rect === other) continue;
      const overlapW = Math.min(rect.x + rect.w, other.x + other.w) - Math.max(rect.x, other.x);
      const overlapH = Math.min(rect.y + rect.h, other.y + other.h) - Math.max(rect.y, other.y);
      assert.ok(overlapW <= 1e-8 || overlapH <= 1e-8);
    }
  }
  assert.deepEqual(nodes.map((node) => node.size), [1, 61, 3, 21, 14]);
});

test("Figma gutters stay within bounds at small and large window sizes", () => {
  for (const [w, h] of [[1, 1], [56, 40], [808, 316], [928, 396], [1600, 900]]) {
    const rects = layoutTreemap([1000, 300, 150, 0.001].map((size) => ({ size })), w, h, 4);
    for (const rect of rects) {
      assert.ok([rect.x, rect.y, rect.w, rect.h].every(Number.isFinite));
      assert.ok(rect.w > 0 && rect.h > 0);
      assert.ok(rect.x + rect.w <= w + 1e-8 && rect.y + rect.h <= h + 1e-8);
    }
  }
});

test("empty and non-positive data never creates invalid tiles", () => {
  assert.deepEqual(layoutTreemap([], 100, 100, 4), []);
  assert.deepEqual(layoutTreemap([{ size: 0 }, { size: -1 }, { size: NaN }], 100, 100, 4), []);
  assert.deepEqual(layoutTreemap([{ size: 20 }], 0, 100, 4), []);
  assert.deepEqual(layoutTreemap([{ size: 20 }], 100, 0, 4), []);
});
