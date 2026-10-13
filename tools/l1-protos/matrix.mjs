#!/usr/bin/env node
// Frame-config matrix: builds D2-D5 for every frame in frame-config.json (build.mjs under
// L1_FRAME), copies the true-size PNG and SVG of each, and writes <outDir>/index.html with a
// cell per design and frame: fits or not, the derived caps, k, the fallbacks taken and the
// rules violated. Usage: node tools/l1-protos/matrix.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
// L1_FRAMES=<a,b> limits the frames.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveLimits, loadConfig, topKBounds } from "./lib/config.mjs";

const DESIGNS = ["d2-area-overview", "d3-expand-in-place", "d4-area-focus", "d5-package-focus"];
const THUMB_H = 360;
const [snapshot, outArg, ...rest] = process.argv.slice(2);
const out = path.resolve(outArg);
const build = path.join(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const cfg = loadConfig();
const frameNames = (process.env.L1_FRAMES?.split(",") ?? Object.keys(cfg.frames)).filter(Boolean);

function runBuild(frame, dir) {
  const env = { ...process.env, L1_FRAME: frame, L1_CLIP: "0" };
  delete env.L1_LABEL_PX;
  const run = spawnSync("node", [build, snapshot, dir, ...rest], { env, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`build for ${frame} failed: ${run.stderr.slice(-2000)}`);
  return JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8"));
}

function verdict(m) {
  return m.violated.length === 0 ? "fits" : m.rules.labelFloor.ok && m.rules.caps.ok ? "fits, rules violated" : "DOES NOT FIT";
}

function ruleList(m) {
  return m.violated.map((n) => {
    const r = m.rules[n];
    const value = typeof r.value === "object" ? JSON.stringify(r.value) : r.value;
    const threshold = typeof r.threshold === "object" ? JSON.stringify(r.threshold) : r.threshold;
    return `<li><b>${n}</b>: ${esc(value)} vs ${esc(threshold)}</li>`;
  });
}

function cell(frame, m) {
  const png = `${m.name}-${frame.name}.png`;
  const w = Math.round((frame.width * THUMB_H) / frame.height);
  const facts = [`k ${m.k ?? "n/a"}${m.open ? ` · open ${m.open}` : ""}`, `boxes ${m.boxes}`, `edges ${m.edges}`, `labels ${m.labels}`, `min label ${m.minLabelPx} px`, `fit ${m.fit}`, `pills dropped ${m.pillsDropped}`];
  const fallbacks = m.fallbacks.length ? `<details><summary>${m.fallbacks.length} fallbacks</summary><ol>${m.fallbacks.map((f) => `<li>${esc(f)}</li>`).join("")}</ol></details>` : "<p>no fallback</p>";
  const rules = m.violated.length ? `<ul class="rules">${ruleList(m).join("")}</ul>` : `<p class="ok">all ${Object.keys(m.rules).length} rules pass</p>`;
  return `<td class="${verdict(m).startsWith("fits") ? "fits" : "fails"}"><div class="verdict">${verdict(m)}</div>
<a href="${png}"><img src="${png}" width="${w}" height="${THUMB_H}" alt="${esc(m.name)} at ${frame.name}"></a>
<p class="facts">${facts.join(" · ")}</p>${rules}${fallbacks}</td>`;
}

function frameHead(frame, limits, topK) {
  const c = limits.content;
  const lines = [
    `<b>${frame.name}</b> ${frame.width}x${frame.height} @ ${frame.viewScale}`,
    `floor ${limits.labelPx} px (x-height ${limits.xHeightPx})`,
    `content ${c.width}x${c.height}`,
    `grid ${limits.grid.cols}x${limits.grid.rows} = ${limits.grid.boxes}, lanes ${limits.lanes}`,
    `caps: groups ${limits.caps.groups}, boxes ${limits.caps.boxes}, edges ${limits.caps.edges}`,
    `k bounds: D3 ${topK.d3}, D4 ${topK.d4}, D5 ${topK.d5}`,
    `min stroke ${limits.minStrokePx.toFixed(1)} px`,
  ];
  return `<th>${lines.join("<br>")}</th>`;
}

function page(all) {
  const frames = frameNames.map((name) => ({ name, ...cfg.frames[name] }));
  const limitsOf = (f) => deriveLimits(f, cfg);
  const head = frames.map((f) => frameHead(f, limitsOf(f), all[f.name].topK)).join("");
  const rows = DESIGNS.map((d) => `<tr><th class="design">${esc(all[frames[0].name].results.find((m) => m.name === d).title.split(" (")[0])}</th>${frames.map((f) => cell(f, all[f.name].results.find((m) => m.name === d))).join("")}</tr>`);
  const formula = "F = ceil(max(xHeightFraction·H, minViewerXHeight/viewScale) / xHeightRatio); cols = floor((W_c + gap)/(box(labelChars) + gap)); rows = floor((H_c + layerGap)/(box_h + layerGap)); cap = min(cognitive, cols·rows)";
  return `<!doctype html><html><head><meta charset="utf-8"><title>L1 frame-config matrix</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f4f4f4}table{border-collapse:collapse}
th,td{border:1px solid #bbb;padding:6px;vertical-align:top;text-align:left;font-size:13px;background:#fff}
th{font-weight:normal;background:#eee}th.design{font-weight:bold;width:9em}
td.fails{background:#fff3f0}td.fits{background:#f3fbf3}.verdict{font-weight:bold;margin-bottom:4px}
img{display:block;border:1px solid #999;background:#fff}body.true img{width:auto!important;height:auto!important}
p.facts{max-width:640px;margin:4px 0}ul.rules{margin:4px 0;padding-left:18px}p.ok{color:#0a7d3c;margin:4px 0}
details{margin:4px 0}code{font-size:12px}</style></head><body>
<h1>L1 build spec: designs across frame configurations</h1>
<p>Every cell is a true-size render (thumbnail at ${THUMB_H} px tall; click for full size, or <button onclick="document.body.classList.toggle('true')">toggle true size</button>).
Green bars top right of each frame are 24, 32, 40 px and the derived floor; the last bar is the floor's x-height.
Config: <code>tools/l1-protos/frame-config.json</code>. Derived limits: <code>${esc(formula)}</code>.</p>
<table><tr><th></th>${head}</tr>${rows.join("\n")}</table>
<p>"fits" = every rule passes. "fits, rules violated" = label floor and caps hold but a layout rule fails (listed). "DOES NOT FIT" = the floor or a cap is broken after every fallback.</p>
</body></html>`;
}

mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(path.dirname(out), ".l1-matrix-"));
try {
  const all = {};
  for (const name of frameNames) {
    const dir = path.join(work, name);
    all[name] = runBuild(name, dir);
    for (const d of DESIGNS) for (const ext of ["png", "svg"]) copyFileSync(path.join(dir, d, `frame.${ext}`), path.join(out, `${d}-${name}.${ext}`));
    for (const m of all[name].results.filter((r) => DESIGNS.includes(r.name))) console.log(name, m.name, "k", m.k, "fit", m.fit, verdict(m), m.violated.join(","));
  }
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify(all, null, 1));
  writeFileSync(path.join(out, "index.html"), page(all));
} finally {
  rmSync(work, { recursive: true, force: true });
}
