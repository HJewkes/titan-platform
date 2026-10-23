import { readFileSync } from "node:fs";
import { beatSpec, BEATS } from "./beat-fixtures.test-helpers.js";
import type { BeatSpec } from "./beat-schema.js";
import type { EmphasisBox, MarkFrame } from "./emphasis-change.js";
import type { EmphasisGateInput, EmphasisLayout } from "./emphasis-gate.js";
import { ScriptSchema } from "./script-schema.js";

// Synthetic: an invented two-line code walk and a three-node map; nothing here is a real render.
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/emphasis/${name}`, import.meta.url), "utf8"));

/** The invented specs plus `flow-map`, whose nodes and edges are both target lists, so one id can name two elements. */
const SPECS: ReadonlyMap<string, BeatSpec> = new Map([
  ...BEATS,
  ["flow-map", beatSpec("flow-map", { slots: "map", emphasis: { targets: ["nodes", "edges"], treatments: ["trace", "colour"] } })],
]);

export const emphasisScript = () => ScriptSchema.parse(read("script.json"));
export const emphasisSlots = () => read("slots.json") as Record<string, Record<string, unknown>>;
export const emphasisLayout = () => read("layout.json") as EmphasisLayout & { boxes: Record<string, Record<string, EmphasisBox>> };

/** The gate's input over the fixtures, with any field replaced. */
export const gateInput = (overrides: Partial<EmphasisGateInput> = {}): EmphasisGateInput => ({
  beats: emphasisScript().beats,
  specs: SPECS,
  slots: emphasisSlots(),
  layout: emphasisLayout(),
  ...overrides,
});

/** A flat grey frame with an optional filled rectangle, small enough to diff in a test. */
export function frame(width: number, height: number, fill?: { x: number; y: number; width: number; height: number; level: number }): MarkFrame {
  const rgba = new Uint8Array(width * height * 4).fill(40);
  if (fill) {
    for (let y = fill.y; y < fill.y + fill.height; y++) {
      for (let x = fill.x; x < fill.x + fill.width; x++) rgba.fill(fill.level, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
  }
  return { width, height, rgba };
}
