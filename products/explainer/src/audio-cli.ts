import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appDirs } from "@titan-design/app-paths";
import { encodeWav } from "@titan-design/speech-tts";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import type { FfmpegExec } from "./audio/ffmpeg.js";
import { AudioKindSchema, AudioSourceSchema, type AudioKind } from "./audio/ledger-schema.js";
import { audioLibraryDir, importAudio, ImportRefused, readLedger, type ImportRequest, type ImportResult } from "./audio/library.js";
import { generateBed, generateSfx, PROCEDURAL_GENERATOR, SFX_NAMES, type Generated, type SfxName } from "./audio/procedural.js";
import { dataDirOption } from "./workflow/run-cli.js";

export interface AudioCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  exec?: FfmpegExec;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

interface LibraryFlags {
  dataDir?: string;
  audioLibrary?: string;
}

interface ImportFlags extends LibraryFlags {
  id: string;
  kind: AudioKind;
  licence: string;
  sourceKind: ImportRequest["source"]["kind"];
  sourceName: string;
  sourceUrl?: string;
  attribution?: string;
  creator?: string;
  title?: string;
  tags: string[];
  anchorS?: number;
  loop?: boolean;
}

interface GenFlags extends LibraryFlags {
  kind: AudioKind;
  name?: SfxName;
  seed: number;
  durationS?: number;
  id?: string;
}

const seconds = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`expected seconds, got "${value}"`);
  return n;
};
const integer = (value: string): number => {
  if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError(`expected an integer, got "${value}"`);
  return Number(value);
};
const list = (value: string): string[] => value.split(",").map((tag) => tag.trim()).filter(Boolean);

const libraryOption = () => new Option("--audio-library <dir>", "the audio library (default: $EXPLAINER_AUDIO_LIBRARY, else <data-dir>/audio-library)");

interface Context {
  deps: AudioCliDeps;
  out: (text: string) => void;
}

const libraryFor = (flags: LibraryFlags, { deps }: Context): string =>
  audioLibraryDir(flags.dataDir ?? appDirs("explainer").data, flags.audioLibrary, deps.env ?? process.env);

const importDeps = ({ deps }: Context) => ({ ...(deps.exec ? { exec: deps.exec } : {}), ...(deps.now ? { now: deps.now } : {}) });

const report = ({ entry, added }: ImportResult): string => `${added ? "added" : "exists"} ${entry.id} ${entry.sha256}\n`;

function importRequest(file: string, flags: ImportFlags): ImportRequest {
  const source = { kind: flags.sourceKind, name: flags.sourceName, ...(flags.sourceUrl ? { url: flags.sourceUrl } : {}) };
  return {
    file, id: flags.id, kind: flags.kind, source, licence: flags.licence, tags: flags.tags,
    ...(flags.attribution === undefined ? {} : { attribution: flags.attribution }),
    ...(flags.creator === undefined ? {} : { creator: flags.creator }),
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.anchorS === undefined ? {} : { anchorS: flags.anchorS }),
    ...(flags.loop ? { loop: true } : {}),
  };
}

function importCommand(ctx: Context): Command {
  return new Command("import")
    .description("Add a licensed file to the audio library: refuses NC, ND, SA, unknown licences and CC BY with no attribution")
    .argument("<file>", "any audio file ffmpeg reads")
    .requiredOption("--id <id>", "kebab slug, unique in the library")
    .addOption(new Option("--kind <kind>", "bgm or sfx").choices(AudioKindSchema.options).makeOptionMandatory())
    .requiredOption("--licence <id>", "CC0-1.0, CC-BY-4.0 or generated-own")
    .addOption(new Option("--source-kind <kind>", "where it came from").choices(AudioSourceSchema.shape.kind.options).makeOptionMandatory())
    .requiredOption("--source-name <name>", "the site, pack or generator")
    .option("--source-url <url>", "the page it came from")
    .option("--attribution <line>", "the exact credit line; required for CC BY")
    .option("--creator <name>", "who made it")
    .option("--title <title>", "its title")
    .option("--tags <tags>", "comma-separated moods (bgm) or names (sfx)", list, [])
    .option("--anchor-s <s>", "an SFX: where its hit lands inside the clip", seconds)
    .option("--loop", "a bed: it loops cleanly")
    .addOption(dataDirOption()).addOption(libraryOption())
    .exitOverride()
    .action(async (file: string, flags: ImportFlags) => ctx.out(report(await importAudio(libraryFor(flags, ctx), importRequest(file, flags), importDeps(ctx)))));
}

