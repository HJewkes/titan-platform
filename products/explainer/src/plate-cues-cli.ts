import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { canonicalJson } from "./eval-store.js";
import { compileTimeline } from "./render/compile-timeline.js";
import { checkPlateLog, PLATE_TOLERANCE_S, PlateLogSchema, plateCues } from "./render/plate-cues.js";
import { StoryboardSchema } from "./storyboard.js";

interface PlateCuesFlags {
  audio?: string;
  out: string;
  check?: string;
}

interface PlateCuesCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function runPlateCues(beatsFile: string, flags: PlateCuesFlags, err: (text: string) => void): number {
  if (!flags.audio) {
    err("plate-cues: --audio is required, since cues need voiced words\n");
    return 1;
  }
  const board = StoryboardSchema.parse(readJson(beatsFile));
  const cues = plateCues(compileTimeline(board, readJson(path.join(flags.audio, "words.json"))));
  mkdirSync(path.dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, `${canonicalJson(cues)}\n`);
  if (!flags.check) return 0;
  const problems = checkPlateLog(cues, PlateLogSchema.parse(readJson(flags.check)), PLATE_TOLERANCE_S);
  for (const problem of problems) err(`plate-cues: ${problem}\n`);
  return problems.length > 0 ? 1 : 0;
}

/** `explainer plate-cues <beats.json> --audio <dir> --out <file> [--check <plate-log.json>]`: exit 0 on success, 1 on drift or a missing --audio, 2 on usage. */
export async function runPlateCuesCli(argv: readonly string[], deps: PlateCuesCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  let code = 0;
  const command = new Command("plate-cues")
    .description("Export each beat's cue seconds for plate authors, and check a plate log against them")
    .argument("<beats.json>", "the storyboard")
    .requiredOption("--out <file>", "where explainer.plate-cues/v1 goes")
    .option("--audio <dir>", "narration bundle v1 (words.json); required, since cues need voiced words")
    .option("--check <plate-log.json>", "a log of [{beat, cue, atS}] to hold to the exported cues, within one frame")
    .exitOverride()
    .configureOutput({ writeOut: out, writeErr: err })
    .action((beatsFile: string, flags: PlateCuesFlags) => {
      code = runPlateCues(beatsFile, flags, err);
    });
  const program = new Command("explainer").enablePositionalOptions().exitOverride().configureOutput({ writeOut: out, writeErr: err }).addCommand(command);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    err(`plate-cues: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
