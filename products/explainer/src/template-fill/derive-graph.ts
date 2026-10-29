import type { ScriptBeat } from "../script-schema.js";
import { chapterTitle } from "./derive-rows.js";
import { firstWord, itemReveals } from "./label-parse.js";
import type { BeatScope, Derivation, Derived, ScopeMap } from "./types.js";

// flow.ts MAP: five nodes fill the box, and one node is not a path.
const PATH_NODES = { min: 2, max: 5 };

/** The labels, in order, as a one-way path: node n to node n+1. */
function pathMap(beat: ScriptBeat, labels: readonly string[], scope: BeatScope): Derived {
  const nodes = labels.map((label, i) => ({ id: `nodes-${i + 1}`, label }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `edges-${i + 1}`, from: `nodes-${i + 1}`, to: node.id }));
  return { slots: { ...chapterTitle(scope), nodes, edges }, reveals: itemReveals(beat, "nodes", nodes.length) };
}

/** The script map's nodes in `map_state.reveal` order (all of them when nothing is revealed), each on its reveal cue. */
function stateMap(beat: ScriptBeat, map: ScopeMap, scope: BeatScope): Derived {
  const state = beat.visual.map_state!;
  const cues = new Map((state.reveal ?? []).map((reveal) => [reveal.id, reveal.atCue]));
  const shown = cues.size > 0 ? [...cues.keys()].flatMap((id) => map.nodes.find((node) => node.id === id) ?? []) : map.nodes;
  const ids = new Map(shown.map((node, i) => [node.id, `nodes-${i + 1}`]));
  const nodes = shown.map((node) => ({ id: ids.get(node.id)!, label: node.label }));
  const edges = map.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge, i) => ({ id: `edges-${i + 1}`, from: ids.get(edge.from)!, to: ids.get(edge.to)! }));
  const focus = ids.get(state.focus?.ids[0] ?? "");
  const reveals = shown.map((node) => ({ target: ids.get(node.id)!, atCue: cues.get(node.id) ?? firstWord(beat) }));
  return { slots: { ...chapterTitle(scope), nodes, edges, ...(focus === undefined ? {} : { focus }) }, reveals };
}

/** 2 to 5 labels as a path (the sample builder's arch-map), else the beat's map_state over the script map. */
export function deriveMap(beat: ScriptBeat, scope: BeatScope): Derivation {
  const { labels } = beat.visual;
  if (labels.length >= PATH_NODES.min && labels.length <= PATH_NODES.max) return pathMap(beat, labels, scope);
  if (beat.visual.map_state !== undefined && scope.map !== undefined) return stateMap(beat, scope.map, scope);
  return { reason: `a map needs ${PATH_NODES.min} to ${PATH_NODES.max} labels, or a map_state over the script map; this beat has ${labels.length} labels` };
}
