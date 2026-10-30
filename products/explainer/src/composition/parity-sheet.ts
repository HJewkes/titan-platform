import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureFrame, withBrowser, withCapturePage } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { decodeArgs, spawnFfmpeg, FRAMEDIFF_HEIGHT, FRAMEDIFF_WIDTH } from "@titan-design/render-qa";
import { DEFAULT_CELL_WIDTH, LABEL_STRIP_PX, tileArgs, type FfmpegExec } from "../contact-sheet-render.js";
import { servePage } from "../render/composition-page.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { OUTRO_FADE_OUT_S } from "./beats/stage/outro-fade.js";
import type { Timeline, TimelineBeat } from "./timeline.js";

/**
 * The per-kind screenshot sheet (TP-4276 plan section 3.1): each kind's first beat at its first reveal plus 0.6 s
 * and at its settled frame, so a reviewer sees every drawn kind on one page. Evidence for review, never a pixel gate.
 */

const FIRST_AFTER_S = 0.6;
const SETTLED_BEFORE_END_S = 0.1;
/** Kinds drawn by the OutroBeat port, which fades its content out at the end: they settle before the fade. */
const FADES_OUT_S: Readonly<Record<string, number>> = { button: OUTRO_FADE_OUT_S, outro: OUTRO_FADE_OUT_S };
/** Grey levels a pixel may sit from the background and still count as background (antialiasing, gradients). */
const INK_TOLERANCE = 8;
const STAGE = { width: 1920, height: 1080 };
/** A kind's first and settled frames side by side, one kind per row. */
const SHEET_COLUMNS = 2;

/** Kinds drawn by a different view per value of one slot, by that slot: each variant gets its own sheet row. */
const VARIANT_SLOT: Readonly<Record<string, string>> = { chart: "kind" };

interface KindCell {
  /** The spec type, with its variant when it has one (`chart-bar`, `chart-line`). */
  kind: string;
  beat: string;
  tag: "first" | "settled";
  /** Seconds from the timeline's start. */
  t: number;
}

/** The beat's spec type, suffixed with its variant slot's value for a kind that draws each variant differently. */
export function sheetKind(beat: TimelineBeat): string {
  const slot = Object.hasOwn(VARIANT_SLOT, beat.kind) ? VARIANT_SLOT[beat.kind]! : undefined;
  const variant: unknown = slot !== undefined && typeof beat.slots === "object" && beat.slots !== null ? Reflect.get(beat.slots, slot) : undefined;
  return typeof variant === "string" ? `${beat.kind}-${variant}` : beat.kind;
}

/** Seconds from the beat's start to its settled frame: its end less 0.1 s, before the fade for a kind that fades out. */
export function settledS(beat: TimelineBeat): number {
  const fade = Object.hasOwn(FADES_OUT_S, beat.kind) ? FADES_OUT_S[beat.kind]! : 0;
  return beat.durationS - fade - SETTLED_BEFORE_END_S;
}

function cellsOf(beat: TimelineBeat): KindCell[] {
  const settled = settledS(beat);
  const firstReveal = Math.min(...(beat.reveals ?? []).map((r) => r.atS), Infinity);
  const first = Math.min((Number.isFinite(firstReveal) ? firstReveal : 0) + FIRST_AFTER_S, settled);
  return [
    { kind: sheetKind(beat), beat: beat.id, tag: "first", t: beat.startS + first },
    { kind: sheetKind(beat), beat: beat.id, tag: "settled", t: beat.startS + settled },
  ];
}

/** Two cells for the first beat of each kind (each variant of a variant kind), in timeline order. */
export function kindCells(timeline: Timeline): KindCell[] {
  const firsts = timeline.beats.filter((beat, i) => timeline.beats.findIndex((b) => sheetKind(b) === sheetKind(beat)) === i);
  return firsts.flatMap(cellsOf);
}

/** The share of pixels further than INK_TOLERANCE from the commonest grey level: 0 for a blank frame. */
export function inkShare(gray: Uint8Array): number {
  if (gray.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const v of gray) counts[v] = (counts[v] ?? 0) + 1;
  const background = counts.indexOf(Math.max(...counts));
  const inked = gray.reduce((n, v) => n + (Math.abs(v - background) > INK_TOLERANCE ? 1 : 0), 0);
  return inked / gray.length;
}

