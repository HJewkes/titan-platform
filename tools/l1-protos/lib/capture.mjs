// Headless capture: one browser for the whole run, pages rendered serially at the frame size.
// The page.evaluate callbacks run in the browser, hence its globals.
/* global document, window */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FPS = 25;

// file:// pages may not load a file:// font without the first flag; the pinned label font
// needs it. Software rendering keeps large (4K) captures from failing sporadically.
const LAUNCH_ARGS = ["--allow-file-access-from-files", "--disable-gpu"];
const SHOT_TRIES = 3;

// Page.captureScreenshot fails now and then on big viewports; a retry renders the same pixels.
async function screenshot(page, options) {
  for (let i = 1; ; i++) {
    try {
      return await page.screenshot(options);
    } catch (e) {
      if (i >= SHOT_TRIES) throw e;
      await page.waitForTimeout(200 * i);
    }
  }
}

export async function openBrowser(pwDir, executablePath) {
  const { chromium } = createRequire(path.join(path.resolve(pwDir), "package.json"))("playwright-core");
  return chromium.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
}

async function openPage(browser, file, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(file).href}?capture=1`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Screenshot, serialized SVG and DOM measurements of a static frame. */
export async function renderStatic(browser, file, png, viewport) {
  const page = await openPage(browser, file, viewport);
  try {
    const metrics = await page.evaluate(() => window.__measure());
    writeFileSync(png.replace(/\.png$/, ".svg"), await page.evaluate(() => window.__svg()));
    await screenshot(page, { path: png, clip: { x: 0, y: 0, ...viewport } });
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
export async function renderClip(browser, file, dir, viewport) {
  const page = await openPage(browser, file, viewport);
  const framesDir = path.join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  try {
    const duration = await page.evaluate(() => window.__duration);
    const count = Math.ceil(duration * FPS) + 1;
    for (let i = 0; i < count; i++) {
      await page.evaluate((t) => window.__seek(t), Math.min(duration, i / FPS));
      await screenshot(page, { path: path.join(framesDir, `f${String(i).padStart(4, "0")}.png`), clip: { x: 0, y: 0, ...viewport } });
    }
    const stages = [];
    for (const [i, s] of (await stageEnds(page)).entries()) {
      await page.evaluate((t) => window.__seek(t), s.t);
      const still = `stage-${i + 1}.png`;
      await screenshot(page, { path: path.join(dir, still), clip: { x: 0, y: 0, ...viewport } });
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
