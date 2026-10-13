#!/usr/bin/env node
// Label-floor comparison: builds D2-D5 at 24, 32 and 40 px (each re-fitted to the frame by
// build.mjs under L1_LABEL_PX), then writes <outDir>/<design>-<px>.png and <outDir>/index.html.
// Usage: node tools/l1-protos/sizes.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [24, 32, 40];
const DESIGNS = ["d2-area-overview", "d3-expand-in-place", "d4-area-focus", "d5-package-focus"];
const [snapshot, outArg, ...rest] = process.argv.slice(2);
const out = path.resolve(outArg);
const build = path.join(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function runBuild(px, dir) {
  const env = { ...process.env, L1_LABEL_PX: String(px), L1_CLIP: "0" };
  const run = spawnSync("node", [build, snapshot, dir, ...rest], { env, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`build at ${px}px failed: ${run.stderr}`);
  return JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8")).results;
}

function fitVerdict(m) {
  const ok = m.fit >= 1 && m.labelOverlaps === 0 && m.labelOverflow === 0 && m.boxesCutByFrame === 0 && m.boxes <= 20 && m.edges <= 25;
  return ok ? "fits" : "DOES NOT FIT";
}

function cell(m, px) {
  const png = `${m.name}-${px}.png`;
  const facts = [`boxes ${m.boxes}`, `edges ${m.edges}`, `labels ${m.labels}`, `k ${m.k ?? "n/a"}`, `scale ${m.fit}`, `label overlaps ${m.labelOverlaps}`, `edge/label crossings ${m.labelEdgeHits}`, `min label ${m.minLabelPx} px`];
  return `<figure><figcaption>${px} px · <b>${fitVerdict(m)}</b></figcaption>
<a href="${png}"><img src="${png}" width="620" alt="${esc(m.name)} at ${px} px"></a>
<p>${facts.join(" · ")}</p></figure>`;
}

function page(all) {
  const rows = DESIGNS.map((d) => `<h2>${esc(all[SIZES[0]].find((m) => m.name === d).title)}</h2>
<div class="row">${SIZES.map((px) => cell(all[px].find((m) => m.name === d), px)).join("")}</div>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>L1 label-size comparison</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f4f4f4}.row{display:flex;gap:16px}
figure{margin:0}img{display:block;border:1px solid #999;background:#fff}p{font-size:13px;max-width:620px;margin:4px 0 0}
</style></head><body><h1>L1 map label floor: 24 | 32 | 40 px</h1>
<p>Each design is re-fitted at each floor with the same cap (≤ 20 boxes, ≤ 25 edges): only the floor and top-k change.
Every frame is a true 1920x1080 render shown at about a third; click a frame for full size. Green bars top right are 24, 32 and 40 px.</p>
${rows.join("\n")}</body></html>`;
}

mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(path.dirname(out), ".l1-sizes-"));
try {
  const all = {};
  for (const px of SIZES) {
    const dir = path.join(work, String(px));
    all[px] = runBuild(px, dir);
    for (const d of DESIGNS) copyFileSync(path.join(dir, d, "frame.png"), path.join(out, `${d}-${px}.png`));
  }
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify(all, null, 1));
  writeFileSync(path.join(out, "index.html"), page(all));
  for (const px of SIZES) for (const m of all[px].filter((r) => DESIGNS.includes(r.name))) console.log(px, m.name, m.boxes, m.edges, m.labels, m.k, m.fit, m.labelOverlaps, m.labelEdgeHits, fitVerdict(m));
} finally {
  rmSync(work, { recursive: true, force: true });
}
