import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appDirs } from "@titan-design/app-paths";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { loadQaGate, type QaGate } from "./qa/gate-profile.js";
import { compileTimeline, writeTimeline } from "./render/compile-timeline.js";
import { cachedPage, servePage, type BuiltPage, type PageSource } from "./render/composition-page.js";
import { renderVideo, RenderWordsSchema, type RenderInput, type RenderResult, type RenderWords } from "./render/render-video.js";
import { StoryboardSchema, type Storyboard } from "./storyboard.js";

// src/ and dist/ both sit one level under the package root; the page builds from its sources in src/.
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PAGE_SOURCE: PageSource = {
  root: path.join(PACKAGE_ROOT, "src", "composition"),
  extra: [path.join(PACKAGE_ROOT, "src", "beat-slots.ts"), path.join(PACKAGE_ROOT, "package.json")],
};

interface RenderFlags {
  audio?: string;
  workers: number;
  qa: boolean;
  out: string;
}

export interface RenderCliDeps {
  /** The built composition page; by default a Vite build cached per page-source sha. */
  page?: () => Promise<BuiltPage>;
  render?: (input: RenderInput) => Promise<RenderResult>;
  gate?: (videoType: string) => QaGate;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Narration bundle v1: `words.json` plus one `<beat id>.wav` per beat. */
interface Narration {
  raw: unknown;
  words: RenderWords;
  wavDir: string;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

export const defaultWorkers = (): number => Math.min(16, availableParallelism());

function workerCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("workers must be a positive integer");
  return n;
}

function readNarration(dir: string, board: Storyboard): Narration {
  const raw = readJson(path.join(dir, "words.json"));
  const missing = board.beats.map((beat) => beat.id).filter((id) => !existsSync(path.join(dir, `${id}.wav`)));
  if (missing.length > 0) throw new Error(`narration bundle ${dir} has no wav for ${missing.join(", ")}`);
  return { raw, words: RenderWordsSchema.parse(raw), wavDir: dir };
}

async function viteBuild(outDir: string): Promise<void> {
  const { build } = await import("vite");
  await build({ configFile: path.join(PAGE_SOURCE.root, "vite.config.ts"), logLevel: "warn", build: { outDir, emptyOutDir: true } });
}

/** The composition page from this package's sources, built with Vite at most once per source sha under `cacheRoot`. */
export const compositionPage = (cacheRoot: string): Promise<BuiltPage> => cachedPage(PAGE_SOURCE, cacheRoot, viteBuild);

const defaultPage = (): Promise<BuiltPage> => compositionPage(path.join(appDirs("explainer").cache, "composition"));

async function runRender(beatsFile: string, flags: RenderFlags, deps: Required<RenderCliDeps>): Promise<number> {
  const board = StoryboardSchema.parse(readJson(beatsFile));
  const narration = flags.audio ? readNarration(flags.audio, board) : undefined;
  const timeline = compileTimeline(board, narration?.raw);
  const page = await deps.page();
  mkdirSync(flags.out, { recursive: true });
  const served = await servePage(page.dir, writeTimeline(flags.out, timeline));
  try {
    const result = await deps.render({
      timeline, pageUrl: served.url, pageSha: page.sha, workers: flags.workers, outDir: flags.out, stem: path.parse(beatsFile).name,
      qa: { mode: flags.qa ? "gate" : "skip", gate: deps.gate(board.video_type) },
      ...(narration ? { audio: { words: narration.words, wavDir: narration.wavDir } } : {}),
    });
    deps.out(`render: ${result.data.frames} frames, ${result.data.durationS} s${result.data.draft ? ", DRAFT" : ""}, qa ${result.data.qaGate} -> ${result.mp4}\n`);
    return 0;
  } finally {
    await served.close();
  }
}

function renderCommand(deps: Required<RenderCliDeps>, onResult: (code: number) => void): Command {
  return new Command("render")
    .description("Render a storyboard (beats.json) to <stem>.mp4, captions.vtt and render-manifest.json through the composition page")
    .argument("<beats.json>", "the storyboard")
    .requiredOption("--out <dir>", "where the mp4, captions.vtt, render-manifest.json and timeline.json go")
    .option("--audio <dir>", "narration bundle v1: words.json and <beat id>.wav; without it the render is a silent DRAFT")
    .option("--workers <n>", "capture workers", workerCount, defaultWorkers())
    .option("--no-qa", "render without the pre-capture QA gate; the manifest records qaGate \"skipped\"")
    .exitOverride()
    .configureOutput({ writeOut: deps.out, writeErr: deps.err })
    .action(async (beatsFile: string, flags: RenderFlags) => onResult(await runRender(beatsFile, flags, deps)));
}

/** `explainer render <beats.json> ...`: exit 0 on a written render, 1 when compile, QA or the render fails, 2 on usage. */
export async function runRenderCli(argv: readonly string[], deps: RenderCliDeps = {}): Promise<number> {
  const resolved: Required<RenderCliDeps> = {
    page: deps.page ?? defaultPage,
    render: deps.render ?? ((input) => renderVideo(input)),
    gate: deps.gate ?? ((videoType) => loadQaGate(videoType)),
    out: deps.out ?? ((text) => process.stdout.write(text)),
    err: deps.err ?? ((text) => process.stderr.write(text)),
  };
  let code = 0;
  const program = new Command("explainer").enablePositionalOptions().exitOverride().configureOutput({ writeOut: resolved.out, writeErr: resolved.err })
    .addCommand(renderCommand(resolved, (next) => (code = next)));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    resolved.err(`render: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
