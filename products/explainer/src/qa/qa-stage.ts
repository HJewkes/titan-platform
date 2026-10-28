import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_OPTIONS } from "@titan-design/render-qa";
import { z } from "zod";
import { RENDER_FPS } from "../render/render-video.js";
import { renameWordsBeats, storyboardIds } from "../render/beat-ids.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { readTiming } from "../timing.js";
import type { ArtifactStore } from "../workflow/artifacts.js";
import type { ModelStageInput } from "../workflow/model-stages.js";
import type { StageOutcome } from "../workflow/records.js";
import { captionReport } from "./caption-check.js";
import { cueGate, type CueGateResult } from "./cue-gate.js";
import type { QaEngine } from "./qa-engine.js";
import { leadLineBeats } from "./qa-lead-lines.js";
import { measuredFindings } from "./qa-measured.js";
import { INLINE_MAX_BYTES, mediaScanByBeat, qaReport, qaSummary, type QaReport } from "./qa-report.js";
import { timelineFromArtifact, timelineS, type QaTimeline } from "./qa-timeline.js";
import type { QaGate } from "./gate-profile.js";
import { serveTree } from "./serve-tree.js";
import { timingProfile, timingReport, type TimingProfile } from "./timing-gates.js";

export interface QaConfig extends QaGate {
  /** The run's video type, recorded in qa.json. */
  profile?: string;
  /** The 2 Hz sweep joins the cue moments unless this is false. */
  sweep?: boolean;
  /** The type profile's timing thresholds; the defaults when the run has no profile. */
  timing?: TimingProfile;
}

interface QaInput extends Omit<ModelStageInput, "store"> {
  store: Pick<ArtifactStore, "readText" | "putText" | "putTree" | "path" | "materialise">;
}

/** The composition page fetches its timeline from the tree it is served from, under a name no page build writes. */
const TIMELINE_FILE = "qa-timeline.json";

function need(input: QaInput, name: string): string {
  const sha = input.artifacts[name];
  if (sha === undefined) throw new Error(`stage qa needs artifact "${name}", which no earlier stage produced`);
  return sha;
}

const json = (input: QaInput, sha: string): unknown => JSON.parse(input.store.readText(sha));

/** The render's caption track; a render that made none is the caption check's finding, not the stage's error. */
const vttText = (input: QaInput): string | undefined => (input.artifacts.vtt === undefined ? undefined : input.store.readText(input.artifacts.vtt));

/** Lays the render's page tree out in `dir` with its timeline beside it, and names the page to open on it. */
function pageQuery(input: QaInput, dir: string): string {
  input.store.materialise(need(input, "page"), dir);
  input.store.materialise(need(input, "timeline"), path.join(dir, TIMELINE_FILE));
  return `?timeline=${TIMELINE_FILE}`;
}

async function servedInspection(input: QaInput, engine: QaEngine, timeline: QaTimeline, config: QaConfig, scratch: string): Promise<CueGateResult> {
  const tree = path.join(scratch, "page");
  const query = pageQuery(input, tree);
  const served = await serveTree(tree);
  try {
    return await cueGate(engine, `${served.origin}/${query}`, timeline, config, { lead: leadLineBeats(input), cropDir: path.join(scratch, "crops"), sweep: config.sweep !== false, probe: true });
  } finally {
    await served.close();
  }
}

/** A series too large to sit inline in qa.json goes to its own artifact, which `outputs` gains; returns its sha. */
function storedIfLarge(input: QaInput, outputs: Record<string, string>, name: string, value: unknown): string | undefined {
  const text = JSON.stringify(value);
  if (text.length <= INLINE_MAX_BYTES) return undefined;
  outputs[name] = input.store.putText(`${text}\n`, name, input.from);
  return outputs[name];
}

type Measured = Pick<QaReport, "sweep" | "framediff" | "probe" | "measured" | "timing" | "mediaScan" | "captions" | "flash">;

/** What the timing gates read of the script: the beats it declares held, by `heldS` or the held speech band. */
const HeldScriptSchema = z.object({ beats: z.array(z.object({ id: z.string(), band: z.string().optional(), heldS: z.number().optional() })) });

