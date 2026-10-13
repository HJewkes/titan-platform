// Pill and header placement: labels land where nothing crosses them, deterministically.
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeCrosses, labelEdgeHits, placeHeaders, placePills, textRects } from "./lib/labels.mjs";
import { MIN_GAP } from "./lib/scene.mjs";

const edge = (id, points, sw = 3) => ({ id, kind: "edge", points, sw });
const box = (id, kind, x, y, w, h, lines) => ({ id, kind, lines, x, y, w, h });

test("a pill avoids a neighbouring parallel edge instead of sitting on it", () => {
  const main = edge("a>b", [{ x: 100, y: 500 }, { x: 900, y: 500 }]);
  const neighbour = edge("c>d", [{ x: 100, y: 520 }, { x: 900, y: 520 }]);
  const { pills, dropped } = placePills([main, neighbour], [[main, "7"]]);
  assert.equal(dropped, 0);
  assert.equal(pills.length, 1);
  assert.ok(!edgeCrosses([neighbour], pills[0], null, MIN_GAP));
});

test("a pill never straddles a container border", () => {
  const container = box("c", "container", 300, 300, 400, 400, []);
  const main = edge("x>y", [{ x: 500, y: 100 }, { x: 500, y: 700 }]);
  const { pills } = placePills([container, main], [[main, "2"]]);
  const p = pills[0];
  const inside = p.y >= 300 + MIN_GAP && p.y + p.h <= 700 - MIN_GAP;
  const outside = p.y + p.h <= 300 - MIN_GAP || p.y >= 700 + MIN_GAP;
  assert.ok(inside || outside);
});

test("a pill with no clear spot is dropped and counted", () => {
  const main = edge("a>b", [{ x: 100, y: 500 }, { x: 140, y: 500 }]);
  const wall = box("w", "box", 0, 0, 2000, 2000, ["wall"]);
  assert.equal(placePills([main, wall], [[main, "7"]]).dropped, 1);
});

test("placement is deterministic for the same input", () => {
  const scene = () => {
    const edges = [edge("a>b", [{ x: 100, y: 500 }, { x: 900, y: 500 }, { x: 900, y: 900 }]), edge("c>d", [{ x: 100, y: 520 }, { x: 900, y: 520 }])];
    return placePills(edges, edges.map((e) => [e, "3"]));
  };
  assert.deepEqual(scene(), scene());
});

test("a container header slides along its top band until no edge crosses it", () => {
  const container = box("c", "container", 0, 0, 1600, 600, ["header text"]);
  const through = edge("p>q", [{ x: 60, y: -100 }, { x: 60, y: 300 }]);
  const elements = [container, through];
  assert.equal(labelEdgeHits(elements), 1);
  const { moved, unresolved } = placeHeaders(elements);
  assert.deepEqual({ moved, unresolved }, { moved: 1, unresolved: 0 });
  assert.equal(labelEdgeHits(elements), 0);
  assert.ok(textRects(container)[0].x > 60);
});

test("a header with no clear spot is reported, not moved", () => {
  const container = box("c", "container", 0, 0, 400, 300, ["header"]);
  const curtain = Array.from({ length: 20 }, (_, i) => edge(`e${i}`, [{ x: 10 + i * 20, y: -100 }, { x: 10 + i * 20, y: 200 }]));
  assert.equal(placeHeaders([container, ...curtain]).unresolved, 1);
});
