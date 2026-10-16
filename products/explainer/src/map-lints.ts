import type { CueResolver } from "./cues.js";
import { walkMapRun, type MapStep } from "./map-run.js";
import { MAP_LEVELS, type MapBeat, type MapLayout, type MapState, type MessageInFlight } from "./map-state.js";

export const MAX_NEW_BOXES = 3;
export const MAX_FULL_WEIGHT = 7;
// A hop dwells 0.8 s, then travels its route in 0.5 to 1.5 s. Without route lengths only the floor is
// checkable here; titan-design's validator re-checks each hop against its real route.
export const HOP_DWELL_S = 0.8;
export const HOP_MIN_TRAVEL_S = 0.5;

export type MapLintRule =
  | "level-step"
  | "new-boxes"
  | "full-weight"
  | "unknown-id"
  | "edge-source"
  | "hand-framing"
  | "card-per-cue"
  | "flow-hops"
  | "flow-replay"
  | "return-to-map";

/** Rules that need the beats' word timings, run by `lintMapCues`. */
export type MapCueLintRule = "hop-fit" | "until-cue";

/** An error fails the storyboard; a warning is style advice and never blocks a render. */
export interface MapLint {
  rule: MapLintRule | MapCueLintRule;
  severity: "error" | "warning";
  beatId: string;
  message: string;
}

type Lint = Omit<MapLint, "beatId">;
const error = (rule: MapLint["rule"], message: string): Lint => ({ rule, severity: "error", message });

function levelStep(step: MapStep): Lint[] {
  const jump = Math.abs(MAP_LEVELS.indexOf(step.end.level) - MAP_LEVELS.indexOf(step.start.level));
  return jump > 1 ? [error("level-step", `changes level ${jump} steps (${step.start.level} to ${step.end.level}); at most 1`)] : [];
}

function newBoxes(step: MapStep): Lint[] {
  const count = step.newBoxes.length;
  return count > MAX_NEW_BOXES ? [error("new-boxes", `reveals ${count} new boxes; at most ${MAX_NEW_BOXES}`)] : [];
}

function fullWeight(step: MapStep): Lint[] {
  const { focus, revealed, active } = step.end;
  const visible = Array.isArray(step.state.visible) ? step.state.visible : revealed;
  const count = new Set([...(focus ?? visible), ...active]).size;
  return count > MAX_FULL_WEIGHT ? [error("full-weight", `${count} boxes at full weight; at most ${MAX_FULL_WEIGHT}`)] : [];
}

function nodeIdsOf(state: MapState): string[] {
  const camera = state.camera && "fit" in state.camera ? state.camera.fit : [];
  return [
    ...camera,
    ...(state.reveal ?? []).map((r) => r.id),
    ...(Array.isArray(state.visible) ? state.visible : []),
    ...(state.active ?? []),
    ...(state.focus?.ids ?? []),
    ...(state.annotations ?? []).map((a) => a.anchor),
    ...(state.pins ?? []).map((p) => p.anchor),
  ];
}

function idsExist(step: MapStep, layout: MapLayout): Lint[] {
  const nodes = new Set(layout.nodes.map((n) => n.id));
  const edges = new Set(layout.edges.map((e) => e.id));
  const missing = [
    ...nodeIdsOf(step.state).filter((id) => !nodes.has(id)),
    ...(step.state.edges ?? []).map((e) => e.id).filter((id) => !edges.has(id)),
  ];
  return [...new Set(missing)].map((id) => error("unknown-id", `${id} is not in the layout`));
}

function edgeSources(step: MapStep, layout: MapLayout): Lint[] {
  const sourced = new Set(layout.edges.filter((e) => e.edgeSource).map((e) => e.id));
  const layoutIds = new Set(layout.edges.map((e) => e.id));
  return (step.state.edges ?? [])
    .filter((e) => layoutIds.has(e.id) && !sourced.has(e.id))
    .map((e) => error("edge-source", `edge ${e.id} has no edgeSource`));
}

function cardPerCue(step: MapStep): Lint[] {
  const seen = new Set<string>();
  const doubled = new Set<string>();
  for (const card of step.state.cards ?? []) (seen.has(card.atCue) ? doubled : seen).add(card.atCue);
  return [...doubled].map((cue) => error("card-per-cue", `more than one card enters at cue "${cue}"`));
}

const hopCount = (flow: MessageInFlight): number => flow.toHop - flow.fromHop + 1;
const walkKey = (flow: MessageInFlight): string => `${flow.flow}:${flow.fromHop}-${flow.toHop}`;

