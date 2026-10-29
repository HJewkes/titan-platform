import { writeFile } from "node:fs/promises";
import { countByKind } from "@titan-design/render-qa";
import { cueGate, type CueGateResult } from "../qa/cue-gate.js";
import type { QaGate } from "../qa/gate-profile.js";
import { chromiumQaEngine, type QaEngine } from "../qa/qa-engine.js";
import type { QaTimeline } from "../qa/qa-timeline.js";

/** A timeline beat as the gate reads it; `cues` are beat-local seconds, as TP-2990's `Timeline` writes them. */
export interface GateBeat {
  id: string;
  kind?: string;
  startS: number;
  durationS: number;
  cues?: Readonly<Record<string, number>>;
  /** The fill's page hints as `timeline.json` carries them; only `qaLeadLine` is read here. */
  hints?: { qaLeadLine?: true };
}

/** `gate` holds the render while errors are held; `skip` renders unchecked and the manifest says so. */
export interface RenderQa {
  mode: "gate" | "skip";
  gate: QaGate;
}

export type RenderQaGate = (pageUrl: string, timeline: { beats: readonly GateBeat[] }, gate: QaGate) => Promise<CueGateResult>;

/** Thrown before any mix or frame is written: the page holds QA errors and `qa.json` names them. */
export class QaRefused extends Error {
  constructor(stem: string, readonly qaJson: string, readonly heldErrors: number) {
    super(`qa: refusing to render ${stem}: ${heldErrors} held errors; see ${qaJson}, or render with qa mode "skip"`);
    this.name = "QaRefused";
  }
}

function qaTimeline({ beats }: { beats: readonly GateBeat[] }): QaTimeline {
  return {
    beats: beats.map(({ id, kind, startS, durationS, cues }) => ({
      id, kind, startS, durationS, cues: Object.entries(cues ?? {}).map(([name, atS]) => ({ name, atS })),
    })),
  };
}

/** Beats whose lead line stands alone, from the timeline's own hints: the set the qa stage derives from the fill. */
function leadLines({ beats }: { beats: readonly GateBeat[] }): Set<string> {
  return new Set(beats.filter((beat) => beat.hints?.qaLeadLine).map((beat) => beat.id));
}

/** render-qa's cue-moment gate over the served page, the same code the qa stage runs. */
export function qaGateWith(engine: Pick<QaEngine, "open">): RenderQaGate {
  return (pageUrl, timeline, gate) => cueGate(engine, pageUrl, qaTimeline(timeline), gate, { lead: leadLines(timeline) });
}

export const defaultQaGate: RenderQaGate = (pageUrl, timeline, gate) => qaGateWith(chromiumQaEngine())(pageUrl, timeline, gate);

/** The gate's verdict beside the render, so a refusal points at the held errors by kind and beat. */
export async function writeGateReport(file: string, { held }: CueGateResult, gate: QaGate): Promise<void> {
  const errors = held.errors.map(({ kind, beat, ts, reason, finding }) => ({ kind, beat, ts, reason, at: finding.at, el: finding.el }));
  const report = { schema: "explainer.render-qa-gate/v1", pass: errors.length === 0, gateProfileSha: gate.sha, gate: gate.gate, errorCounts: countByKind(held.errors), errors };
  await writeFile(file, `${JSON.stringify(report, null, 1)}\n`);
}
