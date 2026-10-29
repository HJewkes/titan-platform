import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Timeline } from "../composition/timeline.js";
import type { QaGate } from "../qa/gate-profile.js";
import { sha256, type ArtifactStore } from "../workflow/artifacts.js";
import type { ModelStageInput } from "../workflow/model-stages.js";
import type { Check, StageOutcome } from "../workflow/records.js";
import { renameWordsBeats } from "./beat-ids.js";
import { compileTimeline, writeTimeline } from "./compile-timeline.js";
import { defaultCompositionPage, servePage, treeSha, type BuiltPage } from "./composition-page.js";
import { stageCustomLayers, withCustomLayers, type PageLayer } from "./custom-layers.js";
import { renderBoard } from "./render-board.js";
import { renderVideo, RenderWordsSchema, type RenderInput, type RenderResult, type RenderWords } from "./render-video.js";

/** What the render stage drives: the built composition page and the capture; tests pass fakes, so no Chromium runs. */
export interface RenderEngine {
  page: () => Promise<BuiltPage>;
  render: (input: RenderInput) => Promise<RenderResult>;
}

export const defaultRenderEngine = (): RenderEngine => ({ page: defaultCompositionPage, render: (input) => renderVideo(input) });

interface RenderConfig {
  workers: number;
  /** Renders a second time at the same worker count and reports whether the MP4 bytes match. */
  twoRun: boolean;
  /** Skips the pre-capture QA gate; the manifest records `qaGate: "skipped"`. */
  noQa: boolean;
  gate: QaGate;
  /** The style pack's custom properties, served with the page. */
  styleCss?: string;
}

interface RenderStageInput extends Omit<ModelStageInput, "store"> {
  store: Pick<ArtifactStore, "readText" | "putText" | "putFile" | "putTree" | "materialise">;
}

interface Prepared {
  timeline: Timeline;
  pageDir: string;
  pageSha: string;
  audio: { words: RenderWords; wavDir: string };
  notes: string[];
}

const STYLE_FILE = "style-pack.css";
const CUSTOM_LAYERS = "custom-layers";
const STEM = "render";

function need(input: RenderStageInput, name: string): string {
  const sha = input.artifacts[name];
  if (sha === undefined) throw new Error(`stage render needs artifact "${name}", which no earlier stage produced`);
  return sha;
}

const json = (input: RenderStageInput, name: string): unknown => JSON.parse(input.store.readText(need(input, name)));

/** tts names each wav by script beat; the mix reads them by storyboard beat, so each is linked under its new name. */
function linkedWavs(input: RenderStageInput, ids: ReadonlyMap<string, string>, scratch: string): string {
  const voiced = path.join(scratch, "voiced");
  const wavDir = path.join(scratch, "wavs");
  input.store.materialise(need(input, "audio"), voiced);
  mkdirSync(wavDir, { recursive: true });
  for (const [from, to] of ids) symlinkSync(path.join(voiced, `${from}.wav`), path.join(wavDir, `${to}.wav`));
  return wavDir;
}

/** The page tree render serves and qa serves again: the built page, with the style pack's sheet linked from its head. */
function stagedPage(built: BuiltPage, styleCss: string | undefined, dir: string): void {
  cpSync(built.dir, dir, { recursive: true });
  if (styleCss !== undefined) {
    writeFileSync(path.join(dir, STYLE_FILE), `:root { ${styleCss} }\n`);
    const index = path.join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace("</head>", `<link rel="stylesheet" href="./${STYLE_FILE}" /></head>`));
  }
}

/** The custom beats' layers, bundled into the page tree. A custom beat is never drawn from a template spec, so a missing tree or layer throws naming the beat. */
async function pageLayers(input: RenderStageInput, custom: ReadonlyMap<string, string>, scratch: string, pageDir: string): Promise<{ layers: Map<string, PageLayer>; notes: string[] }> {
  if (custom.size === 0) return { layers: new Map(), notes: [] };
  const sha = input.artifacts[CUSTOM_LAYERS];
  if (sha === undefined) throw new Error(`custom layer for beat "${[...custom.keys()].join('", "')}" is not built: the run has no custom-layers tree`);
  const treeDir = path.join(scratch, CUSTOM_LAYERS);
  input.store.materialise(sha, treeDir);
  const layers = await stageCustomLayers(treeDir, custom, pageDir);
  return { layers, notes: [`${layers.size} custom layers drawn`] };
}

