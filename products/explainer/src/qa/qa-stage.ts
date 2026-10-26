import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addLateFill, classify, DEFAULT_OPTIONS, type Held, type InspectOptions, type Moment, type SampledFrame } from "@titan-design/render-qa";
import { RENDER_FPS } from "../render/render-video.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema } from "../script-schema.js";
import type { ArtifactStore } from "../workflow/artifacts.js";
import type { ModelStageInput } from "../workflow/model-stages.js";
import type { StageOutcome } from "../workflow/records.js";
import type { QaEngine, QaPage } from "./qa-engine.js";
import { leadLineBeats } from "./qa-lead-lines.js";
import { qaReport, qaSummary } from "./qa-report.js";
import { qaCues, qaMoments, timelineFromArtifact, timelineFromWords, timelineS, type QaTimeline } from "./qa-timeline.js";
import type { QaGate } from "./gate-profile.js";
import { serveTree } from "./serve-tree.js";

export interface QaConfig extends QaGate {
  /** The run's video type, recorded in qa.json. */
  profile?: string;
  /** The bridged spike page's `?page=` stem, read only when the render wrote no `timeline`. */
  page?: string;
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

async function sampleFrames(page: QaPage, moments: readonly Moment[], options: InspectOptions): Promise<SampledFrame[]> {
  const frames: SampledFrame[] = [];
  for (const moment of moments) {
    const { contentRuns, findings } = await page.inspectAt(moment.t, options);
    frames.push({ beat: moment.beat, local: moment.local, t: moment.t, kind: moment.kind, contentRuns, findings });
  }
  return frames;
}

interface Inspection {
  held: Held;
  moments: number;
}

/** Seeks to every cue moment, holds what persists under the profile's gating kinds, and crops each held error. */
async function inspectPage(engine: QaEngine, url: string, timeline: QaTimeline, config: QaConfig, cropDir: string, lead: Set<string>): Promise<Inspection> {
  const options: InspectOptions = { ...DEFAULT_OPTIONS, ...config.inspect };
  const cues = qaCues(timeline);
  const moments = qaMoments(timeline);
  const page = await engine.open(url, options, cues);
  try {
    const frames = await sampleFrames(page, moments, options);
    addLateFill(frames.filter((frame) => !lead.has(frame.beat)), cues, new Map(timeline.beats.map((beat) => [beat.id, beat.durationS])));
    const held = classify(frames, { gate: config.gate });
    if (held.errors.length > 0) await page.crops(held.errors, cropDir, options);
    return { held, moments: moments.length };
  } finally {
    await page.close();
  }
}

async function servedInspection(input: QaInput, engine: QaEngine, timeline: QaTimeline, config: QaConfig, scratch: string): Promise<Inspection> {
  const tree = path.join(scratch, "page");
  const query = pageQuery(input, tree, config);
  const served = await serveTree(tree);
  try {
    return await inspectPage(engine, `${served.origin}/${query}`, timeline, config, path.join(scratch, "crops"), leadLineBeats(input));
  } finally {
    await served.close();
  }
}

/**
 * The `explainer.qa` body (workflow plan §2.3 stage 9): render-qa's cue-moment gate over the served page, the MP4's
 * length against the timeline QA inspected, and `qa.json` (`explainer.qa/v1`). It never fails on a finding; the
 * stage's `held-errors` and `mp4-duration` checks read `qa.json` and gate.
 */
export async function runQaStage(input: QaInput, config: QaConfig, engine: QaEngine): Promise<StageOutcome> {
  const mp4 = input.store.path(need(input, "mp4"));
  const timeline = readTimeline(input);
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-qa-"));
  try {
    const { held, moments } = await servedInspection(input, engine, timeline, config, scratch);
    const mp4S = { durationS: await engine.durationS(mp4), timelineS: timelineS(timeline), frameS: 1 / RENDER_FPS };
    const source = input.artifacts.timeline === undefined ? "words" : "timeline";
    const report = qaReport(held, {
      profile: config.profile ?? null, gateProfileSha: config.sha, gate: config.gate, timeline: source, moments, mp4: mp4S,
      notes: [`${timeline.beats.length} beats from ${source}`],
    });
    const outputs: Record<string, string> = { qa: input.store.putText(`${JSON.stringify(report, null, 1)}\n`, "qa", input.from) };
    if (held.errors.length > 0) outputs["qa-crops"] = input.store.putTree(path.join(scratch, "crops"), "qa-crops", input.from);
    return { outputs, notes: [qaSummary(report), `${report.notes[0]}; mp4 ${mp4S.durationS.toFixed(2)} s`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
