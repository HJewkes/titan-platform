import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverflowRow } from "../composition/beats/stage/overflow-row.js";
import { fakeRenderDeps } from "./render-fakes.test-helpers.js";
import { timelineOf } from "./render-fixtures.test-helpers.js";
import { renderVideo, type RenderInput } from "./render-video.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-fit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const input = (): RenderInput => ({ timeline: timelineOf([1, 1]), pageUrl: "http://127.0.0.1:1/", pageSha: "a".repeat(64), workers: 2, outDir: path.join(dir, "out"), stem: "sample" });

const row = (beat: string, element: string, right: number): OverflowRow => ({
  beat, element, px: right, sides: { top: 0, right, bottom: 0, left: 0 }, hint: `shorten ${element} "synthetic" to <= 6 chars`,
});

describe("renderVideo's stage-fit scan", () => {
  it("refuses once, naming every beat past its stage box, before it mixes or captures anything", async () => {
    const deps = fakeRenderDeps({ overflows: [row("beat-1", "figures-2 beat-stat-label", 30), row("beat-2", "beat-heading", 80)] });

    const render = renderVideo(input(), deps);

    await expect(render).rejects.toThrow(
      /^render: 2 beats overflow the stage box at the 40 px type floor:\n {2}beat-1 overflows its stage box by 30 px \(right 30\): figures-2 beat-stat-label; shorten .*\n {2}beat-2 overflows .*beat-heading/,
    );
    expect(existsSync(path.join(dir, "out", "mix.wav"))).toBe(false);
    expect(existsSync(path.join(dir, "out", "sample.mp4"))).toBe(false);
  });

  it("renders when every beat fits its stage box", async () => {
    const result = await renderVideo(input(), fakeRenderDeps());

    expect(result.data.frames).toBe(60);
  });
});
