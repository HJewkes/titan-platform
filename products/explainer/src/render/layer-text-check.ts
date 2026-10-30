import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeArgs, DEFAULT_OPTIONS, spawnFfmpeg, type Finding, type InspectOptions, type Moment, type ProbedMoment } from "@titan-design/render-qa";
import { cueFrameTimes, cueWindows, stillCueRows, type CueWindow } from "../build/layer-cue-change.js";
import { badTextRows, distinctRows, heldRows, plannedCues, qaRows, revealMoments, type LayerCheckInput, type LayerTextCheck, type LayerTextRow } from "../build/layer-text.js";
import { layerTreeFiles, writeLayerTree } from "../build/layer-tree.js";
import type { Timeline } from "../composition/timeline.js";
import { chromiumQaEngine, type QaEngine, type QaPage } from "../qa/qa-engine.js";
import { heldAtSamples, layerSamplings } from "../qa/layer-contrast.js";
import { contentFillRows, frameWordRows } from "../qa/layer-frame.js";
import { narrationRows } from "../qa/layer-narration.js";
import { timelineFromArtifact } from "../qa/qa-timeline.js";
import { defaultCompositionPage, servePage, type BuiltPage } from "./composition-page.js";
import { stageCustomLayers, withCustomLayers } from "./custom-layers.js";

interface LayerTextCheckDeps {
  /** The composition page the render draws with; the host's cached build by default. */
  page?: () => Promise<BuiltPage>;
  engine?: Pick<QaEngine, "open">;
  /** qa's inspector options, its own defaults unless a gate profile overrides them. */
  options?: InspectOptions;
}

/** One custom beat, the whole timeline, drawn by the layer under check. */
async function layerPage(input: LayerCheckInput, built: BuiltPage, scratch: string): Promise<{ pageDir: string; timeline: Timeline }> {
  const pageDir = path.join(scratch, "page");
  const treeDir = path.join(scratch, "custom-layers");
  cpSync(built.dir, pageDir, { recursive: true });
  writeLayerTree(treeDir, layerTreeFiles(input.builder, [input.layer]));
  const { beatId } = input.layer;
  const layers = await stageCustomLayers(treeDir, new Map([[beatId, beatId]]), pageDir);
  const durationS = input.packet.planned_s;
  const beat = { id: beatId, kind: "custom", startS: 0, durationS, cues: plannedCues(input.packet), slots: {} };
  return { pageDir, timeline: withCustomLayers({ durationS, beats: [beat] }, layers) };
}

interface Moments {
  /** Each reveal once it settles, then the beat's end: the text rules and the probes read these. */
  reveal: readonly number[];
  /** qa's own samples at every 2 Hz phase the voiced beat start may land on, which low-contrast and off-frame are held over. */
  samplings: readonly Moment[][];
  /** Each cue word's frames, which must change the picture. */
  cues: readonly CueWindow[];
}

interface Seen {
  findings: Map<number, Finding[]>;
  probed: ProbedMoment[];
  frames: Map<number, Buffer>;
}

// Virtual time only runs forward, so each second is inspected, probed when it is a reveal and shot when a cue reads it, before the next is sought.
async function seekAll(page: QaPage, beat: string, moments: Moments, options: InspectOptions): Promise<Seen> {
  const reveal = new Set(moments.reveal);
  const cueTimes = cueFrameTimes(moments.cues);
  const shot = new Set(cueTimes);
  const inspect = new Set([...reveal, ...moments.samplings.flat().map((m) => m.t)]);
  const seen: Seen = { findings: new Map(), probed: [], frames: new Map() };
  for (const t of [...new Set([...inspect, ...cueTimes])].sort((a, b) => a - b)) {
    if (inspect.has(t)) seen.findings.set(t, (await page.inspectAt(t, options)).findings);
    if (reveal.has(t)) seen.probed.push(...(await page.probe([{ beat, t }])));
    if (shot.has(t)) seen.frames.set(t, await page.frame(t));
  }
  return seen;
}

/** Each PNG as qa's framediff decodes a frame of the MP4: area-scaled to 320x180 grey. */
async function greyFrames(frames: ReadonlyMap<number, Buffer>, scratch: string): Promise<Map<number, Uint8Array>> {
  const file = path.join(scratch, "cue-frame.png");
  const grey = new Map<number, Uint8Array>();
  for (const [t, png] of frames) {
    writeFileSync(file, png);
    const chunks: Uint8Array[] = [];
    for await (const chunk of spawnFfmpeg(decodeArgs(file))) chunks.push(chunk);
    grey.set(t, Buffer.concat(chunks));
  }
  return grey;
}

/** The seconds the check reads on the layer's one-beat timeline. */
function momentsOf(input: LayerCheckInput, timeline: Timeline): Moments {
  const cues = timeline.beats[0]!.cues ?? {};
  return {
    reveal: revealMoments(cues, timeline.durationS),
    samplings: layerSamplings(timelineFromArtifact(timeline)),
    cues: cueWindows(input.packet.cues, cues, timeline.durationS),
  };
}

async function rowsAt(page: QaPage, packet: LayerCheckInput["packet"], moments: Moments, options: InspectOptions, scratch: string): Promise<LayerTextRow[]> {
  const beat = packet.beat_id;
  const { findings, probed, frames } = await seekAll(page, beat, moments, options);
  const rows = moments.reveal.flatMap((t) => qaRows(beat, t, findings.get(t)!));
  const sampled = heldRows(heldAtSamples(moments.samplings, (t) => findings.get(t) ?? []));
  const frame = [...contentFillRows(beat, probed.at(-1)!, { width: options.W, height: options.H }), ...frameWordRows(beat, probed)];
  const grey = await greyFrames(frames, scratch);
  const still = stillCueRows(beat, moments.cues, (t) => grey.get(t)!);
  return distinctRows([...rows, ...sampled, ...frame, ...still, ...badTextRows(beat, probed), ...narrationRows(beat, packet.spoken, probed)]);
}

/**
 * The $0 check after a layer build: the layer alone on the composition page, seeked to each reveal point, held to qa's
 * small-text and under-chrome rules at qa's thresholds, to the bad-text rule, to qa's words-per-frame gate, to its
 * content-fill gate on the settled frame, to qa's narration-facts and G10 rules against the beat's spoken words, and
 * to a picture change on every cue word, read from the frames on qa's 320x180 grey scale.
 * Low-contrast text and off-frame elements are read over qa's own samples at every 2 Hz phase, as qa would read them once
 * the voice sets the beat's start, so the check is at least as strict as qa wherever that start lands. No model call; Chromium only.
 */
export function chromiumLayerTextCheck(deps: LayerTextCheckDeps = {}): LayerTextCheck {
  const engine = deps.engine ?? chromiumQaEngine();
  const options = deps.options ?? DEFAULT_OPTIONS;
  return async (input) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "explainer-layer-check-"));
    try {
      const { pageDir, timeline } = await layerPage(input, await (deps.page ?? defaultCompositionPage)(), scratch);
      const file = path.join(scratch, "timeline.json");
      writeFileSync(file, JSON.stringify(timeline));
      const served = await servePage(pageDir, file);
      try {
        const page = await engine.open(served.url, options, []);
        try {
          return await rowsAt(page, { ...input.packet, beat_id: input.layer.beatId }, momentsOf(input, timeline), options, scratch);
        } finally {
          await page.close();
        }
      } finally {
        await served.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}
