import { emphasisTargets, parseBeatSlots } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import { emphasisStepChanges, type EmphasisBox, type MarkFrame } from "./emphasis-change.js";
import type { ScriptBeat } from "./script-schema.js";

/** The laid-out frame: its size, and each beat's element boxes by element id. */
export interface EmphasisLayout {
  stage: { width: number; height: number };
  boxes: Readonly<Record<string, Readonly<Record<string, EmphasisBox>>>>;
}

/** The mark frames either side of one cue's step, keyed by beat id and then cue index. */
export type EmphasisMarks = Readonly<Record<string, Readonly<Record<number, { before: MarkFrame; after: MarkFrame }>>>>;

/**
 * What the resolve stage knows before render: the script, the beat-spec registry, each beat's slots by beat id, and,
 * once laid out, the element boxes. `marks` is the contact-sheet input TP-3000 will produce.
 */
export interface EmphasisGateInput {
  beats: readonly Pick<ScriptBeat, "id" | "visual">[];
  specs: ReadonlyMap<string, BeatSpec>;
  slots: Readonly<Record<string, unknown>>;
  /** The element ids each built custom layer exposes, by beat id: a beat listed here is held to its layer, not a beat spec. */
  layers?: Readonly<Record<string, readonly string[]>>;
  layout?: EmphasisLayout;
  marks?: EmphasisMarks;
}

export const EMPHASIS_PROBLEMS = ["no-beat-spec", "bad-slots", "no-element", "ambiguous", "off-frame", "unchanged"] as const;
export type EmphasisProblem = (typeof EMPHASIS_PROBLEMS)[number];

export interface EmphasisFailure {
  beat: string;
  cue: number;
  target: string;
  problem: EmphasisProblem;
  detail: string;
}

type Cue = ScriptBeat["visual"]["cues"][number];
type Fail = (cue: number, target: string, problem: EmphasisProblem, detail: string) => EmphasisFailure;

const onFrame = (box: EmphasisBox, stage: EmphasisLayout["stage"]): boolean =>
  box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= stage.width && box.y + box.height <= stage.height;

type Resolved = { spec: BeatSpec; slots: Record<string, unknown> } | { problem: EmphasisProblem; detail: string };

function beatSlots(input: EmphasisGateInput, beat: Pick<ScriptBeat, "id" | "visual">): Resolved {
  const ref = beat.visual.beat;
  if (ref === undefined) return { problem: "no-beat-spec", detail: "the beat names no beat spec (visual.beat)" };
  try {
    return { spec: input.specs.get(ref)!, slots: parseBeatSlots(input.specs, ref, input.slots[beat.id]) };
  } catch (error) {
    return { problem: "bad-slots", detail: error instanceof Error ? error.message : String(error) };
  }
}

function placement(input: EmphasisGateInput, beat: string, cue: number, target: string, fail: Fail): EmphasisFailure[] {
  if (!input.layout) return [];
  const box = input.layout.boxes[beat]?.[target];
  if (!box) return [fail(cue, target, "off-frame", `element ${target} is not laid out`)];
  if (!onFrame(box, input.layout.stage)) return [fail(cue, target, "off-frame", `element ${target} is not wholly inside the frame`)];
  const step = input.marks?.[beat]?.[cue];
  if (step && !emphasisStepChanges({ ...step, target: box })) return [fail(cue, target, "unchanged", `element ${target} does not change between the step's marks`)];
  return [];
}

function cueFailures(input: EmphasisGateInput, beat: string, spec: BeatSpec, slots: Record<string, unknown>, fail: Fail) {
  return (cue: Cue, i: number): EmphasisFailure[] => {
    const found = emphasisTargets(spec, slots).filter((id) => id === cue.target).length;
    if (found === 0) return [fail(i, cue.target, "no-element", `${cue.target} names no element of beat spec ${spec.type}`)];
    if (found > 1) return [fail(i, cue.target, "ambiguous", `${cue.target} names ${found} elements of beat spec ${spec.type}`)];
    return placement(input, beat, i, cue.target, fail);
  };
}

function layerCueFailures(input: EmphasisGateInput, beat: string, exposed: readonly string[], fail: Fail) {
  return (cue: Cue, i: number): EmphasisFailure[] => {
    if (exposed.includes(cue.target)) return placement(input, beat, i, cue.target, fail);
    return [fail(i, cue.target, "no-element", `${cue.target} is not an element the custom layer exposes (it exposes ${exposed.join(", ") || "none"})`)];
  };
}

/**
 * The emphasis-target gate: every emphasis cue resolves to exactly one element of its beat, that element is on the
 * frame once laid out, and, given its marks, the step changes it on screen. How the element is emphasised stays with
 * the beat's template; the gate only checks the mapping.
 */
export function emphasisTargetGate(input: EmphasisGateInput): EmphasisFailure[] {
  return input.beats.flatMap((beat) => {
    const fail: Fail = (cue, target, problem, detail) => ({ beat: beat.id, cue, target, problem, detail });
    if (beat.visual.cues.length === 0) return [];
    const layer = input.layers?.[beat.id];
    if (layer !== undefined) return beat.visual.cues.flatMap(layerCueFailures(input, beat.id, layer, fail));
    const found = beatSlots(input, beat);
    if ("problem" in found) return beat.visual.cues.map((cue, i) => fail(i, cue.target, found.problem, found.detail));
    return beat.visual.cues.flatMap(cueFailures(input, beat.id, found.spec, found.slots, fail));
  });
}

const FIXES: Record<EmphasisProblem, string> = {
  "no-beat-spec": "name the beat's beat spec in visual.beat",
  "bad-slots": "give the beat slots its beat spec parses",
  "no-element": "point each cue at an element its beat draws, or make the beat draw it: a beat that falls back draws its fallback's elements, and a custom layer only the ids it exposes",
  ambiguous: "rename the target so it names one element",
  "off-frame": "keep the target's element inside the frame",
  unchanged: "make the step change its target on screen",
};

const failureLine = (f: EmphasisFailure): string => `${f.beat}#${f.cue} ${f.target} ${f.problem} (${f.detail})`;

/** The repair for each kind of failure the gate found, once each. */
const gateHint = (failures: readonly EmphasisFailure[]): string => [...new Set(failures.map((f) => f.problem))].map((problem) => FIXES[problem]).join("; ");

/** The gate as a stage check's verdict: pass with no failure, else every failing cue by beat, cue, target and reason, and the repair. */
export function emphasisGateVerdict(input: EmphasisGateInput): { pass: boolean; detail: string } {
  const failures = emphasisTargetGate(input);
  const total = input.beats.reduce((sum, beat) => sum + beat.visual.cues.length, 0);
  const listed = failures.length ? `: ${failures.map(failureLine).join("; ")}. Hint: ${gateHint(failures)}` : "";
  return { pass: failures.length === 0, detail: `${failures.length} of ${total} emphasis cues fail${listed}` };
}
