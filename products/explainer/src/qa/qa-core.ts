import { DEFAULT_OPTIONS } from "@titan-design/render-qa";
import { z } from "zod";
import { parseTimeline } from "../composition/timeline.js";
import { renameWordsBeats, storyboardIds } from "../render/beat-ids.js";
import { RENDER_FPS } from "../render/render-video.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { readTiming } from "../timing.js";
import { captionReport } from "./caption-check.js";
import { contrastReport } from "./contrast-check.js";
import { cueGate, type CueGateResult } from "./cue-gate.js";
import { CONTRAST, type QaGate } from "./gate-profile.js";
import type { QaEngine } from "./qa-engine.js";
import { measuredFindings } from "./qa-measured.js";
import { narrationFactsReport } from "./narration-facts.js";
import { INLINE_MAX_BYTES, mediaScanByBeat, qaReport, type QaReport } from "./qa-report.js";
import { timelineFromArtifact, timelineS, type QaTimeline } from "./qa-timeline.js";
import { timingProfile, timingReport, type TimingProfile } from "./timing-gates.js";

export interface QaConfig extends QaGate {
  /** The run's video type, recorded in qa.json. */
  profile?: string;
  /** The 2 Hz sweep joins the cue moments unless this is false. */
  sweep?: boolean;
  /** The type profile's timing thresholds; the defaults when the run has no profile. */
  timing?: TimingProfile;
}

/** What qa's report reads: the served page and the MP4 it was captured to, and the run's artifacts as parsed JSON. */
interface QaSources {
  /** The composition page, served and laid out on `timeline`. */
  pageUrl: string;
  /** The MP4 on disk. */
  mp4: string;
  timeline: unknown;
  words: unknown;
  script: unknown;
  resolved: unknown;
  /** The caption track; a render that made none is the caption check's finding. */
  vtt: string | undefined;
  /** Beats whose lead line stands alone by design. */
  lead: ReadonlySet<string>;
  /** Where each held error's annotated crop is written. */
  cropDir: string;
  /** Keeps a series too large to sit inline in qa.json and returns its sha. */
  put: (name: string, text: string) => string;
}

type Measured = Pick<QaReport, "sweep" | "framediff" | "probe" | "measured" | "timing" | "mediaScan" | "captions" | "narrationFacts" | "flash" | "contrast">;

/** What the timing gates read of the script: the beats it declares held, by `heldS` or the held speech band. */
const HeldScriptSchema = z.object({ beats: z.array(z.object({ id: z.string(), band: z.string().optional(), heldS: z.number().optional() })) });

/** words.json and the script name beats by script id, the render's timeline by storyboard id. */
const timelineIds = (sources: QaSources): Map<string, string> => storyboardIds(HeldScriptSchema.parse(sources.script), ResolvedSchema.parse(sources.resolved));

function heldBeats(sources: QaSources, ids: ReadonlyMap<string, string>): Set<string> {
  const { beats } = HeldScriptSchema.parse(sources.script);
  return new Set(beats.filter((beat) => beat.band === "held" || (beat.heldS ?? 0) > 0).flatMap((beat) => ids.get(beat.id) ?? []));
}

/** A series too large to sit inline in qa.json goes to its own artifact; returns its sha. */
function storedIfLarge(sources: QaSources, name: string, value: unknown): string | undefined {
  const text = JSON.stringify(value);
  return text.length <= INLINE_MAX_BYTES ? undefined : sources.put(name, `${text}\n`);
}

/** The MP4's frame change and the probe, inline or by sha, and the page-measured findings they give. */
async function measure(sources: QaSources, engine: QaEngine, timeline: QaTimeline, inspection: CueGateResult, config: QaConfig): Promise<Measured> {
  const diffs = await engine.frameDiffs(sources.mp4);
  const options = { ...DEFAULT_OPTIONS, ...config.inspect };
  const { sampled: moments, probed } = inspection;
  const framediff = storedIfLarge(sources, "framediff", diffs);
  const probe = storedIfLarge(sources, "qa-probe", probed);
  const ids = timelineIds(sources);
  const words = readTiming(renameWordsBeats(sources.words, ids));
  const timing = timingReport({ timeline, words, held: heldBeats(sources, ids), diffs, fps: RENDER_FPS, probed, profile: config.timing ?? timingProfile() });
  return {
    sweep: config.sweep !== false,
    framediff: framediff === undefined ? { fps: RENDER_FPS, shares: diffs } : { fps: RENDER_FPS, artifact: framediff },
    probe: probe === undefined ? { moments: probed } : { artifact: probe },
    measured: measuredFindings({ timeline, moments, probed, diffs, fps: RENDER_FPS, stage: { width: options.W, height: options.H } }),
    timing,
    mediaScan: mediaScanByBeat(await engine.mediaScan(sources.mp4), timeline),
    captions: captionReport(sources.vtt, sources.words),
    narrationFacts: narrationFactsReport(probed, (beat) => (words.get(beat)?.words ?? []).map((w) => w.word).join(" ")),
    flash: await engine.flashScan(sources.mp4),
    contrast: contrastReport(parseTimeline(sources.timeline).beats, [...inspection.held.errors, ...inspection.held.info], CONTRAST, options),
  };
}

/**
 * qa's report (`explainer.qa/v1`): render-qa's gate over the served page at the cue moments and the 2 Hz sweep, the
 * page-measured checks over the probe and the MP4's frame change, the DIRECTION timing gates, the MP4's black, silent
 * and frozen stretches by beat, and the MP4's length against the timeline. The qa stage and render both run it, so
 * render's verdict on an MP4 is the qa stage's.
 */
export async function qaCoreReport(sources: QaSources, engine: QaEngine, config: QaConfig): Promise<QaReport> {
  const timeline = timelineFromArtifact(sources.timeline);
  const inspection = await cueGate(engine, sources.pageUrl, timeline, config, { lead: sources.lead, cropDir: sources.cropDir, sweep: config.sweep !== false, probe: true });
  const measured = await measure(sources, engine, timeline, inspection, config);
  const mp4 = { durationS: await engine.durationS(sources.mp4), timelineS: timelineS(timeline), frameS: 1 / RENDER_FPS };
  return qaReport(inspection.held, {
    profile: config.profile ?? null, gateProfileSha: config.sha, gate: config.gate, timeline: "timeline", moments: inspection.moments, mp4, ...measured,
    notes: [`${timeline.beats.length} beats from timeline`],
  });
}
