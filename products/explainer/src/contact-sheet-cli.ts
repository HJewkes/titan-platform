import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { CueTimesSchema, cutCells, PageMarksSchema, RenderTimelineSchema, SheetVisualSchema } from "./contact-sheet.js";
import { writeContactSheets, type FfmpegExec } from "./contact-sheet-render.js";
import { contentFillFindings } from "./content-fill.js";

const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
/** Each beat's element boxes at its settled moment, as the measure step reads them off the page. */
const SettledBoxesSchema = z.object({
  frame: z.object({ width: z.number().positive(), height: z.number().positive() }),
  moments: z.array(z.object({ beat: z.string(), t: z.number(), boxes: z.array(z.object({ element: z.string(), box: BoxSchema, decor: z.boolean().optional() })) })),
});

interface SheetsFlags {
  video: string;
  render: string;
  cues: string;
  visual: string;
  out: string;
  marks?: string;
  fill?: string;
  columns: number;
}

export interface SheetsCliDeps {
  ffmpeg?: FfmpegExec;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const run = promisify(execFile);
const systemFfmpeg: FfmpegExec = async (args) => void (await run("ffmpeg", [...args]));

const readJson = <T>(schema: z.ZodType<T>, file: string): T => schema.parse(JSON.parse(readFileSync(file, "utf8")));

function columnCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("columns must be a positive integer");
  return n;
}

async function runSheets(flags: SheetsFlags, deps: Required<SheetsCliDeps>): Promise<number> {
  const marks = flags.marks ? readJson(PageMarksSchema, flags.marks) : undefined;
  const cells = cutCells({
    render: readJson(RenderTimelineSchema, flags.render), cues: readJson(CueTimesSchema, flags.cues), visual: readJson(SheetVisualSchema, flags.visual),
    ...(marks ? { marks } : {}),
  });
  const set = await writeContactSheets(flags.video, cells, flags.out, deps.ffmpeg, { columns: flags.columns });
  deps.out(`sheets: ${set.cells.length} cells on ${set.sheets.length} chapter sheets -> ${flags.out}\n`);
  if (!flags.fill) return 0;
  const { frame, moments } = readJson(SettledBoxesSchema, flags.fill);
  const findings = contentFillFindings(moments, frame);
  for (const finding of findings) deps.err(`content-fill FAIL ${finding.message}\n`);
  deps.out(`content-fill: ${moments.length - findings.length} of ${moments.length} beats pass\n`);
  return findings.length > 0 ? 1 : 0;
}

function sheetsCommand(deps: Required<SheetsCliDeps>, onResult: (code: number) => void): Command {
  return new Command("sheets")
    .description("Beat-aware contact sheets: cut stills by beat kind and cue times (or page marks), label each, tile one PNG per chapter")
    .requiredOption("--video <mp4>", "the rendered video")
    .requiredOption("--render <json>", "render.json: beats with startS and durationS")
    .requiredOption("--cues <json>", "the cue gate's qa.json: cues with beat and measured atS")
    .requiredOption("--visual <json>", "visual.json or the sample: each beat's component and chapter")
    .requiredOption("--out <dir>", "where cells/, sheet-<chapter>.png and cells.json go")
    .option("--marks <json>", "the page's __titanMotion marks(); preferred over the rules for the beats it covers")
    .option("--fill <json>", "settled element boxes per beat: also run the content-fill gate (>= 60 % of the frame width)")
    .option("--columns <n>", "cells per sheet row", columnCount, 3)
    .exitOverride()
    .configureOutput({ writeOut: deps.out, writeErr: deps.err })
    .action(async (flags: SheetsFlags) => onResult(await runSheets(flags, deps)));
}

/** `explainer sheets ...`: exit 0 on written sheets, 1 when a beat fails content-fill or ffmpeg fails, 2 on usage. */
export async function runSheetsCli(argv: readonly string[], deps: SheetsCliDeps = {}): Promise<number> {
  const resolved: Required<SheetsCliDeps> = {
    ffmpeg: deps.ffmpeg ?? systemFfmpeg,
    out: deps.out ?? ((text) => process.stdout.write(text)),
    err: deps.err ?? ((text) => process.stderr.write(text)),
  };
  let code = 0;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: resolved.out, writeErr: resolved.err })
    .addCommand(sheetsCommand(resolved, (next) => (code = next)));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    resolved.err(`sheets: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
