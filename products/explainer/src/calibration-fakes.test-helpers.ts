import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditionEntry } from "./calibration-auditions.js";

export type Scores = Partial<Record<"J8" | "J9" | "J10" | "J11" | "J12", number | null>>;

/** A synthetic parcel-desk candidate; its structure, system, id and scores are what the owner must never see. */
const candidate = (id: string, rubric: Scores | null, structure = `shape-${id}`, desk = id.endsWith("-p") ? "north" : "south") => ({
  id, structure, system: `system-${id}`, basis: "fit", likelihood: 0.42, tension: {}, skipped: [], findings: [],
  scores: { total: 0.913 },
  spine: {
    structure, system: `system-${id}`, likelihood: 0.42, sentence: `The ${desk} desk refuses ghost labels.`, hook: { fact: "F1", line: `A ${desk} parcel that does not exist.` },
    blocks: [
      { id: `${structure}-open`, question: `Why does the ${desk} desk refuse it?`, facts: ["F1"], seconds: 30, beat: "hook", covers: [] },
      { id: "close", question: "What does the courier do next?", facts: ["F1"], seconds: 20, beat: "payoff", covers: [] },
    ],
    payoff: "close", signatureLayer: "ledger", cuts: [],
  },
  rubric: rubric && {
    eval_version: "rubric-v1", judge: "fake", mode: "reported",
    dims: Object.entries(rubric).map(([dim, score]) => ({ dim, verdict: { score, evidence: "", void_reason: score === null ? "no quote" : null } })),
  },
});

export function auditionEntry(dir: string, name: string, pick: Scores | null, runnerUp: Scores | null): AuditionEntry {
  const record = join(dir, `${name}.json`);
  const candidates = [candidate(`${name}-p`, pick), candidate(`${name}-r`, runnerUp)];
  writeFileSync(record, JSON.stringify({
    schema: "audition/v1", profile: { type: "repo-tour", version: "0.4.0", runtimeS: 90 }, candidates,
    pick: { candidate: `${name}-p`, structure: "shape-p", system: null, total: 0.913 }, runnerUp: { candidate: `${name}-r`, structure: "shape-r", system: null, total: 0.9 },
  }));
  return { case: "explainer-eval/pairs", title: "Storyboard pairs", video_type: "repo-tour", split: "dev", owner_named: false, record };
}

