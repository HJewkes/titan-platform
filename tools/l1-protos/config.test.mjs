// Derived limits from frame-config.json. Run: node --test tools/l1-protos
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentRect, deriveLimits, labelFloorPx, loadConfig, themedConfig, topKBounds } from "./lib/config.mjs";

const cfg = loadConfig();
const frame = (name) => ({ name, ...cfg.frames[name] });

test("the 1080p label floor is 40 px: a 2% x-height through DejaVu Sans Mono's 0.547 ratio", () => {
  assert.equal(labelFloorPx(frame("1080p"), cfg), 40);
  assert.equal(labelFloorPx(frame("720p"), cfg), 27);
  assert.equal(labelFloorPx(frame("portrait-1080"), cfg), 71);
});

test("the titan themes derive a 44 px floor from Space Grotesk's 0.500 x-height and keep the layout budget", () => {
  const titan = themedConfig(cfg, "dark");
  assert.equal(labelFloorPx(frame("1080p"), titan), 44);
  assert.equal(titan.font.advance, cfg.font.advance);
  assert.equal(themedConfig(cfg, "plain"), cfg);
});

test("a frame viewed at a third needs the viewer-absolute floor, which wins over the fraction", () => {
  const third = labelFloorPx(frame("1080p-embed-third"), cfg);
  assert.equal(third, Math.ceil(cfg.labelFloor.minViewerXHeightPx / 0.3333 / cfg.font.xHeight));
  assert.ok(third > labelFloorPx(frame("1080p"), cfg));
});

test("the 1080p content area is the one the sizes page used", () => {
  assert.deepEqual(contentRect(frame("1080p"), cfg), { x: 24, y: 96, width: 1872, height: 948 });
});

test("every 16:9 frame derives the same grid and caps, because the floor is a fraction of height", () => {
  const grids = ["720p", "1080p", "1440p", "2160p"].map((n) => deriveLimits(frame(n), cfg)).map((d) => JSON.stringify([d.grid.cols, d.grid.rows, d.caps]));
  assert.equal(new Set(grids).size, 1);
});

test("caps never exceed the cognitive ceiling and never exceed the grid", () => {
  for (const name of Object.keys(cfg.frames)) {
    const d = deriveLimits(frame(name), cfg);
    assert.ok(d.caps.boxes <= cfg.cognitive.boxes && d.caps.boxes <= d.grid.boxes, name);
    assert.ok(d.caps.edges <= cfg.cognitive.edges && d.caps.edges <= d.lanes, name);
    assert.ok(d.caps.groups <= cfg.cognitive.groups, name);
  }
});

test("portrait at the ARPP floor has a one-column grid, so its caps collapse", () => {
  const d = deriveLimits(frame("portrait-1080"), cfg);
  assert.equal(d.grid.cols, 1);
  assert.ok(d.caps.boxes < 10);
});

test("an explicit label size overrides the derived floor (the 24/32/40 comparison path)", () => {
  assert.equal(deriveLimits(frame("1080p"), cfg, 24).labelPx, 24);
});

test("top-k bounds spend the box cap on containers, tiles and proxies", () => {
  const caps = { boxes: 20 };
  assert.deepEqual(topKBounds(caps, { groups: 7, open: 2, proxies: 6 }), { d3: 5, d4: 12, d5: 10 });
  assert.deepEqual(topKBounds({ boxes: 6 }, { groups: 7, open: 2, proxies: 6 }), { d3: 0, d4: 0, d5: 0 });
});

test("the minimum stroke scales with the viewing scale", () => {
  const one = deriveLimits(frame("1080p"), cfg).minStrokePx;
  const third = deriveLimits(frame("1080p-embed-third"), cfg).minStrokePx;
  assert.ok(third >= cfg.stroke.minViewerPx / 0.3333 - 0.01);
  assert.ok(third > one);
});
