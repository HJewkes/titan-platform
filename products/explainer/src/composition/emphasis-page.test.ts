import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFrame, launch, openCapturePage } from "@titan-design/frame-capture";
import { changedShare as greyChangedShare, decodeArgs, FRAMEDIFF_HEIGHT, FRAMEDIFF_WIDTH, spawnFfmpeg } from "@titan-design/render-qa";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CHANNEL_TOLERANCE, changedShare, MIN_CHANGED_SHARE, type EmphasisBox, type MarkFrame } from "../emphasis-change.js";
import { FLOW_DWELL_S } from "./beats/stage/video.js";
import { buildPage, servePage, STAGE, type PageServer } from "./page.test-helpers.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** qa's static-window counts a frame as moving past this many changed pixels of its 320x180 grey frame. */
const STATIC_WINDOW_PX = 10;
/** Before the lit ramp starts, and halfway through the dwell. */
const BEFORE_S = 0.4;
const DURING_S = FLOW_DWELL_S / 2;
/** Room around the element's own box for its ring and an SVG edge's stroke, which its bounding box leaves out. */
const BOX_PAD_PX = 8;

/** One emphasis of fixtures/emphasis.timeline.json: its beat's start, the element it names and its beat-local time. */
const CASES = [
  { kind: "list row", beat: "list-lit", startS: 0, target: "rows-2", atS: 3.5 },
  { kind: "bar", beat: "bar-lit", startS: 6, target: "series-2", atS: 3.5 },
  { kind: "arch-map node", beat: "map-lit", startS: 12, target: "nodes-2", atS: 6, box: ".ex-map-node" },
  { kind: "arch-map edge", beat: "map-lit", startS: 12, target: "edges-2", atS: 8 },
  { kind: "stat", beat: "stat-lit", startS: 22, target: "figures-1", atS: 3.5 },
  { kind: "claim", beat: "claim-lit", startS: 28, target: "claim", atS: 3.5 },
] as const satisfies readonly { kind: string; beat: string; startS: number; target: string; atS: number; box?: string }[];

let pageDir: string;
let server: PageServer;
let browser: Browser;
let page: Page;
let scratch: string;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, 0);
  browser = await launch();
  ({ page } = await openCapturePage(browser, server.url("index.html", "/timelines/emphasis.timeline.json"), STAGE));
  scratch = mkdtempSync(join(tmpdir(), "explainer-emphasis-"));
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function decoded(png: Buffer, name: string, args: (file: string) => string[]): Promise<Uint8Array> {
  const file = join(scratch, `${name}.png`);
  writeFileSync(file, png);
  const chunks: Uint8Array[] = [];
  for await (const chunk of spawnFfmpeg(args(file))) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const rgbaArgs = (file: string) => ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];

interface Frame {
  full: MarkFrame;
  grey: Uint8Array;
}

async function frameAt(t: number, name: string): Promise<Frame> {
  const png = await captureFrame(page, t);
  return { full: { ...STAGE, rgba: await decoded(png, name, rgbaArgs) }, grey: await decoded(png, name, decodeArgs) };
}

/** The element's box on the page, or that of its nearest `box` ancestor (a map node, whose label carries the id). */
function elementBox({ beat, target, box, pad }: { beat: string; target: string; box: string | undefined; pad: number }): EmphasisBox {
  const el = document.querySelector(`[data-stage="${beat}"] [data-reveal="${target}"]`)!;
  const rect = (box === undefined ? el : el.closest(box)!).getBoundingClientRect();
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad };
}

const inside = (box: EmphasisBox, x: number, y: number) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

/**
 * A step a viewer sees, not just one past encoder noise: three times the noise tolerance. A tint of under a tenth
 * moves no channel that far (5 % of the full range is 13 levels), so only a treatment as strong as the token's lit
 * node clears it.
 */
const VISIBLE_LEVELS = 3 * CHANNEL_TOLERANCE;

const movedPast = (a: MarkFrame, b: MarkFrame, at: number, levels: number) => [0, 1, 2, 3].some((c) => Math.abs(a.rgba[at + c]! - b.rgba[at + c]!) > levels);

/** Full-resolution pixels between two frames that moved more than `levels`, counted inside or outside `box`. */
function movedPixels(a: MarkFrame, b: MarkFrame, box: EmphasisBox, where: "inside" | "outside", levels: number): number {
  let moved = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (inside(box, x, y) === (where === "inside") && movedPast(a, b, (y * a.width + x) * 4, levels)) moved++;
    }
  }
  return moved;
}

const greyPixelsChanged = (a: Uint8Array, b: Uint8Array) => Math.round(greyChangedShare(a, b) * FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT);

describe("a lit element on the rendered page", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: light at a 5 % tint with no ring; no pixel of the lit box then moves VISIBLE_LEVELS, and it fails.
  // The change stays inside the element's own box: the treatment points at what the cue names and moves nothing else.
  test.each(CASES)("a lit $kind changes more than 10 px of the 320x180 frame, visibly and only inside its box", async (lit) => {
    // Arrange
    const { beat, startS, target, atS } = lit;
    const before = await frameAt(startS + atS - BEFORE_S, `${target}-before`);
    const during = await frameAt(startS + atS + DURING_S, `${target}-during`);
    const box = await page.evaluate(elementBox, { beat, target, box: "box" in lit ? lit.box : undefined, pad: BOX_PAD_PX });

    // Act
    const step = { before: before.full, after: during.full, target: box };
    const visible = movedPixels(before.full, during.full, box, "inside", VISIBLE_LEVELS) / (box.width * box.height);
    const greyPx = greyPixelsChanged(before.grey, during.grey);
    const outside = movedPixels(before.full, during.full, box, "outside", CHANNEL_TOLERANCE);

    // Assert
    expect(changedShare(step)).toBeGreaterThanOrEqual(MIN_CHANGED_SHARE);
    expect(visible).toBeGreaterThanOrEqual(MIN_CHANGED_SHARE);
    expect(greyPx).toBeGreaterThan(STATIC_WINDOW_PX);
    expect(outside).toBe(0);
  });
});
