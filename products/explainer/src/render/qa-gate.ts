import { writeFile } from "node:fs/promises";
import { countByKind } from "@titan-design/render-qa";
import type { Browser } from "playwright-core";
import { cueGate, type CueGateResult } from "../qa/cue-gate.js";
import type { QaGate } from "../qa/gate-profile.js";
import { chromiumQaEngine, type QaEngine } from "../qa/qa-engine.js";
import type { QaReport } from "../qa/qa-report.js";
import type { QaTimeline } from "../qa/qa-timeline.js";
import type { Check } from "../workflow/records.js";

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

/** qa's report on the encoded MP4, captured from the page at `pageUrl`. */
export type EncodedQa = (pageUrl: string, files: { mp4: string; vtt: string }) => Promise<QaReport>;

/** `gate` holds the render while errors are held; `skip` renders unchecked and the manifest says so. */
export interface RenderQa {
  mode: "gate" | "skip";
  gate: QaGate;
  /** Runs after encode; qa's gate rows over its report refuse the render as the qa stage would fail it. */
  encoded?: EncodedQa;
}

export type RenderQaGate = (pageUrl: string, timeline: { beats: readonly GateBeat[] }, gate: QaGate) => Promise<CueGateResult>;

/** The qa gate rows that failed, by name. */
export const failedQaGates = (checks: readonly Check[]): string[] => checks.filter((check) => check.gate === true && !check.pass).map((check) => check.name);

/** Why the render was refused: its held errors and, after encode, the qa gate rows that failed. */
export function refusalCause(heldErrors: number, checks: readonly Check[]): string {
  const failed = failedQaGates(checks);
  return `${heldErrors} held errors${failed.length > 0 ? `, qa gates failed: ${failed.join(", ")}` : ""}`;
}

/** Thrown before any mix or frame is written when the page holds QA errors, or after encode when a qa gate row fails; `qa.json` names them. */
export class QaRefused extends Error {
  constructor(stem: string, readonly qaJson: string, readonly heldErrors: number, readonly checks: readonly Check[] = []) {
    super(`qa: refusing to render ${stem}: ${refusalCause(heldErrors, checks)}; see ${qaJson}, or render with qa mode "skip"`);
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

/** render-qa's gate over the served page at the cue moments and the 2 Hz sweep, the same samples the qa stage holds errors on. */
export function qaGateWith(engine: Pick<QaEngine, "open">): RenderQaGate {
  return (pageUrl, timeline, gate) => cueGate(engine, pageUrl, qaTimeline(timeline), gate, { lead: leadLines(timeline), sweep: true });
}

/** The gate on real Chromium, in `browser` when one is lent. */
export function chromiumQaGate(browser?: Browser): RenderQaGate {
  return (pageUrl, timeline, gate) => qaGateWith(chromiumQaEngine(undefined, browser))(pageUrl, timeline, gate);
}

/** The gate's verdict beside the render, so a refusal points at the held errors by kind and beat. */
export async function writeGateReport(file: string, { held }: CueGateResult, gate: QaGate): Promise<void> {
  const errors = held.errors.map(({ kind, beat, ts, reason, finding }) => ({ kind, beat, ts, reason, at: finding.at, el: finding.el }));
  const report = { schema: "explainer.render-qa-gate/v1", pass: errors.length === 0, gateProfileSha: gate.sha, gate: gate.gate, errorCounts: countByKind(held.errors), errors };
  await writeFile(file, `${JSON.stringify(report, null, 1)}\n`);
}
