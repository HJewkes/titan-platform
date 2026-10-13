// Headless capture: one browser for the whole run, pages rendered serially at 1920x1080.
// The page.evaluate callbacks run in the browser, hence its globals.
/* global document, window */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VIEWPORT = { width: 1920, height: 1080 };
const FPS = 25;

export async function openBrowser(pwDir, executablePath) {
  const { chromium } = createRequire(path.join(path.resolve(pwDir), "package.json"))("playwright-core");
  return chromium.launch({ executablePath, headless: true });
}

async function openPage(browser, file) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(file).href}?capture=1`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Screenshot and DOM measurements of a static frame. */
export async function renderStatic(browser, file, png) {
  const page = await openPage(browser, file);
  try {
    const metrics = await page.evaluate(() => window.__measure());
    await page.screenshot({ path: png, clip: { x: 0, y: 0, ...VIEWPORT } });
    return metrics;
  } finally {
    await page.close();
  }
}

// Stage boundaries from the timeline; the clip is measured at the end of each stage.
async function stageEnds(page) {
  return page.evaluate(() => {
    const out = [];
    let t = 0;
    for (const s of JSON.parse(document.getElementById("data").textContent).timeline) {
      t += s.dur;
      out.push({ label: s.label, t: +(t - 0.001).toFixed(3) });
    }
    return out;
  });
}

/** Every frame of the clip to an MP4, plus a still and measurements at each stage's end. */
export async function renderClip(browser, file, dir) {
  const page = await openPage(browser, file);
  const framesDir = path.join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  try {
    const duration = await page.evaluate(() => window.__duration);
    const count = Math.ceil(duration * FPS) + 1;
    for (let i = 0; i < count; i++) {
      await page.evaluate((t) => window.__seek(t), Math.min(duration, i / FPS));
      await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(4, "0")}.png`), clip: { x: 0, y: 0, ...VIEWPORT } });
    }
    const stages = [];
    for (const [i, s] of (await stageEnds(page)).entries()) {
      await page.evaluate((t) => window.__seek(t), s.t);
      const still = `stage-${i + 1}.png`;
      await page.screenshot({ path: path.join(dir, still), clip: { x: 0, y: 0, ...VIEWPORT } });
      stages.push({ ...s, still, ...(await page.evaluate(() => window.__measure())) });
    }
    encode(framesDir, path.join(dir, "transition.mp4"));
    return { duration, fps: FPS, frames: count, stages };
  } finally {
    await page.close();
    rmSync(framesDir, { recursive: true, force: true });
  }
}

function encode(framesDir, mp4) {
  const args = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(framesDir, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", mp4];
  const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}
