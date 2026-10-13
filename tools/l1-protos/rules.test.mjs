// Every constraint rule with a passing fixture and a mutation that must fail it.
// Fixtures are frame-px elements for the default 1080p frame (label floor 40 px).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFrame, crossingCount, mentalMap } from "./lib/rules.mjs";
import { LIMITS } from "./lib/scene.mjs";

const F = LIMITS.labelPx;
const box = (id, kind, x, y, w, h, lines, extra = {}) => ({ id, kind, lines, x, y, w, h, fs: F, ...extra });
const edge = (id, points, sw = 3) => ({ id, kind: "edge", points, sw });

function fixture() {
  return {
    name: "fixture",
    fit: 1,
    elisions: [{ what: "packages", hidden: 5, in: "more:c" }],
    elements: [
      box("c", "container", 100, 200, 800, 400, []),
      box("a", "box", 150, 300, 300, 87, ["alpha"], { parent: "c" }),
      box("b", "box", 550, 300, 300, 87, ["beta"], { parent: "c" }),
      box("more:c", "tile", 150, 480, 300, 87, ["+5 more"], { parent: "c" }),
      edge("a>b", [{ x: 450, y: 343 }, { x: 550, y: 343 }]),
      box("a>b#n", "elabel", 470, 220, 60, 60, ["3"]),
    ],
  };
}

function violated(mutate, prev = null) {
  const frame = fixture();
  mutate(frame, Object.fromEntries(frame.elements.map((e) => [e.id, e])));
  return checkFrame(frame, LIMITS, prev).violated;
}

test("the fixture passes every rule", () => {
  assert.deepEqual(checkFrame(fixture(), LIMITS).violated, []);
});

test("labelFloor: one label under the floor fails", () => {
  assert.ok(violated((f, e) => (e.a.fs = F - 1)).includes("labelFloor"));
});

test("labelOverlap: two labels sharing pixels fail", () => {
  assert.ok(violated((f, e) => (e.b.x = 160)).includes("labelOverlap"));
});

test("edgeThroughLabel: an edge through a box's text fails", () => {
  assert.ok(violated((f) => f.elements.push(edge("x", [{ x: 200, y: 250 }, { x: 200, y: 450 }]))).includes("edgeThroughLabel"));
});

test("pillsClear: a pill straddling the container border fails", () => {
  assert.ok(violated((f, e) => (e["a>b#n"].y = 180)).includes("pillsClear"));
});

test("pillsClear: a pill touching a leaf box fails", () => {
  assert.ok(violated((f, e) => Object.assign(e["a>b#n"], { x: 400, y: 245 })).includes("pillsClear"));
});

test("pillsClear: another edge running under the pill fails", () => {
  assert.ok(violated((f) => f.elements.push(edge("y", [{ x: 500, y: 150 }, { x: 500, y: 600 }]))).includes("pillsClear"));
});

test("containment: a child outside its parent fails", () => {
  assert.ok(violated((f, e) => (e.a.x = 20)).includes("containment"));
});

test("safeArea: an element past the content area fails", () => {
  assert.ok(violated((f, e) => (e.c.w = 1800)).includes("safeArea"));
});

test("minSpacing: two boxes closer than the minimum gap fail", () => {
  assert.ok(violated((f, e) => (e.b.x = 455)).includes("minSpacing"));
});

test("edgeCrossings: crossings over the per-edge budget fail", () => {
  const cross = (f) => f.elements.push(edge("p", [{ x: 120, y: 420 }, { x: 880, y: 420 }]), edge("q", [{ x: 500, y: 250 }, { x: 500, y: 580 }]));
  assert.equal(crossingCount(fixture().elements), 0);
  assert.ok(violated(cross).includes("edgeCrossings"));
});

test("elisionsCounted: a hidden count with no label showing it fails", () => {
  assert.ok(violated((f, e) => (e["more:c"].lines = ["+4 more"])).includes("elisionsCounted"));
});

test("caps: more boxes than the cap fail", () => {
  const many = (f) => {
    for (let i = 0; i < LIMITS.caps.boxes; i++) f.elements.push(box(`z${i}`, "box", 1000 + i * 2, 700, 1, 1, []));
  };
  assert.ok(violated(many).includes("caps"));
});

test("stroke: an edge thinner than the minimum fails", () => {
  assert.ok(violated((f, e) => (e["a>b"].sw = 1)).includes("stroke"));
});

test("stability: boxes that move more than the budget from the previous step fail", () => {
  const prev = fixture();
  prev.elements.find((e) => e.id === "a").x = 1000;
  prev.elements.find((e) => e.id === "b").x = 1400;
  assert.ok(violated(() => {}, prev).includes("stability"));
  assert.ok(!violated(() => {}, fixture()).includes("stability"));
  assert.equal(mentalMap(prev, fixture()).persisting, 4);
});

test("a viewer-tracked step counts a border proxy as its area and ignores the bands", async () => {
  const { asTracked } = await import("./lib/frames.mjs");
  const overview = { elements: [box("area:x", "box", 100, 100, 300, 87, ["x"]), box("area:y", "box", 500, 100, 300, 87, ["y"])] };
  const focus = {
    elements: [
      box("band:top", "band", 0, 0, 1900, 120, []),
      box("area:x", "container", 100, 300, 800, 400, []),
      box("top:area:y", "chip", 500, 20, 200, 80, ["y"]),
      box("bot:area:y", "chip", 900, 900, 200, 80, ["y"]),
    ],
  };
  const tracked = mentalMap(asTracked(overview), asTracked(focus));
  assert.equal(tracked.persisting, 2);
  assert.equal(mentalMap(overview, focus).persisting, 1);
});
