import type { LineSource } from "@titan-design/evidence";
import type { ScriptBeat, ScriptV1 } from "../script-schema.js";
import type { BeatScope, Lead, ScopeMap } from "./types.js";

type SpikeMap = NonNullable<ScriptV1["map"]>;

const isEdge = (edge: unknown): edge is { from: string; to: string } =>
  typeof edge === "object" && edge !== null && "from" in edge && "to" in edge && typeof edge.from === "string" && typeof edge.to === "string";

/** A script map's nodes, and its edges when the map carries any: the spike map shape holds no edge field of its own. */
function scopeMap(map: SpikeMap | undefined): ScopeMap | undefined {
  if (map === undefined) return undefined;
  const edges = Array.isArray(map.edges) ? (map.edges as unknown[]).filter(isEdge) : [];
  return { nodes: map.nodes.map(({ id, label }) => ({ id, label })), edges: edges.map(({ from, to }) => ({ from, to })) };
}

/** What one beat's derivation reads from the rest of the script: its chapter, the map, the persona, the stage it extends. */
export function beatScope(script: ScriptV1, beat: ScriptBeat, code?: LineSource, lead?: Lead): BeatScope {
  const index = script.chapters.findIndex((chapter) => chapter.id === beat.chapter);
  const { label, question } = script.chapters[index]!;
  const named = beat.visual.map_state?.map;
  const map = scopeMap(script.map ?? (named === undefined ? undefined : script.maps?.[named]));
  const { audience } = script.video;
  const persona = typeof audience === "string" ? undefined : audience.persona;
  return {
    chapter: { n: index + 1, label, question },
    chapterLabels: script.chapters.map((chapter) => chapter.label),
    ...(map === undefined ? {} : { map }),
    ...(persona === undefined ? {} : { persona }),
    ...(code === undefined ? {} : { code }),
    ...(lead === undefined ? {} : { lead }),
  };
}
