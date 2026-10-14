import { walkMapRun, type MapStep } from "./map-run.js";
import { MAP_LEVELS, type MapBeat, type MapLayout, type MapState } from "./map-state.js";

export const MAX_NEW_BOXES = 3;
export const MAX_FULL_WEIGHT = 7;

export type MapLintRule =
  | "level-step"
  | "new-boxes"
  | "full-weight"
  | "unknown-id"
  | "edge-source"
  | "hand-framing"
  | "card-per-cue"
  | "return-to-map";

/** An error fails the storyboard; a warning is style advice and never blocks a render. */
export interface MapLint {
  rule: MapLintRule;
  severity: "error" | "warning";
  beatId: string;
  message: string;
}

type Lint = Omit<MapLint, "beatId">;
const error = (rule: MapLintRule, message: string): Lint => ({ rule, severity: "error", message });

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
  const stepLints = walkMapRun(beats).flatMap((step) =>
    [
      ...levelStep(step),
      ...newBoxes(step),
      ...fullWeight(step),
      ...idsExist(step, layout),
      ...edgeSources(step, layout),
      ...cardPerCue(step),
    ].map((lint) => ({ ...lint, beatId: step.beat.id })),
  );
  const beatLints = beats.flatMap((beat) => handFraming(beat).map((lint) => ({ ...lint, beatId: beat.id })));
  return [...stepLints, ...beatLints, ...returnToMap(beats)];
}
