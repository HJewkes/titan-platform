import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FfmpegExec } from "../contact-sheet-render.js";
import { pairCells, parseSsim, writePairSheet } from "./pair-sheet.js";
import { parseTimeline } from "./timeline.js";

const KINDS = parseTimeline(JSON.parse(readFileSync(new URL("../../fixtures/kinds.timeline.json", import.meta.url), "utf8")));

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** ffmpeg that writes its output file (the last argument) and records each call. */
function fakeFfmpeg(): FfmpegExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = async (args: readonly string[]) => {
    calls.push([...args]);
    writeFileSync(args.at(-1)!, `still ${calls.length}`);
  };
  return Object.assign(exec, { calls });
}

describe("the bridged-vs-in-process pair sheet", () => {
  it("cuts one cell per beat inside that beat's window, labelled with its kind", () => {
    const cells = pairCells(KINDS);

    expect(cells.map((c) => c.beat)).toEqual(KINDS.beats.map((b) => b.id));
    for (const [i, beat] of KINDS.beats.entries()) {
      expect(cells[i]!.t).toBeGreaterThan(beat.startS);
      expect(cells[i]!.t).toBeLessThan(beat.startS + beat.durationS);
    }
    expect(cells.find((c) => c.beat === "beat-05")?.label).toMatch(/^chart-bar beat-05/);
  });

  // Mutation: drop the R5 note; claim-card's pair would read as a regression, not a known change.
  it("marks the R5 known differences on their pairs, and no others", () => {
    const marked = pairCells(KINDS).filter((c) => c.known !== undefined).map((c) => c.kind);

    expect(marked).toEqual(["hook", "chart-bar", "chart-line", "compare", "claim-card"]);
  });

  it("writes one side-by-side tile per beat, bridged left and in-process right, with its SSIM", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pair-sheet-"));
    const ffmpeg = fakeFfmpeg();
    const ssim = async (left: string, right: string) => (path.basename(left) === path.basename(right) ? 0.9 : 0);

    const { pairs } = await writePairSheet("bridged.mp4", "in-process.mp4", KINDS, dir, { ffmpeg, ssim });

    const stacks = ffmpeg.calls.filter((args) => args.includes("hstack=inputs=2"));
    expect(stacks).toHaveLength(KINDS.beats.length);
    expect(stacks[3]!.filter((a) => a.endsWith(".png")).map((a) => path.relative(dir, a))).toEqual(["bridged/cells/003.png", "in-process/cells/003.png", "pairs/pair-04-beat-01.png"]);
    const report = JSON.parse(readFileSync(path.join(dir, "ssim.json"), "utf8")) as { beat: string; ssim: number }[];
    expect(report.map((r) => r.beat)).toEqual(KINDS.beats.map((b) => b.id));
    expect(pairs.every((p) => p.ssim === 0.9)).toBe(true);
  });

  it("reads the All: score from ffmpeg's ssim stats", () => {
    expect(parseSsim("n:1 Y:0.950 U:0.990 V:0.980 All:0.962113 (14.2)\n")).toBe(0.962113);
  });
});