/** words.json and the script name beats by script id, the render's timeline by storyboard id. */
const timelineIds = (input: QaInput): Map<string, string> =>
  storyboardIds(HeldScriptSchema.parse(json(input, need(input, "script"))), ResolvedSchema.parse(json(input, need(input, "resolved"))));

function heldBeats(input: QaInput, ids: ReadonlyMap<string, string>): Set<string> {
  const { beats } = HeldScriptSchema.parse(json(input, need(input, "script")));
  return new Set(beats.filter((beat) => beat.band === "held" || (beat.heldS ?? 0) > 0).flatMap((beat) => ids.get(beat.id) ?? []));
}

/** The MP4's frame change and the probe, inline or by sha, and the page-measured findings they give. */
async function measure(input: QaInput, engine: QaEngine, timeline: QaTimeline, inspection: CueGateResult, config: QaConfig, outputs: Record<string, string>): Promise<Measured> {
  const mp4 = input.store.path(need(input, "mp4"));
  const diffs = await engine.frameDiffs(mp4);
  const options = { ...DEFAULT_OPTIONS, ...config.inspect };
  const { sampled: moments, probed } = inspection;
  const framediff = storedIfLarge(input, outputs, "framediff", diffs);
  const probe = storedIfLarge(input, outputs, "qa-probe", probed);
  const ids = timelineIds(input);
  const words = readTiming(renameWordsBeats(json(input, need(input, "words")), ids));
  const timing = timingReport({ timeline, words, held: heldBeats(input, ids), diffs, fps: RENDER_FPS, probed, profile: config.timing ?? timingProfile() });
  return {
    sweep: config.sweep !== false,
    framediff: framediff === undefined ? { fps: RENDER_FPS, shares: diffs } : { fps: RENDER_FPS, artifact: framediff },
    probe: probe === undefined ? { moments: probed } : { artifact: probe },
    measured: measuredFindings({ timeline, moments, probed, diffs, fps: RENDER_FPS, stage: { width: options.W, height: options.H } }),
    timing,
    mediaScan: mediaScanByBeat(await engine.mediaScan(mp4), timeline),
    captions: captionReport(vttText(input), json(input, need(input, "words"))),
    flash: await engine.flashScan(mp4),
  };
}

/**
 * The `explainer.qa` body (workflow plan §2.3 stage 9): render-qa's gate over the served page at the cue moments and
 * the 2 Hz sweep, the page-measured checks over the probe and the MP4's frame change, the DIRECTION timing gates, the
 * MP4's black, silent and frozen stretches by beat, the MP4's length against the timeline QA inspected, and `qa.json` (`explainer.qa/v1`). It never fails on a finding; the stage's checks read
 * `qa.json` and gate.
 */
export async function runQaStage(input: QaInput, config: QaConfig, engine: QaEngine): Promise<StageOutcome> {
  const mp4 = input.store.path(need(input, "mp4"));
  const timeline = timelineFromArtifact(json(input, need(input, "timeline")));
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-qa-"));
  try {
    const inspection = await servedInspection(input, engine, timeline, config, scratch);
    const { held } = inspection;
    const outputs: Record<string, string> = {};
    const measured = await measure(input, engine, timeline, inspection, config, outputs);
    const mp4S = { durationS: await engine.durationS(mp4), timelineS: timelineS(timeline), frameS: 1 / RENDER_FPS };
    const report = qaReport(held, {
      profile: config.profile ?? null, gateProfileSha: config.sha, gate: config.gate, timeline: "timeline", moments: inspection.moments, mp4: mp4S, ...measured,
      notes: [`${timeline.beats.length} beats from timeline`],
    });
    outputs.qa = input.store.putText(`${JSON.stringify(report, null, 1)}\n`, "qa", input.from);
    if (held.errors.length > 0) outputs["qa-crops"] = input.store.putTree(path.join(scratch, "crops"), "qa-crops", input.from);
    return { outputs, notes: [qaSummary(report), `${report.notes[0]}; mp4 ${mp4S.durationS.toFixed(2)} s`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
