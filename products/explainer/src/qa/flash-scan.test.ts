import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flashScan } from "./flash-scan.js";

const FPS = 30;
const FFMPEG_TIMEOUT_MS = 60_000;

/** A 2 s clip of `base` with a `box` drawn over it on alternate halves of each cycle: `hz` flashes a second. */
function clip(dir: string, name: string, { base, box, hz, size = "" }: { base: string; box: string; hz: number; size?: string }): string {
  const out = path.join(dir, `${name}.mp4`);
  const blink = `drawbox=${size}c=${box}:t=fill:enable='lt(mod(t*${2 * hz},2),1)'`;
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${base}:s=320x180:r=${FPS}:d=2,${blink}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", out]);
  return out;
}

describe("flashScan on clips ffmpeg makes", { timeout: FFMPEG_TIMEOUT_MS }, () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "explainer-flash-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails a full-frame black and white flash at 5 Hz", async () => {
    const video = clip(dir, "general-5hz", { base: "black", box: "white", hz: 5 });

    const report = await flashScan(video, FPS);

    expect(report.general.maxPerS).toBe(5);
    expect(report.general.windows).toEqual([{ startS: 0, endS: 2 }]);
    expect(report.red).toEqual({ maxPerS: 0, windows: [] });
  });

  it("passes the same flash at 2 Hz, under three a second", async () => {
    const video = clip(dir, "general-2hz", { base: "black", box: "white", hz: 2 });

    const report = await flashScan(video, FPS);

    expect(report.general.maxPerS).toBe(2);
    expect(report.general.windows).toEqual([]);
  });

  it("passes a 5 Hz flash between white and a light grey, whose darker state is not below 0.80", async () => {
    const video = clip(dir, "bright-5hz", { base: "0xEDEDED", box: "white", hz: 5 });

    const report = await flashScan(video, FPS);

    expect(report.general).toEqual({ maxPerS: 0, windows: [] });
  });

  it("fails a saturated red flash on a grey of the same luminance as a red flash only", async () => {
    const video = clip(dir, "red-5hz", { base: "0x7F7F7F", box: "red", hz: 5 });

    const report = await flashScan(video, FPS);

    expect(report.general.maxPerS).toBe(0);
    expect(report.red.maxPerS).toBe(5);
    expect(report.red.windows).not.toEqual([]);
  });

  it("passes a 5 Hz flash on 1 % of the frame, under the small-area threshold", async () => {
    const video = clip(dir, "small-5hz", { base: "black", box: "white", hz: 5, size: "x=148:y=78:w=24:h=24:" });

    const report = await flashScan(video, FPS);

    expect(report.general).toEqual({ maxPerS: 0, windows: [] });
  });

  it("rejects a video ffmpeg cannot read instead of reading it as flash-free", async () => {
    await expect(flashScan(path.join(dir, "missing.mp4"), FPS)).rejects.toThrow(/ffmpeg exited/);
  });
});
