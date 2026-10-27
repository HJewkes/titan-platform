import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SheetCell } from "../contact-sheet.js";
import { LABEL_STRIP_PX, tileArgs, writeContactSheets, type FfmpegExec, type FramedCell } from "../contact-sheet-render.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { settledS, sheetKind } from "./parity-sheet.js";
import type { Timeline } from "./timeline.js";

/**
 * The bridged-vs-in-process pair sheet (TP-4276 plan section 3.1, layer 2): each beat's settled frame from both
 * MP4s, left and right, with an SSIM per pair. The SSIM is evidence for the owner's per-kind sign-off, never a gate.
 */

/** Plan risk R5: where the template fill differs from the bridge's sample builder by design, so a reviewer judges a change, not a bug. */
export const KNOWN_DIFFERENCES: Readonly<Record<string, string>> = {
  "claim-card": "R5: the fill keeps only the claim; the bridge listed every label",
  hook: "R5: the fill keeps the cards; the bridge dropped them",
  compare: "R5: unequal sides fall back to a list; the bridge drew ragged columns",
  "chart-bar": "R5: chart tone is not a slot, so bars draw neutral",
  "chart-line": "R5: chart tone is not a slot, so the line draws neutral",
};

/** Two sheet pairs across: each pair is two cells wide already. */
const PAIR_COLUMNS = 2;
const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/** SSIM of two stills, from 0 to 1. */
export type SsimExec = (left: string, right: string) => Promise<number>;

export interface PairCell extends SheetCell {
  /** The spec type, with its variant (`chart-bar`). */
  kind: string;
  /** The R5 note for a kind the fill draws differently on purpose. */
  known?: string;
}

export interface SheetPair extends PairCell {
  /** `pairs/pair-NN-<beat>.png`, relative to the output directory: bridged left, in-process right. */
  file: string;
  ssim: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One cell per beat at its settled moment, the same moment on both MP4s, since one script and one words file timed both. */
export function pairCells(timeline: Timeline): PairCell[] {
  return timeline.beats.map((beat) => {
    const kind = sheetKind(beat);
    const local = round3(settledS(beat));
    const known = Object.hasOwn(KNOWN_DIFFERENCES, kind) ? KNOWN_DIFFERENCES[kind]! : undefined;
    const label = `${kind} ${beat.id}${known ? " R5 known difference" : ""}`;
    const cell = { key: `${beat.id}/settled`, beat: beat.id, chapter: "pairs", rule: "hero" as const, tag: "settled", local, t: round3(beat.startS + local), label, kind };
    return known ? { ...cell, known } : cell;
  });
}

/** The stills compared without their label strips, which would read as matching pixels. */
export function ssimArgs(left: string, right: string): string[] {
  const crop = `crop=iw:ih-${LABEL_STRIP_PX}:0:0`;
  return ["-i", left, "-i", right, "-lavfi", `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]ssim=stats_file=-`, "-f", "null", "-"];
}

export function parseSsim(stats: string): number {
  const all = /All:([\d.]+)/.exec(stats);
  if (!all) throw new Error(`ffmpeg ssim printed no All: score: ${stats.slice(0, 200)}`);
  return Number(all[1]);
}

const sideCells = (cells: readonly PairCell[], side: string): PairCell[] => cells.map((cell) => ({ ...cell, label: `${side} ${cell.label}` }));

async function pairUp(left: FramedCell, right: FramedCell, i: number, dirs: { out: string; bridged: string; inProcess: string }, ffmpeg: FfmpegExec): Promise<string> {
  const file = path.join("pairs", `pair-${String(i + 1).padStart(2, "0")}-${left.beat}.png`);
  const inputs = ["-i", path.join(dirs.bridged, left.frame), "-i", path.join(dirs.inProcess, right.frame)];
  await ffmpeg([...QUIET, ...inputs, "-filter_complex", "hstack=inputs=2", "-frames:v", "1", path.join(dirs.out, file)]);
  return file;
}

async function tilePairs(pairs: readonly SheetPair[], outDir: string, ffmpeg: FfmpegExec): Promise<string> {
  const list = path.join(outDir, "pairs.list");
  writeFileSync(list, pairs.map((pair) => `file '${path.resolve(outDir, pair.file)}'\n`).join(""));
  await ffmpeg(tileArgs(list, pairs.length, PAIR_COLUMNS, path.join(outDir, "sheet.png")));
  return "sheet.png";
}

export interface PairSheetDeps {
  ffmpeg: FfmpegExec;
  ssim: SsimExec;
}

export const defaultPairSheetDeps: PairSheetDeps = {
  ffmpeg: async (args) => void (await runFfmpeg(args)),
  ssim: async (left, right) => parseSsim(await runFfmpeg(ssimArgs(left, right))),
};

/**
 * Cuts each beat's settled frame from `bridged` and `inProcess` (through writeContactSheets, under `bridged/` and
 * `in-process/`), writes one `pairs/pair-NN-<beat>.png` per beat, `sheet.png` tiling them, and `ssim.json`.
 */
export async function writePairSheet(
  bridged: string, inProcess: string, timeline: Timeline, outDir: string, deps: PairSheetDeps = defaultPairSheetDeps,
): Promise<{ pairs: SheetPair[]; sheet: string }> {
  const cells = pairCells(timeline);
  const dirs = { out: outDir, bridged: path.join(outDir, "bridged"), inProcess: path.join(outDir, "in-process") };
  const left = await writeContactSheets(bridged, sideCells(cells, "bridged"), dirs.bridged, deps.ffmpeg);
  const right = await writeContactSheets(inProcess, sideCells(cells, "in-process"), dirs.inProcess, deps.ffmpeg);
  mkdirSync(path.join(outDir, "pairs"), { recursive: true });
  const pairs: SheetPair[] = [];
  for (const [i, cell] of cells.entries()) {
    const [l, r] = [left.cells[i]!, right.cells[i]!];
    const file = await pairUp(l, r, i, dirs, deps.ffmpeg);
    pairs.push({ ...cell, file, ssim: await deps.ssim(path.join(dirs.bridged, l.frame), path.join(dirs.inProcess, r.frame)) });
  }
  const sheet = await tilePairs(pairs, outDir, deps.ffmpeg);
  writeFileSync(path.join(outDir, "ssim.json"), `${JSON.stringify(pairs.map(({ beat, kind, t, ssim, known, file }) => ({ beat, kind, t, ssim, file, ...(known ? { known } : {}) })), null, 2)}\n`);
  return { pairs, sheet };
}
