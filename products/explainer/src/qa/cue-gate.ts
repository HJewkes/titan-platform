import { addLateFill, classify, DEFAULT_OPTIONS, type Held, type InspectOptions, type Moment, type SampledFrame } from "@titan-design/render-qa";
import type { QaEngine, QaPage } from "./qa-engine.js";
import type { QaGate } from "./gate-profile.js";
import { qaCues, qaMoments, type QaTimeline } from "./qa-timeline.js";

async function sampleFrames(page: QaPage, moments: readonly Moment[], options: InspectOptions): Promise<SampledFrame[]> {
  const frames: SampledFrame[] = [];
  for (const moment of moments) {
    const { contentRuns, findings } = await page.inspectAt(moment.t, options);
    frames.push({ beat: moment.beat, local: moment.local, t: moment.t, kind: moment.kind, contentRuns, findings });
  }
  return frames;
}

export interface CueGateResult {
  held: Held;
  moments: number;
}

interface CueGateOptions {
  /** Beats whose stage holds only a lead line, which late-fill must not read as an empty stage. */
  lead?: ReadonlySet<string>;
  /** Where to write an annotated crop of each held error; no crops without it. */
  cropDir?: string;
}

/**
 * render-qa's cue-moment gate, shared by the qa stage and render's pre-capture refusal: seeks to every cue moment,
 * holds what persists under the profile's gating kinds, and crops each held error when asked.
 */
export async function cueGate(engine: Pick<QaEngine, "open">, url: string, timeline: QaTimeline, gate: Omit<QaGate, "sha">, opts: CueGateOptions = {}): Promise<CueGateResult> {
  const options: InspectOptions = { ...DEFAULT_OPTIONS, ...gate.inspect };
  const cues = qaCues(timeline);
  const moments = qaMoments(timeline);
  const lead = opts.lead ?? new Set<string>();
  const page = await engine.open(url, options, cues);
  try {
    const frames = await sampleFrames(page, moments, options);
    addLateFill(frames.filter((frame) => !lead.has(frame.beat)), cues, new Map(timeline.beats.map((beat) => [beat.id, beat.durationS])));
    const held = classify(frames, { gate: gate.gate });
    if (opts.cropDir !== undefined && held.errors.length > 0) await page.crops(held.errors, opts.cropDir, options);
    return { held, moments: moments.length };
  } finally {
    await page.close();
  }
}