async function grayPixels(png: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of spawnFfmpeg(decodeArgs(png))) chunks.push(chunk);
  const gray = Buffer.concat(chunks);
  if (gray.length !== FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT) throw new Error(`${png}: decoded ${gray.length} grey bytes, not one frame`);
  return gray;
}

const drawable = (label: string) => label.replace(/[^A-Za-z0-9 ._/-]/g, "_");

function labelArgs(png: string, label: string, out: string): string[] {
  const strip = `pad=iw:ih+${LABEL_STRIP_PX}:0:0:color=0x111111`;
  const text = `drawtext=text='${drawable(label)}':x=8:y=h-${LABEL_STRIP_PX - 7}:fontsize=18:fontcolor=white`;
  return ["-y", "-i", png, "-frames:v", "1", "-vf", `scale=${DEFAULT_CELL_WIDTH}:-2,${strip},${text}`, out];
}

interface SheetFrame extends KindCell {
  /** `kind-<spec>-<tag>.png`, relative to the output directory. */
  file: string;
  inkShare: number;
}

interface ParitySheet {
  frames: SheetFrame[];
  /** The tiled sheet, relative to the output directory. */
  sheet: string;
}

async function captureCells(browser: Browser, url: string, cells: readonly KindCell[], outDir: string): Promise<SheetFrame[]> {
  return withCapturePage(browser, url, STAGE, async ({ page }) => {
    const frames: SheetFrame[] = [];
    for (const cell of cells) {
      const file = `kind-${cell.kind}-${cell.tag}.png`;
      writeFileSync(path.join(outDir, file), await captureFrame(page, cell.t));
      frames.push({ ...cell, file, inkShare: inkShare(await grayPixels(path.join(outDir, file))) });
    }
    return frames;
  });
}

async function tile(frames: readonly SheetFrame[], outDir: string, ffmpeg: FfmpegExec): Promise<string> {
  mkdirSync(path.join(outDir, "cells"), { recursive: true });
  const labelled: string[] = [];
  for (const frame of frames) {
    const out = path.join(outDir, "cells", frame.file);
    await ffmpeg(labelArgs(path.join(outDir, frame.file), `${frame.kind} ${frame.tag} ${frame.beat}`, out));
    labelled.push(out);
  }
  const list = path.join(outDir, "sheet.list");
  writeFileSync(list, labelled.map((file) => `file '${file}'\n`).join(""));
  await ffmpeg(tileArgs(list, labelled.length, SHEET_COLUMNS, path.join(outDir, "sheet.png")));
  return "sheet.png";
}

interface ParitySheetDeps {
  ffmpeg?: FfmpegExec;
  browser?: Browser;
}

const defaultFfmpeg: FfmpegExec = async (args) => {
  await runFfmpeg(args);
};

/**
 * Renders `timeline` on the built page in `pageDir` and writes `timeline.json` (what was served),
 * `kind-<spec>-first.png`, `kind-<spec>-settled.png`, `sheet.png` (the cells tiled two across, labelled) and
 * `sheet.json` under `outDir`. A page error rejects. The cells capture in `browser` when one is lent.
 */
export async function writeParitySheet(pageDir: string, timeline: Timeline, outDir: string, { ffmpeg = defaultFfmpeg, browser }: ParitySheetDeps = {}): Promise<ParitySheet> {
  mkdirSync(outDir, { recursive: true });
  const timelineFile = path.join(outDir, "timeline.json");
  writeFileSync(timelineFile, `${JSON.stringify(timeline)}\n`);
  const served = await servePage(pageDir, timelineFile);
  try {
    const frames = await withBrowser(browser, (captureIn) => captureCells(captureIn, served.url, kindCells(timeline), outDir));
    const sheet = await tile(frames, outDir, ffmpeg);
    writeFileSync(path.join(outDir, "sheet.json"), `${JSON.stringify({ frames, sheet }, null, 2)}\n`);
    return { frames, sheet };
  } finally {
    await served.close();
  }
}
