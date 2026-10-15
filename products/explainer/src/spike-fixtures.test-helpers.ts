import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/spike/redesign-explainer-v4/${name}`, import.meta.url), "utf8"));

/** The frozen v4 spike script subset; see the fixture folder's README for its source. */
export const v4Script = (): unknown => read("script.json");

/** The durations-only extract of the v4 words.json, all 75 beats. */
export const v4Durations = (): unknown => read("durations.json");

/** The v4 labelled set from the script-evals plan section 4.1. */
export const v4Labels = (): unknown => read("labels.json");

export const V4_LABELS_PATH = fileURLToPath(new URL("../fixtures/spike/redesign-explainer-v4/labels.json", import.meta.url));
