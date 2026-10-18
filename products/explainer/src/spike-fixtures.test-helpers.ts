import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = (script: string, name: string): URL => new URL(`../fixtures/spike/${script}/${name}`, import.meta.url);
const read = (name: string, script = "redesign-explainer-v4"): unknown => JSON.parse(readFileSync(fixture(script, name), "utf8"));

/** The frozen v4 spike script subset; see the fixture folder's README for its source. */
export const v4Script = (): unknown => read("script.json");

/** The durations-only extract of the v4 words.json, all 75 beats. */
export const v4Durations = (): unknown => read("durations.json");

/** The v4 labelled set from the script-evals plan section 4.1. */
export const v4Labels = (): unknown => read("labels.json");

export const V4_LABELS_PATH = fileURLToPath(fixture("redesign-explainer-v4", "labels.json"));

/** The frozen pipeline-explainer spike script, the hold-out fixture; see its folder's README. */
export const pipelineScript = (): unknown => read("script.json", "pipeline-explainer");

/** The pipeline-explainer labels frozen from its first `eval pace` run. */
export const pipelineLabels = (): unknown => read("labels.json", "pipeline-explainer");