function flowHops(step: MapStep): Lint[] {
  const flow = step.state.message_in_flight;
  if (!flow) return [];
  if (flow.toHop < flow.fromHop) return [error("flow-hops", `toHop ${flow.toHop} is before fromHop ${flow.fromHop}`)];
  if (!flow.hopCues || flow.hopCues.length === hopCount(flow)) return [];
  return [error("flow-hops", `${flow.hopCues.length} hopCues for ${hopCount(flow)} hops; give one per hop`)];
}

/** A speed-3 replay is only legible after the viewer has watched the same walk at speed 1. */
function flowReplay(steps: readonly MapStep[]): MapLint[] {
  const walked = new Set<string>();
  return steps.flatMap((step) => {
    const flow = step.state.message_in_flight;
    if (!flow) return [];
    if (flow.speed !== 3) {
      walked.add(walkKey(flow));
      return [];
    }
    if (walked.has(walkKey(flow))) return [];
    const message = `speed-3 walk ${walkKey(flow)} has no earlier speed-1 walk over the same hops`;
    return [{ ...error("flow-replay", message), beatId: step.beat.id }];
  });
}

function handFraming(beat: MapBeat): Lint[] {
  const visual = beat.visual;
  if (visual?.layout_source !== "hand" || visual.chips.includes("our-framing")) return [];
  return [error("hand-framing", "layout_source hand needs an our-framing chip")];
}

function returnToMap(beats: readonly MapBeat[]): MapLint[] {
  return beats.flatMap((beat, i) => {
    const returns = beats.slice(i + 1).some((later) => later.visual?.map_state);
    if (beat.visual?.job !== "zoom" || returns) return [];
    const message = "a zoom with no later return to the map; consider one so the viewer can re-orient";
    return [{ rule: "return-to-map" as const, severity: "warning" as const, beatId: beat.id, message }];
  });
}

/** Lints a storyboard's map track against the layout. A beat without `map_state` is valid. */
export function lintMapBeats(beats: readonly MapBeat[], layout: MapLayout): MapLint[] {
  const steps = walkMapRun(beats);
  const stepLints = steps.flatMap((step) =>
    [
      ...levelStep(step),
      ...newBoxes(step),
      ...fullWeight(step),
      ...idsExist(step, layout),
      ...edgeSources(step, layout),
      ...cardPerCue(step),
      ...flowHops(step),
    ].map((lint) => ({ ...lint, beatId: step.beat.id })),
  );
  const beatLints = beats.flatMap((beat) => handFraming(beat).map((lint) => ({ ...lint, beatId: beat.id })));
  return [...stepLints, ...flowReplay(steps), ...beatLints, ...returnToMap(beats)];
}

/** Hop k must fit its dwell and travel before hop k+1's cue, and the last hop before the beat ends. */
function hopFit(beat: MapBeat, flow: MessageInFlight, resolveCue: CueResolver): Lint[] {
  if (!flow.hopCues) return [];
  const hopS = (HOP_DWELL_S + HOP_MIN_TRAVEL_S) / (flow.speed ?? 1);
  const walkS = resolveCue(beat.id, flow.atCue);
  const cueS = flow.hopCues.map((cue) => resolveCue(beat.id, cue));
  return flow.hopCues.flatMap((cue, k) => {
    const startS = cueS[k] ?? 0;
    const room = (cueS[k + 1] ?? beat.duration_s) - startS;
    if (startS < walkS) return [error("hop-fit", `hop cue "${cue}" comes before the walk's atCue`)];
    if (room >= hopS - 1e-9) return [];
    return [error("hop-fit", `hop cue "${cue}" leaves ${room.toFixed(2)} s; a hop needs ${hopS.toFixed(2)} s`)];
  });
}

function untilCue(beat: MapBeat, flow: MessageInFlight, resolveCue: CueResolver): Lint[] {
  if (!flow.untilCue || resolveCue(beat.id, flow.untilCue) > resolveCue(beat.id, flow.atCue)) return [];
  return [error("until-cue", `untilCue "${flow.untilCue}" is not after the walk's atCue "${flow.atCue}"`)];
}

/** The map lints that read word timings: a cued walk must fit the narration that drives it. */
export function lintMapCues(beats: readonly MapBeat[], resolveCue: CueResolver): MapLint[] {
  return beats.flatMap((beat) => {
    const flow = beat.visual?.map_state?.message_in_flight;
    if (!flow) return [];
    const lints = [...hopFit(beat, flow, resolveCue), ...untilCue(beat, flow, resolveCue)];
    return lints.map((lint) => ({ ...lint, beatId: beat.id }));
  });
}
