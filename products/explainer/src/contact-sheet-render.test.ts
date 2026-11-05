import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SheetCell } from "./contact-sheet.js";
import { writeContactSheets, type FfmpegExec } from "./contact-sheet-render.js";

const cell = (beat: string, chapter: string, tag: string, t: number): SheetCell => ({
  key: `${beat}/${tag}`, beat, chapter, rule: "focus", tag, local: t, t, label: `${beat} focus ${tag} ${t.toFixed(1)}s`,
});

/** A code walk whose second focus step moves only a thin bar: its still is byte-identical to the first step's here. */
const CELLS = [
  cell("b09-rows", "ch1", "settled", 3),
  cell("b10-walk", "ch2", "step1", 10),
  cell("b10-walk", "ch2", "step2", 12),
  cell("b10-walk", "ch2", "step3", 14),
];

interface FakeFfmpeg {
  exec: FfmpegExec;
  calls: string[][];
}

/** Writes the output file each call names; a still's bytes depend on its time, except that 12 s looks like 10 s. */
function fakeFfmpeg(): FakeFfmpeg {
  const calls: string[][] = [];
  const exec: FfmpegExec = async (args) => {
    calls.push([...args]);
    const out = args[args.length - 1]!;
    const at = args[args.indexOf("-ss") + 1];
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, at === undefined ? "sheet" : `frame@${at === "12.000" ? "10.000" : at}`);
  };
  return { exec, calls };
}

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeContactSheets", () => {
  it("tiles every cell, even a focus step whose still matches the step before it", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "contact-sheet-"));
    const ffmpeg = fakeFfmpeg();

    const set = await writeContactSheets("demo.mp4", CELLS, dir, ffmpeg.exec);

    expect(set.sheets.find((sheet) => sheet.chapter === "ch2")?.cells).toEqual(["b10-walk/step1", "b10-walk/step2", "b10-walk/step3"]);
    expect(readFileSync(path.join(dir, "sheet-ch2.list"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("writes one sheet per chapter and a cells.json naming each still and its sha", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "contact-sheet-"));

    const set = await writeContactSheets("demo.mp4", CELLS, dir, fakeFfmpeg().exec);

    expect(set.sheets.map((sheet) => sheet.file)).toEqual(["sheet-ch1.png", "sheet-ch2.png"]);
    const written = JSON.parse(readFileSync(path.join(dir, "cells.json"), "utf8"));
    expect(written.cells.map((c: { frame: string }) => c.frame)).toEqual(["cells/000.png", "cells/001.png", "cells/002.png", "cells/003.png"]);
    expect(written.cells[1].sha).toBe(written.cells[2].sha);
  });

  it("draws the label in a strip under the frame and seeks to the cell's time", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "contact-sheet-"));
    const ffmpeg = fakeFfmpeg();

    await writeContactSheets("demo.mp4", CELLS.slice(0, 1), dir, ffmpeg.exec, { cellWidth: 480 });

    const [extract, tile] = ffmpeg.calls;
    expect(extract).toEqual(expect.arrayContaining(["-ss", "3.000", "-frames:v", "1"]));
    expect(extract![extract!.indexOf("-vf") + 1]).toBe("scale=480:-2,pad=iw:ih+32:0:0:color=0x111111,drawtext=text='b09-rows focus settled 3.0s':x=8:y=h-25:fontsize=18:fontcolor=white");
    expect(tile![tile!.indexOf("-vf") + 1]).toBe("tile=1x1:padding=6:color=0x555555");
  });

  it("wraps a chapter's cells into rows of the requested width", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "contact-sheet-"));
    const ffmpeg = fakeFfmpeg();

    await writeContactSheets("demo.mp4", CELLS, dir, ffmpeg.exec, { columns: 2 });

    const tiles = ffmpeg.calls.filter((args) => args.includes("concat")).map((args) => args[args.indexOf("-vf") + 1]);
    expect(tiles).toEqual(["tile=1x1:padding=6:color=0x555555", "tile=2x2:padding=6:color=0x555555"]);
  });
});
