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
import { asTracked, frameOf, ladderData, mentalMap, staticData, transitionData } from "./lib/frames.mjs";
import { frameInfo, pageHtml } from "./lib/page.mjs";
import { openBrowser, renderClip, renderStatic } from "./lib/capture.mjs";
import { indexHtml } from "./lib/index-page.mjs";
import { toneOf, withTones } from "./lib/tones.mjs";
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

// L1_LADDER_PACKAGE=1 enters the largest non-product package D4 shows, so D4 → D5 is a step a
// viewer can take; by default D5 is the largest non-product package anywhere, as in the matrix.
function ladderPackage(model, focus, fallback) {
  if (process.env.L1_LADDER_PACKAGE !== "1") return fallback;
  const shown = focus.elements.filter((e) => e.kind === "box" && e.id.startsWith("pkg:")).map((e) => model.packages.get(e.id.slice(4)));
  const ranked = shown.filter((p) => p && p.tier !== "product").sort((a, b) => b.counts.source - a.counts.source);
  return ranked[0]?.id ?? fallback;
}

async function scenes(model) {
  const t = targets(model);
  // L1_MODEL_ORDER=0 lays each view out cold, for comparing how far a transition moves boxes.
  const seeded = process.env.L1_MODEL_ORDER !== "0";
  const overview = await areaOverview(model);
  const expanded = await expandFitted(model, t.open, topKBounds(CAP, { groups: model.areas.length, open: t.open.length }).d3, seeded ? readingOrder(overview) : null);
  const focus = await areaFocus(model, t.focusArea.id, seeded ? readingOrder(expanded) : null);
  t.focusPackage = ladderPackage(model, focus, t.focusPackage);
  return { t, list: [await tierBands(model), overview, expanded, focus, await packageFocus(model, t.focusPackage)] };
}

// The ladder D2 → D4 → D5: each frame's stability rule compares it with the step it is entered
// from. D3 is off the ladder but still measured against D2, the step it would expand.
const ENTERED_FROM = [["d3-", "d2-"], ["d4-", "d2-"], ["d5-", "d4-"]];

function ladderFrames(list) {
  const frames = [];
  for (const scene of list) {
    const from = ENTERED_FROM.find(([step]) => scene.name.startsWith(step))?.[1];
    frames.push(frameOf(scene, from ? frames.find((f) => f.name.startsWith(from)) : null));
  }
  return frames;
}

const byName = (frames, step) => frames.find((f) => f.name.startsWith(step));

// L1_CLIP=ladder renders D2 → D4 → D5 into motion-ladder/ (L1_LADDER_ZOOM=0 for a cross-step
// instead of the camera zoom); otherwise the older D2 → D3 → D4 clip into motion/.
function clipOf(frames, t) {
  const [d2, d3, d4, d5] = ["d2-", "d3-", "d4-", "d5-"].map((step) => byName(frames, step));
  if (process.env.L1_CLIP === "ladder") {
    const zoom = process.env.L1_LADDER_ZOOM !== "0";
    const clip = ladderData(d2, d4, d5, t.focusArea.id, t.focusArea.name, zoom);
    const enter = zoom ? mentalMap(clip.frames[1], d4) : mentalMap(d2, d4);
    const tracked = (a, b) => mentalMap(asTracked(a), asTracked(b));
    const mental = { zoom, d2ToD4: mentalMap(d2, d4), enterAfterCamera: enter, d4ToD5: mentalMap(d4, d5), d2ToD4Tracked: tracked(d2, d4), d4ToD5Tracked: tracked(d4, d5) };
    return { dir: "motion-ladder", clip, mental };
  }
  const clip = transitionData(d2, d3, d4, t.focusArea.id, t.focusArea.name);
  return { dir: "motion", clip, mental: { expand: mentalMap(clip.frames[0], clip.frames[1]), enter: mentalMap(clip.frames[2], clip.frames[3]) } };
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
  const tone = toneOf(model);
  const frames = ladderFrames(list).map((f) => withTones(f, tone));
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
    const { dir, clip, mental } = clipOf(frames, t);
    const clipPage = writePage(path.join(out, dir), "transition.html", "level transition", { ...clip, frame: info });
    results.push({ name: dir, mental, clip: await renderClip(browser, clipPage, path.join(out, dir), VIEWPORT) });
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify(report(), null, 1));
  writeFileSync(path.join(out, "index.html"), indexHtml(results, CAP));
  console.log(JSON.stringify(report(), null, 1));
}

await main();
