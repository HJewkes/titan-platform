#!/usr/bin/env node
// Theme comparison: builds D2, D4 and D5 at a 40 px floor under each L1_THEME (the layout is the same
// in all three; only CSS differs), re-renders the transition clip in the titan themes, measures the
// label faces, and writes <outDir>/index.html with true-size PNGs.
// Usage: node tools/l1-protos/theme-compare.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/capture.mjs";
import { measureFaces } from "./lib/font-metrics.mjs";
import { THEMES, themeStyles } from "./lib/theme.mjs";

const PX = 40;
const FLOOR_X_HEIGHT = 22;
const DESIGNS = ["d2-area-overview", "d4-area-focus", "d5-package-focus"];
const CLIP_THEMES = new Set(["dark", "light"]);
const FACES = [
  { name: "box and area labels: titan heading face", weight: 500, family: "'Space Grotesk'" },
  { name: "area headers: titan heading face, semibold", weight: 600, family: "'Space Grotesk'" },
  { name: "pills and file paths: titan mono token", weight: 400, family: "var(--font-family-mono)" },
  { name: "plain styling today", weight: 400, family: "'DejaVu Sans Mono'" },
];
const [snapshot, outArg, pwDir, chromium] = process.argv.slice(2);
const out = path.resolve(outArg);
const build = path.join(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function runBuild(theme, dir) {
  const env = { ...process.env, L1_LABEL_PX: String(PX), L1_THEME: theme, L1_CLIP: CLIP_THEMES.has(theme) ? "1" : "0" };
  const run = spawnSync("node", [build, snapshot, dir, pwDir, chromium].filter(Boolean), { env, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`build in ${theme} failed: ${run.stderr}`);
  return JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8")).results;
}

function collect(theme, dir) {
  for (const d of DESIGNS) copyFileSync(path.join(dir, d, "frame.png"), path.join(out, `${d}-${theme}.png`));
  if (!CLIP_THEMES.has(theme)) return;
  const clip = path.join(out, "motion", theme);
  mkdirSync(clip, { recursive: true });
  for (const f of ["transition.html", "transition.mp4", "stage-6.png"]) copyFileSync(path.join(dir, "motion", f), path.join(clip, f));
}

function labelsOf(dir) {
  return DESIGNS.flatMap((d) => {
    const html = readFileSync(path.join(dir, d, "frame.html"), "utf8");
    const data = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
    return data.frames[0].elements.flatMap((e) => e.lines ?? []);
  });
}

async function measure(labels) {
  const browser = await openBrowser(pwDir, chromium);
  try {
    return await measureFaces(browser, themeStyles("dark").css, FACES, labels);
  } finally {
    await browser.close();
  }
}

function fontRows(faces) {
  return faces.map((f) => {
    const xh = f.xHeight * PX;
    const floor = Math.ceil(FLOOR_X_HEIGHT / f.xHeight);
    return `<tr><td>${esc(f.name)}</td><td>${esc(f.stack)} ${f.weight}</td><td>${f.xHeight}</td><td>${xh.toFixed(1)} px ${xh >= FLOOR_X_HEIGHT ? "meets" : "<b>misses</b>"} 22</td><td>${floor} px</td><td>${f.avgAdvance} em</td><td>${f.worstFill}</td></tr>`;
  });
}

function cell(m, design, theme) {
  const png = `${design}-${theme}.png`;
  const facts = [`labels ${m.labels}`, `min label ${m.minLabelPx} px`, `label overlaps ${m.labelOverlaps}`, `label overflow ${m.labelOverflow}`];
  return `<figure><figcaption>${theme}</figcaption><a href="${png}"><img src="${png}" width="620" alt="${design} ${theme}"></a><p>${facts.join(" · ")}</p></figure>`;
}

function page(all, faces) {
  const rows = DESIGNS.map((d) => `<h2>${esc(all.plain.find((m) => m.name === d).title)}</h2>
<div class="row">${THEMES.map((t) => cell(all[t].find((m) => m.name === d), d, t)).join("")}</div>`);
  const clips = [...CLIP_THEMES].map((t) => `<a href="motion/${t}/transition.html">${t} player</a> · <a href="motion/${t}/transition.mp4">${t} mp4</a>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>L1 map: titan-design theming</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f4f4f4}.row{display:flex;gap:16px}
figure{margin:0}img{display:block;border:1px solid #999}p{font-size:13px;max-width:620px;margin:4px 0 0}
table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #bbb;padding:3px 6px;text-align:left}
</style></head><body><h1>L1 map at a ${PX} px floor: plain | titan dark | titan light</h1>
<p>Same layout in all three columns; only the stylesheet changes. Each frame is a true 1920x1080 render shown at about a third;
click for full size. Green bars top right are 24, 32 and 40 px. Token mapping and proposed diagram tokens: <a href="gaps.md">gaps.md</a>.</p>
<h2>Label faces (x-height floor ${FLOOR_X_HEIGHT} px)</h2><table><tr><th>role</th><th>face</th><th>x-height / em</th><th>x-height at ${PX} px</th><th>size for 22 px</th><th>avg advance</th><th>worst label vs 0.6 em budget</th></tr>
${fontRows(faces).join("\n")}</table>
<h2>Transition clip</h2><p>${clips.join(" | ")}</p>
${rows.join("\n")}</body></html>`;
}

mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(path.dirname(out), ".l1-theme-"));
try {
  const all = {};
  for (const theme of THEMES) {
    const dir = path.join(work, theme);
    all[theme] = runBuild(theme, dir);
    collect(theme, dir);
  }
  const faces = await measure(labelsOf(path.join(work, "dark")));
  writeFileSync(path.join(out, "metrics.json"), JSON.stringify({ px: PX, faces, results: all }, null, 1));
  writeFileSync(path.join(out, "index.html"), page(all, faces));
  console.log(JSON.stringify(faces, null, 1));
} finally {
  rmSync(work, { recursive: true, force: true });
}
