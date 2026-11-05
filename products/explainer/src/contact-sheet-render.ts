import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chapterSheets, type SheetCell } from "./contact-sheet.js";
import { sha256 } from "./workflow/artifacts.js";

/**
 * Draws the sheets ffmpeg-side: one still per cell with its label in a strip under the frame (a label drawn on the
 * frame hid the headline), tiled into one PNG per chapter. Every cell is tiled. A cue that changes nothing on screen
 * is a lint finding (TP-4016), never a dropped cell: a 16×16 hash could not see a code focus bar move.
 */

/** Runs `ffmpeg <args>`; rejects when it exits non-zero. */
export type FfmpegExec = (args: readonly string[]) => Promise<void>;

export const LABEL_STRIP_PX = 32;
export const DEFAULT_CELL_WIDTH = 640;
export const DEFAULT_COLUMNS = 3;

export interface SheetOptions {
  columns?: number;
  cellWidth?: number;
}

export interface FramedCell extends SheetCell {
  /** The still, relative to the output directory. */
  frame: string;
  /** sha256 of the still's bytes: what a later stage compares, never what this one drops cells by. */
  sha: string;
}

export interface ChapterSheet {
  chapter: string;
  file: string;
  cells: string[];
}

export interface SheetSet {
  sheets: ChapterSheet[];
  cells: FramedCell[];
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

// drawtext reads quotes, colons, backslashes and percents as syntax; beat ids never need them.
const drawable = (label: string) => label.replace(/[^A-Za-z0-9 ._/-]/g, "_");

export function cellArgs(video: string, cell: SheetCell, out: string, width: number): string[] {
  const strip = `pad=iw:ih+${LABEL_STRIP_PX}:0:0:color=0x111111`;
  const text = `drawtext=text='${drawable(cell.label)}':x=8:y=h-${LABEL_STRIP_PX - 7}:fontsize=18:fontcolor=white`;
  return [...QUIET, "-ss", cell.t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2,${strip},${text}`, out];
}

export function tileArgs(list: string, count: number, columns: number, out: string): string[] {
  const across = Math.min(columns, count);
  const rows = Math.ceil(count / across);
  return [...QUIET, "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=${across}x${rows}:padding=6:color=0x555555`, "-frames:v", "1", out];
}

async function extractCells(video: string, cells: readonly SheetCell[], outDir: string, width: number, ffmpeg: FfmpegExec): Promise<FramedCell[]> {
  mkdirSync(path.join(outDir, "cells"), { recursive: true });
  const framed: FramedCell[] = [];
  for (const [i, cell] of cells.entries()) {
    const frame = path.join("cells", `${String(i).padStart(3, "0")}.png`);
    await ffmpeg(cellArgs(video, cell, path.join(outDir, frame), width));
    framed.push({ ...cell, frame, sha: sha256(readFileSync(path.join(outDir, frame))) });
  }
  return framed;
}

/** Writes `cells/NNN.png`, `sheet-<chapter>.png` per chapter and `cells.json` under `outDir`. */
export async function writeContactSheets(video: string, cells: readonly SheetCell[], outDir: string, ffmpeg: FfmpegExec, options: SheetOptions = {}): Promise<SheetSet> {
  const framed = await extractCells(path.resolve(video), cells, outDir, options.cellWidth ?? DEFAULT_CELL_WIDTH, ffmpeg);
  const sheets: ChapterSheet[] = [];
  for (const { chapter, cells: group } of chapterSheets(framed)) {
    const tiled = group.map((cell) => cell.frame);
    const list = path.join(outDir, `sheet-${chapter}.list`);
    writeFileSync(list, tiled.map((frame) => `file '${path.resolve(outDir, frame)}'\n`).join(""));
    const file = `sheet-${chapter}.png`;
    await ffmpeg(tileArgs(list, tiled.length, options.columns ?? DEFAULT_COLUMNS, path.join(outDir, file)));
    sheets.push({ chapter, file, cells: group.map((cell) => cell.key) });
  }
  writeFileSync(path.join(outDir, "cells.json"), `${JSON.stringify({ sheets, cells: framed }, null, 2)}\n`);
  return { sheets, cells: framed };
}
