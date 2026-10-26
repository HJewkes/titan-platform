import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_OPTIONS } from "@titan-design/render-qa";
import { z } from "zod";
import { RENDER_FPS } from "../render/render-video.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema } from "../script-schema.js";
import { readTiming } from "../timing.js";
import type { ArtifactStore } from "../workflow/artifacts.js";
import type { ModelStageInput } from "../workflow/model-stages.js";
import type { StageOutcome } from "../workflow/records.js";
import { cueGate, type CueGateResult } from "./cue-gate.js";
import type { QaEngine } from "./qa-engine.js";
import { leadLineBeats } from "./qa-lead-lines.js";
import { measuredFindings } from "./qa-measured.js";
import { INLINE_MAX_BYTES, qaReport, qaSummary, type QaReport } from "./qa-report.js";
import { timelineFromArtifact, timelineFromWords, timelineS, type QaTimeline } from "./qa-timeline.js";
import type { QaGate } from "./gate-profile.js";
import { serveTree } from "./serve-tree.js";
import { timingProfile, timingReport, type TimingProfile } from "./timing-gates.js";

export interface QaConfig extends QaGate {
  /** The run's video type, recorded in qa.json. */
  profile?: string;
  /** The bridged spike page's `?page=` stem, read only when the render wrote no `timeline`. */
  page?: string;
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

function readTimeline(input: QaInput): QaTimeline {
  const { timeline, resolved } = input.artifacts;
  if (timeline !== undefined) return timelineFromArtifact(json(input, timeline));
  const script = ScriptSchema.parse(json(input, need(input, "script")));
  return timelineFromWords(json(input, need(input, "words")), script, resolved === undefined ? undefined : ResolvedSchema.parse(json(input, resolved)));
}

/** Lays the page tree out in `dir` and names the page to open: the composition page on the timeline, else the spike page. */
function pageQuery(input: QaInput, dir: string, config: QaConfig): string {
  input.store.materialise(need(input, "page"), dir);
  const { timeline } = input.artifacts;
  if (timeline !== undefined) {
    input.store.materialise(timeline, path.join(dir, TIMELINE_FILE));
    return `?timeline=${TIMELINE_FILE}`;
  }
  if (!config.page) throw new Error("stage qa has no timeline artifact and no page stem to open the bridged page with");
  return `?page=${encodeURIComponent(config.page)}`;
}

async function servedInspection(input: QaInput, engine: QaEngine, timeline: QaTimeline, config: QaConfig, scratch: string): Promise<CueGateResult> {
  const tree = path.join(scratch, "page");
  const query = pageQuery(input, tree, config);
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

type Measured = Pick<QaReport, "sweep" | "framediff" | "probe" | "measured" | "timing">;

/** What the timing gates read of the script: the beats it declares held, by `heldS` or the held speech band. */
const HeldScriptSchema = z.object({ beats: z.array(z.object({ id: z.string(), band: z.string().optional(), heldS: z.number().optional() })) });

function heldBeats(input: QaInput): Set<string> {
  const { beats } = HeldScriptSchema.parse(json(input, need(input, "script")));
  return new Set(beats.filter((beat) => beat.band === "held" || (beat.heldS ?? 0) > 0).map((beat) => beat.id));
}

/** The MP4's frame change and the probe, inline or by sha, and the page-measured findings they give. */
async function measure(input: QaInput, engine: QaEngine, timeline: QaTimeline, inspection: CueGateResult, config: QaConfig, outputs: Record<string, string>): Promise<Measured> {
  const diffs = await engine.frameDiffs(input.store.path(need(input, "mp4")));
  const options = { ...DEFAULT_OPTIONS, ...config.inspect };
  const { sampled: moments, probed } = inspection;
  const framediff = storedIfLarge(input, outputs, "framediff", diffs);
  const probe = storedIfLarge(input, outputs, "qa-probe", probed);
  const words = readTiming(json(input, need(input, "words")));
  const timing = timingReport({ timeline, words, held: heldBeats(input), diffs, fps: RENDER_FPS, probed, profile: config.timing ?? timingProfile() });
  return {
    sweep: config.sweep !== false,
    framediff: framediff === undefined ? { fps: RENDER_FPS, shares: diffs } : { fps: RENDER_FPS, artifact: framediff },
    probe: probe === undefined ? { moments: probed } : { artifact: probe },
    measured: measuredFindings({ timeline, moments, probed, diffs, fps: RENDER_FPS, stage: { width: options.W, height: options.H } }),
    timing,
  };
}

/**
 * The `explainer.qa` body (workflow plan §2.3 stage 9): render-qa's gate over the served page at the cue moments and
 * the 2 Hz sweep, the page-measured checks over the probe and the MP4's frame change, the DIRECTION timing gates, the
 * MP4's length against the timeline QA inspected, and `qa.json` (`explainer.qa/v1`). It never fails on a finding; the stage's checks read
 * `qa.json` and gate.
 */
export async function runQaStage(input: QaInput, config: QaConfig, engine: QaEngine): Promise<StageOutcome> {
  const mp4 = input.store.path(need(input, "mp4"));
  const timeline = readTimeline(input);
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-qa-"));
  try {
    const inspection = await servedInspection(input, engine, timeline, config, scratch);
    const { held } = inspection;
    const outputs: Record<string, string> = {};
    const measured = await measure(input, engine, timeline, inspection, config, outputs);
    const mp4S = { durationS: await engine.durationS(mp4), timelineS: timelineS(timeline), frameS: 1 / RENDER_FPS };
    const source = input.artifacts.timeline === undefined ? "words" : "timeline";
    const report = qaReport(held, {
      profile: config.profile ?? null, gateProfileSha: config.sha, gate: config.gate, timeline: source, moments: inspection.moments, mp4: mp4S, ...measured,
      notes: [`${timeline.beats.length} beats from ${source}`],
    });
    outputs.qa = input.store.putText(`${JSON.stringify(report, null, 1)}\n`, "qa", input.from);
    if (held.errors.length > 0) outputs["qa-crops"] = input.store.putTree(path.join(scratch, "crops"), "qa-crops", input.from);
    return { outputs, notes: [qaSummary(report), `${report.notes[0]}; mp4 ${mp4S.durationS.toFixed(2)} s`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
