// Shoots each twin route twice per viewport in fresh browser contexts and fails on any byte difference.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launch, settleFonts, type Viewport } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { SECOND_SHOT_SKEW_MS, TWIN_NOW, frozenClockScript } from "./clock.js";
import type { TwinRoute } from "./routes.js";

const MANIFEST_FORMAT = "titan-console-twin/v1";

interface CaptureOptions {
  /** A built console page with the twin snapshot embedded; it opens from disk, so no daemon answers it. */
  html: string;
  routes: readonly TwinRoute[];
  viewports: Readonly<Record<string, Viewport>>;
  outDir: string;
  /** Contexts open at once. */
  parallel?: number;
}

interface CapturedFrame {
  route: string;
  hash: string;
  viewport: string;
  /** Relative to the output dir. */
  file: string;
  sha256: string;
}

interface TwinManifest {
  format: typeof MANIFEST_FORMAT;
  now: string;
  viewports: Readonly<Record<string, Viewport>>;
  frames: CapturedFrame[];
}

/** Thrown when a route's two shots differ; both shots of each are left in the output dir for a look. */
export class NondeterministicCaptureError extends Error {
  constructor(readonly differing: readonly string[]) {
    super(`twin capture differs between two shots of: ${differing.join(", ")}`);
    this.name = "NondeterministicCaptureError";
  }
}

/** A video's native controls draw an endless loading spinner for a source that never loads, which no screenshot option stops. */
const TWIN_STYLE = "video::-webkit-media-controls { display: none !important; }";

const SETTLE_QUIET_MS = 250;
const SETTLE_TIMEOUT_MS = 15_000;
const SNAPSHOT_MISS = "is not in this snapshot";

/**
 * The page is shot offline. react-ui's stylesheet imports its web fonts from Google Fonts, so text falls back to the
 * system sans; that request alone is let fail quietly, and any other one off disk fails the capture.
 */
const EXPECTED_OFFLINE = /^https:\/\/fonts\.googleapis\.com\//;

/**
 * Resolves once the DOM has not changed for the quiet window and every image and video has loaded or failed; real
 * timers are left running. Plain source for the reason `frozenClockScript` gives.
 */
const SETTLE_SCRIPT = `new Promise((resolve, reject) => {
  const mediaDone = () =>
    Array.from(document.images).every((image) => image.complete) &&
    Array.from(document.querySelectorAll("video")).every((video) => video.error !== null || video.readyState >= 1);
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(check, ${SETTLE_QUIET_MS});
  });
  const deadline = setTimeout(() => {
    observer.disconnect();
    reject(new Error("page did not settle within ${SETTLE_TIMEOUT_MS} ms"));
  }, ${SETTLE_TIMEOUT_MS});
  const check = () => {
    if (!mediaDone()) {
      timer = setTimeout(check, ${SETTLE_QUIET_MS});
      return;
    }
    observer.disconnect();
    clearTimeout(deadline);
    resolve();
  };
  timer = setTimeout(check, ${SETTLE_QUIET_MS});
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})`;

function assertFontsLoaded(fonts: Awaited<ReturnType<typeof settleFonts>>, where: string): void {
  const unloaded = fonts.filter((font) => font.status !== "loaded");
  if (unloaded.length > 0) throw new Error(`${where}: fonts not loaded: ${unloaded.map((font) => `${font.family} (${font.status})`).join(", ")}`);
}

/** One shot in a fresh context: frozen clock at `nowMs`, UTC, en-US, reduced motion, animations stopped at capture. */
async function shoot(browser: Browser, url: string, viewport: Viewport, nowMs: number, where: string): Promise<Buffer> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce", colorScheme: "dark" });
  try {
    await context.addInitScript({ content: frozenClockScript(nowMs) });
    const errors: Error[] = [];
    await context.route(/^(?!file:)/, (route) => {
      if (!EXPECTED_OFFLINE.test(route.request().url())) errors.push(new Error(`asked the network for ${route.request().url()}`));
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(url, { waitUntil: "load" });
    await page.addStyleTag({ content: TWIN_STYLE });
    assertFontsLoaded(await settleFonts(page), where);
    await page.evaluate(SETTLE_SCRIPT);
    if (errors[0]) throw new Error(`${where}: ${errors[0].message}`);
    if ((await page.textContent("body"))?.includes(SNAPSHOT_MISS)) throw new Error(`${where}: the page asked for a call the twin snapshot does not hold`);
    return await page.screenshot({ type: "png", caret: "hide", animations: "disabled" });
  } finally {
    await context.close();
  }
}

interface Job {
  route: TwinRoute;
  viewport: string;
}

async function runJob(browser: Browser, pageUrl: string, options: CaptureOptions, job: Job): Promise<{ frame: CapturedFrame; same: boolean }> {
  const where = `${job.route.name}@${job.viewport}`;
  const url = `${pageUrl}${job.route.hash}`;
  const size = options.viewports[job.viewport]!;
  const first = await shoot(browser, url, size, TWIN_NOW, where);
  const second = await shoot(browser, url, size, TWIN_NOW + SECOND_SHOT_SKEW_MS, where);
  const file = path.join(job.viewport, `${job.route.name}.png`);
  await writeFile(path.join(options.outDir, file), first);
  const same = first.equals(second);
  if (!same) await writeFile(path.join(options.outDir, job.viewport, `${job.route.name}.second.png`), second);
  return { same, frame: { route: job.route.name, hash: job.route.hash, viewport: job.viewport, file, sha256: createHash("sha256").update(first).digest("hex") } };
}

async function runAll<T, R>(items: readonly T[], parallel: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await run(items[index]!);
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  return results;
}

/** Only what a capture writes, so an `--out` that names a dir with other files in it loses none of them. */
async function clearFrames({ outDir, viewports }: CaptureOptions): Promise<void> {
  await rm(path.join(outDir, "manifest.json"), { force: true });
  for (const viewport of Object.keys(viewports)) {
    const dir = path.join(outDir, viewport);
    await mkdir(dir, { recursive: true });
    const frames = (await readdir(dir)).filter((name) => name.endsWith(".png"));
    await Promise.all(frames.map((name) => rm(path.join(dir, name))));
  }
}

/** Writes `<viewport>/<route>.png` and `manifest.json` under `outDir`; throws `NondeterministicCaptureError` after writing them if any route's two shots differ. */
export async function captureTwin(options: CaptureOptions): Promise<TwinManifest> {
  const scratch = await mkdtemp(path.join(tmpdir(), "titan-console-twin-"));
  const pageFile = path.join(scratch, "console.html");
  await writeFile(pageFile, options.html);
  await clearFrames(options);
  const jobs = options.routes.flatMap((route) => Object.keys(options.viewports).map((viewport) => ({ route, viewport })));
  const browser = await launch();
  try {
    const results = await runAll(jobs, options.parallel ?? 4, (job) => runJob(browser, pathToFileURL(pageFile).href, options, job));
    const manifest: TwinManifest = { format: MANIFEST_FORMAT, now: new Date(TWIN_NOW).toISOString(), viewports: options.viewports, frames: results.map((result) => result.frame) };
    await writeFile(path.join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const differing = results.filter((result) => !result.same).map(({ frame }) => `${frame.route}@${frame.viewport}`);
    if (differing.length > 0) throw new NondeterministicCaptureError(differing);
    return manifest;
  } finally {
    await browser.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
