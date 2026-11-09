import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { normalizeMapTree, isAggregateNode, aggregateItemCount } = await import(pathToFileURL(resolve(output, "map-snapshot.js")).href);

const node = (id, name, children = [], can_reveal = true) => ({ id, name, path: `/p/${name}`, size: 1, is_dir: true, can_reveal, cleanup_rule_id: null, children });

test("aggregate nodes get unique ids and stay non-revealable", () => {
  const root = node("root", "home", [
    node("a", "A", [node("", "… 3 smaller items", [], false)]),
    node("b", "B", [node("", "… 7 smaller items", [], false)]),
    node("", "… 2 smaller items", [], false),
  ]);
  const normalized = normalizeMapTree(root);
  const ids = [];
  const walk = (n) => { ids.push(n.id); n.children.forEach(walk); };
  walk(normalized);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(Boolean));
  const aggregates = [normalized.children[0].children[0], normalized.children[1].children[0], normalized.children[2]];
  assert.ok(aggregates.every((a) => isAggregateNode(a) && a.can_reveal === false));
  assert.equal(isAggregateNode(normalized.children[0]), false);
});

test("a synthetic id never makes an id-less node revealable", () => {
  const normalized = normalizeMapTree(node("root", "home", [node("", "odd", [], true)]));
  assert.equal(normalized.children[0].can_reveal, false);
});

test("aggregate labels expose their item count for localization", () => {
  assert.equal(aggregateItemCount("… 12 smaller items"), 12);
  assert.equal(aggregateItemCount("Library"), null);
});
