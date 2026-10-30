import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore } from "../workflow/artifacts.js";
import type { ModelStageInput } from "../workflow/model-stages.js";
import type { StageOutcome } from "../workflow/records.js";
import { qaCoreReport, type QaConfig } from "./qa-core.js";
import type { QaEngine } from "./qa-engine.js";
import { leadLineBeats } from "./qa-lead-lines.js";
import { qaSummary, type QaReport } from "./qa-report.js";
import { serveTree } from "./serve-tree.js";

export type { QaConfig } from "./qa-core.js";

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

/** qa's report core over the page tree served from `scratch`; large series become outputs. */
async function servedReport(input: QaInput, engine: QaEngine, config: QaConfig, scratch: string, outputs: Record<string, string>): Promise<QaReport> {
  const [mp4, timeline] = [input.store.path(need(input, "mp4")), json(input, need(input, "timeline"))];
  const tree = path.join(scratch, "page");
  const query = pageQuery(input, tree);
  const served = await serveTree(tree);
  try {
    const sources = {
      pageUrl: `${served.origin}/${query}`, mp4, timeline, words: json(input, need(input, "words")),
      script: json(input, need(input, "script")), resolved: json(input, need(input, "resolved")), vtt: vttText(input), lead: leadLineBeats(input), cropDir: path.join(scratch, "crops"),
      put: (name: string, text: string) => (outputs[name] = input.store.putText(text, name, input.from)),
    };
    return await qaCoreReport(sources, engine, config);
  } finally {
    await served.close();
  }
}

/**
 * The `explainer.qa` body (workflow plan §2.3 stage 9): render-qa's gate over the served page at the cue moments and
 * the 2 Hz sweep, the page-measured checks over the probe and the MP4's frame change, the DIRECTION timing gates, the
 * MP4's black, silent and frozen stretches by beat, the MP4's length against the timeline QA inspected, and `qa.json` (`explainer.qa/v1`). It never fails on a finding; the stage's checks read
 * `qa.json` and gate.
 */
export async function runQaStage(input: QaInput, config: QaConfig, engine: QaEngine): Promise<StageOutcome> {
  const scratch = mkdtempSync(path.join(tmpdir(), "explainer-qa-"));
  try {
    const outputs: Record<string, string> = {};
    const report = await servedReport(input, engine, config, scratch, outputs);
    outputs.qa = input.store.putText(`${JSON.stringify(report, null, 1)}\n`, "qa", input.from);
    if (report.errors.length > 0) outputs["qa-crops"] = input.store.putTree(path.join(scratch, "crops"), "qa-crops", input.from);
    return { outputs, notes: [qaSummary(report), `${report.notes[0]}; mp4 ${report.mp4.durationS.toFixed(2)} s`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
