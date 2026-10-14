import { readFileSync } from "node:fs";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/spike/redesign-explainer-v4/${name}`, import.meta.url), "utf8"));

/** The frozen v4 spike script subset; see the fixture folder's README for its source. */
export const v4Script = (): unknown => read("script.json");

/** The durations-only extract of the v4 words.json, all 75 beats. */
export const v4Durations = (): unknown => read("durations.json");
