import type { MapBeat, MapLevel, MapState } from "./map-state.js";

export type CameraTarget = { fit: string[] } | { station: string };

/** What the map shows at a beat boundary. Ids are sorted so equal states compare equal. */
export interface MapView {
  level: MapLevel;
  camera: CameraTarget | null;
  revealed: string[];
  focus: string[] | null;
  active: string[];
}

/** One beat with the map on screen: the view it enters from, the view it ends on, and its own boxes. */
export interface MapStep {
  beat: MapBeat;
  state: MapState;
  start: MapView;
  end: MapView;
  newBoxes: string[];
  resumed: boolean;
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

function cameraOf(state: MapState): CameraTarget | undefined {
  if (!state.camera) return undefined;
  return "fit" in state.camera ? { fit: sorted(state.camera.fit) } : { station: state.camera.station };
}

function applyState(prev: MapView, state: MapState): MapView {
  return {
    level: state.level,
    camera: cameraOf(state) ?? prev.camera,
    revealed: sorted([...prev.revealed, ...(state.reveal ?? []).map((r) => r.id)]),
    focus: state.focus ? sorted(state.focus.ids) : prev.focus,
    active: state.active ? sorted(state.active) : prev.active,
  };
}

/**
 * Walks the beats in order and keeps the map's state across beats that leave it, so a beat that
 * re-enters the map starts where the map last was unless it says otherwise.
 */
export function walkMapRun(beats: readonly MapBeat[]): MapStep[] {
  const steps: MapStep[] = [];
  let last: MapView | null = null;
  let previousOnMap = false;
  for (const beat of beats) {
    const state = beat.visual?.map_state;
    if (!state) {
      previousOnMap = false;
      continue;
    }
    const start: MapView = last ?? { level: state.level, camera: null, revealed: [], focus: null, active: [] };
    const end = applyState(start, state);
    const newBoxes = end.revealed.filter((id) => !start.revealed.includes(id));
    steps.push({ beat, state, start, end, newBoxes, resumed: last !== null && !previousOnMap });
    last = end;
    previousOnMap = true;
  }
  return steps;
}
