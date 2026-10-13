#!/usr/bin/env node
// L1 legibility study: builds every design on the real graph for the configured frame
// (L1_FRAME, default 1080p), renders true-size frames, checks every rule, measures them in
// the browser, renders the level-transition clip, and writes an index.
// Usage: node tools/l1-protos/build.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRepo } from "./lib/graph.mjs";
import { buildModel } from "./lib/model.mjs";
import { CAP, areaOverview, expandFitted, readingOrder } from "./lib/designs.mjs";
import { tierBands } from "./lib/bands.mjs";
import { areaFocus, packageFocus } from "./lib/focus-views.mjs";
import { frameOf, mentalMap, staticData, transitionData } from "./lib/frames.mjs";
import { frameInfo, pageHtml } from "./lib/page.mjs";
import { openBrowser, renderClip, renderStatic } from "./lib/capture.mjs";
import { indexHtml } from "./lib/index-page.mjs";
import { LIMITS } from "./lib/scene.mjs";
import { topKBounds } from "./lib/config.mjs";

const [snapshot, outArg, pwDir, chromium] = process.argv.slice(2);
const out = path.resolve(outArg);
const VIEWPORT = { width: LIMITS.frame.width, height: LIMITS.frame.height };

// Picked from the data so nothing names a real package: the two largest areas open, the
// second-largest is entered, and the non-product package with the most files is focused.
function targets(model) {
  const largest = model.areas[0];
  const second = model.areas[1];
  const bigPackage = [...model.packages.values()].filter((p) => p.tier !== "product").sort((a, b) => b.counts.source - a.counts.source)[0];
  return { open: [largest.id, second.id], focusArea: second, focusPackage: bigPackage.id };
}

async function scenes(model) {
  const t = targets(model);
  // L1_MODEL_ORDER=0 lays each view out cold, for comparing how far a transition moves boxes.
  const seeded = process.env.L1_MODEL_ORDER !== "0";
  const overview = await areaOverview(model);
  const expanded = await expandFitted(model, t.open, topKBounds(CAP, { groups: model.areas.length, open: t.open.length }).d3, seeded ? readingOrder(overview) : null);
  return {
    t,
    list: [
      await tierBands(model),
      overview,
      expanded,
      await areaFocus(model, t.focusArea.id, seeded ? readingOrder(expanded) : null),
      await packageFocus(model, t.focusPackage),
    ],
  };
}

// The ladder D2 → D3 → D4: each frame's stability rule compares it with the step before.
function ladderFrames(list) {
  const frames = [];
  for (const scene of list) {
    const prev = /^d[34]-/.test(scene.name) ? frames.at(-1) : null;
    frames.push(frameOf(scene, prev));
  }
  return frames;
}

function writePage(dir, file, title, data) {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  writeFileSync(target, pageHtml(title, data));
  return target;
}

function limitsSummary() {
  const { name, frame, labelPx, xHeightPx, content, grid, lanes, caps, minStrokePx } = LIMITS;
  return { name, width: frame.width, height: frame.height, viewScale: frame.viewScale, labelPx, xHeightPx, content, grid: { cols: grid.cols, rows: grid.rows, boxes: grid.boxes }, lanes, caps, minStrokePx: +minStrokePx.toFixed(2) };
}

async function main() {
  const model = buildModel(await loadRepo(snapshot));
  const { t, list } = await scenes(model);
  const frames = ladderFrames(list);
  const info = frameInfo(LIMITS, LIMITS.cfg);
  const browser = await openBrowser(pwDir, chromium);
  const results = [];
  const report = () => ({ frame: limitsSummary(), cap: CAP, topK: topKBounds(CAP, { groups: model.areas.length, open: t.open.length }), results });
  try {
    for (const f of frames) {
      const page = writePage(path.join(out, f.name), "frame.html", f.title, { ...staticData(f), frame: info });
      const measured = await renderStatic(browser, page, path.join(out, f.name, "frame.png"), VIEWPORT);
      results.push({ name: f.name, title: f.title, fit: f.fit, k: f.k, open: f.open, fallbacks: f.fallbacks, elisions: f.elisions.length, ...f.checks, ...measured });
    }
    if (process.env.L1_CLIP === "0") {
      writeFileSync(path.join(out, "metrics.json"), JSON.stringify(report(), null, 1));
      return;
    }
    const clip = transitionData(frames[1], frames[2], frames[3], t.focusArea.id, t.focusArea.name);
    const clipPage = writePage(path.join(out, "motion"), "transition.html", "level transition", { ...clip, frame: info });
    const mental = { expand: mentalMap(clip.frames[0], clip.frames[1]), enter: mentalMap(clip.frames[2], clip.frames[3]) };
    results.push({ name: "motion", mental, clip: await renderClip(browser, clipPage, path.join(out, "motion"), VIEWPORT) });
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify(report(), null, 1));
  writeFileSync(path.join(out, "index.html"), indexHtml(results, CAP));
  console.log(JSON.stringify(report(), null, 1));
}

await main();
