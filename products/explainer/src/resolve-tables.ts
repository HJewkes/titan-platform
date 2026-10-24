import type { z } from "zod";
import type { VisualSchema } from "./map-state.js";
import type { BEAT_FUNCTIONS, FRAMINGS, VISUAL_LAYERS } from "./script-schema.js";

/**
 * The resolver's tables (profiles plan A.2, PP-6): `{function, job, content, route}` to `{beat, framing, layer}`, then
 * framing to anchors. They are the change class ar target 2 tunes (workflow plan §6.2), so every choice lives here as
 * data. No row matches everything: a beat no row matches is refused, never drawn as a list.
 */

/** What a beat's visual track carries, read off its fields: the resolver's `content` key. */
export const CONTENT_SHAPES = ["code", "map", "items", "statement"] as const;

type BeatFunction = (typeof BEAT_FUNCTIONS)[number];
type VisualJob = z.infer<typeof VisualSchema.shape.job>;
export type ContentShape = (typeof CONTENT_SHAPES)[number];
export type Framing = (typeof FRAMINGS)[number];
export type VisualLayer = (typeof VISUAL_LAYERS)[number];

/** A beat's resolver key. `route` is the visual-router type its `kind` names, or `none`. */
export interface ResolveKey {
  function: BeatFunction;
  job: VisualJob;
  content: ContentShape;
  route: string;
}

/** One table row: each listed field must hold one of its values, and an unlisted field matches any value. */
export interface ResolveRow {
  id: string;
  when: { function?: readonly BeatFunction[]; job?: readonly VisualJob[]; content?: readonly ContentShape[]; route?: readonly string[] };
  then: { beat: string; framing: Framing; layer: VisualLayer };
}

const template = (beat: string, framing: Framing): ResolveRow["then"] => ({ beat, framing, layer: "template" });

/** Ordered most specific first; the first row that matches wins. */
export const RESOLVE_ROWS: readonly ResolveRow[] = [
  { id: "code-excerpt", when: { content: ["code"] }, then: template("code-walk", "focus") },
  // A cast in motion is the one job a still template cannot carry (plan A.2): it resolves to a moving layer.
  { id: "cast-in-motion", when: { job: ["cast-in-motion"] }, then: { beat: "request-walk", framing: "full", layer: "custom" } },
  { id: "route-chart", when: { route: ["bar", "scatter", "treemap", "line", "heatmap", "waterfall", "funnel"] }, then: template("chart", "focus") },
  { id: "route-schema", when: { route: ["er", "db-schema", "uml-class"] }, then: template("schema", "focus") },
  { id: "route-sequence", when: { route: ["sequence", "swimlane"] }, then: template("sequence", "full") },
  { id: "route-timeline", when: { route: ["timeline"] }, then: template("history", "full") },
  { id: "route-gantt", when: { route: ["gantt"] }, then: template("gantt", "full") },
  { id: "route-kanban", when: { route: ["kanban"] }, then: template("kanban-flow", "full") },
  {
    id: "route-graph",
    when: { route: ["dependency-graph", "architecture", "architecture-delta", "high-level", "hub-spoke", "deployment", "data-flow", "flowchart"] },
    then: template("info-flow", "full"),
  },
  { id: "map-state", when: { content: ["map"] }, then: template("arch-map", "full") },
  { id: "map", when: { job: ["map"] }, then: template("arch-map", "full") },
  { id: "zoom", when: { job: ["zoom"] }, then: template("zoom", "focus") },
  { id: "alternatives", when: { job: ["alternatives-vs-ours"] }, then: template("compare", "split") },
  { id: "artifact-filling", when: { job: ["artifact-filling"] }, then: template("scorecard", "focus") },
  // A HOW beat's code proof with no excerpt shows the checks behind the mechanism: C5 voices that at the code band, as proof's spec does.
  { id: "code-proof", when: { function: ["HOW"], job: ["code-proof"], content: ["items", "statement"] }, then: template("proof", "focus") },
  { id: "hook", when: { function: ["HOOK"], job: ["numbers"] }, then: template("hook", "full") },
  { id: "stake", when: { function: ["STAKE"], job: ["numbers"] }, then: template("stakes", "focus") },
  { id: "promise", when: { function: ["PROMISE"], job: ["numbers"] }, then: template("promise", "stack") },
  { id: "misconception", when: { function: ["MISCONCEPTION"], job: ["numbers"] }, then: template("misconception", "split") },
  { id: "history", when: { function: ["HISTORY"], job: ["numbers"] }, then: template("history-why", "full") },
  { id: "verdict", when: { function: ["VERDICT"], job: ["numbers"] }, then: template("verdict-card", "focus") },
  { id: "close", when: { function: ["CLOSE"], job: ["numbers"] }, then: template("takeaways", "stack") },
  { id: "numbers", when: { job: ["numbers"], content: ["items", "statement"] }, then: template("stat", "focus") },
];

/** The anchor cells or ranges each framing occupies on the 6×6 grid (provisional, as the grid is: TP-4015). */
export const FRAMING_ANCHORS: Readonly<Record<Framing, readonly string[]>> = {
  full: ["A1:F6"],
  focus: ["B2:E5"],
  split: ["A1:C6", "D1:F6"],
  stack: ["B1:E3", "B4:E6"],
  grid: ["A1:F6"],
  inset: ["A1:F6", "E5:F6"],
};

const allows = <T>(values: readonly T[] | undefined, value: T): boolean => values === undefined || values.includes(value);

/** The first row whose every listed field holds the key's value, or undefined. */
export function matchRow(key: ResolveKey, rows: readonly ResolveRow[] = RESOLVE_ROWS): ResolveRow | undefined {
  return rows.find(({ when }) => allows(when.function, key.function) && allows(when.job, key.job) && allows(when.content, key.content) && allows(when.route, key.route));
}
