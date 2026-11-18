import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { fingerprintOf, sidecarFingerprint, type Fingerprint } from "../fingerprint.js";
import { parseTimeline } from "../composition/timeline.js";
import { cutCells, PageMarksSchema, type SheetCell } from "../contact-sheet.js";
import { writeContactSheets, type FfmpegExec } from "../contact-sheet-render.js";
import { loadStructures } from "../profile-load.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { buildSidecar, POSTER_WIDTH, posterAt, type SidecarStatus } from "../video-sidecar.js";
import type { ArtifactStore } from "./artifacts.js";
import { spawnExec, type BridgeExec } from "./bridge.js";
import type { ModelStageInput } from "./model-stages.js";
import type { StageOutcome } from "./records.js";

/** The console counts a sidecar whose fingerprint is over this as unreadable (`apps/console/server/video-meta.ts`). */
export const MAX_SIDECAR_FINGERPRINT_BYTES = 32 * 1024;
const MEDIA_TIMEOUT_MS = 120_000;

/** ffprobe and ffmpeg, behind a seam so a test runs the stage on a fake video. */
export interface MediaExec {
  durationS(mp4: string): Promise<number>;
  /** One JPEG frame at `atS`, `widthPx` wide, written to `out`. */
  frame(mp4: string, atS: number, widthPx: number, out: string): Promise<void>;
}

