import type { CueResolver } from "./cues.js";
import { walkMapRun, type MapStep, type MapView } from "./map-run.js";
import type { MapBeat } from "./map-state.js";

export type MapEventKind = "camera" | "reveal" | "edge" | "focus" | "flow" | "card-in" | "card-out" | "annotation" | "pin";

/** A message walk with its cues resolved to video seconds. */
export interface MapFlowWalk {
  flowId: string;
  fromHop: number;
  toHop: number;
  speed?: 1 | 3;
  hopAtS?: number[];
  untilAtS?: number;
}

/** One change on the map, at seconds from the start of the video. `id` is a stable key; the rest is the payload. */
export interface MapEvent {
  atS: number;
  kind: MapEventKind;
  id: string;
  ids?: string[];
  text?: string;
  walk?: MapFlowWalk;
}

/** A stretch of the video with the map on screen. `start` is the view carried in from the last map beat. */
export interface MapSegment {
  beatId: string;
  startS: number;
  endS: number;
  resumed: boolean;
  minimap: boolean;
  start: MapView;
  end: MapView;
  events: MapEvent[];
}

export interface MapTimeline {
  segments: MapSegment[];
}

type Payload = Pick<MapEvent, "ids" | "text">;
type Cued = [cue: string, kind: MapEventKind, id: string, payload?: Payload];

function cuedChanges(step: MapStep): Cued[] {
  const s = step.state;
  const camera = s.camera && ("fit" in s.camera ? [...s.camera.fit].sort().join(",") : s.camera.station);
  const flow = s.message_in_flight;
  const focusIds = s.focus && [...new Set(s.focus.ids)].sort();
  return [
    ...(s.camera && camera ? [[s.camera.atCue, "camera", camera] as Cued] : []),
    ...(s.reveal ?? []).map((r): Cued => [r.atCue, "reveal", r.id]),
    ...(s.edges ?? []).map((e): Cued => [e.atCue, "edge", e.id]),
    ...(s.focus && focusIds ? [[s.focus.atCue, "focus", focusIds.join(","), { ids: focusIds }] as Cued] : []),
    ...(flow ? [[flow.atCue, "flow", `${flow.flow}:${flow.fromHop}-${flow.toHop}`] as Cued] : []),
    ...(s.cards ?? []).map((c): Cued => [c.atCue, "card-in", c.ref]),
    ...(s.cards ?? []).flatMap((c): Cued[] => (c.untilCue ? [[c.untilCue, "card-out", c.ref]] : [])),
    ...(s.annotations ?? []).map((a): Cued => [a.atCue, "annotation", `${a.kind}:${a.anchor}`]),
    ...(s.pins ?? []).map((p): Cued => [p.atCue, "pin", p.anchor, { text: p.text }]),
  ];
}

const byTimeKindId = (a: MapEvent, b: MapEvent): number =>
  a.atS - b.atS || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

function beatStarts(beats: readonly MapBeat[]): Map<string, number> {
  const starts = new Map<string, number>();
  let t = 0;
  for (const beat of beats) {
    starts.set(beat.id, t);
    t += beat.duration_s;
  }
  return starts;
}

function flowWalk(step: MapStep, startS: number, resolveCue: CueResolver): MapFlowWalk | undefined {
  const flow = step.state.message_in_flight;
  if (!flow) return undefined;
  const at = (cue: string): number => startS + resolveCue(step.beat.id, cue);
  return {
    flowId: flow.flow,
    fromHop: flow.fromHop,
    toHop: flow.toHop,
    ...(flow.speed ? { speed: flow.speed } : {}),
    ...(flow.hopCues ? { hopAtS: flow.hopCues.map(at) } : {}),
    ...(flow.untilCue ? { untilAtS: at(flow.untilCue) } : {}),
  };
}

function stepEvents(step: MapStep, startS: number, resolveCue: CueResolver): MapEvent[] {
  const walk = flowWalk(step, startS, resolveCue);
  return cuedChanges(step)
    .map(([cue, kind, id, payload]) => ({
      atS: startS + resolveCue(step.beat.id, cue),
      kind,
      id,
      ...payload,
      ...(kind === "flow" && walk ? { walk } : {}),
    }))
    .sort(byTimeKindId);
}

/**
 * Compiles a storyboard's map track into absolute-time segments, one per beat with the map on
 * screen. Events are sorted, so the output does not depend on the order of a beat's fields.
 */
export function compileMapTimeline(beats: readonly MapBeat[], resolveCue: CueResolver): MapTimeline {
  const starts = beatStarts(beats);
  const segments = walkMapRun(beats).map((step): MapSegment => {
    const startS = starts.get(step.beat.id) ?? 0;
    const { start, end, resumed } = step;
    const minimap = step.state.minimap ?? false;
    const events = stepEvents(step, startS, resolveCue);
    return { beatId: step.beat.id, startS, endS: startS + step.beat.duration_s, resumed, minimap, start, end, events };
  });
  return { segments };
}

export { cuedChanges };