function generated(flags: GenFlags): { clip: Generated; id: string } {
  if (flags.kind === "bgm") {
    const clip = generateBed({ seed: flags.seed, ...(flags.durationS === undefined ? {} : { durationS: flags.durationS }) });
    return { clip, id: flags.id ?? `pad-s${flags.seed}` };
  }
  if (!flags.name) throw new InvalidArgumentError(`--kind sfx needs --name (${SFX_NAMES.join(", ")})`);
  return { clip: generateSfx(flags.name, flags.seed), id: flags.id ?? `${flags.name}-s${flags.seed}` };
}

/** Writes the generated WAV to a scratch dir and imports it as `generated-own`, like any other file. */
async function importGenerated(ctx: Context, flags: GenFlags): Promise<ImportResult> {
  const { clip, id } = generated(flags);
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-audio-gen-"));
  try {
    const file = path.join(scratch, `${id}.wav`);
    writeFileSync(file, encodeWav(clip.audio));
    const request: ImportRequest = {
      file, id, kind: flags.kind, source: { kind: "generator", name: PROCEDURAL_GENERATOR }, licence: "generated-own", tags: clip.tags, generator: clip.generator,
      ...(clip.anchorS === undefined ? {} : { anchorS: clip.anchorS }),
      ...(clip.loop === undefined ? {} : { loop: clip.loop }),
    };
    return await importAudio(libraryFor(flags, ctx), request, importDeps(ctx));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function genCommand(ctx: Context): Command {
  return new Command("gen")
    .description("Generate a seeded procedural bed or SFX and import it as generated-own")
    .addOption(new Option("--kind <kind>", "bgm or sfx").choices(AudioKindSchema.options).makeOptionMandatory())
    .addOption(new Option("--name <name>", "the SFX to make").choices(SFX_NAMES))
    .requiredOption("--seed <n>", "the seed; one seed always makes one file", integer)
    .option("--duration-s <s>", "a bed's length (default 16)", seconds)
    .option("--id <id>", "the ledger id (default pad-s<seed> or <name>-s<seed>)")
    .addOption(dataDirOption()).addOption(libraryOption())
    .exitOverride()
    .action(async (flags: GenFlags) => ctx.out(report(await importGenerated(ctx, flags))));
}

function listCommand(ctx: Context): Command {
  return new Command("list")
    .description("Print the ledger: id, kind, licence, seconds, integrated LUFS and tags")
    .addOption(dataDirOption()).addOption(libraryOption())
    .exitOverride()
    .action((flags: LibraryFlags) => {
      for (const entry of readLedger(libraryFor(flags, ctx))) {
        ctx.out(`${entry.id}\t${entry.kind}\t${entry.licence}\t${entry.durationS.toFixed(2)}\t${entry.loudness.integratedLufs.toFixed(1)}\t${entry.tags.join(",")}\n`);
      }
    });
}

/** `explainer audio import|gen|list`: exit 0 on success, 1 on a refused or failed import, 2 on usage. */
export async function runAudioCli(argv: readonly string[], deps: AudioCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const ctx: Context = { deps, out };
  const audio = new Command("audio").exitOverride().addCommand(importCommand(ctx)).addCommand(genCommand(ctx)).addCommand(listCommand(ctx));
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err }).addCommand(audio);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error instanceof InvalidArgumentError) err(`audio: ${error.message}\n`);
      return error.exitCode === 0 ? 0 : 2;
    }
    err(`audio: ${error instanceof ImportRefused ? "refused: " : ""}${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
