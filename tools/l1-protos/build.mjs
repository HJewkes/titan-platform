#!/usr/bin/env node
// L1 legibility study: builds every design on the real graph, renders true 1920x1080 frames,
// measures them in the browser, renders the level-transition clip, and writes an index.
// Usage: node tools/l1-protos/build.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRepo } from "./lib/graph.mjs";
import { buildModel } from "./lib/model.mjs";
import { CAP, areaOverview, expandInPlace, readingOrder } from "./lib/designs.mjs";
import { tierBands } from "./lib/bands.mjs";
import { areaFocus, packageFocus } from "./lib/focus-views.mjs";
import { frameOf, mentalMap, staticData, transitionData } from "./lib/frames.mjs";
import { pageHtml } from "./lib/page.mjs";
import { openBrowser, renderClip, renderStatic } from "./lib/capture.mjs";
import { indexHtml } from "./lib/index-page.mjs";

const [snapshot, outArg, pwDir, chromium] = process.argv.slice(2);
const out = path.resolve(outArg);

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
  const expanded = await expandInPlace(model, t.open, 4, seeded ? readingOrder(overview) : null);
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

function writePage(dir, file, title, data) {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  writeFileSync(target, pageHtml(title, data));
  return target;
}

async function main() {
  const model = buildModel(await loadRepo(snapshot));
  const { t, list } = await scenes(model);
  const frames = list.map(frameOf);
  const browser = await openBrowser(pwDir, chromium);
  const results = [];
  try {
    for (const f of frames) {
      const page = writePage(path.join(out, f.name), "frame.html", f.title, staticData(f));
      results.push({ name: f.name, title: f.title, fit: f.fit, ...f.checks, ...(await renderStatic(browser, page, path.join(out, f.name, "frame.png"))) });
    }
    const clip = transitionData(frames[1], frames[2], frames[3], t.focusArea.id, t.focusArea.name);
    const clipPage = writePage(path.join(out, "motion"), "transition.html", "level transition", clip);
    const mental = { expand: mentalMap(clip.frames[0], clip.frames[1]), enter: mentalMap(clip.frames[2], clip.frames[3]) };
    results.push({ name: "motion", mental, clip: await renderClip(browser, clipPage, path.join(out, "motion")) });
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify({ cap: CAP, results }, null, 1));
  writeFileSync(path.join(out, "index.html"), indexHtml(results, CAP));
  console.log(JSON.stringify({ cap: CAP, results }, null, 1));
}

await main();
