import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSheetsCli } from "./contact-sheet-cli.js";
import type { FfmpegExec } from "./contact-sheet-render.js";

let dir = "";
const output: string[] = [];
const errors: string[] = [];

const ffmpeg: FfmpegExec = async (args) => {
  const out = args[args.length - 1]!;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, "png");
};

function writeInputs(): Record<string, string> {
  const files = {
    render: { beats: [{ id: "b01-title", startS: 0, durationS: 4 }, { id: "b02-rows", startS: 4, durationS: 6 }] },
    cues: { cues: [{ beat: "b02-rows", word: "scanner", atS: 1.2 }] },
    visual: { beats: [{ id: "b01-title", chapter: "ch1", render: "TitleBeat" }, { id: "b02-rows", chapter: "ch2", render: "ListBeat" }] },
    fill: {
      frame: { width: 1920, height: 1080 },
      moments: [
        { beat: "b01-title", t: 3.8, boxes: [{ element: "title", box: { x: 96, y: 400, width: 620, height: 120 } }] },
        { beat: "b02-rows", t: 9.8, boxes: [{ element: "card", box: { x: 192, y: 200, width: 1536, height: 600 } }] },
      ],
    },
  };
  return Object.fromEntries(Object.entries(files).map(([name, body]) => {
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(body));
    return [name, file];
  }));
}

const run = (argv: string[]) => runSheetsCli(argv, { ffmpeg, out: (text) => output.push(text), err: (text) => errors.push(text) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sheets-cli-"));
  output.length = 0;
  errors.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("explainer sheets", () => {
  it("writes one sheet per chapter from the render's own timeline", async () => {
    const files = writeInputs();
    const out = path.join(dir, "out");

    const code = await run(["sheets", "--video", "demo.mp4", "--render", files.render!, "--cues", files.cues!, "--visual", files.visual!, "--out", out]);

    expect(code).toBe(0);
    expect(existsSync(path.join(out, "sheet-ch1.png")) && existsSync(path.join(out, "sheet-ch2.png"))).toBe(true);
    expect(output.join("")).toContain("sheets: 2 cells on 2 chapter sheets");
  });

  it("exits 1 and names the beat when one fails the content-fill gate", async () => {
    const files = writeInputs();

    const code = await run(["sheets", "--video", "demo.mp4", "--render", files.render!, "--cues", files.cues!, "--visual", files.visual!, "--out", path.join(dir, "out"), "--fill", files.fill!]);

    expect(code).toBe(1);
    expect(errors.join("")).toBe("content-fill FAIL b01-title: content spans 32 % of the frame width (floor 60 %)\n");
    expect(output.join("")).toContain("content-fill: 1 of 2 beats pass");
  });

  it("exits 2 on a missing required option", async () => {
    const code = await run(["sheets", "--video", "demo.mp4"]);

    expect(code).toBe(2);
  });
});
