#!/usr/bin/env node
// Evidence for the owner's L1 decision packet, all in titan dark at 1080: D2-D5 at a 40 and a
// 44 px floor (fit, k, counts, fallbacks, stability against the ladder step before) with the
// matrix's targets; the D2 → D4 → D5 ladder (D5 entering a package D4 shows) at both sizes with
// its zoom clip; the cross-step clip at L1_PACKET_CLIP_PX (default 40); and two variants, A'
// (44 px, box labels budgeted at the face's measured advance) and C in titan colours (40 px,
// labels in the pinned face). Copies the PNGs, clips and stills into <outDir> under flat names
// and writes <outDir>/evidence.json.
// Usage: node tools/l1-protos/packet-builds.mjs <snapshot.json> <outDir> <playwright-core dir> [chromium]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [40, 44];
const DESIGNS = ["d2-area-overview", "d3-expand-in-place", "d4-area-focus", "d5-package-focus"];
const CLIP_PX = Number(process.env.L1_PACKET_CLIP_PX ?? 40);
const [snapshot, outArg, ...rest] = process.argv.slice(2);
const out = path.resolve(outArg);
const build = path.join(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");

function runBuild(dir, env) {
  const full = { ...process.env, L1_THEME: "dark", L1_FRAME: "1080p", ...env };
  const run = spawnSync("node", [build, snapshot, dir, ...rest], { env: full, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`build ${JSON.stringify(env)} failed: ${run.stderr.slice(-2000)}`);
  return JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8"));
}

// One design at one size, as the page reports it.
function summary(r) {
  const stability = r.rules.stability;
  return {
    name: r.name,
    title: r.title,
    fits: r.fit >= 1 && r.rules.labelFloor.ok,
    fit: r.fit,
    k: r.k,
    open: r.open,
    boxes: r.boxes,
    edges: r.edges,
    labels: r.labels,
    minLabelPx: r.minLabelPx,
    pillsDropped: r.pillsDropped,
    labelOverflow: r.labelOverflow,
    labelOverlaps: r.labelOverlaps,
    fallbacks: r.fallbacks,
    violated: r.violated,
    stability: stability.value ? { ...stability.value, budget: stability.threshold, ok: stability.ok, from: stability.detail } : null,
  };
}

// `variant` = { tag, env }: a suffix for the copied files and the env that selects it.
const PLAIN_VARIANT = { tag: "", env: {} };
const VARIANTS = {
  facePrime: { tag: "-face", env: { L1_FACE_ADVANCE: "1" } },
  cTitan: { tag: "-pinned", env: { L1_LABEL_FACE: "pinned" } },
};

function staticSize(work, px, variant = PLAIN_VARIANT) {
  const dir = path.join(work, `px${px}${variant.tag}`);
  const metrics = runBuild(dir, { L1_LABEL_PX: String(px), L1_CLIP: "0", ...variant.env });
  for (const d of DESIGNS) copyFileSync(path.join(dir, d, "frame.png"), path.join(out, `${d}-${px}${variant.tag}.png`));
  return { px, xHeightPx: metrics.frame.xHeightPx, caps: metrics.frame.caps, designs: metrics.results.map(summary) };
}

function ladder(work, px, zoom, variant = PLAIN_VARIANT) {
  const name = `ladder-${zoom ? "zoom" : "cross"}-${px}${variant.tag}`;
  const dir = path.join(work, name);
  const env = { L1_LABEL_PX: String(px), L1_CLIP: "ladder", L1_LADDER_ZOOM: zoom ? "1" : "0", L1_LADDER_PACKAGE: "1", ...variant.env };
  const metrics = runBuild(dir, env);
  const motion = metrics.results.find((r) => r.clip);
  copyFileSync(path.join(dir, motion.name, "transition.mp4"), path.join(out, `${name}.mp4`));
  copyFileSync(path.join(dir, "d5-package-focus", "frame.png"), path.join(out, `d5-ladder-${px}${variant.tag}.png`));
  const stills = motion.clip.stages.map((s, i) => {
    const file = `${name}-stage-${i + 1}.png`;
    copyFileSync(path.join(dir, motion.name, s.still), path.join(out, file));
    return { label: s.label, t: s.t, still: file };
  });
  const designs = metrics.results.filter((r) => !r.clip && /^d[245]-/.test(r.name)).map(summary);
  return { name, px, zoom, mp4: `${name}.mp4`, duration: motion.clip.duration, mental: motion.mental, stills, designs };
}

mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(out, ".l1-packet-"));
try {
  const ladders = [...SIZES.map((px) => ladder(work, px, true)), ladder(work, CLIP_PX, false)];
  const variants = {
    facePrime: { static: staticSize(work, 44, VARIANTS.facePrime), ladder: ladder(work, 44, true, VARIANTS.facePrime) },
    cTitan: { static: staticSize(work, 40, VARIANTS.cTitan), ladder: ladder(work, 40, true, VARIANTS.cTitan) },
  };
  const evidence = { sizes: SIZES.map((px) => staticSize(work, px)), ladders, variants };
  writeFileSync(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 1));
  console.log(JSON.stringify(evidence, null, 1));
} finally {
  rmSync(work, { recursive: true, force: true });
}