async function run(exec: BridgeExec, argv: string[]): Promise<string> {
  const result = await exec({ argv, cwd: tmpdir(), env: {}, timeoutMs: MEDIA_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`${argv[0]} exited ${result.code}: ${result.stderr.trim().split(/\r?\n/).at(-1) ?? ""}`);
  return result.stdout;
}

/** The host's own ffprobe and ffmpeg, the tools the render bridge already needs. */
export function ffmpegMedia(exec: BridgeExec = spawnExec): MediaExec {
  return {
    async durationS(mp4) {
      const out = await run(exec, ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]);
      const seconds = Number(out.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe gave no duration for the video: "${out.trim()}"`);
      return seconds;
    },
    async frame(mp4, atS, widthPx, out) {
      await run(exec, ["ffmpeg", "-v", "error", "-y", "-ss", String(atS), "-i", mp4, "-frames:v", "1", "-vf", `scale=${widthPx}:-2`, "-q:v", "3", out]);
    },
  };
}

export interface SheetsConfig {
  /** An explicit take; absent, `v<n>` for the run's position among the video's runs. */
  take?: string;
  /** The day the run's gather covers. */
  day?: string;
  status: SidecarStatus;
  /** The theater stem the poster file is named after. */
  stem: string;
  /** The run's profile id; absent, the script's own. */
  profile?: string;
  /** The video and every run of it; absent, the child run is the video's only run. */
  video?: { id: string; runIds: string[]; position?: number };
}

interface SheetsInput extends Omit<ModelStageInput, "store"> {
  store: Pick<ArtifactStore, "readText" | "putText" | "putFile" | "putTree" | "path">;
}

const readOptional = <T>(input: SheetsInput, name: string, schema: z.ZodType<T>): T | undefined => {
  const sha = input.artifacts[name];
  return sha === undefined ? undefined : schema.parse(JSON.parse(input.store.readText(sha)));
};

function need(input: SheetsInput, name: string): string {
  const sha = input.artifacts[name];
  if (sha === undefined) throw new Error(`stage sheets needs artifact "${name}", which no earlier stage produced`);
  return sha;
}

async function grabPoster(input: SheetsInput, media: MediaExec, mp4: string, atS: number): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "explainer-poster-"));
  try {
    const file = path.join(dir, "poster.jpg");
    await media.frame(mp4, atS, POSTER_WIDTH, file);
    return input.store.putFile(file, "poster", input.from);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The fingerprint from `resolved` and `slots` when the run has them, else from the script's own visuals. */
function scriptPrint(input: SheetsInput, script: ScriptV1): { fingerprint: Fingerprint; carried: Record<string, unknown>; source: string } {
  const resolved = readOptional(input, "resolved", ResolvedSchema);
  const slots = readOptional(input, "slots", z.record(z.string(), z.unknown()));
  const hooks = new Map([...loadStructures().values()].map((structure) => [structure.id, structure.hook]));
  const terms = script.video.glossary.map((entry) => entry.name);
  const fingerprint = fingerprintOf({ script, hooks, terms, ...(resolved ? { resolved } : {}), ...(slots ? { slots } : {}) });
  const carried = sidecarFingerprint(fingerprint);
  const bytes = Buffer.byteLength(JSON.stringify(carried));
  if (bytes > MAX_SIDECAR_FINGERPRINT_BYTES) throw new Error(`sheets: the sidecar fingerprint is ${bytes} bytes, over the theater's ${MAX_SIDECAR_FINGERPRINT_BYTES}`);
  return { fingerprint, carried, source: resolved ? "resolved" : "script visuals" };
}

/** The host's own ffmpeg, behind the contact-sheet writer's seam. */
function systemFfmpeg(exec: BridgeExec = spawnExec): FfmpegExec {
  return async (args) => void (await run(exec, ["ffmpeg", ...args]));
}

/** A timeline kind (`code-walk`) as the sheet rules name its component (`CodeWalkBeat`). */
const componentOf = (kind: string): string => (/Beat$/.test(kind) ? kind : `${kind.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}Beat`);

const chapterId = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all";

/** Contact-sheet cells from the render's timeline: reveals as cues, the page's marks where it published any. */
function sheetCells(input: SheetsInput, timelineSha: string): SheetCell[] {
  const { beats } = parseTimeline(JSON.parse(input.store.readText(timelineSha)));
  const marks = readOptional(input, "marks", PageMarksSchema);
  return cutCells({
    render: { beats: beats.map(({ id, startS, durationS }) => ({ id, startS, durationS })) },
    cues: { cues: beats.flatMap((beat) => (beat.reveals ?? []).map((reveal) => ({ beat: beat.id, atS: reveal.atS }))) },
    visual: { beats: beats.map((beat) => ({ id: beat.id, kind: componentOf(beat.kind), ...(beat.chapter ? { chapter: chapterId(beat.chapter.label) } : {}) })) },
    ...(marks ? { marks } : {}),
  });
}

/** The chapter sheets as one tree artifact; a run whose render left no timeline has none to cut. */
async function cutSheets(input: SheetsInput, mp4: string, ffmpeg: FfmpegExec): Promise<{ sha: string; cells: number; marked: number } | undefined> {
  const timelineSha = input.artifacts.timeline;
  if (timelineSha === undefined) return undefined;
  const cells = sheetCells(input, timelineSha);
  const dir = mkdtempSync(path.join(tmpdir(), "explainer-sheets-"));
  try {
    await writeContactSheets(mp4, cells, dir, ffmpeg);
    return { sha: input.store.putTree(dir, "contact-sheets", input.from), cells: cells.length, marked: cells.filter((cell) => cell.rule === "marks").length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The `explainer.sheets` body (workflow plan §2.3 stage 10): the theater sidecar, its poster and the script-side
 * fingerprint, from the rendered MP4 and the script, with `resolved` and `slots` read when a run has them.
 */
export async function runSheetsStage(input: SheetsInput, config: SheetsConfig, media: MediaExec, ffmpeg: FfmpegExec = systemFfmpeg()): Promise<StageOutcome> {
  const scriptSha = need(input, "script");
  const mp4 = input.store.path(need(input, "mp4"));
  const script = ScriptSchema.parse(JSON.parse(input.store.readText(scriptSha)));
  const { fingerprint, carried, source } = scriptPrint(input, script);
  const durationS = await media.durationS(mp4);
  const poster = await grabPoster(input, media, mp4, posterAt(durationS));
  const video = config.video ?? { id: input.from.runId, runIds: [input.from.runId] };
  const profile = config.profile ?? script.profile;
  const take = config.take ?? `v${video.position ?? video.runIds.length}`;
  const sidecar = buildSidecar({
    script, profile, durationS, stem: config.stem, take, status: config.status, ...(config.day ? { day: config.day } : {}),
    explainer: { videoId: video.id, runIds: video.runIds, profile, scriptSha, fingerprint: carried },
  });
  const outputs = {
    sidecar: input.store.putText(`${JSON.stringify(sidecar, null, 2)}\n`, "sidecar", input.from),
    poster,
    fingerprint: input.store.putText(`${JSON.stringify(fingerprint, null, 2)}\n`, "fingerprint", input.from),
  };
  const notes = [`poster at ${sidecar.posterAtS} s of ${durationS.toFixed(1)} s`, `fingerprint of ${fingerprint.beats.length} beats from ${source}; ${video.runIds.length} linked runs`];
  const sheets = await cutSheets(input, mp4, ffmpeg);
  if (sheets) {
    Object.assign(outputs, { "contact-sheets": sheets.sha });
    notes.push(`${sheets.cells} contact-sheet cells, ${sheets.marked} cut by the page's marks`);
  }
  return { outputs, notes };
}