async function prepare(input: RenderStageInput, config: RenderConfig, engine: RenderEngine, scratch: string): Promise<Prepared> {
  const { board, extras, ids, custom } = renderBoard(input);
  const words = renameWordsBeats(json(input, "words"), ids);
  const pageDir = path.join(scratch, "page");
  stagedPage(await engine.page(), config.styleCss, pageDir);
  const { layers, notes } = await pageLayers(input, custom, scratch, pageDir);
  const timeline = withCustomLayers(compileTimeline(board, words, { extras, custom: new Set(custom.values()) }), layers);
  return { timeline, pageDir, pageSha: treeSha(pageDir), audio: { words: RenderWordsSchema.parse(words), wavDir: linkedWavs(input, ids, scratch) }, notes };
}

async function renderOnce(run: Prepared, config: RenderConfig, engine: RenderEngine, outDir: string): Promise<RenderResult> {
  mkdirSync(outDir, { recursive: true });
  const served = await servePage(run.pageDir, writeTimeline(outDir, run.timeline));
  try {
    const qa = { mode: config.noQa ? "skip" : "gate", gate: config.gate } as const;
    return await engine.render({ timeline: run.timeline, pageUrl: served.url, pageSha: run.pageSha, audio: run.audio, workers: config.workers, outDir, stem: STEM, qa });
  } finally {
    await served.close();
  }
}

const fileSha = (file: string): string => sha256(readFileSync(file));

/** Reported only: worker count and host are still part of a render's identity, so a mismatch is evidence, not a stop. */
function twoRunCheck(first: RenderResult, second: RenderResult, workers: number): Check {
  const [a, b] = [fileSha(first.mp4), fileSha(second.mp4)];
  const detail = a === b ? `two renders at ${workers} workers gave mp4 ${a.slice(0, 12)}` : `mp4 ${a.slice(0, 12)} then ${b.slice(0, 12)} at ${workers} workers`;
  return { name: "two-run", gate: false, pass: a === b, detail };
}

function stored(input: RenderStageInput, run: Prepared, result: RenderResult, outDir: string): Record<string, string> {
  const put = (file: string, name: string) => input.store.putFile(file, name, input.from);
  return {
    mp4: put(result.mp4, "mp4"), vtt: put(result.vtt, "vtt"), "render-manifest": put(result.manifest, "render-manifest"),
    timeline: put(path.join(outDir, "timeline.json"), "timeline"), page: input.store.putTree(run.pageDir, "page", input.from),
  };
}

/**
 * The `explainer.render` body (workflow plan §2.3 stage 8): script and resolved through the template fill to a
 * storyboard, compiled with the voiced words to `timeline.json`, rendered on the composition page behind the QA gate.
 * Outputs keep the names export and sheets read (`mp4`, `vtt`) beside `render-manifest`, `timeline` and the `page` tree.
 */
export async function runRenderStage(input: RenderStageInput, config: RenderConfig, engine: RenderEngine): Promise<StageOutcome> {
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-render-"));
  try {
    const run = await prepare(input, config, engine, scratch);
    const outDir = path.join(scratch, "out");
    const result = await renderOnce(run, config, engine, outDir);
    const checks = config.twoRun ? [twoRunCheck(result, await renderOnce(run, config, engine, path.join(scratch, "again")), config.workers)] : [];
    const { frames, durationS, draft, qaGate } = result.data;
    const notes = [`${frames} frames, ${durationS} s at ${config.workers} workers${draft ? ", DRAFT" : ""}, qa ${qaGate}`, ...run.notes];
    return { outputs: stored(input, run, result, outDir), checks, notes };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
