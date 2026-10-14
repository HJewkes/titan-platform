import { walkMapRun, type MapStep } from "./map-run.js";
import { VisualSchema, type MapBeat, type MapLayout } from "./map-state.js";
import { cuedChanges, type MapEventKind } from "./map-timeline.js";
import { spokenWordIndex, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

/** One change the viewer sees, keyed to the spoken cue that triggers it. */
export interface StateChange {
  cue: string;
  op: MapEventKind | ScriptBeat["visual"]["cues"][number]["action"];
  target: string;
}

/** The read-only view of a beat that judges and lints read. It is derived, never authored. */
export interface EvalBeat {
  id: string;
  function: ScriptBeat["function"];
  assertion: string;
  why: ScriptBeat["why"];
  spoken: string;
  visual: {
    map_id: string | null;
    mode: "map" | "none";
    you_are_here: string | null;
    nodes_shown: string[];
    edges_shown: string[];
    state_changes: StateChange[];
    labels: string[];
    chips: string[];
  };
  facts: string[];
}

type VisualJob = NonNullable<MapBeat["visual"]>["job"];
const isJob = (job: string): job is VisualJob => VisualSchema.shape.job.safeParse(job).success;

/**
 * Projects a script onto the map track's beats, so `lintMapBeats` and `compileMapTimeline` run on
 * a script unchanged. A beat with no settled job carries no visual; an unset layout source counts
 * as hand-drawn.
 */
export function toMapBeats(script: ScriptV1): MapBeat[] {
  return script.beats.map((beat) => {
    const v = beat.visual;
    if (!isJob(v.job)) return { id: beat.id, duration_s: beat.plannedS };
    const visual = {
      job: v.job,
      layout_source: v.layout_source ?? script.video.map?.layout_source ?? "hand",
      edge_sources: v.edge_sources,
      fact_ids: beat.fact_ids,
      chips: v.chips.map((c) => c.kind),
      ...(v.map_state ? { map_state: v.map_state } : {}),
    };
    return { id: beat.id, duration_s: beat.plannedS, visual };
  });
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

function nodesShown(step: MapStep, layout: MapLayout | undefined): string[] {
  const { visible } = step.state;
  if (Array.isArray(visible)) return sorted(visible);
  if (visible === "level" && layout) return sorted(layout.nodes.map((n) => n.id));
  return step.end.revealed;
}

function youAreHere(step: MapStep): string | null {
  const { camera, focus } = step.end;
  if (camera && "station" in camera) return camera.station;
  return focus?.length ? focus.join(",") : null;
}

function stateChanges(beat: ScriptBeat, step: MapStep | undefined): StateChange[] {
  const index = spokenWordIndex(beat);
  const mapOps = step ? cuedChanges(step).map(([cue, op, target]) => ({ cue, op, target })) : [];
  const offMap = beat.visual.cues.map((c) => ({ cue: c.atCue, op: c.action, target: c.target }));
  return [...mapOps, ...offMap].sort((a, b) => index(a.cue) - index(b.cue) || a.op.localeCompare(b.op));
}

function mapFields(step: MapStep | undefined, layout: MapLayout | undefined) {
  if (!step) return { mode: "none" as const, you_are_here: null, nodes_shown: [], edges_shown: [] };
  const edges = sorted((step.state.edges ?? []).map((e) => e.id));
  return { mode: "map" as const, you_are_here: youAreHere(step), nodes_shown: nodesShown(step, layout), edges_shown: edges };
}

/**
 * Derives each beat's eval view from its authored tracks. A beat that re-enters the map resumes
 * the map's last camera, focus and revealed boxes, as the map timeline does. `layout` resolves
 * `visible: "level"` to the layout's nodes; without it the beat shows what has been revealed.
 */
export function deriveEvalView(script: ScriptV1, layout?: MapLayout): EvalBeat[] {
  const steps = new Map(walkMapRun(toMapBeats(script)).map((step) => [step.beat.id, step]));
  return script.beats.map((beat) => {
    const step = steps.get(beat.id);
    const visual = {
      map_id: step ? (script.video.map?.id ?? null) : null,
      ...mapFields(step, layout),
      state_changes: stateChanges(beat, step),
      labels: beat.visual.labels,
      chips: beat.visual.chips.map((c) => c.text),
    };
    const { id, function: fn, why, spoken } = beat;
    return { id, function: fn, assertion: beat.visual.assertion, why, spoken, visual, facts: beat.fact_ids };
  });
}
