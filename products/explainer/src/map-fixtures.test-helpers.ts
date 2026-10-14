import { MapBeatSchema, MapLayoutSchema, type MapBeat } from "./map-state.js";

export const layout = MapLayoutSchema.parse({
  nodes: ["web", "api", "store", "queue", "worker", "auth", "cache", "billing", "mailer"].map((id) => ({ id })),
  edges: [
    { id: "web->api", edgeSource: "call" },
    { id: "api->store", edgeSource: "import" },
    { id: "api->queue" },
  ],
});

export function mapBeat(id: string, map_state?: Record<string, unknown>, visual: Record<string, unknown> = {}): MapBeat {
  return MapBeatSchema.parse({
    id,
    duration_s: 10,
    visual: { job: "map", layout_source: "code-graph", ...visual, ...(map_state ? { map_state } : {}) },
  });
}

export const offMap = (id: string, job = "numbers"): MapBeat => mapBeat(id, undefined, { job });

export const reveal = (...ids: string[]) => ids.map((id) => ({ id, atCue: "here" }));
